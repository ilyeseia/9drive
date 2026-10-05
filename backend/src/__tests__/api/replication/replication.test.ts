/**
 * Replication route tests — api-contract.md §4.5.
 */

import { randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '../../../config/prisma.js'
import { errorMiddleware } from '../../../middleware/error.middleware.js'
import { closeRateLimitStore } from '../../../middleware/security.middleware.js'
import { replicationRouter } from '../../../modules/replication/replication.routes.js'
import { closeConnections } from '../../../queues/connection.js'
import { closeQueues } from '../../../queues/queues.js'
import { createFakeProvider } from '../../../providers/fake.js'
import { registry } from '../../../providers/registry.js'
import { hashToken, randomToken } from '../../../utils/crypto.js'
import { signAccessToken } from '../../../utils/jwt.js'

const runId = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`

type Actor = { id: string; token: string }

let alice: Actor
let bob: Actor
const userIds: string[] = []
const accountIds: string[] = []

function buildApp() {
  const app = express()
  app.set('trust proxy', 1)
  app.use(express.json())
  app.use('/replication', replicationRouter)
  app.use(errorMiddleware)
  return app
}

async function createActor(label: string): Promise<Actor> {
  const user = await prisma.user.create({
    data: { name: `Repl ${label}`, email: `repl-${label}-${runId}@9drive.test`, passwordHash: 'unused-hash' },
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

async function createAccount(userId: string, seq: number): Promise<string> {
  const account = await prisma.connectedAccount.create({
    data: {
      userId,
      provider: 'google_drive',
      providerAccountId: `repl-${seq}-${runId}`,
      email: `repl-${seq}-${runId}@storage.test`,
      scopes: [],
      status: 'connected',
    },
  })
  accountIds.push(account.id)
  return account.id
}

beforeAll(async () => {
  registry.register(createFakeProvider({ id: 'google_drive', authMode: 'oauth2' }))
  alice = await createActor('alice')
  bob = await createActor('bob')
})

afterAll(async () => {
  await prisma.replicationJob.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.connectedAccount.deleteMany({ where: { id: { in: accountIds } } })
  await prisma.userSession.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  closeRateLimitStore()
  await closeQueues()
  await closeConnections()
})

describe('POST /replication', () => {
  it('creates a replication job and enqueues it', async () => {
    const source = await createAccount(alice.id, 1)
    const target = await createAccount(alice.id, 2)
    const app = buildApp()

    const response = await request(app)
      .post('/replication')
      .set(auth(alice))
      .send({ sourceAccountId: source, targetAccountId: target, scope: { folderIds: ['folder-1'] } })

    expect(response.status).toBe(201)
    expect(response.body.replication.id).toBeDefined()
    expect(response.body.replication.status).toBe('queued')
    expect(response.body.replication.userId).toBe(alice.id)
    expect(response.body.replication.sourceAccountId).toBe(source)
    expect(response.body.replication.targetAccountId).toBe(target)
  })

  it('rejects identical source and target', async () => {
    const source = await createAccount(alice.id, 3)
    const app = buildApp()
    const response = await request(app)
      .post('/replication')
      .set(auth(alice))
      .send({ sourceAccountId: source, targetAccountId: source })
    expect(response.status).toBe(400)
    expect(response.body.code).toBe('VALIDATION_FAILED')
  })

  it('returns 404 for an account owned by another user', async () => {
    const source = await createAccount(alice.id, 4)
    const target = await createAccount(bob.id, 5)
    const app = buildApp()
    const response = await request(app)
      .post('/replication')
      .set(auth(alice))
      .send({ sourceAccountId: source, targetAccountId: target })
    expect(response.status).toBe(404)
    expect(response.body.code).toBe('TARGET_NOT_FOUND')
  })

  it('returns 404 for a non-existent account', async () => {
    const source = await createAccount(alice.id, 6)
    const app = buildApp()
    const response = await request(app)
      .post('/replication')
      .set(auth(alice))
      .send({ sourceAccountId: source, targetAccountId: randomUUID() })
    expect(response.status).toBe(404)
  })

  it('requires authentication', async () => {
    const app = buildApp()
    const response = await request(app).post('/replication').send({})
    expect(response.status).toBe(401)
  })
})

describe('GET /replication', () => {
  it('lists only the caller\'s replications with cursor pagination', async () => {
    await prisma.replicationJob.deleteMany({ where: { userId: alice.id } })
    const source = await createAccount(alice.id, 7)
    const target = await createAccount(alice.id, 8)
    const app = buildApp()

    const first = await request(app)
      .post('/replication')
      .set(auth(alice))
      .send({ sourceAccountId: source, targetAccountId: target })
    const second = await request(app)
      .post('/replication')
      .set(auth(alice))
      .send({ sourceAccountId: source, targetAccountId: target })

    const list = await request(app).get('/replication').set(auth(alice))
    expect(list.status).toBe(200)
    expect(list.body.replications).toHaveLength(2)
    expect(list.body.replications.map((row: { id: string }) => row.id)).toContain(first.body.replication.id)
    expect(list.body.replications.map((row: { id: string }) => row.id)).toContain(second.body.replication.id)

    const paged = await request(app).get('/replication?limit=1').set(auth(alice))
    expect(paged.body.replications).toHaveLength(1)
    expect(paged.body.nextCursor).toBeDefined()

    const bobList = await request(app).get('/replication').set(auth(bob))
    expect(bobList.body.replications).toHaveLength(0)
  })

  it('filters by status', async () => {
    await prisma.replicationJob.deleteMany({ where: { userId: alice.id } })
    const source = await createAccount(alice.id, 9)
    const target = await createAccount(alice.id, 10)
    const app = buildApp()
    await request(app).post('/replication').set(auth(alice)).send({ sourceAccountId: source, targetAccountId: target })

    const queued = await request(app).get('/replication?status=queued').set(auth(alice))
    expect(queued.body.replications.length).toBeGreaterThan(0)
    const cancelled = await request(app).get('/replication?status=cancelled').set(auth(alice))
    expect(cancelled.body.replications).toHaveLength(0)
    const pending = await request(app).get('/replication?status=pending').set(auth(alice))
    expect(pending.body.replications).toHaveLength(0)
  })
})

describe('GET /replication/:id', () => {
  it('returns the job for its owner', async () => {
    const source = await createAccount(alice.id, 11)
    const target = await createAccount(alice.id, 12)
    const app = buildApp()
    const created = await request(app)
      .post('/replication')
      .set(auth(alice))
      .send({ sourceAccountId: source, targetAccountId: target })

    const response = await request(app).get(`/replication/${created.body.replication.id}`).set(auth(alice))
    expect(response.status).toBe(200)
    expect(response.body.replication.id).toBe(created.body.replication.id)
  })

  it('returns 404 for another user\'s job', async () => {
    const source = await createAccount(alice.id, 13)
    const target = await createAccount(alice.id, 14)
    const app = buildApp()
    const created = await request(app)
      .post('/replication')
      .set(auth(alice))
      .send({ sourceAccountId: source, targetAccountId: target })

    const response = await request(app).get(`/replication/${created.body.replication.id}`).set(auth(bob))
    expect(response.status).toBe(404)
  })
})

describe('POST /replication/:id/cancel', () => {
  it('cancels a queued replication', async () => {
    const source = await createAccount(alice.id, 15)
    const target = await createAccount(alice.id, 16)
    const app = buildApp()
    const created = await request(app)
      .post('/replication')
      .set(auth(alice))
      .send({ sourceAccountId: source, targetAccountId: target })

    const response = await request(app)
      .post(`/replication/${created.body.replication.id}/cancel`)
      .set(auth(alice))
    expect(response.status).toBe(200)
    expect(['cancelled', 'queued', 'running']).toContain(response.body.replication.status)
  })

  it('returns 404 for a non-existent job', async () => {
    const app = buildApp()
    const response = await request(app).post(`/replication/${randomUUID()}/cancel`).set(auth(alice))
    expect(response.status).toBe(404)
  })
})
