import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../../config/prisma.js';
import { createFakeProvider } from '../../../providers/fake.js';
import { registry } from '../../../providers/registry.js';
import { registerOAuth2Client } from '../../../providers/oauth2.js';
import {
  ACCOUNT_STATES,
  assertTransition,
  canTransition,
  InvalidAccountTransitionError,
  isRoutable,
  normalizeAccountState,
} from '../../../providers/lifecycle.js';
import { createS3Account, createApiKeyAccount, disconnectOwnedAccount } from '../../../modules/providers/account-service.js';
import { createConnectUrl, handleConnectCallback, sweepOrphanPendingAccounts } from '../../../modules/providers/connect-flow.js';
import { decryptText, encryptText, hashToken } from '../../../utils/crypto.js';
import { createTestUser, pingDb } from '../platform/helpers.js';

describe('account lifecycle state machine', () => {
  it('maps legacy statuses and rejects unknown ones', () => {
    expect(normalizeAccountState('unauthorized')).toBe('reauthorization_required');
    expect(normalizeAccountState('pending')).toBe('pending_authorization');
    expect(normalizeAccountState('connected')).toBe('connected');
    expect(normalizeAccountState('bogus')).toBeNull();
  });

  it('allows recovery paths and forbids skipping the disconnect protocol', () => {
    expect(canTransition('connected', 'temporarily_unavailable')).toBe(true);
    expect(canTransition('temporarily_unavailable', 'connected')).toBe(true);
    expect(canTransition('reauthorization_required', 'connected')).toBe(true);
    expect(canTransition('disconnecting', 'disconnected')).toBe(true);
    expect(canTransition('disconnected', 'connected')).toBe(true);
    expect(canTransition('connected', 'disconnected')).toBe(false);
    expect(canTransition('disconnected', 'degraded')).toBe(false);
    expect(() => assertTransition('connected', 'disconnected')).toThrow(InvalidAccountTransitionError);
    expect(() => assertTransition('weird', 'connected')).toThrow(InvalidAccountTransitionError);
  });

  it('defines every state and routes only connected/degraded accounts', () => {
    for (const state of ACCOUNT_STATES) expect(canTransition(state, state)).toBe(true);
    expect(isRoutable('connected')).toBe(true);
    expect(isRoutable('degraded')).toBe(true);
    for (const s of ['unauthorized', 'temporarily_unavailable', 'disabled', 'disconnected', 'pending']) {
      expect(isRoutable(s)).toBe(false);
    }
  });
});

describe('identity, duplicates and atomicity (real DB)', () => {
  let dbOk = false;
  let userId = '';
  let providerConfigId = '';
  let server: Server | null = null;
  let tokenCalls = 0;
  let profileMode: 'ok' | 'fail' = 'ok';
  let remoteId = 'remote-1';

  beforeAll(async () => {
    dbOk = await pingDb();
    if (!dbOk) return;
    userId = (await createTestUser('identity')).id;
    providerConfigId = (
      await prisma.providerConfig.create({
        data: {
          userId,
          provider: 'google_drive',
          clientIdEncrypted: encryptText('id'),
          clientSecretEncrypted: encryptText('secret'),
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
        res.end(JSON.stringify({ access_token: `a-${tokenCalls}`, refresh_token: `r-${tokenCalls}`, expires_in: 3600 }));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    registerOAuth2Client({
      id: 'google_drive',
      authorizationUrl: 'http://127.0.0.1/authorize',
      tokenUrl: `http://127.0.0.1:${(server!.address() as AddressInfo).port}/token`,
      scopes: [],
    });
    const fake = createFakeProvider({ id: 'google_drive', authMode: 'oauth2' });
    const realGetInfo = fake.getAccountInfo.bind(fake);
    fake.getAccountInfo = async (ctx) => {
      if (profileMode === 'fail') throw new Error('profile unavailable');
      const info = await realGetInfo(ctx);
      return { ...info, providerAccountId: remoteId, email: `${remoteId}@example.test` };
    };
    registry.register(fake);
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (!dbOk) return;
    await prisma.oauthState.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.s3StorageConfig.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.connectedAccount.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.providerConfig.delete({ where: { id: providerConfigId } }).catch(() => undefined);
    await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
  });

  async function newState(): Promise<string> {
    const state = randomUUID();
    await prisma.oauthState.create({
      data: {
        userId,
        providerConfigId,
        flow: 'connect',
        stateHash: hashToken(state),
        expiresAt: new Date(Date.now() + 600_000),
      },
    });
    return state;
  }

  it('F3: a replayed/concurrent callback with one state succeeds exactly once', async (ctx) => {
    if (!dbOk) ctx.skip();
    remoteId = `remote-${randomUUID().slice(0, 6)}`;
    profileMode = 'ok';
    const state = await newState();
    tokenCalls = 0;
    const results = await Promise.allSettled([
      handleConnectCallback('google_drive', { state, code: 'c1' }),
      handleConnectCallback('google_drive', { state, code: 'c1' }),
      handleConnectCallback('google_drive', { state, code: 'c1' }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled' && r.value.ok);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(rejected).toHaveLength(2);
    expect(tokenCalls).toBe(1);
    const rows = await prisma.connectedAccount.findMany({ where: { userId, providerAccountId: remoteId } });
    expect(rows).toHaveLength(1);
  });

  it('F4: a failed profile read leaves no pending account behind', async (ctx) => {
    if (!dbOk) ctx.skip();
    profileMode = 'fail';
    const state = await newState();
    const outcome = await handleConnectCallback('google_drive', { state, code: 'c2' });
    profileMode = 'ok';
    expect(outcome.ok).toBe(false);
    expect(await prisma.connectedAccount.count({ where: { userId, providerAccountId: { startsWith: 'pending:' } } })).toBe(0);
  });

  it('F4: the sweeper removes only stale pending rows of that user', async (ctx) => {
    if (!dbOk) ctx.skip();
    const stale = await prisma.connectedAccount.create({
      data: {
        userId,
        provider: 'google_drive',
        providerAccountId: `pending:${randomUUID()}`,
        email: '',
        scopes: [],
        status: 'pending',
        accessTokenEncrypted: encryptText('x'),
        createdAt: new Date(Date.now() - 3_600_000),
      },
    });
    const fresh = await prisma.connectedAccount.create({
      data: {
        userId,
        provider: 'google_drive',
        providerAccountId: `pending:${randomUUID()}`,
        email: '',
        scopes: [],
        status: 'pending',
        accessTokenEncrypted: encryptText('x'),
      },
    });
    expect(await sweepOrphanPendingAccounts(userId)).toBe(1);
    expect(await prisma.connectedAccount.findUnique({ where: { id: stale.id } })).toBeNull();
    expect(await prisma.connectedAccount.findUnique({ where: { id: fresh.id } })).not.toBeNull();
    await prisma.connectedAccount.delete({ where: { id: fresh.id } });
  });

  const s3Body = (secret: string) => ({
    name: 'bucket-a',
    bucket: `bkt-${userId.slice(0, 6)}`,
    region: 'us-east-1',
    accessKeyId: 'AKIA-TEST',
    secretAccessKey: secret,
  });

  it('F8: a failing S3 test never creates an account or alters a working one', async (ctx) => {
    if (!dbOk) ctx.skip();
    const quota = { id: 'q' } as never;
    const okDeps = { testConnection: async () => undefined, syncQuota: async () => quota };
    const badDeps = {
      testConnection: async () => {
        throw new Error('AccessDenied');
      },
      syncQuota: async () => quota,
    };
    const created = await createS3Account(userId, s3Body('good-secret'), okDeps);
    const before = await prisma.s3StorageConfig.findUniqueOrThrow({ where: { connectedAccountId: created.account.id } });

    await expect(createS3Account(userId, s3Body('wrong-secret'), badDeps)).rejects.toThrow();
    const after = await prisma.s3StorageConfig.findUniqueOrThrow({ where: { connectedAccountId: created.account.id } });
    expect(after.secretAccessKeyEncrypted).toBe(before.secretAccessKeyEncrypted);
    const acct = await prisma.connectedAccount.findUniqueOrThrow({ where: { id: created.account.id } });
    expect(acct.status).toBe('connected');

    const other = { ...s3Body('x'), bucket: `other-${userId.slice(0, 6)}` };
    await expect(createS3Account(userId, other, badDeps)).rejects.toThrow();
    expect(await prisma.connectedAccount.count({ where: { userId, provider: 's3', providerAccountId: { startsWith: 'other-' } } })).toBe(0);
  });

  it('F9: logging in again with the same TeraBox email reuses the account', async (ctx) => {
    if (!dbOk) ctx.skip();
    const email = `tb-${randomUUID().slice(0, 6)}@example.test`;
    const first = await createApiKeyAccount(userId, 'terabox', { apiKey: 'cookie-one', email, password: 'pw' });
    const second = await createApiKeyAccount(userId, 'terabox', { apiKey: 'cookie-two', email: email.toUpperCase(), password: 'pw' });
    expect(second.id).toBe(first.id);
    expect(await prisma.connectedAccount.count({ where: { userId, provider: 'terabox' } })).toBe(1);
  });

  it('F11: inline OAuth credentials for a different client never replace an existing configuration', async (ctx) => {
    if (!dbOk) ctx.skip();
    const before = await prisma.providerConfig.findUniqueOrThrow({ where: { id: providerConfigId } });
    await createConnectUrl(userId, 'google_drive', { clientId: 'client-A', clientSecret: 'secret-A' });
    await createConnectUrl(userId, 'google_drive', { clientId: 'client-B', clientSecret: 'secret-B' });
    await createConnectUrl(userId, 'google_drive', { clientId: 'client-B', clientSecret: 'secret-B2' });
    const after = await prisma.providerConfig.findUniqueOrThrow({ where: { id: providerConfigId } });
    expect(after.clientIdEncrypted).toBe(before.clientIdEncrypted);
    expect(after.clientSecretEncrypted).toBe(before.clientSecretEncrypted);
    // original + client-A + client-B (client-B reused, its secret updated)
    expect(await prisma.providerConfig.count({ where: { userId, provider: 'google_drive' } })).toBe(3);
  });

  it('F10: disconnect removes stored credentials', async (ctx) => {
    if (!dbOk) ctx.skip();
    const quota = { id: 'q' } as never;
    const deps = { testConnection: async () => undefined, syncQuota: async () => quota };
    const created = await createS3Account(userId, { ...s3Body('to-remove'), bucket: `disc-${userId.slice(0, 6)}` }, deps);
    expect(await disconnectOwnedAccount(userId, created.account.id)).toBe(true);
    const row = await prisma.connectedAccount.findUniqueOrThrow({ where: { id: created.account.id } });
    const cfg = await prisma.s3StorageConfig.findUniqueOrThrow({ where: { connectedAccountId: created.account.id } });
    expect(row.status).toBe('disconnected');
    expect(row.accessTokenEncrypted).toBeNull();
    expect(row.refreshTokenEncrypted).toBeNull();
    expect(decryptText(cfg.secretAccessKeyEncrypted)).toBe('__disconnected__');
    expect(cfg.status).toBe('disabled');
  });
});
