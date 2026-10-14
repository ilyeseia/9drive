import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  accounts: [] as Array<Record<string, any>>,
  health: [] as Array<{ connectedAccountId: string; state: string }>,
  reservations: {} as Record<string, string>,
  policy: {} as Record<string, any>,
}));

vi.mock('../../../config/prisma.js', () => ({
  prisma: {
    uploadRoutingPolicy: {
      upsert: async () => state.policy,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        state.policy = { ...state.policy, ...data };
        return state.policy;
      },
    },
    connectedAccount: {
      findMany: async ({ where }: { where: { userId: string; status: string; id?: string } }) =>
        state.accounts.filter((a) => a.userId === where.userId && a.status === where.status && (!where.id || a.id === where.id)),
    },
    providerHealth: { findMany: async () => state.health },
    folder: { findFirst: async () => null },
  },
}));

vi.mock('../../../queues/connection.js', () => ({
  getAppConnection: () => ({ get: async (key: string) => state.reservations[key] ?? null }),
}));

import { catalog } from '../../../providers/catalog.js';
import '../../../providers/index.js';
import {
  QUOTA_MAX_AGE_MS,
  describeRejections,
  routingExclusion,
  selectAccount,
  type RoutingRejection,
} from '../../../providers/routing.js';

const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
const GB = 1_000_000_000n;
let counter = 0;

function account(
  provider: string,
  availableGB: number | null,
  extra: { id?: string; synced?: number | null; metadata?: unknown; storage?: boolean; createdAt?: number } = {},
) {
  counter += 1;
  const id = extra.id ?? `acct-${counter}`;
  return {
    id,
    userId: 'u1',
    provider,
    status: 'connected',
    metadata: extra.metadata ?? null,
    createdAt: new Date(extra.createdAt ?? NOW - 1_000_000 + counter),
    storageAccount:
      extra.storage === false
        ? null
        : {
            availableBytes: availableGB === null ? null : BigInt(availableGB) * GB,
            usedBytes: 0n,
            lastSyncedAt: extra.synced === null ? null : new Date(extra.synced ?? NOW - 60_000),
          },
  };
}

async function pick(
  required = 1n,
  opts: { caps?: any[]; target?: string; diagnostics?: RoutingRejection[] } = {},
) {
  const selection = await selectAccount({
    userId: 'u1',
    requiredBytes: required,
    requiredCapabilities: opts.caps ?? ['upload'],
    targetAccountId: opts.target ?? null,
    diagnostics: opts.diagnostics,
  });
  return selection?.account.id ?? null;
}

beforeEach(() => {
  counter = 0;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  state.accounts = [];
  state.health = [];
  state.reservations = {};
  state.policy = {
    id: 'policy-1',
    userId: 'u1',
    mode: 'most_available',
    priorityAccountIds: [],
    roundRobinCursor: 0,
    fileTypeRules: null,
    minFileSizeBytes: null,
    maxFileSizeBytes: null,
  };
});

describe('routingExclusion (pure)', () => {
  const tb = catalog.get('terabox_open');
  const cookie = catalog.get('terabox');
  const google = catalog.get('google_drive');

  it('requires a known, fresh quota for terabox_open only', () => {
    expect(routingExclusion(account('terabox_open', 5) as any, tb, false, NOW)).toBeNull();
    expect(routingExclusion(account('terabox_open', null) as any, tb, false, NOW)).toBe('quota_unknown');
    expect(routingExclusion(account('terabox_open', 5, { storage: false }) as any, tb, false, NOW)).toBe('quota_unknown');
    expect(routingExclusion(account('terabox_open', 5, { synced: null }) as any, tb, false, NOW)).toBe('quota_unknown');
    expect(routingExclusion(account('terabox_open', 5, { synced: NOW - QUOTA_MAX_AGE_MS - 1 }) as any, tb, false, NOW)).toBe('quota_stale');
    expect(routingExclusion(account('terabox_open', 5, { synced: NOW - QUOTA_MAX_AGE_MS }) as any, tb, false, NOW)).toBeNull();
    // Historical behaviour for providers that do not opt in is preserved.
    expect(routingExclusion(account('google_drive', null, { synced: null }) as any, google, false, NOW)).toBeNull();
  });

  it('honours the per-account switch and the experimental default', () => {
    expect(routingExclusion(account('terabox_open', 5, { metadata: { routingEnabled: false } }) as any, tb, false, NOW)).toBe('routing_disabled');
    expect(routingExclusion(account('terabox', 5) as any, cookie, false, NOW)).toBe('experimental_not_opted_in');
    expect(routingExclusion(account('terabox', 5, { metadata: { routingEnabled: true } }) as any, cookie, false, NOW)).toBeNull();
  });

  it('lets an explicit target bypass the routing switches but never the quota rule', () => {
    const disabled = account('terabox_open', 5, { metadata: { routingEnabled: false } });
    expect(routingExclusion(disabled as any, tb, true, NOW)).toBeNull();
    const unknown = account('terabox_open', null, { metadata: { routingEnabled: false } });
    expect(routingExclusion(unknown as any, tb, true, NOW)).toBe('quota_unknown');
  });
});

describe('selectAccount across Google Drive, TeraBox and S3', () => {
  it('picks the most available eligible account regardless of provider', async () => {
    state.accounts = [
      account('google_drive', 10, { id: 'g' }),
      account('terabox_open', 50, { id: 't' }),
      account('s3', 20, { id: 's' }),
    ];
    expect(await pick()).toBe('t');
  });

  it('chooses between multiple TeraBox accounts by free space', async () => {
    state.accounts = [account('terabox_open', 5, { id: 't1' }), account('terabox_open', 9, { id: 't2' }), account('terabox_open', 7, { id: 't3' })];
    expect(await pick()).toBe('t2');
  });

  it('skips a TeraBox account with stale quota even when it looks biggest', async () => {
    state.accounts = [
      account('terabox_open', 900, { id: 'stale', synced: NOW - QUOTA_MAX_AGE_MS - 1 }),
      account('google_drive', 10, { id: 'g' }),
    ];
    const diagnostics: RoutingRejection[] = [];
    expect(await pick(1n, { diagnostics })).toBe('g');
    expect(diagnostics).toEqual([{ accountId: 'stale', provider: 'terabox_open', reason: 'quota_stale' }]);
  });

  it('never treats unknown TeraBox quota as unlimited space', async () => {
    state.accounts = [account('terabox_open', null, { id: 'unknown' })];
    const diagnostics: RoutingRejection[] = [];
    expect(await pick(1n, { diagnostics })).toBeNull();
    expect(diagnostics[0].reason).toBe('quota_unknown');
    expect(describeRejections(diagnostics)).toContain('quota is unknown');
  });

  it('rejects an account whose free space is below the file size', async () => {
    state.accounts = [account('terabox_open', 1, { id: 'small' }), account('terabox_open', 8, { id: 'big' })];
    expect(await pick(5n * GB)).toBe('big');
    const diagnostics: RoutingRejection[] = [];
    expect(await pick(100n * GB, { diagnostics })).toBeNull();
    expect(diagnostics.map((d) => d.reason)).toEqual(['insufficient_space', 'insufficient_space']);
  });

  it('excludes disabled accounts and experimental cookie accounts by default', async () => {
    state.accounts = [
      account('terabox_open', 80, { id: 'off', metadata: { routingEnabled: false } }),
      account('terabox', 90, { id: 'cookie' }),
      account('s3', 5, { id: 's' }),
    ];
    const diagnostics: RoutingRejection[] = [];
    expect(await pick(1n, { diagnostics })).toBe('s');
    expect(diagnostics.map((d) => d.reason).sort()).toEqual(['experimental_not_opted_in', 'routing_disabled']);
  });

  it('includes an experimental account only after it is explicitly enabled', async () => {
    state.accounts = [account('terabox', 90, { id: 'cookie', metadata: { routingEnabled: true } }), account('s3', 5, { id: 's' })];
    expect(await pick()).toBe('cookie');
  });

  it('honours an explicit target even when automatic routing is disabled for it', async () => {
    state.accounts = [account('terabox_open', 5, { id: 't', metadata: { routingEnabled: false } }), account('s3', 50, { id: 's' })];
    expect(await pick(1n, { target: 't' })).toBe('t');
    expect(await pick()).toBe('s');
  });

  it('requires the operation to be supported (no createFolder on the official provider)', async () => {
    state.accounts = [account('terabox_open', 500, { id: 't' }), account('google_drive', 5, { id: 'g' })];
    const diagnostics: RoutingRejection[] = [];
    expect(await pick(1n, { caps: ['upload', 'createFolder'], diagnostics })).toBe('g');
    expect(diagnostics).toEqual([{ accountId: 't', provider: 'terabox_open', reason: 'missing_capability' }]);
  });

  it('excludes unauthorized and unreachable accounts but keeps degraded ones', async () => {
    state.accounts = [account('terabox_open', 9, { id: 'a' }), account('terabox_open', 8, { id: 'b' }), account('terabox_open', 7, { id: 'c' })];
    state.health = [
      { connectedAccountId: 'a', state: 'unauthorized' },
      { connectedAccountId: 'b', state: 'unreachable' },
      { connectedAccountId: 'c', state: 'degraded' },
    ];
    const diagnostics: RoutingRejection[] = [];
    expect(await pick(1n, { diagnostics })).toBe('c');
    expect(diagnostics.map((d) => d.accountId).sort()).toEqual(['a', 'b']);
    expect(diagnostics.every((d) => d.reason === 'unhealthy')).toBe(true);
  });

  it('subtracts in-flight reservations so concurrent uploads do not share the same free space', async () => {
    state.accounts = [account('terabox_open', 10, { id: 'a' }), account('terabox_open', 8, { id: 'b' })];
    expect(await pick(6n * GB)).toBe('a');
    // The caller reserves the bytes it just routed (Redis counter in production).
    state.reservations['9drive:acct:a:reserved'] = String(6n * GB);
    expect(await pick(6n * GB)).toBe('b');
    state.reservations['9drive:acct:b:reserved'] = String(6n * GB);
    expect(await pick(6n * GB)).toBeNull();
  });
});

describe('routing policies with TeraBox accounts', () => {
  it('priority: follows the configured account order among eligible accounts', async () => {
    state.policy.mode = 'priority';
    state.policy.priorityAccountIds = ['t2', 't1'];
    state.accounts = [account('terabox_open', 50, { id: 't1' }), account('terabox_open', 5, { id: 't2' })];
    expect(await pick()).toBe('t2');
    // An ineligible top-priority account is skipped rather than blocking uploads.
    state.accounts = [account('terabox_open', 5, { id: 't2', synced: NOW - QUOTA_MAX_AGE_MS - 1 }), account('terabox_open', 50, { id: 't1' })];
    expect(await pick()).toBe('t1');
  });

  it('round_robin: cycles deterministically through eligible accounts only', async () => {
    state.policy.mode = 'round_robin';
    state.accounts = [
      account('terabox_open', 5, { id: 'a', createdAt: NOW - 3000 }),
      account('terabox_open', 5, { id: 'b', createdAt: NOW - 2000, synced: NOW - QUOTA_MAX_AGE_MS - 1 }),
      account('google_drive', 5, { id: 'c', createdAt: NOW - 1000 }),
    ];
    expect([await pick(), await pick(), await pick(), await pick()]).toEqual(['a', 'c', 'a', 'c']);
  });

  it('least_used: prefers the emptiest eligible account', async () => {
    state.policy.mode = 'least_used';
    const a = account('terabox_open', 5, { id: 'a' });
    const b = account('terabox_open', 5, { id: 'b' });
    (a.storageAccount as any).usedBytes = 10n;
    (b.storageAccount as any).usedBytes = 1n;
    state.accounts = [a, b];
    expect(await pick()).toBe('b');
  });

  it('reports why nothing can accept the upload', async () => {
    state.accounts = [
      account('terabox_open', 5, { id: 'a', metadata: { routingEnabled: false } }),
      account('terabox_open', null, { id: 'b' }),
      account('terabox_open', 0, { id: 'c' }),
    ];
    const diagnostics: RoutingRejection[] = [];
    expect(await pick(1n, { diagnostics })).toBeNull();
    const text = describeRejections(diagnostics);
    expect(text).toContain('automatic routing is disabled');
    expect(text).toContain('quota is unknown');
    expect(text).toContain('not enough free space');
    expect(describeRejections([])).toBe('no connected storage account is available');
  });
});
