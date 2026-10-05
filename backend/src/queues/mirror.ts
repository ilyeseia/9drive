import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { UnrecoverableError, type Job as BullJob } from 'bullmq'
import { prisma } from '../config/prisma.js'
import { jsonSafe } from '../utils/serialize.js'
import { emitJobEvent } from './events.js'
import { SYSTEM_USER_ID, isJobType } from './job-types.js'
import { JOB_DEFINITIONS } from './queues.js'
import { logger } from './logger.js'

const inflight = new Set<Promise<void>>()

export function trackWrite(write: Promise<unknown>): Promise<void> {
  const settled = write.then(
    () => undefined,
    () => undefined,
  )
  inflight.add(settled)
  void settled.then(() => {
    inflight.delete(settled)
  })
  return settled
}

export async function flushWrites(): Promise<void> {
  while (inflight.size > 0) await Promise.all([...inflight])
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
}

function payloadUserId(data: unknown): string | null {
  const value = (data as { userId?: unknown } | null | undefined)?.userId
  return typeof value === 'string' && value.length > 0 ? value : null
}

function formatError(error: unknown): string {
  const err = error instanceof Error ? error : new Error(String(error))
  const message = `${err.name}: ${err.message}`
  return message.length > 8_000 ? `${message.slice(0, 8_000)}...` : message
}

function durationMs(job: BullJob): number | undefined {
  const finished = job.finishedOn ?? Date.now()
  const started = job.processedOn ?? job.timestamp
  if (!started) return undefined
  return Math.max(0, finished - started)
}

async function guard(step: string, write: () => Promise<void>): Promise<void> {
  try {
    await write()
  } catch (error) {
    logger.error('job mirror write failed', { step, error: (error as Error).message })
  }
}

export async function resolveRowId(job: BullJob): Promise<string | undefined> {
  const data = (job.data ?? {}) as Record<string, unknown>
  const payloadJobId = typeof data.jobId === 'string' && data.jobId.length > 0 ? data.jobId : undefined
  if (payloadJobId) {
    const existing = await prisma.job.findUnique({ where: { id: payloadJobId }, select: { id: true } })
    if (existing) return existing.id
  }
  if (!isJobType(job.name)) {
    logger.warn('no job mirror row for unknown job type', { type: job.name, bullJobId: String(job.id) })
    return payloadJobId
  }
  const definition = JOB_DEFINITIONS[job.name]
  const id = payloadJobId ?? randomUUID()
  const userId = payloadUserId(data)
  try {
    await prisma.job.create({
      data: {
        id,
        userId: userId === SYSTEM_USER_ID ? null : userId,
        type: job.name,
        status: 'active',
        priority: typeof job.opts?.priority === 'number' ? job.opts.priority : definition.priority,
        attempts: job.attemptsMade + 1,
        maxAttempts: typeof job.opts?.attempts === 'number' ? job.opts.attempts : definition.maxAttempts,
        progress: 0,
        payload: jsonSafe({ ...data, jobId: id }) as Prisma.InputJsonValue,
        bullJobId: String(job.id),
        startedAt: new Date(),
      },
    })
    return id
  } catch (error) {
    if (isUniqueViolation(error)) {
      const row = await prisma.job.findFirst({
        where: { OR: [{ id }, { bullJobId: String(job.id) }] },
        select: { id: true },
      })
      if (row) return row.id
    }
    throw error
  }
}

export function markActive(job: BullJob): Promise<void> {
  return trackWrite(guard('active', () => markActiveInner(job)))
}

async function markActiveInner(job: BullJob): Promise<void> {
  const rowId = await resolveRowId(job)
  if (!rowId) return
  const attempts = job.attemptsMade + 1
  await prisma.$transaction([
    prisma.job.updateMany({
      where: { id: rowId, startedAt: null },
      data: { status: 'active', attempts, startedAt: new Date() },
    }),
    prisma.job.updateMany({
      where: { id: rowId, status: { not: 'active' } },
      data: { status: 'active', attempts },
    }),
  ])
  const userId = payloadUserId(job.data)
  logger.info('job state', { jobId: rowId, type: job.name, userId, attempt: attempts, status: 'active' })
  emitJobEvent('job.started', { jobId: rowId, type: job.name, userId, attempts })
}

export function markCompleted(job: BullJob, result: unknown): Promise<void> {
  return trackWrite(guard('completed', () => markCompletedInner(job, result)))
}

async function markCompletedInner(job: BullJob, result: unknown): Promise<void> {
  const rowId = await resolveRowId(job)
  if (!rowId) return
  await prisma.job.updateMany({
    where: { id: rowId },
    data: {
      status: 'completed',
      attempts: job.attemptsMade,
      progress: 100,
      result: jsonSafe(result ?? null) as Prisma.InputJsonValue,
      error: null,
      finishedAt: new Date(),
    },
  })
  const userId = payloadUserId(job.data)
  const elapsed = durationMs(job)
  logger.info('job state', {
    jobId: rowId,
    type: job.name,
    userId,
    attempt: job.attemptsMade,
    ...(elapsed !== undefined ? { durationMs: elapsed } : {}),
    status: 'completed',
  })
  emitJobEvent('job.completed', { jobId: rowId, type: job.name, userId, attempts: job.attemptsMade })
}

export function markFailed(job: BullJob, error: Error): Promise<void> {
  return trackWrite(guard('failed', () => markFailedInner(job, error)))
}

async function markFailedInner(job: BullJob, error: Error): Promise<void> {
  const rowId = await resolveRowId(job)
  if (!rowId) return
  const definition = isJobType(job.name) ? JOB_DEFINITIONS[job.name] : undefined
  const maxAttempts = typeof job.opts?.attempts === 'number' ? job.opts.attempts : definition?.maxAttempts ?? 5
  const attempts = job.attemptsMade
  const cancelled = error.name === 'JobCancelledError'
  const unrecoverable = error instanceof UnrecoverableError || error.name === 'UnrecoverableError'
  const willRetry = !cancelled && !unrecoverable && attempts < maxAttempts
  const status = cancelled ? 'cancelled' : willRetry ? 'delayed' : 'failed'
  await prisma.job.updateMany({
    where: { id: rowId },
    data: {
      status,
      attempts,
      error: formatError(error),
      ...(willRetry ? {} : { finishedAt: new Date() }),
    },
  })
  const userId = payloadUserId(job.data)
  const elapsed = durationMs(job)
  logger.info('job state', {
    jobId: rowId,
    type: job.name,
    userId,
    attempt: attempts,
    ...(elapsed !== undefined ? { durationMs: elapsed } : {}),
    status,
    willRetry,
  })
  if (cancelled) {
    emitJobEvent('job.cancelled', { jobId: rowId, type: job.name, userId, attempts, error: formatError(error) })
  } else if (!willRetry) {
    emitJobEvent('job.failed', { jobId: rowId, type: job.name, userId, attempts, error: formatError(error) })
  }
}

export function markCancelled(rowId: string, reason: string): Promise<void> {
  return trackWrite(
    guard('cancelled', async () => {
      const row = await prisma.job.findUnique({
        where: { id: rowId },
        select: { id: true, type: true, userId: true, attempts: true },
      })
      if (!row) return
      await prisma.job.updateMany({
        where: { id: rowId, status: { in: ['queued', 'delayed', 'active'] } },
        data: { status: 'cancelled', error: reason, finishedAt: new Date() },
      })
      logger.info('job state', { jobId: rowId, type: row.type, userId: row.userId, attempt: row.attempts, status: 'cancelled' })
      emitJobEvent('job.cancelled', { jobId: rowId, type: row.type, userId: row.userId, attempts: row.attempts, error: reason })
    }),
  )
}

export function markProgress(rowId: string, progress: number): Promise<void> {
  return trackWrite(
    guard('progress', async () => {
      await prisma.job.updateMany({
        where: { id: rowId, status: { in: ['queued', 'delayed', 'active'] } },
        data: { progress },
      })
    }),
  )
}
