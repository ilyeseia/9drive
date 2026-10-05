/**
 * Wave 5 webhook integration tests — api-contract.md §4.7, event-contract.md §4.
 * CRUD with SSRF rejection, one-time signing secret, the system.test delivery
 * (row + BullMQ job) and cursor-paged delivery history.
 */

import express from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '../../../config/prisma.js'
import { errorMiddleware } from '../../../middleware/error.middleware.js'
import { closeRateLimitStore } from '../../../middleware/security.middleware.js'
import { webhookRouter } from '../../../modules/webhooks/webhook.routes.js'
import { closeConnections } from '../../../queues/connection.js'
import { isJobType } from '../../../queues/job-types.js'
import { closeQueues, getQueue, queueNameForType } from '../../../queues/queues.js'
import { hashToken, randomToken } from '../../../utils/crypto.js'
import { signAccessToken } from '../../../utils/jwt.js'

const runId = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`

type Actor = { id: string; token: string }

let alice: Actor
let bob: Actor
const userIds: string[] = []

let subId = ''
let wildcardSubId = ''
let firstDeliveryId = ''
let manageKeySecret = ''
let wrongScopeKeySecret = ''

function buildApp() {
  const app = express()
  app.set('trust proxy', 1)
  app.use(express.json())
  app.use('/webhooks', webhookRouter)
  app.use(errorMiddleware)
  return app
}

async function createActor(label: string): Promise<Actor> {
  const user = await prisma.user.create({
    data: { name: `Hook ${label}`, email: `hook-${label}-${runId}@9drive.test`, passwordHash: 'unused-hash' },
  })
  userIds.push(user.id)
  const session = await prisma.userSession.create({
    data: { userId: user.id, refreshTokenHash: hashToken(randomToken()), expiresAt: new Date(Date.now() + 3_600_000) },
  })
  return { id: user.id, token: signAccessToken({ sub: user.id, sid: session.id }) }
}

function auth(actor: Actor) {
  return { Authorization: `Bearer ${actor.token}` }
}

beforeAll(async () => {
  alice = await createActor('alice')
  bob = await createActor('bob')

  manageKeySecret = `9d_live_${randomToken(16)}`
  wrongScopeKeySecret = `9d_live_${randomToken(16)}`
  await prisma.apiKey.create({
    data: {
      userId: alice.id,
      name: 'webhooks-manage-key',
      keyPrefix: manageKeySecret.slice(0, 16),
      keyHash: hashToken(manageKeySecret),
      scopes: ['webhooks:manage'],
    },
  })
  await prisma.apiKey.create({
    data: {
      userId: alice.id,
      name: 'jobs-read-key',
      keyPrefix: wrongScopeKeySecret.slice(0, 16),
      keyHash: hashToken(wrongScopeKeySecret),
      scopes: ['jobs:read'],
    },
  })
})

afterAll(async () => {
  const rows = await prisma.job.findMany({ where: { userId: { in: userIds } } })
  for (const row of rows) {
    if (row.bullJobId && isJobType(row.type)) {
      try {
        const bullJob = await getQueue(queueNameForType(row.type)).getJob(row.bullJobId)
        await bullJob?.remove()
      } catch {
        // best-effort queue cleanup
      }
    }
  }
  await closeQueues()
  const subscriptions = await prisma.webhookSubscription.findMany({ where: { userId: { in: userIds } } })
  const subscriptionIds = subscriptions.map((subscription) => subscription.id)
  if (subscriptionIds.length > 0) {
    await prisma.webhookDelivery.deleteMany({ where: { subscriptionId: { in: subscriptionIds } } })
    await prisma.webhookSubscription.deleteMany({ where: { id: { in: subscriptionIds } } })
  }
  await prisma.job.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.userSession.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  await closeConnections()
  await closeRateLimitStore()
  await prisma.$disconnect()
})

describe('POST /webhooks', () => {
  it('rejects unauthenticated creation', async () => {
    const res = await request(buildApp()).post('/webhooks').send({ url: 'https://hooks.example.test/a', events: ['file.uploaded'] })
    expect(res.status).toBe(401)
  })

  it('creates a subscription and returns the signing secret once', async () => {
    const res = await request(buildApp())
      .post('/webhooks')
      .set(auth(alice))
      .send({ url: 'https://hooks.example.test/9drive', events: ['file.uploaded', 'job.failed'] })
    expect(res.status).toBe(201)
    expect(res.body.webhook.id).toBeTruthy()
    expect(res.body.webhook.url).toBe('https://hooks.example.test/9drive')
    expect(res.body.webhook.events).toEqual(['file.uploaded', 'job.failed'])
    expect(res.body.webhook.status).toBe('active')
    expect(res.body.webhook.secretEncrypted).toBeUndefined()
    expect(typeof res.body.secret).toBe('string')
    expect(res.body.secret.length).toBeGreaterThan(20)
    subId = res.body.webhook.id

    const row = await prisma.webhookSubscription.findUnique({ where: { id: subId } })
    expect(row?.secretEncrypted).not.toBe(res.body.secret)
    expect(row?.secretEncrypted.split(':')).toHaveLength(3)
  })

  it('rejects duplicate urls for the same tenant', async () => {
    const res = await request(buildApp())
      .post('/webhooks')
      .set(auth(alice))
      .send({ url: 'https://hooks.example.test/9drive', events: ['file.uploaded'] })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('CONFLICT')
  })

  it('rejects urls that fail the SSRF gate', async () => {
    for (const url of [
      'http://hooks.example.test/hook',
      'https://localhost/hook',
      'https://hooks.example.test:8443/hook',
    ]) {
      const res = await request(buildApp()).post('/webhooks').set(auth(alice)).send({ url, events: ['file.uploaded'] })
      expect(res.status).toBe(400)
      expect(res.body.code).toBe('VALIDATION_FAILED')
      expect(res.body.message).toContain('not allowed')
    }
  })

  it('rejects unknown events and accepts the wildcard', async () => {
    const unknown = await request(buildApp())
      .post('/webhooks')
      .set(auth(alice))
      .send({ url: 'https://hooks.example.test/unknown', events: ['nope.event'] })
    expect(unknown.status).toBe(400)
    expect(unknown.body.code).toBe('VALIDATION_FAILED')
    expect(unknown.body.message).toContain('nope.event')

    const wildcard = await request(buildApp())
      .post('/webhooks')
      .set(auth(alice))
      .send({ url: 'https://hooks.example.test/all', events: ['*'] })
    expect(wildcard.status).toBe(201)
    expect(wildcard.body.webhook.events).toEqual(['*'])
    wildcardSubId = wildcard.body.webhook.id
  })
})

describe('GET /webhooks', () => {
  it('lists subscriptions without ever exposing secrets', async () => {
    const res = await request(buildApp()).get('/webhooks').set(auth(alice))
    expect(res.status).toBe(200)
    expect(res.body.items).toHaveLength(2)
    const serialized = JSON.stringify(res.body)
    expect(serialized).not.toContain('secretEncrypted')
    expect(serialized).not.toContain('9d_')
  })

  it('shows another tenant nothing', async () => {
    const res = await request(buildApp()).get('/webhooks').set(auth(bob))
    expect(res.status).toBe(200)
    expect(res.body.items).toEqual([])
  })
})

describe('POST /webhooks/:id/test', () => {
  it('creates a pending delivery plus a queued WEBHOOK_DELIVERY job', async () => {
    const res = await request(buildApp()).post(`/webhooks/${subId}/test`).set(auth(alice))
    expect(res.status).toBe(201)
    expect(res.body.delivery.event).toBe('system.test')
    expect(res.body.delivery.status).toBe('pending')
    expect(res.body.delivery.attempts).toBe(0)
    firstDeliveryId = res.body.delivery.id

    const job = await prisma.job.findFirst({
      where: { userId: alice.id, type: 'WEBHOOK_DELIVERY', relatedId: subId },
      orderBy: { createdAt: 'desc' },
    })
    expect(job).not.toBeNull()
    expect(job?.status).toBe('queued')
    expect(job?.bullJobId).toBeTruthy()

    const bullJob = await getQueue('webhook').getJob(job!.bullJobId!)
    expect(bullJob).not.toBeNull()
  })

  it('404s for foreign subscriptions', async () => {
    const res = await request(buildApp()).post(`/webhooks/${subId}/test`).set(auth(bob))
    expect(res.status).toBe(404)
    expect(res.body.code).toBe('NOT_FOUND')
  })
})

describe('GET /webhooks/:id/deliveries', () => {
  it('pages delivery history with a cursor', async () => {
    await request(buildApp()).post(`/webhooks/${subId}/test`).set(auth(alice)).expect(201)

    const first = await request(buildApp()).get(`/webhooks/${subId}/deliveries?limit=1`).set(auth(alice))
    expect(first.status).toBe(200)
    expect(first.body.items).toHaveLength(1)
    expect(first.body.nextCursor).toBeTruthy()

    const second = await request(buildApp())
      .get(`/webhooks/${subId}/deliveries?limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`)
      .set(auth(alice))
    expect(second.status).toBe(200)
    expect(second.body.items).toHaveLength(1)
    expect(second.body.items[0].id).not.toBe(first.body.items[0].id)

    const invalid = await request(buildApp()).get(`/webhooks/${subId}/deliveries?cursor=%%%`).set(auth(alice))
    expect(invalid.status).toBe(400)
    expect(invalid.body.code).toBe('VALIDATION_FAILED')
  })

  it('404s for foreign subscriptions', async () => {
    const res = await request(buildApp()).get(`/webhooks/${subId}/deliveries`).set(auth(bob))
    expect(res.status).toBe(404)
  })
})

describe('DELETE /webhooks/:id', () => {
  it('404s for foreign subscriptions', async () => {
    const res = await request(buildApp()).delete(`/webhooks/${subId}`).set(auth(bob))
    expect(res.status).toBe(404)
    expect(res.body.code).toBe('NOT_FOUND')
  })

  it('removes the subscription and its delivery history', async () => {
    const res = await request(buildApp()).delete(`/webhooks/${subId}`).set(auth(alice))
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ok')

    const subscription = await prisma.webhookSubscription.findUnique({ where: { id: subId } })
    expect(subscription).toBeNull()
    const deliveries = await prisma.webhookDelivery.findMany({ where: { subscriptionId: subId } })
    expect(deliveries).toHaveLength(0)

    const gone = await request(buildApp()).get(`/webhooks/${subId}/deliveries`).set(auth(alice))
    expect(gone.status).toBe(404)

    const audit = await prisma.auditLog.findFirst({ where: { userId: alice.id, action: 'DELETE_WEBHOOK' } })
    expect(audit).not.toBeNull()
  })
})

describe('webhook API key access', () => {
  it('accepts a key with the webhooks:manage scope', async () => {
    const res = await request(buildApp()).get('/webhooks').set('Authorization', `Bearer ${manageKeySecret}`)
    expect(res.status).toBe(200)
    expect(res.body.items).toHaveLength(1)
    expect(res.body.items[0].id).toBe(wildcardSubId)
  })

  it('rejects a key without the webhooks:manage scope', async () => {
    const res = await request(buildApp()).get('/webhooks').set('Authorization', `Bearer ${wrongScopeKeySecret}`)
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('API_KEY_FORBIDDEN')
  })
})
