import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { prisma } from '../../../config/prisma.js';
import { ProviderError } from '../../../providers/errors.js';
import { createFakeProvider } from '../../../providers/fake.js';
import { ROUTING_MODES, selectAccount } from '../../../providers/routing.js';
import { registry } from '../../../providers/registry.js';
import { getAppConnection } from '../../../queues/connection.js';
import { createTestUser, pingDb } from './helpers.js';

const BASE_TIME = Date.UTC(2026, 0, 1);
const at = (offset: number): Date => new Date(BASE_TIME + offset);

interface Quota {
  total: bigint;
  used: bigint;
  available: bigint;
}

describe('selectAccount', () => {
  let dbOk = false;
  let userId = '';
  const accountIds: string[] = [];
  let gAcc = '';
  let sAcc = '';
  let dAcc = '';
  let boxAcc = '';
  let discAcc = '';
  let tieA = '';
  let tieB = '';

  beforeAll(async () => {
    registry.register(
      createFakeProvider({ id: 'google_drive', authMode: 'oauth2' }),
    );
    registry.register(
      createFakeProvider({ id: 's3', authMode: 'access_key' }),
    );
    registry.register(
      createFakeProvider({
        id: 'dropbox',
        authMode: 'oauth2',
        capabilities: ['upload', 'download', 'list', 'getMetadata', 'getQuota', 'healthCheck'],
      }),
    );
    registry.register(createFakeProvider({ id: 'box', authMode: 'oauth2' }));

    dbOk = await pingDb();
    if (!dbOk) return;
    const user = await createTestUser('routing');
    userId = user.id;

    gAcc = await createAccount({ provider: 'google_drive', createdAt: at(1000), quota: { total: 1_000n, used: 500n, available: 900n } });
    sAcc = await createAccount({ provider: 's3', createdAt: at(2000), quota: { total: 1_000n, used: 100n, available: 500n } });
    dAcc = await createAccount({ provider: 'dropbox', createdAt: at(3000), quota: { total: 2_000n, used: 100n, available: 1_500n } });
    boxAcc = await createAccount({ provider: 'box', createdAt: at(4000), quota: { total: 5_000n, used: 0n, available: 5_000n } });
    discAcc = await createAccount({
      provider: 's3',
      createdAt: at(5000),
      status: 'disconnected',
      quota: { total: 8_000n, used: 0n, available: 8_000n },
    });
    tieA = await createAccount({ provider: 'google_drive', createdAt: at(6000), quota: { total: 100n, used: 0n, available: 0n } });
    tieB = await createAccount({ provider: 'google_drive', createdAt: at(7000), quota: { total: 100n, used: 0n, available: 0n } });
  });

  afterAll(async () => {
    if (!dbOk) return;
    await prisma.providerHealth.deleteMany({ where: { connectedAccountId: { in: accountIds } } });
    await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
  });

  async function createAccount(options: {
    provider: string;
    createdAt: Date;
    status?: string;
    quota: Quota;
  }): Promise<string> {
    const seq = accountIds.length + 1;
    const account = await prisma.connectedAccount.create({
      data: {
        userId,
        provider: options.provider,
        providerAccountId: `ra-${seq}`,
        email: `ra-${seq}@example.test`,
        scopes: [],
        status: options.status ?? 'connected',
        createdAt: options.createdAt,
      },
    });
    accountIds.push(account.id);
    await prisma.storageAccount.create({
      data: {
        connectedAccountId: account.id,
        totalBytes: options.quota.total,
        usedBytes: options.quota.used,
        availableBytes: options.quota.available,
        lastSyncedAt: at(0),
      },
    });
    return account.id;
  }

  async function resetPolicy(
    overrides: {
      mode?: string;
      priorityAccountIds?: string[];
      fileTypeRules?: Prisma.InputJsonValue;
      minFileSizeBytes?: bigint | null;
      maxFileSizeBytes?: bigint | null;
    } = {},
  ): Promise<void> {
    const mode = overrides.mode ?? 'most_available';
    const priorityAccountIds = overrides.priorityAccountIds ?? [];
    const fileTypeRules = overrides.fileTypeRules ?? Prisma.DbNull;
    await prisma.uploadRoutingPolicy.upsert({
      where: { userId },
      create: { userId, mode, priorityAccountIds, fileTypeRules },
      update: {
        mode,
        priorityAccountIds,
        fileTypeRules,
        roundRobinCursor: 0,
        minFileSizeBytes: overrides.minFileSizeBytes ?? null,
        maxFileSizeBytes: overrides.maxFileSizeBytes ?? null,
      },
    });
  }

  it('exposes the nine contract routing modes', () => {
    expect(ROUTING_MODES).toHaveLength(9);
    expect(ROUTING_MODES).toContain('most_available');
    expect(ROUTING_MODES).toContain('health_aware');
  });

  it('returns null when the user has no connected accounts', async (testCtx) => {
    if (!dbOk) testCtx.skip();
    const empty = await createTestUser('routing-empty');
    const result = await selectAccount({ userId: empty.id, requiredBytes: 1n, requiredCapabilities: [] });
    expect(result).toBeNull();
    await prisma.user.delete({ where: { id: empty.id } });
  });

  it('filters by status, catalog SUPPORTED and quota headroom under most_available', async (testCtx) => {
    if (!dbOk) testCtx.skip();
    await resetPolicy();
    const result = await selectAccount({ userId, requiredBytes: 10n, requiredCapabilities: [] });
    expect(result).not.toBeNull();
    expect(result!.account.id).toBe(dAcc);
    expect(result!.account.id).not.toBe(boxAcc);
    expect(result!.account.id).not.toBe(discAcc);
    expect(result!.provider.id).toBe('dropbox');

    const tooBig = await selectAccount({ userId, requiredBytes: 1_501n, requiredCapabilities: [] });
    expect(tooBig).toBeNull();
  });

  it('excludes providers that do not declare a required capability', async (testCtx) => {
    if (!dbOk) testCtx.skip();
    await resetPolicy();
    const result = await selectAccount({ userId, requiredBytes: 10n, requiredCapabilities: ['createShare'] });
    expect(result).not.toBeNull();
    expect(result!.account.id).toBe(gAcc);
  });

  it('least_used orders by usedBytes with a stable tie-break', async (testCtx) => {
    if (!dbOk) testCtx.skip();
    await resetPolicy({ mode: 'least_used' });
    const result = await selectAccount({ userId, requiredBytes: 10n, requiredCapabilities: [] });
    expect(result).not.toBeNull();
    expect(result!.account.id).toBe(sAcc);
  });

  it('priority follows priorityAccountIds order', async (testCtx) => {
    if (!dbOk) testCtx.skip();
    await resetPolicy({ mode: 'priority', priorityAccountIds: [sAcc, gAcc] });
    const first = await selectAccount({ userId, requiredBytes: 10n, requiredCapabilities: [] });
    expect(first!.account.id).toBe(sAcc);

    await resetPolicy({ mode: 'priority', priorityAccountIds: [gAcc, sAcc] });
    const second = await selectAccount({ userId, requiredBytes: 10n, requiredCapabilities: [] });
    expect(second!.account.id).toBe(gAcc);
  });

  it('round_robin advances the persisted cursor', async (testCtx) => {
    if (!dbOk) testCtx.skip();
    await resetPolicy({ mode: 'round_robin' });
    const first = await selectAccount({ userId, requiredBytes: 10n, requiredCapabilities: [] });
    const second = await selectAccount({ userId, requiredBytes: 10n, requiredCapabilities: [] });
    expect(first!.account.id).toBe(gAcc);
    expect(second!.account.id).toBe(sAcc);

    const policy = await prisma.uploadRoutingPolicy.findUniqueOrThrow({ where: { userId } });
    expect(policy.roundRobinCursor).toBe(2);
  });

  it('provider_preference reads the preferred provider from the policy', async (testCtx) => {
    if (!dbOk) testCtx.skip();
    await resetPolicy({
      mode: 'provider_preference',
      fileTypeRules: [{ match: 'video/*', preferProvider: 's3' }],
    });
    const result = await selectAccount({ userId, requiredBytes: 10n, requiredCapabilities: [] });
    expect(result!.account.id).toBe(sAcc);
  });

  it('file_type mode also honours preferProvider', async (testCtx) => {
    if (!dbOk) testCtx.skip();
    await resetPolicy({
      mode: 'file_type',
      fileTypeRules: [{ match: 'image/*', preferProvider: 'google_drive' }],
    });
    const result = await selectAccount({ userId, requiredBytes: 10n, requiredCapabilities: [] });
    expect(result!.account.id).toBe(gAcc);
  });

  it('file_size mode selects the best fit inside the size window', async (testCtx) => {
    if (!dbOk) testCtx.skip();
    await resetPolicy({ mode: 'file_size', minFileSizeBytes: 100n, maxFileSizeBytes: 1_000n });
    const result = await selectAccount({ userId, requiredBytes: 500n, requiredCapabilities: [] });
    expect(result!.account.id).toBe(sAcc);
  });

  it('user_policy prefers priority over provider preference', async (testCtx) => {
    if (!dbOk) testCtx.skip();
    await resetPolicy({
      mode: 'user_policy',
      priorityAccountIds: [gAcc],
      fileTypeRules: [{ match: '*', preferProvider: 's3' }],
    });
    const result = await selectAccount({ userId, requiredBytes: 10n, requiredCapabilities: [] });
    expect(result!.account.id).toBe(gAcc);
  });

  it('redis reservations reduce effective headroom', async (testCtx) => {
    if (!dbOk) testCtx.skip();
    await resetPolicy();
    const control = await selectAccount({ userId, requiredBytes: 10n, requiredCapabilities: [] });
    expect(control!.account.id).toBe(dAcc);

    const client = getAppConnection();
    const key = `9drive:acct:${dAcc}:reserved`;
    await client.set(key, '1500');
    try {
      const reserved = await selectAccount({ userId, requiredBytes: 10n, requiredCapabilities: [] });
      expect(reserved!.account.id).toBe(gAcc);
    } finally {
      await client.del(key);
    }

    const released = await selectAccount({ userId, requiredBytes: 10n, requiredCapabilities: [] });
    expect(released!.account.id).toBe(dAcc);
  });

  it('health states exclude accounts unless the mode is health_aware', async (testCtx) => {
    if (!dbOk) testCtx.skip();
    await prisma.providerHealth.upsert({
      where: { connectedAccountId: dAcc },
      create: { provider: 'dropbox', connectedAccountId: dAcc, state: 'unreachable', checkedAt: new Date() },
      update: { state: 'unreachable', checkedAt: new Date() },
    });
    try {
      await resetPolicy();
      const excluded = await selectAccount({ userId, requiredBytes: 1_000n, requiredCapabilities: [] });
      expect(excluded).toBeNull();

      await resetPolicy({ mode: 'health_aware' });
      const tolerant = await selectAccount({ userId, requiredBytes: 1_000n, requiredCapabilities: [] });
      expect(tolerant).not.toBeNull();
      expect(tolerant!.account.id).toBe(dAcc);
    } finally {
      await prisma.providerHealth
        .delete({ where: { connectedAccountId: dAcc } })
        .catch(() => undefined);
    }
  });

  it('targetAccountId pins the selection', async (testCtx) => {
    if (!dbOk) testCtx.skip();
    await resetPolicy();
    const target = await selectAccount({
      userId,
      requiredBytes: 10n,
      requiredCapabilities: [],
      targetAccountId: sAcc,
    });
    expect(target!.account.id).toBe(sAcc);

    const missing = await selectAccount({
      userId,
      requiredBytes: 10n,
      requiredCapabilities: [],
      targetAccountId: randomUUID(),
    });
    expect(missing).toBeNull();
  });

  it('folderId resolves the folder-bound account', async (testCtx) => {
    if (!dbOk) testCtx.skip();
    const folder = await prisma.folder.create({
      data: {
        userId,
        name: 'bound',
        provider: 's3',
        providerFolderId: 'pf-1',
        connectedAccountId: sAcc,
      },
    });
    try {
      const result = await selectAccount({
        userId,
        requiredBytes: 10n,
        requiredCapabilities: [],
        folderId: folder.id,
      });
      expect(result).not.toBeNull();
      expect(result!.account.id).toBe(sAcc);
    } finally {
      await prisma.folder.delete({ where: { id: folder.id } }).catch(() => undefined);
    }
  });

  it('breaks full ties deterministically by createdAt then id', async (testCtx) => {
    if (!dbOk) testCtx.skip();
    await resetPolicy({ mode: 'least_used' });
    const result = await selectAccount({ userId, requiredBytes: 0n, requiredCapabilities: [] });
    expect(result!.account.id).toBe(tieA);
    expect(result!.account.id).not.toBe(tieB);
  });

  it('rejects invalid inputs', async (testCtx) => {
    if (!dbOk) testCtx.skip();
    const negative = await selectAccount({ userId, requiredBytes: -1n, requiredCapabilities: [] }).catch(
      (err: unknown) => err,
    );
    expect(ProviderError.is(negative)).toBe(true);
    expect((negative as ProviderError).code).toBe('ERR_INVALID_INPUT');

    const notBigInt = await selectAccount({
      userId,
      requiredBytes: 10 as unknown as bigint,
      requiredCapabilities: [],
    }).catch((err: unknown) => err);
    expect(ProviderError.is(notBigInt)).toBe(true);
    expect((notBigInt as ProviderError).code).toBe('ERR_INVALID_INPUT');

    const noUser = await selectAccount({ userId: '', requiredBytes: 1n, requiredCapabilities: [] }).catch(
      (err: unknown) => err,
    );
    expect(ProviderError.is(noUser)).toBe(true);
    expect((noUser as ProviderError).code).toBe('ERR_INVALID_INPUT');
  });
});
