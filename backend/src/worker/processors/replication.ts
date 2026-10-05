/**
 * REPLICATION job handler — api-contract §4.5, job-contract.md.
 *
 * Streams every object in the source scope to the target account without
 * buffering, recreating the folder structure. Per-file failures are recorded
 * on the ReplicationJob row instead of aborting the run.
 */

import { prisma } from '../../config/prisma.js'
import { buildContext } from '../../providers/context.js'
import { registry } from '../../providers/registry.js'
import { isCancelRequested } from '../../queues/cancel.js'
import type { JobPayloads } from '../../queues/job-types.js'
import type { JobHandler } from '../types.js'
import { assertTransferCapabilities, runTransfer, type TransferPlan } from './transfer-core.js'

function parseScope(scope: unknown): { folderIds?: string[]; fileIds?: string[] } {
  if (typeof scope !== 'object' || scope === null) return {}
  const record = scope as { folderIds?: unknown; fileIds?: unknown }
  const folderIds = Array.isArray(record.folderIds)
    ? record.folderIds.filter((value): value is string => typeof value === 'string')
    : undefined
  const fileIds = Array.isArray(record.fileIds)
    ? record.fileIds.filter((value): value is string => typeof value === 'string')
    : undefined
  return { ...(folderIds && folderIds.length > 0 ? { folderIds } : {}), ...(fileIds && fileIds.length > 0 ? { fileIds } : {}) }
}

async function loadPlan(replicationJobId: string): Promise<TransferPlan> {
  const job = await prisma.replicationJob.findUniqueOrThrow({ where: { id: replicationJobId } })
  const source = registry.get(await resolveProvider(job.sourceAccountId))
  const target = registry.get(await resolveProvider(job.targetAccountId))
  const [sourceContext, targetContext] = await Promise.all([
    buildContext(job.sourceAccountId),
    buildContext(job.targetAccountId),
  ])
  const plan: TransferPlan = {
    source: { provider: source, context: sourceContext, rootRemoteId: null },
    target: { provider: target, context: targetContext, rootRemoteId: null },
    skipRemoteIds: new Set(),
    deleteSourceAfterCopy: false,
  }
  assertTransferCapabilities(plan)
  return plan
}

async function resolveProvider(accountId: string): Promise<string> {
  const account = await prisma.connectedAccount.findUniqueOrThrow({
    where: { id: accountId },
    select: { provider: true },
  })
  return account.provider
}

export const replicationHandler: JobHandler<JobPayloads['REPLICATION']> = async (ctx) => {
  const { replicationJobId } = ctx.payload
  const row = await prisma.replicationJob.findUnique({ where: { id: replicationJobId } })
  if (!row) throw new Error(`ReplicationJob '${replicationJobId}' not found`)
  if (await isCancelRequested(ctx.payload.jobId)) return { cancelled: true }

  const plan = await loadPlan(replicationJobId)
  const scope = parseScope(row.scope)

  await prisma.replicationJob.update({
    where: { id: replicationJobId },
    data: { status: 'running', startedAt: new Date() },
  })

  const result = await runTransfer(plan, scope.folderIds, ctx, (progress) => {
    const pct = progress.filesTotal > 0 ? Math.round((progress.filesDone / progress.filesTotal) * 100) : 0
    ctx.reportProgress(pct, {
      filesTotal: progress.filesTotal,
      filesDone: progress.filesDone,
      filesFailed: progress.filesFailed,
    })
  })

  await prisma.replicationJob.update({
    where: { id: replicationJobId },
    data: {
      status: result.filesFailed > 0 && result.filesDone === 0 ? 'failed' : 'completed',
      filesTotal: result.filesTotal,
      filesCopied: result.filesDone,
      filesFailed: result.filesFailed,
      bytesCopied: result.bytes,
      ...(result.filesFailed > 0 && result.filesDone === 0 ? { error: result.failures[0]?.message ?? 'replication failed' } : {}),
      finishedAt: new Date(),
    },
  })

  return {
    filesTotal: result.filesTotal,
    filesCopied: result.filesDone,
    filesFailed: result.filesFailed,
    bytesCopied: result.bytes.toString(),
  }
}
