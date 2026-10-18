import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../../config/prisma.js';
import { createFakeProvider } from '../../../providers/fake.js';
import { registerOAuth2Client } from '../../../providers/oauth2.js';
import { registry } from '../../../providers/registry.js';
import { selectAccount } from '../../../providers/routing.js';
import { pickGoogleAccount } from '../../../modules/folders/folder.routes.js';
import { getAuthedGoogleClient } from '../../../modules/google/google.service.js';
import { decryptText, encryptText } from '../../../utils/crypto.js';
import { createTestUser, pingDb } from '../platform/helpers.js';

describe('routing and legacy Google path (real DB)', () => {
  let dbOk = false;
  let userId = '';
  let providerConfigId = '';
  let server: Server | null = null;
  let tokenCalls = 0;
  let seq = 0;

  beforeAll(async () => {
    registry.register(createFakeProvider({ id: 'google_drive', authMode: 'oauth2' }));
    registry.register(createFakeProvider({ id: 's3', authMode: 'access_key' }));
    dbOk = await pingDb();
    if (!dbOk) return;
    userId = (await createTestUser('routing-legacy')).id;
    providerConfigId = (
      await prisma.providerConfig.create({
        data: {
          userId,
          provider: 'google_drive',
          clientIdEncrypted: encryptText('legacy-client'),
          clientSecretEncrypted: encryptText('legacy-secret'),
          redirectUri: 'http://localhost:5173/cb',
          scopes: ['drive'],
        },
      })
    ).id;
    server = createServer((req, res) => {
      req.on('data', () => undefined);
      req.on('end', () => {
        tokenCalls += 1;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ access_token: 'legacy-new-access', refresh_token: 'legacy-new-refresh', expires_in: 3600 }));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    registerOAuth2Client({
      id: 'google_drive',
      authorizationUrl: 'http://127.0.0.1/authorize',
      tokenUrl: `http://127.0.0.1:${(server!.address() as AddressInfo).port}/token`,
      scopes: [],
    });
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (!dbOk) return;
    await prisma.uploadRoutingPolicy.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.connectedAccount.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.providerConfig.delete({ where: { id: providerConfigId } }).catch(() => undefined);
    await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
  });

  async function account(options: {
    provider?: string;
    createdAt?: Date;
    available?: bigint | null;
    expired?: boolean;
  } = {}): Promise<string> {
    seq += 1;
    const row = await prisma.connectedAccount.create({
      data: {
        userId,
        provider: options.provider ?? 'google_drive',
        providerAccountId: `rl-${seq}-${randomUUID().slice(0, 4)}`,
        email: `rl-${seq}@example.test`,
        scopes: [],
        status: 'connected',
        createdAt: options.createdAt ?? new Date(),
        accessTokenEncrypted: encryptText('legacy-old-access'),
        refreshTokenEncrypted: encryptText('legacy-old-refresh'),
        tokenExpiresAt: options.expired ? new Date(Date.now() - 60_000) : new Date(Date.now() + 3_600_000),
        providerConfigId,
      },
    });
    if (options.available !== undefined) {
      await prisma.storageAccount.create({
        data: {
          connectedAccountId: row.id,
          totalBytes: options.available === null ? null : options.available + 10n,
          usedBytes: 10n,
          availableBytes: options.available,
          lastSyncedAt: new Date(),
        },
      });
    }
    return row.id;
  }

  async function policy(mode: string): Promise<void> {
    await prisma.uploadRoutingPolicy.upsert({
      where: { userId },
      create: { userId, mode, priorityAccountIds: [] },
      update: { mode, priorityAccountIds: [], roundRobinCursor: 0 },
    });
  }

  it('F12: an account with unknown capacity ranks after accounts with known room', async (ctx) => {
    if (!dbOk) ctx.skip();
    const unknown = await account({ available: null });
    const known = await account({ available: 5_000n });
    await policy('most_available');
    const picked = await selectAccount({ userId, requiredBytes: 10n, requiredCapabilities: [] });
    expect(picked!.account.id).toBe(known);
    expect(picked!.account.id).not.toBe(unknown);
    await prisma.connectedAccount.deleteMany({ where: { id: { in: [unknown, known] } } });
  });

  it('F12: concurrent round_robin selections receive distinct cursor positions', async (ctx) => {
    if (!dbOk) ctx.skip();
    const ids = [await account({ available: 100n }), await account({ available: 100n }), await account({ available: 100n })];
    await policy('round_robin');
    const picks = await Promise.all(
      [0, 1, 2].map(() => selectAccount({ userId, requiredBytes: 10n, requiredCapabilities: [] })),
    );
    const chosen = new Set(picks.map((p) => p!.account.id));
    expect(chosen.size).toBe(3);
    const row = await prisma.uploadRoutingPolicy.findUniqueOrThrow({ where: { userId } });
    expect(row.roundRobinCursor).toBe(3);
    await prisma.connectedAccount.deleteMany({ where: { id: { in: ids } } });
  });

  it('F7: Google account choice is deterministic (oldest) and sub-folders keep their parent account', async (ctx) => {
    if (!dbOk) ctx.skip();
    const older = await account({ createdAt: new Date(Date.now() - 86_400_000) });
    const newer = await account({ createdAt: new Date() });
    const first = await pickGoogleAccount(userId);
    const again = await pickGoogleAccount(userId);
    expect(first!.id).toBe(older);
    expect(again!.id).toBe(first!.id);
    const sticky = await pickGoogleAccount(userId, newer);
    expect(sticky!.id).toBe(newer);
    const foreign = await pickGoogleAccount(userId, randomUUID());
    expect(foreign!.id).toBe(older);
    await prisma.connectedAccount.deleteMany({ where: { id: { in: [older, newer] } } });
  });

  it('F6: the legacy Google client refreshes through the shared context (persisted once, CAS-safe)', async (ctx) => {
    if (!dbOk) ctx.skip();
    const id = await account({ expired: true });
    const row = await prisma.connectedAccount.findUniqueOrThrow({ where: { id } });
    tokenCalls = 0;
    const clients = await Promise.all([getAuthedGoogleClient(row), getAuthedGoogleClient(row)]);
    expect(clients[0].credentials.access_token).toBe('legacy-new-access');
    expect(clients[0].credentials.refresh_token).toBeUndefined();
    expect(tokenCalls).toBe(1);
    const after = await prisma.connectedAccount.findUniqueOrThrow({ where: { id } });
    expect(decryptText(after.accessTokenEncrypted!)).toBe('legacy-new-access');
    expect(decryptText(after.refreshTokenEncrypted!)).toBe('legacy-new-refresh');
    await prisma.connectedAccount.delete({ where: { id } });
  });
});
