/** Read-only reports and job tools. Output is aggregate/identifier data only. */

import { z } from 'zod';
import { prisma } from '../../../config/prisma.js';
import { listProviderAccountViews } from '../../providers/account-service.js';
import { sanitizeErrorMessage, sanitizeSecrets } from '../../jobs/shared.js';
import { cleanText } from '../sanitize.js';
import { big, uuid } from './common.js';
import { defineTool, ToolError, type AnyTool } from './types.js';

const storageUsageReport = defineTool({
  name: 'storage_usage_report',
  domain: 'reports',
  description: 'Report of stored data per account and provider (file counts, bytes, trashed bytes) alongside quota, plus the largest file types.',
  input: z.object({}),
  output: z.object({ accounts: z.array(z.object({ accountId: z.string() }).passthrough()) }).passthrough(),
  risk: 'low',
  timeoutMs: 30_000,
  audit: false,
  async execute(_args, ctx) {
    const [views, active, trashed, byType] = await Promise.all([
      listProviderAccountViews(ctx.userId),
      prisma.file.groupBy({ by: ['connectedAccountId'], where: { userId: ctx.userId, status: 'active' }, _count: { _all: true }, _sum: { sizeBytes: true } }),
      prisma.file.groupBy({ by: ['connectedAccountId'], where: { userId: ctx.userId, status: 'deleted' }, _count: { _all: true }, _sum: { sizeBytes: true } }),
      prisma.file.groupBy({ by: ['mimeType'], where: { userId: ctx.userId, status: 'active' }, _count: { _all: true }, _sum: { sizeBytes: true }, orderBy: { _sum: { sizeBytes: 'desc' } }, take: 10 }),
    ]);
    const activeBy = new Map(active.map((row) => [row.connectedAccountId, row]));
    const trashedBy = new Map(trashed.map((row) => [row.connectedAccountId, row]));
    const accounts = views.map((view) => ({
      accountId: view.id,
      name: cleanText(view.displayName || view.email, 80),
      provider: view.provider,
      activeFiles: activeBy.get(view.id)?._count._all ?? 0,
      activeBytes: big(activeBy.get(view.id)?._sum.sizeBytes ?? 0n),
      trashedFiles: trashedBy.get(view.id)?._count._all ?? 0,
      trashedBytes: big(trashedBy.get(view.id)?._sum.sizeBytes ?? 0n),
      providerReportedUsedBytes: big(view.quota?.usedBytes),
      providerReportedTotalBytes: big(view.quota?.totalBytes),
    }));
    const byProvider = new Map<string, { files: number; bytes: bigint }>();
    for (const account of accounts) {
      const entry = byProvider.get(account.provider) ?? { files: 0, bytes: 0n };
      entry.files += account.activeFiles;
      entry.bytes += BigInt(account.activeBytes ?? '0');
      byProvider.set(account.provider, entry);
    }
    const totalBytes = accounts.reduce((sum, a) => sum + BigInt(a.activeBytes ?? '0'), 0n);
    return {
      data: {
        accounts,
        byProvider: [...byProvider.entries()].map(([provider, v]) => ({ provider, files: v.files, bytes: v.bytes.toString() })),
        totals: { activeFiles: accounts.reduce((s, a) => s + a.activeFiles, 0), activeBytes: totalBytes.toString() },
        largestTypes: byType.map((t) => ({ mimeType: cleanText(t.mimeType, 80), files: t._count._all, bytes: big(t._sum.sizeBytes) })),
        note: '"active" figures count 9Drive file records; "providerReported" figures come from each provider and may include data 9Drive does not manage.',
      },
      summary: `Usage report for ${accounts.length} account(s).`,
    };
  },
});

const activityReport = defineTool({
  name: 'activity_report',
  domain: 'reports',
  description: 'Upload and operation activity over a time window: operations by type/status, upload sessions, jobs, bytes uploaded and failure counts.',
  input: z.object({ days: z.number().int().min(1).max(90).default(7) }),
  output: z.object({ windowDays: z.number() }).passthrough(),
  risk: 'low',
  timeoutMs: 30_000,
  audit: false,
  async execute(args, ctx) {
    const since = new Date(ctx.now().getTime() - args.days * 86_400_000);
    const [ops, sessions, jobs, uploaded, audits] = await Promise.all([
      prisma.storageOperation.groupBy({ by: ['operation', 'status'], where: { userId: ctx.userId, createdAt: { gte: since } }, _count: { _all: true } }),
      prisma.uploadSession.groupBy({ by: ['status'], where: { userId: ctx.userId, createdAt: { gte: since } }, _count: { _all: true } }),
      prisma.job.groupBy({ by: ['type', 'status'], where: { userId: ctx.userId, createdAt: { gte: since } }, _count: { _all: true } }),
      prisma.storageOperation.aggregate({ where: { userId: ctx.userId, operation: 'upload', status: 'succeeded', createdAt: { gte: since } }, _sum: { bytes: true }, _count: { _all: true } }),
      prisma.auditLog.groupBy({ by: ['action'], where: { userId: ctx.userId, createdAt: { gte: since } }, _count: { _all: true }, orderBy: { _count: { action: 'desc' } }, take: 15 }),
    ]);
    const failed = ops.filter((o) => o.status === 'failed' || o.status === 'error').reduce((sum, o) => sum + o._count._all, 0);
    return {
      data: {
        windowDays: args.days,
        operations: ops.map((o) => ({ operation: o.operation, status: o.status, count: o._count._all })),
        uploadSessions: sessions.map((s) => ({ status: s.status, count: s._count._all })),
        jobs: jobs.map((j) => ({ type: j.type, status: j.status, count: j._count._all })),
        uploads: { succeeded: uploaded._count._all, bytes: big(uploaded._sum.bytes ?? 0n) },
        failedOperations: failed,
        topAuditActions: audits.map((a) => ({ action: cleanText(a.action, 60), count: a._count._all })),
      },
      summary: `Activity over the last ${args.days} day(s): ${uploaded._count._all} successful upload(s), ${failed} failed operation(s).`,
    };
  },
});

const providerHealthSummary = defineTool({
  name: 'provider_health_summary',
  domain: 'reports',
  description: 'Summarise health by provider and list accounts that are not healthy, with their last recorded message.',
  input: z.object({}),
  output: z.object({ providers: z.array(z.object({ provider: z.string() }).passthrough()) }).passthrough(),
  risk: 'low',
  timeoutMs: 15_000,
  audit: false,
  async execute(_args, ctx) {
    const views = await listProviderAccountViews(ctx.userId);
    const providers = new Map<string, Record<string, number>>();
    for (const view of views) {
      const state = view.status === 'connected' ? view.health?.state ?? 'unknown' : view.status;
      const bucket = providers.get(view.provider) ?? {};
      bucket[state] = (bucket[state] ?? 0) + 1;
      providers.set(view.provider, bucket);
    }
    const unhealthy = views
      .filter((v) => v.status !== 'connected' || (v.health && v.health.state !== 'healthy'))
      .map((v) => ({ accountId: v.id, provider: v.provider, status: v.status, health: v.health?.state ?? 'unknown', lastError: sanitizeErrorMessage(v.lastError) }));
    return {
      data: { providers: [...providers.entries()].map(([provider, states]) => ({ provider, states })), unhealthy },
      summary: `${unhealthy.length} of ${views.length} account(s) are not healthy.`,
    };
  },
});

const listJobs = defineTool({
  name: 'list_jobs',
  domain: 'system',
  description: 'List the user\'s background jobs (migrations, replication, sync…) with status and progress, newest first.',
  input: z.object({ status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']).optional(), type: z.string().max(64).optional(), limit: z.number().int().min(1).max(100).optional() }),
  output: z.object({ jobs: z.array(z.object({ id: z.string() }).passthrough()) }).passthrough(),
  risk: 'low',
  timeoutMs: 10_000,
  audit: false,
  async execute(args, ctx) {
    const limit = Math.min(args.limit ?? 20, ctx.config.maxResults);
    const jobs = await prisma.job.findMany({ where: { userId: ctx.userId, ...(args.status ? { status: args.status } : {}), ...(args.type ? { type: args.type } : {}) }, orderBy: { createdAt: 'desc' }, take: limit });
    return {
      data: { jobs: jobs.map((job) => ({ id: job.id, type: job.type, status: job.status, progress: job.progress, attempts: job.attempts, provider: job.provider, error: sanitizeErrorMessage(job.error), createdAt: job.createdAt.toISOString(), finishedAt: job.finishedAt?.toISOString() ?? null })) },
      summary: `Listed ${jobs.length} job(s).`,
    };
  },
});

const getJobStatus = defineTool({
  name: 'get_job_status',
  domain: 'system',
  description: 'Real status of one background job (by job id or migration job id), including migration file counts when applicable. Use it to report progress honestly.',
  input: z.object({ jobId: uuid }),
  output: z.object({ job: z.object({ id: z.string() }).passthrough() }).passthrough(),
  risk: 'low',
  timeoutMs: 10_000,
  audit: false,
  async execute(args, ctx) {
    const job =
      (await prisma.job.findFirst({ where: { id: args.jobId, userId: ctx.userId } })) ??
      (await prisma.job.findFirst({ where: { relatedId: args.jobId, userId: ctx.userId }, orderBy: { createdAt: 'desc' } }));
    const migration = await prisma.migrationJob.findFirst({ where: { id: job?.relatedId ?? args.jobId, userId: ctx.userId } });
    if (!job && !migration) throw new ToolError('NOT_FOUND', 'The job was not found.');
    return {
      data: {
        job: {
          id: job?.id ?? migration!.id,
          type: job?.type ?? 'MIGRATION',
          status: job?.status ?? migration!.status,
          progress: job?.progress ?? null,
          attempts: job?.attempts ?? null,
          error: sanitizeErrorMessage(job?.error ?? migration?.error ?? null),
          startedAt: (job?.startedAt ?? migration?.startedAt)?.toISOString() ?? null,
          finishedAt: (job?.finishedAt ?? migration?.finishedAt)?.toISOString() ?? null,
        },
        migration: migration
          ? { mode: migration.mode, status: migration.status, filesTotal: migration.filesTotal, filesDone: migration.filesDone, filesFailed: migration.filesFailed, bytesMoved: migration.bytesMoved.toString() }
          : null,
        result: job?.result ? sanitizeSecrets(job.result) : null,
      },
      summary: `Job status: ${job?.status ?? migration?.status}.`,
    };
  },
});

export const reportTools: AnyTool[] = [storageUsageReport, activityReport, providerHealthSummary, listJobs, getJobStatus];
