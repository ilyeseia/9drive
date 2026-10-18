import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../../config/prisma.js';
import { buildProviderDiagnostics } from '../../../modules/providers/diagnostics.js';
import { listProviderAccountViews } from '../../../modules/providers/account-service.js';
import { createFakeProvider } from '../../../providers/fake.js';
import { registry } from '../../../providers/registry.js';
import { selectAccount } from '../../../providers/routing.js';
import { createTestUser, pingDb } from '../platform/helpers.js';

const SIZES = [10, 100, 1000];

async function seed(userId: string, count: number, provider = 'google_drive'): Promise<string[]> {
  const batch = randomUUID().slice(0, 6);
  const ids = Array.from({ length: count }, () => randomUUID());
  await prisma.connectedAccount.createMany({
    data: ids.map((id, i) => ({
      id,
      userId,
      provider,
      providerAccountId: `scale-${batch}-${i}`,
      email: `scale-${batch}-${i}@example.test`,
      scopes: [],
      status: i % 10 === 9 ? 'unauthorized' : 'connected',
    })),
  });
  await prisma.storageAccount.createMany({
    data: ids.map((id, i) => ({
      connectedAccountId: id,
      totalBytes: 1_000_000n,
      usedBytes: BigInt(i * 100),
      availableBytes: 1_000_000n - BigInt(i * 100),
      lastSyncedAt: new Date(),
    })),
  });
  return ids;
}

describe('scale and tenant isolation (real DB, PGlite — timings are indicative, not production numbers)', () => {
  let dbOk = false;
  let userA = '';
  let userB = '';
  const timings: string[] = [];

  beforeAll(async () => {
    registry.register(createFakeProvider({ id: 'google_drive', authMode: 'oauth2' }));
    dbOk = await pingDb();
    if (!dbOk) return;
    userA = (await createTestUser('scale-a')).id;
    userB = (await createTestUser('scale-b')).id;
  });

  afterAll(async () => {
    if (dbOk) {
      await prisma.uploadRoutingPolicy.deleteMany({ where: { userId: { in: [userA, userB] } } }).catch(() => undefined);
      await prisma.connectedAccount.deleteMany({ where: { userId: { in: [userA, userB] } } }).catch(() => undefined);
      await prisma.user.deleteMany({ where: { id: { in: [userA, userB] } } }).catch(() => undefined);
    }
    // Optional: set SCALE_REPORT=<file> to keep the measured timings.
    if (process.env.SCALE_REPORT) writeFileSync(process.env.SCALE_REPORT, timings.join('\n'));
  });

  async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    const result = await fn();
    timings.push(`${label}: ${Math.round(performance.now() - start)} ms`);
    return result;
  }

  for (const size of SIZES) {
    it(`${size} accounts: routing, listing and diagnostics stay correct and bounded`, async (ctx) => {
      if (!dbOk) ctx.skip();
      const user = (await createTestUser(`scale-${size}`)).id;
      try {
        const ids = await seed(user, size);
        await prisma.uploadRoutingPolicy.create({ data: { userId: user, mode: 'most_available', priorityAccountIds: [] } });

        const picked = await timed(`${size} accounts: selectAccount(most_available)`, () =>
          selectAccount({ userId: user, requiredBytes: 10n, requiredCapabilities: [] }),
        );
        // index 0 has the most free space and is `connected`.
        expect(picked!.account.id).toBe(ids[0]);

        const page = await timed(`${size} accounts: listProviderAccountViews(limit 500)`, () =>
          listProviderAccountViews(user, { limit: 500 }),
        );
        expect(page.length).toBe(Math.min(size, 500));
        const all: string[] = [];
        for (let offset = 0; offset < size; offset += 500) {
          const next = await listProviderAccountViews(user, { limit: 500, offset });
          all.push(...next.map((a) => a.id));
        }
        expect(new Set(all).size).toBe(size);

        const report = await timed(`${size} accounts: buildProviderDiagnostics`, () => buildProviderDiagnostics(user));
        expect(report.totalAccounts).toBe(size);
        expect(report.byProvider.google_drive?.connected).toBe(size - Math.floor(size / 10));
        expect(report.byProvider.google_drive?.reauthorization_required).toBe(Math.floor(size / 10));

        // Unauthorised accounts are never routed to, however many there are.
        const unauthorized = new Set(report.accounts.filter((a) => !a.routable).map((a) => a.id));
        for (let i = 0; i < 5; i++) {
          const pick = await selectAccount({ userId: user, requiredBytes: 10n, requiredCapabilities: [] });
          expect(unauthorized.has(pick!.account.id)).toBe(false);
        }
      } finally {
        await prisma.uploadRoutingPolicy.deleteMany({ where: { userId: user } }).catch(() => undefined);
        await prisma.connectedAccount.deleteMany({ where: { userId: user } }).catch(() => undefined);
        await prisma.user.delete({ where: { id: user } }).catch(() => undefined);
      }
    }, 180_000);
  }

  it('isolation: a user with 1000 accounts never leaks into another tenant routing, listing or diagnostics', async (ctx) => {
    if (!dbOk) ctx.skip();
    const aIds = await seed(userA, 5);
    const bIds = await seed(userB, 1000);
    await prisma.uploadRoutingPolicy.create({ data: { userId: userA, mode: 'most_available', priorityAccountIds: [] } });

    const pick = await selectAccount({ userId: userA, requiredBytes: 10n, requiredCapabilities: [] });
    expect(aIds).toContain(pick!.account.id);

    // Targeting another tenant's account must never select it.
    const hostile = await selectAccount({
      userId: userA,
      requiredBytes: 10n,
      requiredCapabilities: [],
      targetAccountId: bIds[0],
    });
    expect(hostile === null || aIds.includes(hostile.account.id)).toBe(true);

    const list = await listProviderAccountViews(userA);
    expect(list.every((view) => aIds.includes(view.id))).toBe(true);
    const report = await buildProviderDiagnostics(userA);
    expect(report.accounts.every((a) => aIds.includes(a.id))).toBe(true);
    expect(report.totalAccounts).toBe(5);
  }, 180_000);

  it('concurrency: 50 parallel selections on 100 accounts complete without error and honour eligibility', async (ctx) => {
    if (!dbOk) ctx.skip();
    const user = (await createTestUser('scale-conc')).id;
    try {
      const ids = await seed(user, 100);
      await prisma.uploadRoutingPolicy.create({ data: { userId: user, mode: 'round_robin', priorityAccountIds: [] } });
      const picks = await timed('100 accounts: 50 parallel round_robin selections', () =>
        Promise.all(Array.from({ length: 50 }, () => selectAccount({ userId: user, requiredBytes: 10n, requiredCapabilities: [] }))),
      );
      const eligible = new Set(ids.filter((_, i) => i % 10 !== 9));
      expect(picks.every((p) => p !== null && eligible.has(p.account.id))).toBe(true);
      // Atomic cursor: 50 selections advanced it by exactly 50 and spread over many distinct accounts.
      const policy = await prisma.uploadRoutingPolicy.findUniqueOrThrow({ where: { userId: user } });
      expect(policy.roundRobinCursor).toBe(50);
      expect(new Set(picks.map((p) => p!.account.id)).size).toBe(50);
    } finally {
      await prisma.uploadRoutingPolicy.deleteMany({ where: { userId: user } }).catch(() => undefined);
      await prisma.connectedAccount.deleteMany({ where: { userId: user } }).catch(() => undefined);
      await prisma.user.delete({ where: { id: user } }).catch(() => undefined);
    }
  }, 180_000);
});
