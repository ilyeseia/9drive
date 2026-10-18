import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  views: [] as any[],
  accounts: [] as any[],
  audit: [] as string[],
  quotaCalls: [] as string[],
  quotaAfter: null as any,
  quotaReads: 0,
  health: { state: 'healthy', latencyMs: 12, message: 'ok token=abcdef123456', checkedAt: '2026-10-18T00:00:00Z' } as any,
}));

vi.mock('../../config/prisma.js', () => ({
  prisma: {
    connectedAccount: {
      findFirst: async ({ where }: any) => h.accounts.find((a) => a.id === where.id && a.userId === where.userId) ?? null,
      update: async ({ where, data }: any) => Object.assign(h.accounts.find((a) => a.id === where.id), data),
    },
    storageOperation: { count: async () => 3 },
    file: { count: async () => 4 },
    storageAccount: {
      // First read = before the refresh, second read = after it.
      findUnique: async () => (h.quotaReads++ === 0 ? { ...h.quotaAfter, lastSyncedAt: new Date('2026-10-18T11:00:00Z') } : h.quotaAfter),
    },
  },
}));
vi.mock('../../utils/audit.js', () => ({ createAuditLog: async (_u: string, action: string) => void h.audit.push(action) }));
vi.mock('../../providers/health.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../providers/health.js')>()),
  checkAccount: async () => h.health,
  refreshQuota: async (id: string) => void h.quotaCalls.push(id),
}));
vi.mock('../../modules/providers/account-service.js', () => ({
  listProviderAccountViews: async () => h.views,
  findOwnedAccount: async (userId: string, id: string) => h.accounts.find((a) => a.id === id && a.userId === userId) ?? null,
  disconnectOwnedAccount: async (userId: string, id: string) => {
    const a = h.accounts.find((x) => x.id === id && x.userId === userId);
    if (!a) return false;
    a.status = 'disconnected';
    return true;
  },
}));

import { loadAiConfig } from '../../modules/ai/config.js';
import { createDefaultRegistry } from '../../modules/ai/tools/index.js';
import { parseToolArgs, runTool } from '../../modules/ai/tools/registry.js';

const tools = createDefaultRegistry();
const config = loadAiConfig({ AI_PROVIDER: 'openai_compatible', AI_MODEL: 'm', AI_API_KEY: 'k' });
const NOW = new Date('2026-10-18T12:00:00Z');
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';

function view(id: string, extra: Record<string, any> = {}) {
  return {
    id,
    provider: 'google_drive',
    displayName: `acct-${id.slice(-1)}`,
    email: 'me@example.com',
    status: 'connected',
    lastError: null,
    authMode: 'oauth2',
    capabilities: ['upload', 'list'],
    quota: { totalBytes: 100n, usedBytes: 40n, availableBytes: 60n },
    health: { state: 'healthy', latencyMs: 5, checkedAt: new Date() },
    lastSyncedAt: new Date(NOW.getTime() - 60_000),
    routingEnabled: null,
    experimental: false,
    quotaPolicy: 'optional',
    ...extra,
  };
}

async function exec(name: string, args: unknown, userId = 'user-1') {
  const tool = tools.get(name)!;
  const parsed = parseToolArgs(tool, args);
  if (!parsed.ok) throw new Error(parsed.message);
  return runTool(tool, parsed.args, { userId, taskId: 't', config, now: () => NOW }) as Promise<any>;
}

beforeEach(() => {
  h.views = [];
  h.accounts = [
    { id: A, userId: 'user-1', provider: 'google_drive', status: 'connected', metadata: { clientHint: 'keep' } },
    { id: C, userId: 'user-2', provider: 'google_drive', status: 'connected', metadata: null },
  ];
  h.audit = [];
  h.quotaCalls = [];
  h.quotaAfter = null;
  h.quotaReads = 0;
});

describe('account listing and comparison', () => {
  it('lists accounts with quota freshness and no credential fields', async () => {
    h.views = [view(A), view(B, { lastSyncedAt: new Date(NOW.getTime() - 2 * 3_600_000) }), view(C, { quota: null, lastSyncedAt: null })];
    const out = await exec('list_storage_accounts', {});
    const accounts = out.result.data.accounts;
    expect(accounts.map((a: any) => a.quota?.freshness ?? 'none')).toEqual(['fresh', 'stale', 'none']);
    expect(JSON.stringify(out.result.data)).not.toMatch(/accessToken|refreshToken|apiKey|secret|cookie/i);
  });

  it('does not rank unknown or stale quota as free space', async () => {
    h.views = [
      view(A, { quota: { totalBytes: 100n, usedBytes: 90n, availableBytes: 10n } }),
      view(B, { quota: null, lastSyncedAt: null }),
      view(C, { quota: { totalBytes: 1000n, usedBytes: 0n, availableBytes: 1000n }, lastSyncedAt: new Date(NOW.getTime() - 5 * 3_600_000) }),
    ];
    const ranking = (await exec('compare_account_usage', {})).result.data.ranking;
    expect(ranking[0]).toMatchObject({ id: A, comparable: true });
    expect(ranking.slice(1).every((r: any) => r.comparable === false)).toBe(true);
    expect(ranking.find((r: any) => r.id === C).quotaFreshness).toBe('stale');
    expect(ranking.find((r: any) => r.id === B).quotaFreshness).toBe('unknown');
  });

  it('flags accounts needing attention with an actionable, honest recommendation', async () => {
    h.views = [
      view(A),
      view(B, { status: 'unauthorized', lastError: 'refresh failed' }),
      view(C, { provider: 'terabox_open', quotaPolicy: 'required', lastSyncedAt: null, health: { state: 'unreachable', latencyMs: null, checkedAt: new Date() } }),
    ];
    const data = (await exec('find_accounts_needing_attention', {})).result.data;
    expect(data.checked).toBe(3);
    expect(data.issues.map((i: any) => i.accountId).sort()).toEqual([B, C].sort());
    const b = data.issues.find((i: any) => i.accountId === B);
    expect(b.problems).toContain('credentials expired or revoked');
    expect(b.recommendation).toContain('assistant cannot do this');
    const c = data.issues.find((i: any) => i.accountId === C);
    expect(c.problems.join(' ')).toContain('skipped by automatic routing');
  });
});

describe('connectivity, quota, routing and disconnect', () => {
  it('tests connectivity only for owned accounts and scrubs provider messages', async () => {
    const ok = await exec('test_account_connectivity', { accountId: A });
    expect(ok.result.data.state).toBe('healthy');
    expect(JSON.stringify(ok.result.data)).not.toContain('abcdef123456');
    expect(await exec('test_account_connectivity', { accountId: C })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  it('refreshes quota and verifies that the stored sync time advanced', async () => {
    h.quotaAfter = { totalBytes: 100n, usedBytes: 1n, availableBytes: 99n, lastSyncedAt: NOW };
    const out = await exec('refresh_account_quota', { accountId: A });
    expect(h.quotaCalls).toEqual([A]);
    expect(out.result.verification).toContain('advanced');
    expect(await exec('refresh_account_quota', { accountId: C })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(h.quotaCalls).toEqual([A]);
  });

  it('sets the routing flag without clobbering other metadata, verifies, audits, and enforces ownership', async () => {
    const out = await exec('set_account_routing', { accountId: A, enabled: false });
    expect(out.ok).toBe(true);
    expect(h.accounts[0].metadata).toEqual({ clientHint: 'keep', routingEnabled: false });
    expect(out.result.verification).toContain('matches');
    expect(h.audit).toContain('AI_SET_ACCOUNT_ROUTING');
    expect(await exec('set_account_routing', { accountId: C, enabled: false })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(h.accounts[1].metadata).toBeNull();
  });

  it('disconnects only owned accounts and verifies the status', async () => {
    expect(await exec('disconnect_account', { accountId: C })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(h.accounts[1].status).toBe('connected');
    const out = await exec('disconnect_account', { accountId: A });
    expect(out.result.verification).toContain('disconnected');
    expect(h.audit).toContain('AI_DISCONNECT_ACCOUNT');
    const tool = tools.get('disconnect_account')!;
    const pv = await tool.preview!({ accountId: A }, { userId: 'user-1', taskId: 't', config, now: () => NOW });
    expect(pv.warnings.join(' ')).toContain('stop being downloadable');
  });
});
