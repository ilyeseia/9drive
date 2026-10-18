/**
 * Reproduction tests for the provider audit (docs/provider-audit). Each test asserts the CORRECT behaviour and is
 * wrapped in `it.fails` while the defect exists, so the suite stays green and documents the defect. When a defect is
 * fixed, vitest reports the `it.fails` test as failing; flip it to a plain `it` in the same change.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../../config/prisma.js';
import { buildContext } from '../../../providers/context.js';
import { registerOAuth2Client } from '../../../providers/oauth2.js';
import { encryptText } from '../../../utils/crypto.js';
import { createTestUser, pingDb } from '../platform/helpers.js';

describe('provider audit — reproduced defects', () => {
  let dbOk = false;
  let userId = '';
  let providerConfigId = '';
  const accountIds: string[] = [];
  let server: Server | null = null;
  let mode: 'ok' | 'unavailable' | 'rate_limited' = 'ok';
  let tokenCalls = 0;

  beforeAll(async () => {
    dbOk = await pingDb();
    if (!dbOk) return;
    userId = (await createTestUser('audit')).id;
    providerConfigId = (
      await prisma.providerConfig.create({
        data: {
          userId,
          provider: 'google_drive',
          clientIdEncrypted: encryptText('audit-client'),
          clientSecretEncrypted: encryptText('audit-secret'),
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
        if (mode === 'unavailable') {
          res.statusCode = 503;
          res.end(JSON.stringify({ error: 'temporarily_unavailable' }));
          return;
        }
        if (mode === 'rate_limited') {
          res.statusCode = 429;
          res.setHeader('retry-after', '30');
          res.end(JSON.stringify({ error: 'rate_limited' }));
          return;
        }
        // Small delay so concurrent refreshes genuinely overlap.
        setTimeout(() => {
          res.end(JSON.stringify({ access_token: `access-${tokenCalls}`, refresh_token: `refresh-${tokenCalls}`, expires_in: 3600 }));
        }, 150);
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
    await prisma.connectedAccount.deleteMany({ where: { id: { in: accountIds } } }).catch(() => undefined);
    await prisma.providerConfig.delete({ where: { id: providerConfigId } }).catch(() => undefined);
    await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
  });

  async function expiredAccount(): Promise<string> {
    const account = await prisma.connectedAccount.create({
      data: {
        userId,
        provider: 'google_drive',
        providerAccountId: `pa-${randomUUID().slice(0, 8)}`,
        email: `${randomUUID().slice(0, 8)}@example.test`,
        accessTokenEncrypted: encryptText('old-access'),
        refreshTokenEncrypted: encryptText('old-refresh'),
        tokenExpiresAt: new Date(Date.now() - 60_000),
        scopes: [],
        status: 'connected',
        providerConfigId,
      },
    });
    accountIds.push(account.id);
    return account.id;
  }

  // F1 — a provider outage during token refresh must not be reported as "reauthorization required".
  it.fails('F1: token endpoint 503 keeps the account connected and does not throw ERR_AUTH_EXPIRED', async (ctx) => {
    if (!dbOk) ctx.skip();
    mode = 'unavailable';
    const id = await expiredAccount();
    const error = await buildContext(id).catch((err: unknown) => err as { code?: string });
    const row = await prisma.connectedAccount.findUniqueOrThrow({ where: { id } });
    mode = 'ok';
    expect((error as { code?: string }).code).not.toBe('ERR_AUTH_EXPIRED');
    expect(row.status).not.toBe('unauthorized');
  });

  it.fails('F1: token endpoint 429 keeps the account connected', async (ctx) => {
    if (!dbOk) ctx.skip();
    mode = 'rate_limited';
    const id = await expiredAccount();
    await buildContext(id).catch(() => undefined);
    const row = await prisma.connectedAccount.findUniqueOrThrow({ where: { id } });
    mode = 'ok';
    expect(row.status).not.toBe('unauthorized');
  });

  // F2 — concurrent refreshes of one account must hit the token endpoint once.
  it.fails('F2: concurrent buildContext calls refresh the token exactly once', async (ctx) => {
    if (!dbOk) ctx.skip();
    mode = 'ok';
    const id = await expiredAccount();
    tokenCalls = 0;
    await Promise.all([buildContext(id), buildContext(id), buildContext(id), buildContext(id)]);
    expect(tokenCalls).toBe(1);
  });
});
