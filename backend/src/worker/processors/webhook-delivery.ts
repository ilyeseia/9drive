import { createHmac } from 'node:crypto'
import { prisma } from '../../config/prisma.js'
import type { JobPayloads } from '../../queues/job-types.js'
import { WEBHOOK_BACKOFF_DELAYS_MS } from '../../queues/queues.js'
import { decryptText } from '../../utils/crypto.js'
import { safeFetch } from '../../utils/ssrf.js'
import { PermanentJobError } from '../errors.js'
import type { JobHandler } from '../types.js'

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const DELIVERY_TIMEOUT_MS = 10_000
const USER_AGENT = '9Drive-Webhooks/1'
const MAX_ERROR_LENGTH = 2_000

function eventIdFor(deliveryId: string): string {
  const hex = deliveryId.replace(/-/g, '')
  let value = BigInt(`0x${hex}`)
  let out = ''
  for (let i = 0; i < 26; i++) {
    out = CROCKFORD[Number(value % 32n)] + out
    value /= 32n
  }
  return `evt_${out}`
}

function nextAttemptDelay(attempt: number): number {
  const index = Math.min(attempt - 1, WEBHOOK_BACKOFF_DELAYS_MS.length - 1)
  return WEBHOOK_BACKOFF_DELAYS_MS[Math.max(0, index)]
}

function truncate(message: string): string {
  return message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH)}...` : message
}

export const webhookDeliveryHandler: JobHandler<JobPayloads['WEBHOOK_DELIVERY']> = async (ctx) => {
  const { deliveryId } = ctx.payload
  const delivery = await prisma.webhookDelivery.findUnique({ where: { id: deliveryId } })
  if (!delivery) {
    throw new PermanentJobError(`ERR_INVALID_INPUT: webhook delivery ${deliveryId} not found`)
  }
  if (delivery.status === 'delivered') return { skipped: 'already_delivered' }
  const subscription = await prisma.webhookSubscription.findUnique({
    where: { id: delivery.subscriptionId },
  })
  if (!subscription) {
    throw new PermanentJobError(`ERR_INVALID_INPUT: webhook subscription ${delivery.subscriptionId} not found`)
  }
  if (subscription.status !== 'active') {
    await prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: { status: 'skipped', attempts: delivery.attempts + 1, lastError: 'subscription_inactive' },
    })
    return { skipped: 'subscription_inactive' }
  }

  const maxAttempts = typeof ctx.job.opts.attempts === 'number' ? ctx.job.opts.attempts : 5
  const attempt = delivery.attempts + 1
  const terminal = attempt >= maxAttempts
  const timestamp = Math.floor(Date.now() / 1_000)
  const body = JSON.stringify({
    id: eventIdFor(delivery.id),
    type: delivery.event,
    createdAt: delivery.createdAt.toISOString(),
    data: delivery.payload,
  })
  const secret = decryptText(subscription.secretEncrypted)
  const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')

  let response: Response
  try {
    response = await safeFetch(subscription.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': USER_AGENT,
        'x-9drive-delivery': `dlv_${delivery.id}`,
        'x-9drive-timestamp': String(timestamp),
        'x-9drive-signature': `v1=${signature}`,
      },
      body,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      redirect: 'follow',
    })
  } catch (error) {
    const message = truncate((error as Error).message || String(error))
    await prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        attempts: attempt,
        lastError: message,
        status: terminal ? 'failed' : 'pending',
        nextAttemptAt: new Date(Date.now() + nextAttemptDelay(attempt)),
      },
    })
    throw new Error(`webhook delivery ${delivery.id} failed: ${message}`)
  }

  if (!response.ok) {
    const message = truncate(`endpoint responded with HTTP ${response.status}`)
    await prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        attempts: attempt,
        lastError: message,
        status: terminal ? 'failed' : 'pending',
        nextAttemptAt: new Date(Date.now() + nextAttemptDelay(attempt)),
      },
    })
    throw new Error(`webhook delivery ${delivery.id} failed: ${message}`)
  }

  await prisma.webhookDelivery.update({
    where: { id: delivery.id },
    data: {
      status: 'delivered',
      attempts: attempt,
      deliveredAt: new Date(),
      lastError: null,
    },
  })
  ctx.logger.info('webhook delivered', { deliveryId: delivery.id, attempt, status: response.status })
  return { delivered: true, status: response.status, attempt }
}
