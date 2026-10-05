/**
 * Webhook subscriptions and deliveries — event-contract.md §4.
 * `secretEncrypted` is AES-GCM sealed via utils/crypto.ts; subscription URLs
 * pass the SSRF gate at creation (utils/ssrf.ts) and again at delivery time.
 */

import type { Prisma, WebhookSubscription } from '@prisma/client'
import { prisma } from '../../config/prisma.js'
import { enqueueJob } from '../../queues/queues.js'
import { jsonSafe } from '../../utils/serialize.js'

export const WEBHOOK_EVENTS = [
  'auth.registered',
  'auth.login',
  'auth.logout',
  'auth.refresh_reuse_detected',
  'provider.connected',
  'provider.disconnected',
  'provider.health_changed',
  'provider.quota_exceeded',
  'provider.token_refresh_failed',
  'file.uploaded',
  'file.deleted',
  'file.renamed',
  'file.moved',
  'file.copied',
  'file.share_created',
  'file.share_revoked',
  'folder.created',
  'folder.deleted',
  'job.queued',
  'job.started',
  'job.completed',
  'job.failed',
  'job.cancelled',
  'replication.started',
  'replication.progress',
  'replication.completed',
  'replication.failed',
  'migration.started',
  'migration.progress',
  'migration.completed',
  'migration.failed',
  'security.rate_limited',
  'security.suspicious_request',
  'system.backup_created',
  'system.test',
] as const

export const WEBHOOK_EVENT_SET: ReadonlySet<string> = new Set<string>(WEBHOOK_EVENTS)

export const WEBHOOK_EVENT_WILDCARD = '*'

export function normalizeSubscribedEvents(events: string[]): { events: string[]; invalid: string[] } {
  const unique = [...new Set(events.map((event) => event.trim().toLowerCase()).filter(Boolean))]
  if (unique.includes(WEBHOOK_EVENT_WILDCARD)) return { events: [WEBHOOK_EVENT_WILDCARD], invalid: [] }
  return {
    events: unique,
    invalid: unique.filter((event) => !WEBHOOK_EVENT_SET.has(event)),
  }
}

export function subscriptionMatches(subscriptionEvents: unknown, event: string): boolean {
  if (!Array.isArray(subscriptionEvents)) return false
  if (subscriptionEvents.includes(WEBHOOK_EVENT_WILDCARD)) return true
  return subscriptionEvents.includes(event)
}

export function serializeSubscription(subscription: WebhookSubscription) {
  return {
    id: subscription.id,
    url: subscription.url,
    events: Array.isArray(subscription.events)
      ? subscription.events.filter((entry): entry is string => typeof entry === 'string')
      : [],
    status: subscription.status,
    createdAt: subscription.createdAt.toISOString(),
    updatedAt: subscription.updatedAt.toISOString(),
  }
}

function deliveryCreateData(subscription: WebhookSubscription, event: string, data: Record<string, unknown>) {
  return {
    subscriptionId: subscription.id,
    event,
    payload: jsonSafe(data) as Prisma.InputJsonValue,
    status: 'pending',
    nextAttemptAt: new Date(),
  }
}

export async function createDelivery(
  subscription: WebhookSubscription,
  event: string,
  data: Record<string, unknown>,
) {
  return prisma.webhookDelivery.create({ data: deliveryCreateData(subscription, event, data) })
}

export async function enqueueDelivery(deliveryId: string, userId: string, subscriptionId: string): Promise<string> {
  return enqueueJob('WEBHOOK_DELIVERY', { deliveryId, userId }, { relatedId: subscriptionId })
}

export async function fanOutWebhookEvent(
  event: string,
  data: Record<string, unknown>,
  userId: string,
): Promise<string[]> {
  if (!WEBHOOK_EVENT_SET.has(event)) return []
  const subscriptions = await prisma.webhookSubscription.findMany({ where: { userId, status: 'active' } })
  const matching = subscriptions.filter((subscription) => subscriptionMatches(subscription.events, event))
  if (matching.length === 0) return []
  const deliveries = await prisma.$transaction(async (tx) => {
    const rows = []
    for (const subscription of matching) {
      rows.push(await tx.webhookDelivery.create({ data: deliveryCreateData(subscription, event, { ...data, userId }) }))
    }
    return rows
  })
  const ids: string[] = []
  for (const delivery of deliveries) {
    await enqueueDelivery(delivery.id, userId, delivery.subscriptionId)
    ids.push(delivery.id)
  }
  return ids
}
