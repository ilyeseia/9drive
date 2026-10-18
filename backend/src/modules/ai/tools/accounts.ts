/** Storage-account tools. Credentials never appear in any output (views carry no token fields). */

import { z } from 'zod';
import { prisma } from '../../../config/prisma.js';
import { catalog } from '../../../providers/catalog.js';
import { checkAccount, refreshQuota } from '../../../providers/health.js';
import { QUOTA_MAX_AGE_MS } from '../../../providers/routing.js';
import { sanitizeErrorMessage } from '../../jobs/shared.js';
import { disconnectOwnedAccount, findOwnedAccount, listProviderAccountViews, type ProviderAccountView } from '../../providers/account-service.js';
import { createAuditLog } from '../../../utils/audit.js';
import { cleanText } from '../sanitize.js';
import { big, uuid } from './common.js';
import { defineTool, ToolError, type AnyTool } from './types.js';

type Freshness = 'fresh' | 'stale' | 'unknown';

function freshness(view: ProviderAccountView, now: Date): Freshness {
  if (!view.quota || !view.lastSyncedAt) return 'unknown';
  return now.getTime() - view.lastSyncedAt.getTime() > QUOTA_MAX_AGE_MS ? 'stale' : 'fresh';
}

function accountSummary(view: ProviderAccountView, now: Date) {
  const trust = freshness(view, now);
  return {
    id: view.id,
    provider: view.provider,
    name: cleanText(view.displayName || view.email, 120),
    status: view.status,
    health: view.health?.state ?? 'unknown',
    routingEnabled: view.routingEnabled ?? !view.experimental,
    experimental: view.experimental,
    quota: view.quota
      ? {
          totalBytes: big(view.quota.totalBytes),
          usedBytes: big(view.quota.usedBytes),
          availableBytes: big(view.quota.availableBytes),
          unlimitedOrUnreported: view.quota.totalBytes === null,
          freshness: trust,
          lastSyncedAt: view.lastSyncedAt ? view.lastSyncedAt.toISOString() : null,
        }
      : null,
    lastError: view.status === 'connected' ? null : sanitizeErrorMessage(view.lastError),
  };
}

const accountOutput = z.object({ accounts: z.array(z.object({ id: z.string() }).passthrough()) }).passthrough();

const listStorageAccounts = defineTool({
  name: 'list_storage_accounts',
  domain: 'accounts',
  description: 'List the user\'s connected storage accounts with provider, status, health, routing eligibility and quota (with freshness). Never includes credentials.',
  input: z.object({}),
  output: accountOutput,
  risk: 'low',
  timeoutMs: 15_000,
  audit: false,
  async execute(_args, ctx) {
    const views = await listProviderAccountViews(ctx.userId);
    const accounts = views.map((view) => accountSummary(view, ctx.now()));
    return { data: { accounts, count: accounts.length }, summary: `Retrieved ${accounts.length} connected storage account(s).` };
  },
});

const getAccountDetails = defineTool({
  name: 'get_account_details',
  domain: 'accounts',
  description: 'Details for one storage account: capabilities, quota freshness, health, last error and recent failed operations.',
  input: z.object({ accountId: uuid }),
  output: z.object({ account: z.object({ id: z.string() }).passthrough() }).passthrough(),
  risk: 'low',
  timeoutMs: 15_000,
  audit: false,
  async execute(args, ctx) {
    const owned = await findOwnedAccount(ctx.userId, args.accountId);
    if (!owned) throw new ToolError('NOT_FOUND', 'The storage account was not found.');
    const views = await listProviderAccountViews(ctx.userId);
    const view = views.find((v) => v.id === owned.id);
    if (!view) throw new ToolError('NOT_FOUND', 'The storage account was not found.');
    const since = new Date(ctx.now().getTime() - 7 * 86_400_000);
    const failures = await prisma.storageOperation.count({ where: { userId: ctx.userId, accountId: owned.id, status: { in: ['failed', 'error'] }, createdAt: { gte: since } } });
    const entry = catalog.get(view.provider);
    return {
      data: {
        account: { ...accountSummary(view, ctx.now()), capabilities: view.capabilities, authMode: view.authMode },
        providerNotes: entry?.notes ? cleanText(entry.notes, 400) : null,
        failedOperationsLast7Days: failures,
      },
      summary: `Retrieved details for account ${cleanText(view.displayName || view.email, 60)}.`,
    };
  },
});

const compareAccountUsage = defineTool({
  name: 'compare_account_usage',
  domain: 'accounts',
  description: 'Compare storage usage and free space across accounts, sorted by free space. Accounts with unknown or stale quota are flagged and are NOT assumed to have free space.',
  input: z.object({}),
  output: z.object({ ranking: z.array(z.object({ id: z.string() }).passthrough()) }).passthrough(),
  risk: 'low',
  timeoutMs: 15_000,
  audit: false,
  async execute(_args, ctx) {
    const views = await listProviderAccountViews(ctx.userId);
    const rows = views.map((view) => {
      const used = view.quota?.usedBytes ?? 0n;
      const total = view.quota?.totalBytes ?? null;
      const trust = freshness(view, ctx.now());
      return {
        id: view.id,
        name: cleanText(view.displayName || view.email, 80),
        provider: view.provider,
        status: view.status,
        usedBytes: used.toString(),
        totalBytes: big(total),
        availableBytes: big(view.quota?.availableBytes),
        usedPercent: total && total > 0n ? Math.round((Number(used) / Number(total)) * 1000) / 10 : null,
        quotaFreshness: trust,
        comparable: trust === 'fresh' && view.quota?.availableBytes !== null && view.quota?.availableBytes !== undefined,
      };
    });
    rows.sort((a, b) => {
      if (a.comparable !== b.comparable) return a.comparable ? -1 : 1;
      return Number(BigInt(b.availableBytes ?? '0') - BigInt(a.availableBytes ?? '0'));
    });
    return {
      data: { ranking: rows, note: 'Only rows with comparable=true can be ranked by free space; others have unknown, stale or unreported capacity.' },
      summary: `Compared ${rows.length} account(s); ${rows.filter((r) => r.comparable).length} have a fresh, known quota.`,
    };
  },
});

const findAccountsNeedingAttention = defineTool({
  name: 'find_accounts_needing_attention',
  domain: 'accounts',
  description: 'Identify accounts that need reauthorization or have unhealthy, stale-quota or error states, with a recommended fix for each.',
  input: z.object({}),
  output: z.object({ issues: z.array(z.object({ accountId: z.string() }).passthrough()) }).passthrough(),
  risk: 'low',
  timeoutMs: 15_000,
  audit: false,
  async execute(_args, ctx) {
    const views = await listProviderAccountViews(ctx.userId);
    const issues: Array<{ accountId: string; name: string; provider: string; problems: string[]; recommendation: string }> = [];
    for (const view of views) {
      const problems: string[] = [];
      let recommendation = '';
      if (view.status === 'unauthorized') {
        problems.push('credentials expired or revoked');
        recommendation = 'Reauthorize on the Providers page (the assistant cannot do this: it needs your browser).';
      }
      const health = view.health?.state;
      if (health === 'unreachable' || health === 'degraded') {
        problems.push(`provider health is ${health}`);
        recommendation ||= 'Run a connectivity test; if it keeps failing, check the provider status and credentials.';
      }
      const trust = freshness(view, ctx.now());
      if (trust !== 'fresh' && view.quotaPolicy === 'required') {
        problems.push(`quota is ${trust}; this account is skipped by automatic routing`);
        recommendation ||= 'Refresh the account quota.';
      }
      if (view.status === 'connected' && view.routingEnabled === false) problems.push('excluded from automatic routing by you');
      if (problems.length > 0) {
        issues.push({ accountId: view.id, name: cleanText(view.displayName || view.email, 80), provider: view.provider, problems, recommendation });
      }
    }
    return {
      data: { issues, checked: views.length },
      summary: issues.length === 0 ? `Checked ${views.length} account(s); none need attention.` : `${issues.length} of ${views.length} account(s) need attention.`,
    };
  },
});

const testAccountConnectivity = defineTool({
  name: 'test_account_connectivity',
  domain: 'accounts',
  description: 'Run a live connectivity/health check against one account\'s provider and record the result.',
  input: z.object({ accountId: uuid }),
  output: z.object({ state: z.string() }).passthrough(),
  risk: 'low',
  timeoutMs: 45_000,
  audit: false,
  async execute(args, ctx) {
    const owned = await findOwnedAccount(ctx.userId, args.accountId);
    if (!owned) throw new ToolError('NOT_FOUND', 'The storage account was not found.');
    const health = await checkAccount(owned.id);
    return {
      data: { accountId: owned.id, state: health.state, latencyMs: health.latencyMs, message: sanitizeErrorMessage(health.message ?? null), checkedAt: health.checkedAt },
      summary: `Connectivity check finished: ${health.state}.`,
    };
  },
});

const refreshAccountQuota = defineTool({
  name: 'refresh_account_quota',
  domain: 'accounts',
  description: 'Re-read an account\'s quota from its provider and report the new reading.',
  input: z.object({ accountId: uuid }),
  output: z.object({ accountId: z.string() }).passthrough(),
  risk: 'low',
  timeoutMs: 45_000,
  audit: false,
  async execute(args, ctx) {
    const owned = await findOwnedAccount(ctx.userId, args.accountId);
    if (!owned) throw new ToolError('NOT_FOUND', 'The storage account was not found.');
    const before = await prisma.storageAccount.findUnique({ where: { connectedAccountId: owned.id } });
    await refreshQuota(owned.id);
    const after = await prisma.storageAccount.findUnique({ where: { connectedAccountId: owned.id } });
    const advanced = Boolean(after?.lastSyncedAt && (!before?.lastSyncedAt || after.lastSyncedAt > before.lastSyncedAt));
    return {
      data: { accountId: owned.id, totalBytes: big(after?.totalBytes), usedBytes: big(after?.usedBytes), availableBytes: big(after?.availableBytes), lastSyncedAt: after?.lastSyncedAt?.toISOString() ?? null },
      summary: 'Quota refreshed.',
      verification: advanced ? 'Re-read the stored quota: its sync time advanced.' : 'Could not confirm that the stored quota changed.',
    };
  },
});

const setAccountRouting = defineTool({
  name: 'set_account_routing',
  domain: 'accounts',
  description: 'Include or exclude one account from automatic upload routing.',
  input: z.object({ accountId: uuid, enabled: z.boolean() }),
  output: z.object({ accountId: z.string(), routingEnabled: z.boolean() }).passthrough(),
  risk: 'medium',
  timeoutMs: 10_000,
  audit: true,
  async preview(args, ctx) {
    const owned = await findOwnedAccount(ctx.userId, args.accountId);
    if (!owned) throw new ToolError('NOT_FOUND', 'The storage account was not found.');
    return {
      summary: `${args.enabled ? 'Include' : 'Exclude'} the ${owned.provider} account in automatic upload routing`,
      affectedCount: 1,
      sample: [owned.id],
      warnings: args.enabled ? [] : ['New uploads will no longer be routed to this account automatically.'],
    };
  },
  async execute(args, ctx) {
    const owned = await findOwnedAccount(ctx.userId, args.accountId);
    if (!owned) throw new ToolError('NOT_FOUND', 'The storage account was not found.');
    const row = await prisma.connectedAccount.findFirst({ where: { id: owned.id, userId: ctx.userId }, select: { metadata: true } });
    const existing = row?.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata : {};
    await prisma.connectedAccount.update({ where: { id: owned.id }, data: { metadata: { ...existing, routingEnabled: args.enabled } } });
    const after = await prisma.connectedAccount.findFirst({ where: { id: owned.id, userId: ctx.userId }, select: { metadata: true } });
    const stored = (after?.metadata as Record<string, unknown> | null)?.routingEnabled;
    await createAuditLog(ctx.userId, 'AI_SET_ACCOUNT_ROUTING', 'connected_account', owned.id, { enabled: args.enabled });
    return {
      data: { accountId: owned.id, routingEnabled: args.enabled },
      summary: `Automatic routing ${args.enabled ? 'enabled' : 'disabled'} for the account.`,
      verification: stored === args.enabled ? 'Re-read the account: the routing flag matches.' : 'The stored routing flag did not match after the update.',
    };
  },
});

const disconnectAccount = defineTool({
  name: 'disconnect_account',
  domain: 'accounts',
  description: 'Disconnect a storage account from 9Drive. Its files stay in the provider but 9Drive stops managing them until it is reconnected.',
  input: z.object({ accountId: uuid }),
  output: z.object({ accountId: z.string(), status: z.string() }).passthrough(),
  risk: 'high',
  timeoutMs: 15_000,
  audit: true,
  async preview(args, ctx) {
    const owned = await findOwnedAccount(ctx.userId, args.accountId);
    if (!owned) throw new ToolError('NOT_FOUND', 'The storage account was not found.');
    const files = await prisma.file.count({ where: { userId: ctx.userId, connectedAccountId: owned.id, status: 'active' } });
    return {
      summary: `Disconnect the ${owned.provider} account (${files} file record(s) depend on it)`,
      affectedCount: files,
      sample: [owned.id],
      warnings: ['Files recorded on this account stop being downloadable or manageable until it is reconnected.', 'Stored credentials for some providers are erased.'],
    };
  },
  async execute(args, ctx) {
    const removed = await disconnectOwnedAccount(ctx.userId, args.accountId);
    if (!removed) throw new ToolError('NOT_FOUND', 'The storage account was not found.');
    const after = await prisma.connectedAccount.findFirst({ where: { id: args.accountId, userId: ctx.userId }, select: { status: true } });
    await createAuditLog(ctx.userId, 'AI_DISCONNECT_ACCOUNT', 'connected_account', args.accountId);
    return {
      data: { accountId: args.accountId, status: after?.status ?? 'unknown' },
      summary: 'The account was disconnected.',
      verification: after?.status === 'disconnected' ? 'Re-read the account: status is disconnected.' : 'Could not confirm the disconnected status.',
    };
  },
});

export const accountTools: AnyTool[] = [
  listStorageAccounts,
  getAccountDetails,
  compareAccountUsage,
  findAccountsNeedingAttention,
  testAccountConnectivity,
  refreshAccountQuota,
  setAccountRouting,
  disconnectAccount,
];
