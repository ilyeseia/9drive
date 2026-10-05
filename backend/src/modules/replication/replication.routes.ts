/**
 * Replication API — docs/architecture/contracts/api-contract.md §4.5.
 *
 * Replication copies objects between two owned accounts without deleting the
 * source. Both accounts must belong to SUPPORTED providers declaring
 * `download` + `upload` + `list`.
 */

import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../config/prisma.js'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { catalog, registry } from '../../providers/index.js'
import { requestJobCancel } from '../../queues/cancel.js'
import { enqueueJob } from '../../queues/queues.js'
import { createAuditLog } from '../../utils/audit.js'
import { jsonSafe } from '../../utils/serialize.js'

export const replicationRouter = Router()

const REQUIRED_CAPABILITIES = ['download', 'upload', 'list'] as const

const scopeSchema = z.object({
  folderIds: z.array(z.string().min(1)).max(500).optional(),
  fileIds: z.array(z.string().min(1)).max(5000).optional(),
})

const createSchema = z.object({
  sourceAccountId: z.string().min(1),
  targetAccountId: z.string().min(1),
  scope: scopeSchema.optional(),
  overwrite: z.boolean().optional(),
})

const listQuerySchema = z.object({
  status: z.enum(['pending', 'queued', 'running', 'completed', 'failed', 'cancelled']).optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
})

const idSchema = z.string().min(1)

function serializeRow(row: Record<string, unknown>): Record<string, unknown> {
  return jsonSafe(row) as Record<string, unknown>
}

async function findOwnedAccount(userId: string, accountId: string) {
  return prisma.connectedAccount.findFirst({
    where: { id: accountId, userId, status: { not: 'disconnected' } },
    select: { id: true, provider: true, status: true },
  })
}

function assertReplicationAllowed(source: { provider: string }, target: { provider: string }): void {
  for (const account of [source, target]) {
    const entry = catalog.get(account.provider as never)
    if (!entry || entry.status !== 'SUPPORTED') {
      throw new Error(`provider '${account.provider}' is not available for replication`)
    }
    const provider = registry.tryGet(account.provider as never)
    if (!provider) throw new Error(`no adapter registered for provider '${account.provider}'`)
    for (const capability of REQUIRED_CAPABILITIES) {
      if (!provider.capabilities.has(capability as never)) {
        throw new Error(`provider '${account.provider}' does not support '${capability}'`)
      }
    }
  }
}

async function findOwnedReplication(userId: string, id: string) {
  return prisma.replicationJob.findFirst({
    where: { id, userId },
    orderBy: { createdAt: 'desc' },
  })
}

replicationRouter.use(requireAuth)

replicationRouter.post('/', async (req: AuthRequest, res, next) => {
  try {
    const body = createSchema.parse(req.body)
    if (body.sourceAccountId === body.targetAccountId) {
      return res.status(400).json({ code: 'VALIDATION_FAILED', message: 'sourceAccountId and targetAccountId must differ.' })
    }

    const [source, target] = await Promise.all([
      findOwnedAccount(req.user!.id, body.sourceAccountId),
      findOwnedAccount(req.user!.id, body.targetAccountId),
    ])
    if (!source) return res.status(404).json({ code: 'SOURCE_NOT_FOUND', message: 'Source account not found.' })
    if (!target) return res.status(404).json({ code: 'TARGET_NOT_FOUND', message: 'Target account not found.' })

    try {
      assertReplicationAllowed(source, target)
    } catch (error) {
      return res.status(409).json({
        code: 'REPLICATION_NOT_ALLOWED',
        message: error instanceof Error ? error.message : 'Replication is not allowed between these accounts.',
      })
    }

    const row = await prisma.replicationJob.create({
      data: {
        userId: req.user!.id,
        sourceAccountId: source.id,
        targetAccountId: target.id,
        scope: jsonSafe(body.scope ?? {}) as never,
        status: 'pending',
      },
    })

    const jobId = await enqueueJob('REPLICATION', {
      userId: req.user!.id,
      replicationJobId: row.id,
    }, { relatedId: row.id })

    await prisma.replicationJob.update({ where: { id: row.id }, data: { status: 'queued' } })
    await createAuditLog(req.user!.id, 'CREATE_REPLICATION', 'replication', row.id, {
      sourceAccountId: source.id,
      targetAccountId: target.id,
      jobId,
    })

    const created = await prisma.replicationJob.findUniqueOrThrow({ where: { id: row.id } })
    return res.status(201).json({ replication: serializeRow(created as unknown as Record<string, unknown>) })
  } catch (error) {
    return next(error)
  }
})

replicationRouter.get('/', async (req: AuthRequest, res, next) => {
  try {
    const query = listQuerySchema.parse(req.query)
    const limit = query.limit ?? 20
    const rows = await prisma.replicationJob.findMany({
      where: {
        userId: req.user!.id,
        ...(query.status ? { status: query.status } : {}),
        ...(query.cursor ? { id: { lt: query.cursor } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
    })
    const page = rows.slice(0, limit)
    const nextCursor = rows.length > limit ? page[page.length - 1]?.id ?? null : null
    return res.json({
      replications: page.map((row) => serializeRow(row as unknown as Record<string, unknown>)),
      ...(nextCursor ? { nextCursor } : {}),
    })
  } catch (error) {
    return next(error)
  }
})

replicationRouter.get('/:id', async (req: AuthRequest, res, next) => {
  try {
    const id = idSchema.parse(req.params.id)
    const row = await findOwnedReplication(req.user!.id, id)
    if (!row) return res.status(404).json({ code: 'NOT_FOUND', message: 'Replication job not found.' })
    return res.json({ replication: serializeRow(row as unknown as Record<string, unknown>) })
  } catch (error) {
    return next(error)
  }
})

replicationRouter.post('/:id/cancel', async (req: AuthRequest, res, next) => {
  try {
    const id = idSchema.parse(req.params.id)
    const row = await findOwnedReplication(req.user!.id, id)
    if (!row) return res.status(404).json({ code: 'NOT_FOUND', message: 'Replication job not found.' })
    if (row.status === 'completed' || row.status === 'failed' || row.status === 'cancelled') {
      return res.status(409).json({ code: 'CONFLICT', message: 'Replication job has already finished.' })
    }
    const { removed } = await requestJobCancel(row.id)
    await createAuditLog(req.user!.id, 'CANCEL_REPLICATION', 'replication', row.id, { removed })
    const updated = await prisma.replicationJob.findUnique({ where: { id: row.id } })
    return res.json({ replication: serializeRow((updated ?? row) as unknown as Record<string, unknown>) })
  } catch (error) {
    return next(error)
  }
})
