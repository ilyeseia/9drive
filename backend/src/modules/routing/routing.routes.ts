/**
 * Routing API — api-contract.md §4.4. GET/PATCH policies read and write the
 * user's `UploadRoutingPolicy` (superset body, §6); POST preview is a dry run
 * that returns the chosen account plus an explanation.
 */

import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../config/prisma.js'
import { type AuthRequest } from '../../middleware/auth.middleware.js'
import { requireSessionOrScope } from '../jobs/shared.js'
import { previewRouting } from './routing.explain.js'
import {
  getOrCreateRoutingPolicy,
  routingPolicyUpdateSchema,
  serializeRoutingPolicy,
  updateRoutingPolicy,
} from './routing.service.js'

export const routingRouter = Router()
routingRouter.use(requireSessionOrScope('providers:read'))

const previewSchema = z.object({
  bytes: z.union([z.number().int().min(0), z.string().regex(/^\d+$/)]),
  fileType: z.string().trim().min(1).max(191).optional(),
  folderId: z.string().uuid().optional(),
})

routingRouter.get('/policies', async (req: AuthRequest, res, next) => {
  try {
    const policy = await getOrCreateRoutingPolicy(req.user!.id)
    return res.json({ policy: serializeRoutingPolicy(policy) })
  } catch (error) {
    return next(error)
  }
})

routingRouter.patch('/policies', async (req: AuthRequest, res, next) => {
  try {
    const body = routingPolicyUpdateSchema.parse(req.body)
    const policy = await updateRoutingPolicy(req.user!.id, body)
    return res.json({ policy: serializeRoutingPolicy(policy) })
  } catch (error) {
    return next(error)
  }
})

routingRouter.post('/preview', async (req: AuthRequest, res, next) => {
  try {
    const body = previewSchema.parse(req.body)
    const userId = req.user!.id
    let targetAccountId: string | undefined
    if (body.folderId) {
      const folder = await prisma.folder.findFirst({
        where: { id: body.folderId, userId, deletedAt: null },
        select: { id: true, connectedAccountId: true },
      })
      if (!folder) return res.status(404).json({ code: 'NOT_FOUND', message: 'Folder not found.' })
      targetAccountId = folder.connectedAccountId ?? undefined
    }
    const preview = await previewRouting({
      userId,
      bytes: BigInt(body.bytes),
      ...(body.fileType !== undefined ? { fileType: body.fileType } : {}),
      ...(body.folderId !== undefined ? { folderId: body.folderId } : {}),
      ...(targetAccountId !== undefined ? { targetAccountId } : {}),
    })
    return res.json(preview)
  } catch (error) {
    return next(error)
  }
})
