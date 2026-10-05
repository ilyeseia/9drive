/**
 * MIGRATION job handler — api-contract §4.6, job-contract.md.
 *
 * `mode: 'copy'` leaves the source untouched. `mode: 'move'` deletes each
 * source object only after its target copy has been verified, so an interrupted
 * migration never loses data.
 */

import { prisma } from '../../config/prisma.js'
import { buildContext } from '../../providers/context.js'
import { registry } from '../../providers/registry.js'
import { isCancelRequested } from '../../queues/cancel.js'
import type { JobPayloads } from '../../queues/job-types.js'
import type { JobHandler } from '../types.js'
import { assertTransferCapabilities, runTransfer, type TransferPlan } from './transfer-core.js'

async function resolveProvider(accountId: string): Promise<string> {
  const account = await prisma.connectedAccount.findUniqueOrThrow({
    where: { id: accountId },
    select: { provider: true },
  })
  return account.provider
}

async function loadPlan(migrationJobId: string, mode: 'copy' | 'move', scope?: { folderIds?: string[]; fileIds?: string[] }): Promise<TransferPlan> {
  const job = await prisma.migrationJob.findUniqueOrThrow({ where: { id: migrationJobId } })
  const [sourceProvider, targetProvider] = await Promise.all([
    resolveProvider(job.sourceAccountId),
    resolveProvider(job.targetAccountId),
  ])
  const [sourceContext, targetContext] = await Promise.all([
    buildContext(job.sourceAccountId),
    buildContext(job.targetAccountId),
  ])
  const plan: TransferPlan = {
    source: { provider: registry.get(sourceProvider), context: sourceContext, rootRemoteId: null },
    target: { provider: registry.get(targetProvider), context: targetContext, rootRemoteId: null },
    skipRemoteIds: new Set(),
    deleteSourceAfterCopy: mode === 'move',
  }
  assertTransferCapabilities(plan)
  return plan
}

export const migrationHandler: JobHandler<JobPayloads['MIGRATION']> = async (ctx) => {
  const { migrationJobId } = ctx.payload
  const row = await prisma.migrationJob.findUnique({ where: { id: migrationJobId } })
  if (!row) throw new Error(`MigrationJob '${migrationJobId}' not found`)
  if (await isCancelRequested(ctx.payload.jobId)) return { cancelled: true }

  const plan = await loadPlan(migrationJobId, row.mode as 'copy' | 'move', ctx.payload.scope)

  await prisma.migrationJob.update({
    where: { id: migrationJobId },
    data: { status: 'running', startedAt: new Date() },
  })

  const result = await runTransfer(plan, undefined, ctx, (progress) => {
    const pct = progress.filesTotal > 0 ? Math.round((progress.filesDone / progress.filesTotal) * 100) : 0
    ctx.reportProgress(pct, {
      filesTotal: progress.filesTotal,
      filesDone: progress.filesDone,
      filesFailed: progress.filesFailed,
    })
  })

  await prisma.migrationJob.update({
    where: { id: migrationJobId },
    data: {
      status: result.filesFailed > 0 && result.filesDone === 0 ? 'failed' : 'completed',
      filesTotal: result.filesTotal,
      filesDone: result.filesDone,
      filesFailed: result.filesFailed,
      bytesMoved: result.bytes,
      ...(result.filesFailed > 0 && result.filesDone === 0 ? { error: result.failures[0]?.message ?? 'migration failed' } : {}),
      finishedAt: new Date(),
    },
  })

  return {
    filesTotal: result.filesTotal,
    filesDone: result.filesDone,
    filesFailed: result.filesFailed,
    bytesMoved: result.bytes.toString(),
  }
}
