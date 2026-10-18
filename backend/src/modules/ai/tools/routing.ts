/** Routing tools. The routing engine is NOT reimplemented: these call the existing services. */

import { z } from 'zod';
import { prisma } from '../../../config/prisma.js';
import { ROUTING_MODES } from '../../../providers/routing.js';
import { getOrCreateRoutingPolicy, routingPolicyUpdateSchema, serializeRoutingPolicy, updateRoutingPolicy } from '../../routing/routing.service.js';
import { previewRouting } from '../../routing/routing.explain.js';
import { sanitizeErrorMessage } from '../../jobs/shared.js';
import { listProviderAccountViews } from '../../providers/account-service.js';
import { cleanText } from '../sanitize.js';
import { uuid } from './common.js';
import { defineTool, ToolError, type AnyTool } from './types.js';

const MODE_HELP: Record<string, string> = {
  most_available: 'Pick the eligible account with the most free space.',
  least_used: 'Pick the eligible account with the least used space.',
  round_robin: 'Rotate through eligible accounts.',
  priority: 'Use the configured account order.',
  provider_preference: 'Prefer certain providers, then most free space.',
  file_size: 'Choose by file-size window, best fit first.',
  file_type: 'Prefer providers by file-type rules.',
  health_aware: 'Prefer the healthiest accounts.',
  user_policy: 'Account priority, then provider preference, then free space.',
};

const getRoutingPolicy = defineTool({
  name: 'get_routing_policy',
  domain: 'routing',
  description: 'Show the current upload-routing policy and explain the available routing modes.',
  input: z.object({}),
  output: z.object({ policy: z.object({ mode: z.string() }).passthrough() }).passthrough(),
  risk: 'low',
  timeoutMs: 10_000,
  audit: false,
  async execute(_args, ctx) {
    const policy = serializeRoutingPolicy(await getOrCreateRoutingPolicy(ctx.userId));
    return {
      data: { policy, modes: ROUTING_MODES.map((mode) => ({ mode, description: MODE_HELP[mode] ?? '' })) },
      summary: `Current routing mode: ${policy.mode}.`,
    };
  },
});

const explainRouting = defineTool({
  name: 'explain_routing',
  domain: 'routing',
  description:
    'Dry-run the real routing engine for a hypothetical upload (size, optional MIME type, folder, pinned account) and explain which account would be chosen and why, step by step. Nothing is uploaded or changed.',
  input: z.object({ sizeBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), fileType: z.string().trim().max(100).optional(), folderId: uuid.optional(), targetAccountId: uuid.optional() }),
  output: z.object({ preview: z.object({ reason: z.string() }).passthrough() }).passthrough(),
  risk: 'low',
  timeoutMs: 30_000,
  audit: false,
  async execute(args, ctx) {
    const preview = await previewRouting({ userId: ctx.userId, bytes: BigInt(args.sizeBytes), fileType: args.fileType, folderId: args.folderId, targetAccountId: args.targetAccountId });
    return {
      data: {
        preview: { ...preview, account: preview.account ? { ...preview.account, displayName: preview.account.displayName ? cleanText(preview.account.displayName, 100) : null } : null },
        note: 'Accounts whose quota is unknown or stale are excluded for providers that require a trustworthy quota. This is a preview; the real upload re-evaluates at upload time.',
      },
      summary: preview.account ? `The upload would go to a ${preview.account.provider} account.` : 'No connected account can accept this upload.',
    };
  },
});

const updateRoutingPolicyTool = defineTool({
  name: 'update_routing_policy',
  domain: 'routing',
  description: 'Change the upload-routing policy (mode, priority account order, file-type rules, size window). Affects all future uploads. Requires confirmation.',
  input: routingPolicyUpdateSchema,
  output: z.object({ policy: z.object({ mode: z.string() }).passthrough() }).passthrough(),
  risk: 'medium',
  timeoutMs: 15_000,
  audit: true,
  async preview(args, ctx) {
    const current = serializeRoutingPolicy(await getOrCreateRoutingPolicy(ctx.userId));
    const changes: string[] = [];
    if (args.mode !== undefined && args.mode !== current.mode) changes.push(`mode ${current.mode} → ${args.mode}`);
    if (args.priorityAccountIds !== undefined) changes.push(`priority order of ${args.priorityAccountIds.length} account(s)`);
    if (args.fileTypeRules !== undefined) changes.push('file-type rules');
    if (args.minFileSizeBytes !== undefined || args.maxFileSizeBytes !== undefined) changes.push('file-size window');
    if (changes.length === 0) throw new ToolError('INVALID_ARGUMENTS', 'The requested policy equals the current one.');
    return { summary: `Change the upload-routing policy: ${changes.join(', ')}`, affectedCount: changes.length, sample: changes, warnings: ['All future uploads will use the new policy.'] };
  },
  async execute(args, ctx) {
    const policy = serializeRoutingPolicy(await updateRoutingPolicy(ctx.userId, args));
    const after = serializeRoutingPolicy(await getOrCreateRoutingPolicy(ctx.userId));
    const modeOk = args.mode === undefined || after.mode === args.mode;
    return {
      data: { policy },
      summary: `Routing policy updated (mode: ${policy.mode}).`,
      verification: modeOk ? 'Re-read the policy: the requested mode is stored.' : 'The stored mode did not match after the update.',
    };
  },
});

const HINTS: Array<[RegExp, string]> = [
  [/spool size limit/i, 'The upload exceeded the server\'s staging limit; use a smaller file or ask the administrator to raise UPLOAD_SPOOL_MAX_BYTES.'],
  [/did not match declared size/i, 'The client sent a different number of bytes than declared (interrupted transfer); retry the upload.'],
  [/quota|space|storage_quota/i, 'The destination ran out of space; check account quotas or add storage.'],
  [/auth|token|unauthor|expired|revoked/i, 'The account credentials may have expired; reauthorize it on the Providers page.'],
  [/timeout|timed out|unreachable|unavailable/i, 'The provider was slow or unreachable; retry later and run a connectivity test.'],
];

const diagnoseUploads = defineTool({
  name: 'diagnose_uploads',
  domain: 'routing',
  description: 'Summarise recent failed uploads and stuck upload sessions, group failures by provider and error, and give likely causes. Use it to explain why an upload failed.',
  input: z.object({ days: z.number().int().min(1).max(30).default(7) }),
  output: z.object({ failedSessions: z.array(z.object({ id: z.string() }).passthrough()) }).passthrough(),
  risk: 'low',
  timeoutMs: 20_000,
  audit: false,
  async execute(args, ctx) {
    const since = new Date(ctx.now().getTime() - args.days * 86_400_000);
    const staleBefore = new Date(ctx.now().getTime() - 3_600_000);
    const [sessions, stuck, ops, views] = await Promise.all([
      prisma.uploadSession.findMany({ where: { userId: ctx.userId, status: 'failed', createdAt: { gte: since } }, orderBy: { createdAt: 'desc' }, take: 20 }),
      prisma.uploadSession.count({ where: { userId: ctx.userId, status: 'uploading', createdAt: { lt: staleBefore } } }),
      prisma.storageOperation.groupBy({ by: ['provider', 'errorCode'], where: { userId: ctx.userId, operation: 'upload', status: { in: ['failed', 'error'] }, createdAt: { gte: since } }, _count: { _all: true } }),
      listProviderAccountViews(ctx.userId),
    ]);
    const failedSessions = sessions.map((s) => {
      const message = sanitizeErrorMessage(s.errorMessage) ?? 'No error message was recorded.';
      return {
        id: s.id,
        fileName: cleanText(s.fileName, 120),
        sizeBytes: s.sizeBytes.toString(),
        accountId: s.targetConnectedAccountId,
        createdAt: s.createdAt.toISOString(),
        message,
        likelyCause: HINTS.find(([pattern]) => pattern.test(message))?.[1] ?? 'No known pattern; check the account health and retry.',
      };
    });
    const accountProblems = views.filter((v) => v.status !== 'connected' || v.health?.state === 'unreachable' || v.health?.state === 'unauthorized').map((v) => ({ accountId: v.id, provider: v.provider, status: v.status, health: v.health?.state ?? 'unknown' }));
    return {
      data: {
        windowDays: args.days,
        failedSessions,
        stuckSessions: stuck,
        failuresByProvider: ops.map((o) => ({ provider: o.provider, errorCode: o.errorCode, count: o._count._all })),
        accountProblems,
      },
      summary: `${failedSessions.length} failed upload session(s) and ${stuck} stuck session(s) in the last ${args.days} day(s).`,
    };
  },
});

export const routingTools: AnyTool[] = [getRoutingPolicy, explainRouting, updateRoutingPolicyTool, diagnoseUploads];
