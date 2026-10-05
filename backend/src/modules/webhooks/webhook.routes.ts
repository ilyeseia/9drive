/**
 * Webhook REST API — api-contract.md §4.7, event-contract.md §4.
 * The signing secret is returned exactly once at creation and never again.
 */

import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../config/prisma.js'
import { type AuthRequest } from '../../middleware/auth.middleware.js'
import { createAuditLog } from '../../utils/audit.js'
import { encryptText, randomToken } from '../../utils/crypto.js'
import { assertUrlAllowed, sanitizeUrlForDisplay } from '../../utils/ssrf.js'
import { decodeCursor, encodeCursor, requireSessionOrScope, sanitizeErrorMessage, sanitizeSecrets } from '../jobs/shared.js'
import {
  createDelivery,
  enqueueDelivery,
  normalizeSubscribedEvents,
  serializeSubscription,
  WEBHOOK_EVENTS,
} from './webhook.service.js'

export const webhookRouter = Router()
webhookRouter.use(requireSessionOrScope('webhooks:manage'))

const idSchema = z.string().uuid()
const createSchema = z.object({
  url: z.string().trim().min(1).max(2048),
  events: z.array(z.string().trim().min(1).max(64)).min(1).max(WEBHOOK_EVENTS.length),
})
const deliveriesQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
}

function serializeDelivery(delivery: {
  id: string
  subscriptionId: string
  event: string
  payload: unknown
  status: string
  attempts: number
  lastError: string | null
  nextAttemptAt: Date
  deliveredAt: Date | null
  createdAt: Date
}) {
  return {
    id: delivery.id,
    subscriptionId: delivery.subscriptionId,
    event: delivery.event,
    payload: sanitizeSecrets(delivery.payload),
    status: delivery.status,
    attempts: delivery.attempts,
    lastError: sanitizeErrorMessage(delivery.lastError),
    nextAttemptAt: delivery.nextAttemptAt.toISOString(),
    deliveredAt: delivery.deliveredAt?.toISOString() ?? null,
    createdAt: delivery.createdAt.toISOString(),
  }
}

async function findOwnedSubscription(id: string, userId: string) {
  return prisma.webhookSubscription.findFirst({ where: { id, userId } })
}

webhookRouter.get('/', async (req: AuthRequest, res, next) => {
  try {
    const subscriptions = await prisma.webhookSubscription.findMany({
      where: { userId: req.user!.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    })
    return res.json({ items: subscriptions.map(serializeSubscription) })
  } catch (error) {
    return next(error)
  }
})

webhookRouter.post('/', async (req: AuthRequest, res, next) => {
  try {
    const userId = req.user!.id
    const body = createSchema.parse(req.body)
    try {
      assertUrlAllowed(body.url)
    } catch {
      return res.status(400).json({ code: 'VALIDATION_FAILED', message: 'url: webhook URL is not allowed.' })
    }
    const { events, invalid } = normalizeSubscribedEvents(body.events)
    if (invalid.length > 0) {
      return res.status(400).json({
        code: 'VALIDATION_FAILED',
        message: `events: unknown event "${invalid[0]}".`,
      })
    }
    if (events.length === 0) {
      return res.status(400).json({ code: 'VALIDATION_FAILED', message: 'events: at least one event is required.' })
    }
    const secret = randomToken(32)
    let subscription
    try {
      subscription = await prisma.webhookSubscription.create({
        data: { userId, url: body.url, secretEncrypted: encryptText(secret), events },
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        return res.status(409).json({ code: 'CONFLICT', message: 'Webhook URL is already registered.' })
      }
      throw error
    }
    await createAuditLog(userId, 'CREATE_WEBHOOK', 'webhook', subscription.id, {
      url: sanitizeUrlForDisplay(subscription.url),
      events,
    })
    return res.status(201).json({ webhook: serializeSubscription(subscription), secret })
  } catch (error) {
    return next(error)
  }
})

webhookRouter.delete('/:id', async (req: AuthRequest, res, next) => {
  try {
    const userId = req.user!.id
    const id = idSchema.parse(req.params.id)
    const subscription = await findOwnedSubscription(id, userId)
    if (!subscription) return res.status(404).json({ code: 'NOT_FOUND', message: 'Webhook not found.' })
    await prisma.$transaction([
      prisma.webhookDelivery.deleteMany({ where: { subscriptionId: subscription.id } }),
      prisma.webhookSubscription.delete({ where: { id: subscription.id } }),
    ])
    await createAuditLog(userId, 'DELETE_WEBHOOK', 'webhook', subscription.id, {
      url: sanitizeUrlForDisplay(subscription.url),
    })
    return res.json({ status: 'ok' })
  } catch (error) {
    return next(error)
  }
})

webhookRouter.post('/:id/test', async (req: AuthRequest, res, next) => {
  try {
    const userId = req.user!.id
    const id = idSchema.parse(req.params.id)
    const subscription = await findOwnedSubscription(id, userId)
    if (!subscription) return res.status(404).json({ code: 'NOT_FOUND', message: 'Webhook not found.' })
    const delivery = await createDelivery(subscription, 'system.test', {
      userId,
      subscriptionId: subscription.id,
      url: sanitizeUrlForDisplay(subscription.url),
      test: true,
      sentAt: new Date().toISOString(),
    })
    await enqueueDelivery(delivery.id, userId, subscription.id)
    await createAuditLog(userId, 'TEST_WEBHOOK', 'webhook', subscription.id, { deliveryId: delivery.id })
    return res.status(201).json({ delivery: serializeDelivery(delivery) })
  } catch (error) {
    return next(error)
  }
})

webhookRouter.get('/:id/deliveries', async (req: AuthRequest, res, next) => {
  try {
    const userId = req.user!.id
    const id = idSchema.parse(req.params.id)
    const subscription = await findOwnedSubscription(id, userId)
    if (!subscription) return res.status(404).json({ code: 'NOT_FOUND', message: 'Webhook not found.' })
    const query = deliveriesQuerySchema.parse(req.query)
    const limit = query.limit ?? 50
    const cursor = query.cursor ? decodeCursor(query.cursor) : null
    if (query.cursor && !cursor) {
      return res.status(400).json({ code: 'VALIDATION_FAILED', message: 'cursor: invalid cursor.' })
    }
    const rows = await prisma.webhookDelivery.findMany({
      where: {
        subscriptionId: subscription.id,
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
      items: items.map(serializeDelivery),
      ...(hasMore && last ? { nextCursor: encodeCursor({ createdAt: last.createdAt, id: last.id }) } : {}),
    })
  } catch (error) {
    return next(error)
  }
})
