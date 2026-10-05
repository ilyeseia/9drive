/**
 * Wave 5 routing integration tests — api-contract.md §4.4 and §6.
 * Covers GET/PATCH /routing/policies, the PATCH /storage/routing-policy
 * superset body and the POST /routing/preview dry run (including the
 * round-robin cursor rollback).
 */

import { randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '../../../config/prisma.js'
import { errorMiddleware } from '../../../middleware/error.middleware.js'
import { closeRateLimitStore } from '../../../middleware/security.middleware.js'
import { createFakeProvider } from '../../../providers/fake.js'
import { registry } from '../../../providers/registry.js'
import { routingRouter } from '../../../modules/routing/routing.routes.js'
import { storageRouter } from '../../../modules/storage/storage.routes.js'
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

let s3AccountId = ''
let driveAccountId = ''
let aliceFolderId = ''
let bobFolderId = ''

function buildApp() {
  const app = express()
  app.set('trust proxy', 1)
  app.use(express.json())
  app.use('/routing', routingRouter)
  app.use('/storage', storageRouter)
  app.use(errorMiddleware)
  return app
}

async function createActor(label: string): Promise<Actor> {
  const user = await prisma.user.create({
    data: { name: `Route ${label}`, email: `route-${label}-${runId}@9drive.test`, passwordHash: 'unused-hash' },
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

async function createAccount(
  userId: string,
  options: { provider: string; seq: number; available: bigint; used: bigint },
): Promise<string> {
  const account = await prisma.connectedAccount.create({
    data: {
      userId,
      provider: options.provider,
      providerAccountId: `route-${options.seq}-${runId}`,
      email: `route-${options.seq}-${runId}@storage.test`,
      scopes: [],
    },
  })
  accountIds.push(account.id)
  await prisma.storageAccount.create({
    data: {
      connectedAccountId: account.id,
      totalBytes: options.available + options.used,
      usedBytes: options.used,
      availableBytes: options.available,
      lastSyncedAt: new Date(),
    },
  })
  return account.id
}

beforeAll(async () => {
  registry.register(createFakeProvider({ id: 's3', authMode: 'access_key' }))
  registry.register(createFakeProvider({ id: 'google_drive', authMode: 'oauth2' }))

  alice = await createActor('alice')
  bob = await createActor('bob')

  s3AccountId = await createAccount(alice.id, { provider: 's3', seq: 1, available: 900n, used: 100n })
  driveAccountId = await createAccount(alice.id, { provider: 'google_drive', seq: 2, available: 500n, used: 500n })
  await createAccount(alice.id, { provider: 'weird_x', seq: 3, available: 9_999n, used: 0n })

  const aliceFolder = await prisma.folder.create({
    data: { userId: alice.id, name: 'bound', provider: 's3', connectedAccountId: s3AccountId },
  })
  aliceFolderId = aliceFolder.id
  const bobFolder = await prisma.folder.create({
    data: { userId: bob.id, name: 'bob-bound' },
  })
  bobFolderId = bobFolder.id
})

afterAll(async () => {
  await closeQueues()
  await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.userSession.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  await closeConnections()
  await closeRateLimitStore()
  await prisma.$disconnect()
})

describe('GET /routing/policies', () => {
  it('creates a default policy for a new user', async () => {
    const res = await request(buildApp()).get('/routing/policies').set(auth(bob))
    expect(res.status).toBe(200)
    expect(res.body.policy.mode).toBe('most_available')
    expect(res.body.policy.priorityAccountIds).toEqual([])
    expect(res.body.policy.roundRobinCursor).toBe(0)
    expect(res.body.policy.updatedAt).toBeTruthy()
  })

  it('requires authentication', async () => {
    const res = await request(buildApp()).get('/routing/policies')
    expect(res.status).toBe(401)
  })
})

describe('POST /routing/preview', () => {
  it('picks an account and explains every elimination step', async () => {
    const res = await request(buildApp())
      .post('/routing/preview')
      .set(auth(alice))
      .send({ bytes: 100, fileType: 'application/pdf' })
    expect(res.status).toBe(200)
    expect(res.body.account).not.toBeNull()
    expect(res.body.account.provider).toBe('s3')
    expect(res.body.bytes).toBe('100')
    expect(res.body.mode).toBe('most_available')

    const stepNames = (res.body.steps as Array<{ step: string }>).map((step) => step.step)
    expect(stepNames).toEqual(['connected', 'provider_supported', 'capabilities', 'quota_headroom', 'health', 'mode', 'selected'])

    const unsupported = (res.body.steps as Array<{ step: string; eliminated: number; detail: string }>).find(
      (step) => step.step === 'provider_supported',
    )
    expect(unsupported?.eliminated).toBe(1)
    expect(unsupported?.detail).toContain('weird_x')
    expect(res.body.reason).toContain('mode=most_available')
  })

  it('reports no eligible account when nothing has the headroom', async () => {
    const res = await request(buildApp()).post('/routing/preview').set(auth(alice)).send({ bytes: 5000 })
    expect(res.status).toBe(200)
    expect(res.body.account).toBeNull()
    expect(res.body.reason).toMatch(/^no eligible account/)
  })

  it('404s for unknown or foreign folders', async () => {
    const unknown = await request(buildApp())
      .post('/routing/preview')
      .set(auth(alice))
      .send({ bytes: 100, folderId: randomUUID() })
    expect(unknown.status).toBe(404)
    expect(unknown.body.code).toBe('NOT_FOUND')

    const foreign = await request(buildApp())
      .post('/routing/preview')
      .set(auth(alice))
      .send({ bytes: 100, folderId: bobFolderId })
    expect(foreign.status).toBe(404)
  })

  it('pins the choice to the folder-bound account', async () => {
    const res = await request(buildApp())
      .post('/routing/preview')
      .set(auth(alice))
      .send({ bytes: 100, folderId: aliceFolderId })
    expect(res.status).toBe(200)
    expect(res.body.account.id).toBe(s3AccountId)
    const first = (res.body.steps as Array<{ step: string }>)[0]
    expect(first.step).toBe('target')
  })

  it('rejects malformed bodies', async () => {
    const negative = await request(buildApp()).post('/routing/preview').set(auth(alice)).send({ bytes: -1 })
    expect(negative.status).toBe(400)
    expect(negative.body.code).toBe('VALIDATION_FAILED')

    const missing = await request(buildApp()).post('/routing/preview').set(auth(alice)).send({})
    expect(missing.status).toBe(400)
  })
})

describe('PATCH /routing/policies', () => {
  it('persists the superset body and drops unknown priority accounts', async () => {
    const res = await request(buildApp())
      .patch('/routing/policies')
      .set(auth(alice))
      .send({
        mode: 'file_size',
        priorityAccountIds: [driveAccountId, randomUUID()],
        fileTypeRules: [{ match: 'video/*', preferProvider: 's3' }],
        minFileSizeBytes: 100,
        maxFileSizeBytes: '1000',
      })
    expect(res.status).toBe(200)
    expect(res.body.policy.mode).toBe('file_size')
    expect(res.body.policy.priorityAccountIds).toEqual([driveAccountId])
    expect(res.body.policy.fileTypeRules).toEqual([{ match: 'video/*', preferProvider: 's3' }])
    expect(res.body.policy.minFileSizeBytes).toBe('100')
    expect(res.body.policy.maxFileSizeBytes).toBe('1000')
    expect(res.body.policy.roundRobinCursor).toBe(0)
  })

  it('matches file_type rules in the preview', async () => {
    await request(buildApp())
      .patch('/routing/policies')
      .set(auth(alice))
      .send({ mode: 'file_type', fileTypeRules: [{ match: 'image/*', preferProvider: 'google_drive' }] })
      .expect(200)

    const res = await request(buildApp())
      .post('/routing/preview')
      .set(auth(alice))
      .send({ bytes: 100, fileType: 'image/png' })
    expect(res.status).toBe(200)
    expect(res.body.matchedRule).toMatchObject({ match: 'image/*', preferProvider: 'google_drive' })
    expect(res.body.account.provider).toBe('google_drive')
    expect(res.body.reason).toContain("file_type rule 'image/*' matched 'image/png'")
  })

  it('rolls the round-robin cursor back after a preview', async () => {
    await request(buildApp()).patch('/routing/policies').set(auth(alice)).send({ mode: 'round_robin' }).expect(200)
    const before = await request(buildApp()).get('/routing/policies').set(auth(alice))
    const cursorBefore = before.body.policy.roundRobinCursor

    const preview = await request(buildApp()).post('/routing/preview').set(auth(alice)).send({ bytes: 100 })
    expect(preview.status).toBe(200)
    expect(preview.body.account).not.toBeNull()

    const after = await request(buildApp()).get('/routing/policies').set(auth(alice))
    expect(after.body.policy.roundRobinCursor).toBe(cursorBefore)
  })

  it('rejects unknown modes and inverted size windows', async () => {
    const badMode = await request(buildApp()).patch('/routing/policies').set(auth(alice)).send({ mode: 'bogus' })
    expect(badMode.status).toBe(400)
    expect(badMode.body.code).toBe('VALIDATION_FAILED')

    const inverted = await request(buildApp())
      .patch('/routing/policies')
      .set(auth(alice))
      .send({ minFileSizeBytes: 100, maxFileSizeBytes: 50 })
    expect(inverted.status).toBe(400)
    expect(inverted.body.message).toContain('minFileSizeBytes')
  })
})

describe('PATCH /storage/routing-policy', () => {
  it('accepts the extended body', async () => {
    const res = await request(buildApp())
      .patch('/storage/routing-policy')
      .set(auth(alice))
      .send({
        mode: 'least_used',
        priorityAccountIds: [s3AccountId],
        fileTypeRules: [{ match: '*' }],
        minFileSizeBytes: 10,
        maxFileSizeBytes: '5000',
      })
    expect(res.status).toBe(200)
    expect(res.body.policy.mode).toBe('least_used')
    expect(res.body.policy.priorityAccountIds).toEqual([s3AccountId])
    expect(res.body.policy.fileTypeRules).toEqual([{ match: '*' }])
    expect(res.body.policy.minFileSizeBytes).toBe('10')
    expect(res.body.policy.maxFileSizeBytes).toBe('5000')

    const audit = await prisma.auditLog.findFirst({
      where: { userId: alice.id, action: 'UPDATE_ROUTING_POLICY' },
      orderBy: { createdAt: 'desc' },
    })
    expect(audit).not.toBeNull()
  })

  it('still accepts the original body shape', async () => {
    const res = await request(buildApp())
      .patch('/storage/routing-policy')
      .set(auth(alice))
      .send({ mode: 'priority', priorityAccountIds: [driveAccountId] })
    expect(res.status).toBe(200)
    expect(res.body.policy.mode).toBe('priority')
  })

  it('rejects invalid modes', async () => {
    const res = await request(buildApp())
      .patch('/storage/routing-policy')
      .set(auth(alice))
      .send({ mode: 'not-a-mode' })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('VALIDATION_FAILED')
  })

  it('requires authentication', async () => {
    const res = await request(buildApp()).patch('/storage/routing-policy').send({ mode: 'priority' })
    expect(res.status).toBe(401)
  })
})

describe('routing policy isolation', () => {
  it('keeps each tenant on its own policy row', async () => {
    const bobPatch = await request(buildApp())
      .patch('/routing/policies')
      .set(auth(bob))
      .send({ mode: 'priority', priorityAccountIds: ['some-account'] })
    expect(bobPatch.status).toBe(200)
    expect(bobPatch.body.policy.mode).toBe('priority')
    expect(bobPatch.body.policy.priorityAccountIds).toEqual([])

    const alicePolicy = await request(buildApp()).get('/routing/policies').set(auth(alice))
    expect(alicePolicy.body.policy.mode).toBe('least_used')
    expect(alicePolicy.body.policy.priorityAccountIds).toEqual([s3AccountId])
  })
})
