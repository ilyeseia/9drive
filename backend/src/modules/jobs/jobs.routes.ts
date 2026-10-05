/**
 * Job REST API — api-contract.md §4.3, job-contract.md §6.
 * Ownership-scoped: every lookup filters on `userId` and 404s otherwise.
 */

import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../config/prisma.js'
import { type AuthRequest } from '../../middleware/auth.middleware.js'
import { requestJobCancel } from '../../queues/cancel.js'
import { isJobType, JOB_TYPES } from '../../queues/job-types.js'
import { enqueueJob, getQueue, JOB_DEFINITIONS, queueNameForType } from '../../queues/queues.js'
import { createAuditLog } from '../../utils/audit.js'
import { FINISHED_JOB_STATUSES, JOB_STATUSES, serializeJob } from './job.serialize.js'
import { decodeCursor, encodeCursor, requireSessionOrScope } from './shared.js'

export const jobsRouter = Router()
jobsRouter.use(requireSessionOrScope('jobs:read'))

const listQuerySchema = z.object({
  status: z.enum(JOB_STATUSES).optional(),
  type: z.enum(JOB_TYPES).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})

const idSchema = z.string().uuid()

async function findOwnedJob(id: string, userId: string) {
  return prisma.job.findFirst({ where: { id, userId } })
}

function isFinished(status: string): boolean {
  return FINISHED_JOB_STATUSES.has(status)
}

jobsRouter.get('/', async (req: AuthRequest, res, next) => {
  try {
    const query = listQuerySchema.parse(req.query)
    const limit = query.limit ?? 50
    const cursor = query.cursor ? decodeCursor(query.cursor) : null
    if (query.cursor && !cursor) {
      return res.status(400).json({ code: 'VALIDATION_FAILED', message: 'cursor: invalid cursor.' })
    }
    const rows = await prisma.job.findMany({
      where: {
        userId: req.user!.id,
        ...(query.status ? { status: query.status } : {}),
        ...(query.type ? { type: query.type } : {}),
        ...(cursor
          ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    })
    const hasMore = rows.length > limit
    const items = rows.slice(0, limit)
    const last = items[items.length - 1]
    return res.json({
      items: items.map(serializeJob),
      ...(hasMore && last ? { nextCursor: encodeCursor({ createdAt: last.createdAt, id: last.id }) } : {}),
    })
  } catch (error) {
    return next(error)
  }
})

jobsRouter.get('/:id', async (req: AuthRequest, res, next) => {
  try {
    const id = idSchema.parse(req.params.id)
    const job = await findOwnedJob(id, req.user!.id)
    if (!job) return res.status(404).json({ code: 'NOT_FOUND', message: 'Job not found.' })
    return res.json({ job: serializeJob(job) })
  } catch (error) {
    return next(error)
  }
})

jobsRouter.post('/:id/retry', async (req: AuthRequest, res, next) => {
  try {
    const id = idSchema.parse(req.params.id)
    const job = await findOwnedJob(id, req.user!.id)
    if (!job) return res.status(404).json({ code: 'NOT_FOUND', message: 'Job not found.' })
    if (!isFinished(job.status)) {
      return res.status(409).json({ code: 'CONFLICT', message: 'Only finished jobs can be retried.' })
    }
    if (!isJobType(job.type)) {
      return res.status(409).json({ code: 'CONFLICT', message: 'This job type cannot be retried.' })
    }
    const definition = JOB_DEFINITIONS[job.type]
    const payload = (job.payload ?? {}) as Record<string, unknown>
    const parsed = definition.payloadSchema.safeParse({ ...payload, userId: job.userId ?? req.user!.id })
    if (!parsed.success) {
      return res.status(409).json({ code: 'CONFLICT', message: 'Job payload is no longer valid for retry.' })
    }
    const newId = await enqueueJob(job.type, parsed.data, {
      priority: job.priority,
      ...(job.provider ? { provider: job.provider } : {}),
      ...(job.relatedId ? { relatedId: job.relatedId } : {}),
    })
    await createAuditLog(req.user!.id, 'RETRY_JOB', 'job', newId, { retryOf: job.id, type: job.type })
    const created = await prisma.job.findUnique({ where: { id: newId } })
    if (!created) return res.status(500).json({ code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' })
    return res.status(201).json({ job: serializeJob(created), retryOf: job.id })
  } catch (error) {
    return next(error)
  }
})

jobsRouter.post('/:id/cancel', async (req: AuthRequest, res, next) => {
  try {
    const id = idSchema.parse(req.params.id)
    const job = await findOwnedJob(id, req.user!.id)
    if (!job) return res.status(404).json({ code: 'NOT_FOUND', message: 'Job not found.' })
    if (isFinished(job.status)) {
      return res.status(409).json({ code: 'CONFLICT', message: 'Job has already finished.' })
    }
    await requestJobCancel(job.id)
    await createAuditLog(req.user!.id, 'CANCEL_JOB', 'job', job.id, { type: job.type })
    const updated = await findOwnedJob(job.id, req.user!.id)
    return res.json({ job: serializeJob(updated ?? job) })
  } catch (error) {
    return next(error)
  }
})

jobsRouter.delete('/:id', async (req: AuthRequest, res, next) => {
  try {
    const id = idSchema.parse(req.params.id)
    const job = await findOwnedJob(id, req.user!.id)
    if (!job) return res.status(404).json({ code: 'NOT_FOUND', message: 'Job not found.' })
    if (!isFinished(job.status)) {
      return res.status(409).json({ code: 'CONFLICT', message: 'Only finished jobs can be deleted.' })
    }
    if (job.bullJobId && isJobType(job.type)) {
      try {
        const bullJob = await getQueue(queueNameForType(job.type)).getJob(job.bullJobId)
        await bullJob?.remove()
      } catch {
        // retained queue entries are best-effort; the row is authoritative
      }
    }
    await prisma.job.delete({ where: { id: job.id } })
    await createAuditLog(req.user!.id, 'DELETE_JOB', 'job', job.id, { type: job.type, status: job.status })
    return res.json({ status: 'ok' })
  } catch (error) {
    return next(error)
  }
})
