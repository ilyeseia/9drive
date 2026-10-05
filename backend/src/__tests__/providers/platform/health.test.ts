import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../../config/prisma.js';
import { ProviderError } from '../../../providers/errors.js';
import { createFakeProvider, type FakeProvider } from '../../../providers/fake.js';
import { checkAccount, mapErrorToHealthState, refreshQuota } from '../../../providers/health.js';
import { registry } from '../../../providers/registry.js';
import { encryptText } from '../../../utils/crypto.js';
import { createTestUser, pingDb } from './helpers.js';

describe('checkAccount / refreshQuota', () => {
  let dbOk = false;
  let userId = '';
  const accountIds: string[] = [];
  const healthy: FakeProvider = createFakeProvider({
    id: 'fake_health',
    authMode: 'oauth2',
    quota: { totalBytes: 10_000n, usedBytes: 4_000n, trashBytes: 500n },
  });
  const noHealth: FakeProvider = createFakeProvider({
    id: 'fake_no_health',
    authMode: 'oauth2',
    capabilities: ['upload', 'getQuota'],
  });
  const noQuota: FakeProvider = createFakeProvider({
    id: 'fake_no_quota',
    authMode: 'oauth2',
    capabilities: ['upload', 'healthCheck'],
  });

  beforeAll(async () => {
    registry.register(healthy);
    registry.register(noHealth);
    registry.register(noQuota);
    dbOk = await pingDb();
    if (!dbOk) return;
    const user = await createTestUser('health');
    userId = user.id;
  });

  afterAll(async () => {
    if (!dbOk) return;
    await prisma.providerHealth.deleteMany({ where: { connectedAccountId: { in: accountIds } } });
    await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
  });

  async function createHealthAccount(
    options: { provider?: string; accessToken?: string | null; status?: string } = {},
  ): Promise<string> {
    const account = await prisma.connectedAccount.create({
      data: {
        userId,
        provider: options.provider ?? 'fake_health',
        providerAccountId: `ha-${randomUUID().slice(0, 8)}`,
        email: `${randomUUID().slice(0, 8)}@example.test`,
        accessTokenEncrypted:
          options.accessToken === null ? null : encryptText(options.accessToken ?? 'health-access-token'),
        tokenExpiresAt: null,
        scopes: [],
        status: options.status ?? 'connected',
      },
    });
    accountIds.push(account.id);
    return account.id;
  }

  it('maps error codes onto health states', () => {
    expect(mapErrorToHealthState(new ProviderError('ERR_AUTH_EXPIRED', 'x'))).toBe('unauthorized');
    expect(mapErrorToHealthState(new ProviderError('ERR_AUTH_REVOKED', 'x'))).toBe('unauthorized');
    expect(mapErrorToHealthState(new ProviderError('ERR_TIMEOUT', 'x'))).toBe('unreachable');
    expect(mapErrorToHealthState(new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'x'))).toBe('unreachable');
    expect(mapErrorToHealthState(new ProviderError('ERR_RATE_LIMITED', 'x'))).toBe('degraded');
    expect(mapErrorToHealthState(new ProviderError('ERR_QUOTA_EXCEEDED', 'x'))).toBe('degraded');
    expect(mapErrorToHealthState(new ProviderError('ERR_SSRF_BLOCKED', 'x'))).toBe('degraded');
    expect(mapErrorToHealthState(new ProviderError('ERR_NOT_FOUND', 'x'))).toBe('degraded');
    expect(mapErrorToHealthState(new ProviderError('ERR_INTERNAL', 'x'))).toBe('unknown');
    expect(mapErrorToHealthState(new Error('boom'))).toBe('unknown');
    expect(mapErrorToHealthState(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))).toBe('unreachable');
    expect(mapErrorToHealthState(Object.assign(new Error('slow'), { name: 'TimeoutError' }))).toBe('unreachable');
  });

  it('records a healthy state for a working account', async (testCtx) => {
    if (!dbOk) testCtx.skip();
    healthy.clearCallLog();
    const accountId = await createHealthAccount();
    const record = await checkAccount(accountId);

    expect(record.state).toBe('healthy');
    expect(record.connectedAccountId).toBe(accountId);
    expect(record.provider).toBe('fake_health');
    expect(record.message).toBeNull();
    expect(record.latencyMs).not.toBeNull();
    expect(record.latencyMs!).toBeGreaterThanOrEqual(0);
    expect(record.checkedAt).toBeInstanceOf(Date);
    expect(healthy.callCount('healthCheck')).toBe(1);

    const stored = await prisma.providerHealth.findUnique({ where: { connectedAccountId: accountId } });
    expect(stored?.state).toBe('healthy');

    const account = await prisma.connectedAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.status).toBe('connected');
    expect(account.lastError).toBeNull();
  });

  it('marks the account unauthorized on an auth health failure and restores it', async (testCtx) => {
    if (!dbOk) testCtx.skip();
    const accountId = await createHealthAccount();
    healthy.failNext('healthCheck', { code: 'ERR_AUTH_REVOKED', message: 'upstream said no' });

    const failed = await checkAccount(accountId);
    expect(failed.state).toBe('unauthorized');
    expect(failed.message).toBe('upstream said no');

    let account = await prisma.connectedAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.status).toBe('unauthorized');
    expect(account.lastError).toBe('upstream said no');

    healthy.setHealth({ state: 'healthy', message: null });
    healthy.clearFailures();
    const recovered = await checkAccount(accountId);
    expect(recovered.state).toBe('healthy');

    account = await prisma.connectedAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.status).toBe('connected');
    expect(account.lastError).toBeNull();
  });

  it('records unknown without calling providers that lack the healthCheck capability', async (testCtx) => {
    if (!dbOk) testCtx.skip();
    const accountId = await createHealthAccount({ provider: 'fake_no_health' });
    noHealth.clearCallLog();
    const record = await checkAccount(accountId);

    expect(record.state).toBe('unknown');
    expect(record.message).toContain("does not declare capability 'healthCheck'");
    expect(noHealth.callCount('healthCheck')).toBe(0);
  });

  it('records unauthorized when the context cannot be built', async (testCtx) => {
    if (!dbOk) testCtx.skip();
    const accountId = await createHealthAccount({ accessToken: null });
    const record = await checkAccount(accountId);

    expect(record.state).toBe('unauthorized');
    expect(record.message).not.toBeNull();

    const account = await prisma.connectedAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.status).toBe('unauthorized');
    expect(account.lastError).not.toBeNull();
  });

  it('throws ERR_NOT_FOUND for an unknown account', async (testCtx) => {
    if (!dbOk) testCtx.skip();
    const error = await checkAccount(randomUUID()).catch((err: unknown) => err);
    expect(ProviderError.is(error)).toBe(true);
    expect((error as ProviderError).code).toBe('ERR_NOT_FOUND');
  });

  it('upserts the StorageAccount row on quota refresh', async (testCtx) => {
    if (!dbOk) testCtx.skip();
    const accountId = await createHealthAccount();
    const before = Date.now();
    await refreshQuota(accountId);

    const first = await prisma.storageAccount.findUniqueOrThrow({ where: { connectedAccountId: accountId } });
    expect(first.totalBytes).toBe(10_000n);
    expect(first.usedBytes).toBe(4_000n);
    expect(first.availableBytes).toBe(6_000n);
    expect(first.trashBytes).toBe(500n);
    expect(first.lastSyncedAt!.getTime()).toBeGreaterThanOrEqual(before - 1_000);

    await refreshQuota(accountId);
    const second = await prisma.storageAccount.findUniqueOrThrow({ where: { connectedAccountId: accountId } });
    expect(second.id).toBe(first.id);
    expect(second.usedBytes).toBe(4_000n);
  });

  it('throws ERR_NOT_FOUND on quota refresh for an unknown account', async (testCtx) => {
    if (!dbOk) testCtx.skip();
    const error = await refreshQuota(randomUUID()).catch((err: unknown) => err);
    expect(ProviderError.is(error)).toBe(true);
    expect((error as ProviderError).code).toBe('ERR_NOT_FOUND');
  });

  it('throws ERR_CAPABILITY_UNSUPPORTED when the provider has no getQuota capability', async (testCtx) => {
    if (!dbOk) testCtx.skip();
    const accountId = await createHealthAccount({ provider: 'fake_no_quota' });
    const error = await refreshQuota(accountId).catch((err: unknown) => err);
    expect(ProviderError.is(error)).toBe(true);
    expect((error as ProviderError).code).toBe('ERR_CAPABILITY_UNSUPPORTED');

    const stored = await prisma.storageAccount.findUnique({ where: { connectedAccountId: accountId } });
    expect(stored).toBeNull();
  });
});
