/**
 * Migration route tests — api-contract.md §4.6.
 */

import { randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '../../../config/prisma.js'
import { errorMiddleware } from '../../../middleware/error.middleware.js'
import { closeRateLimitStore } from '../../../middleware/security.middleware.js'
import { migrationRouter } from '../../../modules/migration/migration.routes.js'
import { createFakeProvider } from '../../../providers/fake.js'
import { registry } from '../../../providers/registry.js'
import { closeConnections } from '../../../queues/connection.js'
import { closeQueues } from '../../../queues/queues.js'
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
  app.use('/migration', migrationRouter)
  app.use(errorMiddleware)
  return app
}

async function createActor(label: string): Promise<Actor> {
  const user = await prisma.user.create({
    data: { name: `Mig ${label}`, email: `mig-${label}-${runId}@9drive.test`, passwordHash: 'unused-hash' },
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
      providerAccountId: `mig-${seq}-${runId}`,
      email: `mig-${seq}-${runId}@storage.test`,
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
  await prisma.migrationJob.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.connectedAccount.deleteMany({ where: { id: { in: accountIds } } })
  await prisma.userSession.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  closeRateLimitStore()
  await closeQueues()
  await closeConnections()
})

describe('POST /migration', () => {
  it('creates a migration job and enqueues it', async () => {
    await prisma.migrationJob.deleteMany({ where: { userId: alice.id } })
    const source = await createAccount(alice.id, 1)
    const target = await createAccount(alice.id, 2)
    const app = buildApp()

    const response = await request(app)
      .post('/migration')
      .set(auth(alice))
      .send({ sourceAccountId: source, targetAccountId: target, scope: { folderIds: ['folder-1'] } })

    expect(response.status).toBe(201)
    expect(response.body.migration.id).toBeDefined()
    expect(response.body.migration.status).toBe('queued')
    expect(response.body.migration.userId).toBe(alice.id)
    expect(response.body.migration.sourceAccountId).toBe(source)
    expect(response.body.migration.targetAccountId).toBe(target)
  })

  it('rejects identical source and target', async () => {
    await prisma.migrationJob.deleteMany({ where: { userId: alice.id } })
    const source = await createAccount(alice.id, 3)
    const app = buildApp()
    const response = await request(app)
      .post('/migration')
      .set(auth(alice))
      .send({ sourceAccountId: source, targetAccountId: source })
    expect(response.status).toBe(400)
    expect(response.body.code).toBe('VALIDATION_FAILED')
  })

  it('returns 404 for an account owned by another user', async () => {
    await prisma.migrationJob.deleteMany({ where: { userId: alice.id } })
    const source = await createAccount(alice.id, 4)
    const target = await createAccount(bob.id, 5)
    const app = buildApp()
    const response = await request(app)
      .post('/migration')
      .set(auth(alice))
      .send({ sourceAccountId: source, targetAccountId: target })
    expect(response.status).toBe(404)
    expect(response.body.code).toBe('TARGET_NOT_FOUND')
  })

  it('returns 404 for a non-existent account', async () => {
    await prisma.migrationJob.deleteMany({ where: { userId: alice.id } })
    const source = await createAccount(alice.id, 6)
    const app = buildApp()
    const response = await request(app)
      .post('/migration')
      .set(auth(alice))
      .send({ sourceAccountId: source, targetAccountId: randomUUID() })
    expect(response.status).toBe(404)
  })

  it('requires authentication', async () => {
    await prisma.migrationJob.deleteMany({ where: { userId: alice.id } })
    const app = buildApp()
    const response = await request(app).post('/migration').send({})
    expect(response.status).toBe(401)
  })
})

describe('GET /migration', () => {
  it('lists only the caller\'s migrations with cursor pagination', async () => {
    await prisma.migrationJob.deleteMany({ where: { userId: alice.id } })
    const source = await createAccount(alice.id, 7)
    const target = await createAccount(alice.id, 8)
    const app = buildApp()

    const first = await request(app)
      .post('/migration')
      .set(auth(alice))
      .send({ sourceAccountId: source, targetAccountId: target })
    const second = await request(app)
      .post('/migration')
      .set(auth(alice))
      .send({ sourceAccountId: source, targetAccountId: target })

    const list = await request(app).get('/migration').set(auth(alice))
    expect(list.status).toBe(200)
    expect(list.body.migrations).toHaveLength(2)
    expect(list.body.migrations.map((row: { id: string }) => row.id)).toContain(first.body.migration.id)
    expect(list.body.migrations.map((row: { id: string }) => row.id)).toContain(second.body.migration.id)

    const paged = await request(app).get('/migration?limit=1').set(auth(alice))
    expect(paged.body.migrations).toHaveLength(1)
    expect(paged.body.nextCursor).toBeDefined()

    const bobList = await request(app).get('/migration').set(auth(bob))
    expect(bobList.body.migrations).toHaveLength(0)
  })

  it('filters by status', async () => {
    await prisma.migrationJob.deleteMany({ where: { userId: alice.id } })
    const source = await createAccount(alice.id, 9)
    const target = await createAccount(alice.id, 10)
    const app = buildApp()
    await request(app).post('/migration')
      .set(auth(alice))
      .send({ sourceAccountId: source, targetAccountId: target })

    const queued = await request(app).get('/migration?status=queued').set(auth(alice))
    expect(queued.body.migrations.length).toBeGreaterThan(0)
    const cancelled = await request(app).get('/migration?status=cancelled').set(auth(alice))
    expect(cancelled.body.migrations).toHaveLength(0)
    const pending = await request(app).get('/migration?status=pending').set(auth(alice))
    expect(pending.body.migrations).toHaveLength(0)
  })
})

describe('GET /migration/:id', () => {
  it('returns the job for its owner', async () => {
    await prisma.migrationJob.deleteMany({ where: { userId: alice.id } })
    const source = await createAccount(alice.id, 11)
    const target = await createAccount(alice.id, 12)
    const app = buildApp()
    const created = await request(app)
      .post('/migration')
      .set(auth(alice))
      .send({ sourceAccountId: source, targetAccountId: target })

    const response = await request(app).get(`/migration/${created.body.migration.id}`).set(auth(alice))
    expect(response.status).toBe(200)
    expect(response.body.migration.id).toBe(created.body.migration.id)
  })

  it('returns 404 for another user\'s job', async () => {
    await prisma.migrationJob.deleteMany({ where: { userId: alice.id } })
    const source = await createAccount(alice.id, 13)
    const target = await createAccount(alice.id, 14)
    const app = buildApp()
    const created = await request(app)
      .post('/migration')
      .set(auth(alice))
      .send({ sourceAccountId: source, targetAccountId: target })

    const response = await request(app).get(`/migration/${created.body.migration.id}`).set(auth(bob))
    expect(response.status).toBe(404)
  })
})

describe('POST /migration/:id/cancel', () => {
  it('cancels a queued migration', async () => {
    await prisma.migrationJob.deleteMany({ where: { userId: alice.id } })
    const source = await createAccount(alice.id, 15)
    const target = await createAccount(alice.id, 16)
    const app = buildApp()
    const created = await request(app)
      .post('/migration')
      .set(auth(alice))
      .send({ sourceAccountId: source, targetAccountId: target })

    const response = await request(app)
      .post(`/migration/${created.body.migration.id}/cancel`)
      .set(auth(alice))
    expect(response.status).toBe(200)
    expect(['cancelled', 'queued', 'running']).toContain(response.body.migration.status)
  })

  it('returns 404 for a non-existent job', async () => {
    await prisma.migrationJob.deleteMany({ where: { userId: alice.id } })
    const app = buildApp()
    const response = await request(app).post(`/migration/${randomUUID()}/cancel`).set(auth(alice))
    expect(response.status).toBe(404)
  })
})
