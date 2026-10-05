/**
 * Migration API — docs/architecture/contracts/api-contract.md §4.6.
 *
 * Migration copies (or moves) objects between two owned accounts. `mode: 'move'`
 * deletes each source object only after its target copy has been verified.
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

export const migrationRouter = Router()

const REQUIRED_CAPABILITIES = ['download', 'upload', 'list'] as const

const scopeSchema = z.object({
  folderIds: z.array(z.string().min(1)).max(500).optional(),
  fileIds: z.array(z.string().min(1)).max(5000).optional(),
})

const createSchema = z.object({
  sourceAccountId: z.string().min(1),
  targetAccountId: z.string().min(1),
  mode: z.enum(['copy', 'move']).optional(),
  scope: scopeSchema.optional(),
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

function assertMigrationAllowed(source: { provider: string }, target: { provider: string }): void {
  for (const account of [source, target]) {
    const entry = catalog.get(account.provider as never)
    if (!entry || entry.status !== 'SUPPORTED') {
      throw new Error(`provider '${account.provider}' is not available for migration`)
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

async function findOwnedMigration(userId: string, id: string) {
  return prisma.migrationJob.findFirst({
    where: { id, userId },
    orderBy: { createdAt: 'desc' },
  })
}

migrationRouter.use(requireAuth)

migrationRouter.post('/', async (req: AuthRequest, res, next) => {
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
      assertMigrationAllowed(source, target)
    } catch (error) {
      return res.status(409).json({
        code: 'MIGRATION_NOT_ALLOWED',
        message: error instanceof Error ? error.message : 'Migration is not allowed between these accounts.',
      })
    }

    const row = await prisma.migrationJob.create({
      data: {
        userId: req.user!.id,
        sourceAccountId: source.id,
        targetAccountId: target.id,
        mode: body.mode ?? 'copy',
        status: 'pending',
      },
    })

    const jobId = await enqueueJob('MIGRATION', {
      userId: req.user!.id,
      migrationJobId: row.id,
      scope: body.scope ?? {},
    }, { relatedId: row.id })

    await prisma.migrationJob.update({ where: { id: row.id }, data: { status: 'queued' } })
    await createAuditLog(req.user!.id, 'CREATE_MIGRATION', 'migration', row.id, {
      sourceAccountId: source.id,
      targetAccountId: target.id,
      mode: body.mode ?? 'copy',
      jobId,
    })

    const created = await prisma.migrationJob.findUniqueOrThrow({ where: { id: row.id } })
    return res.status(201).json({ migration: serializeRow(created as unknown as Record<string, unknown>) })
  } catch (error) {
    return next(error)
  }
})

migrationRouter.get('/', async (req: AuthRequest, res, next) => {
  try {
    const query = listQuerySchema.parse(req.query)
    const limit = query.limit ?? 20
    const rows = await prisma.migrationJob.findMany({
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
      migrations: page.map((row) => serializeRow(row as unknown as Record<string, unknown>)),
      ...(nextCursor ? { nextCursor } : {}),
    })
  } catch (error) {
    return next(error)
  }
})

migrationRouter.get('/:id', async (req: AuthRequest, res, next) => {
  try {
    const id = idSchema.parse(req.params.id)
    const row = await findOwnedMigration(req.user!.id, id)
    if (!row) return res.status(404).json({ code: 'NOT_FOUND', message: 'Migration job not found.' })
    return res.json({ migration: serializeRow(row as unknown as Record<string, unknown>) })
  } catch (error) {
    return next(error)
  }
})

migrationRouter.post('/:id/cancel', async (req: AuthRequest, res, next) => {
  try {
    const id = idSchema.parse(req.params.id)
    const row = await findOwnedMigration(req.user!.id, id)
    if (!row) return res.status(404).json({ code: 'NOT_FOUND', message: 'Migration job not found.' })
    if (row.status === 'completed' || row.status === 'failed' || row.status === 'cancelled') {
      return res.status(409).json({ code: 'CONFLICT', message: 'Migration job has already finished.' })
    }
    const { removed } = await requestJobCancel(row.id)
    await createAuditLog(req.user!.id, 'CANCEL_MIGRATION', 'migration', row.id, { removed })
    const updated = await prisma.migrationJob.findUnique({ where: { id: row.id } })
    return res.json({ migration: serializeRow((updated ?? row) as unknown as Record<string, unknown>) })
  } catch (error) {
    return next(error)
  }
})
