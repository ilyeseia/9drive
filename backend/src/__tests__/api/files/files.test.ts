/**
 * Files route tests for §4.8 additions — api-contract §4.8.
 *
 * Tests GET /files stats, copy endpoint, cursor pagination, and filtering
 * by provider/accountId/sort/order. Uses fake providers for isolation.
 */

import { randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../../../config/prisma.js'
import { errorMiddleware } from '../../../middleware/error.middleware.js'
import { fileRouter } from '../../../modules/files/file.routes.js'
import { createFakeProvider } from '../../../providers/fake.js'
import { registry } from '../../../providers/registry.js'
import { closeRateLimitStore } from '../../../middleware/security.middleware.js'
import { hashToken, randomToken } from '../../../utils/crypto.js'
import { signAccessToken } from '../../../utils/jwt.js'
import { buildContext } from '../../../providers/context.js'
import { closeConnections } from '../../../queues/connection.js'
import { closeQueues } from '../../../queues/queues.js'

const runId = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`

type Actor = { id: string; token: string }

let alice: Actor
const userIds: string[] = []
const accountIds: string[] = []

function buildApp() {
  const app = express()
  app.set('trust proxy', 1)
  app.use(express.json())
  app.use('/files', fileRouter)
  app.use(errorMiddleware)
  return app
}

async function createActor(label: string): Promise<Actor> {
  const user = await prisma.user.create({
    data: { name: `Files ${label}`, email: `files-${label}-${runId}@9drive.test`, passwordHash: 'unused-hash' },
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

async function createAccount(userId: string, provider: string): Promise<string> {
  const account = await prisma.connectedAccount.create({
    data: {
      userId,
      provider,
      providerAccountId: `${provider}-${runId}`,
      email: `${provider}-${runId}@storage.test`,
      scopes: [],
      status: 'connected',
    },
  })
  accountIds.push(account.id)
  return account.id
}

beforeEach(async () => {
  await prisma.connectedAccount.deleteMany({ where: { userId: alice?.id } })
})

beforeAll(async () => {
  registry.register(createFakeProvider({ id: 'fake1', authMode: 'api_key' }))
  registry.register(createFakeProvider({ id: 'fake2', authMode: 'api_key' }))
  alice = await createActor('alice')
})

afterAll(async () => {
  await prisma.file.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.folder.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.connectedAccount.deleteMany({ where: { id: { in: accountIds } } })
  await prisma.userSession.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  closeRateLimitStore()
  await closeQueues()
  await closeConnections()
})

describe('GET /files/stats', () => {
  it('returns file and folder counts and total bytes', async () => {
    const account = await createAccount(alice.id, 'fake1')
    const app = buildApp()

    // create two files via upload (need to mock upload; instead insert directly)
    await prisma.file.create({
      data: {
        userId: alice.id,
        connectedAccountId: account,
        provider: 'fake1',
        providerFileId: 'file-1',
        name: 'one.txt',
        mimeType: 'text/plain',
        sizeBytes: 100n,
        status: 'active',
      },
    })
    await prisma.file.create({
      data: {
        userId: alice.id,
        connectedAccountId: account,
        provider: 'fake1',
        providerFileId: 'file-2',
        name: 'two.txt',
        mimeType: 'text/plain',
        sizeBytes: 200n,
        status: 'active',
      },
    })
    await prisma.folder.create({
      data: {
        userId: alice.id,
        name: 'test-folder',
      },
    })

    const response = await request(app).get('/files/stats').set(auth(alice))
    expect(response.status).toBe(200)
    expect(response.body.fileCount).toBe(2)
    expect(response.body.folderCount).toBe(1)
    expect(typeof response.body.bytes).toBe('string')
    expect(response.body.bytes).toContain('300')
  })
})

describe('POST /files/:id/copy', () => {
  it('copies a file via the provider copy capability', async () => {
    const sourceAccount = await createAccount(alice.id, 'fake1')
    const targetAccount = await createAccount(alice.id, 'fake2')
    const app = buildApp()

    // insert a source file directly (bypassing upload)
    const source = await prisma.file.create({
      data: {
        userId: alice.id,
        connectedAccountId: sourceAccount,
        provider: 'fake1',
        providerFileId: 'src-file',
        name: 'source.txt',
        mimeType: 'text/plain',
        sizeBytes: 50n,
        status: 'active',
      },
    })

    // ensure the fake provider declares copy capability
    const fake1 = registry.get('fake1')
    if (!fake1.capabilities.has('copy')) {
      // patch the fake provider at runtime for this test
      const originalFake1 = createFakeProvider({ id: 'fake1', authMode: 'api_key' })
      originalFake1.injectFailure({ operation: 'copy', times: 0 }) // no failure
      // we cannot replace the registry entry easily; instead rely on the fact that
      // the fake provider in the registry is the one we registered in beforeAll,
      // which by default has ALL_CAPABILITIES (including copy) via FakeProvider constructor.
      // So this should already have copy capability.
    }

    const response = await request(app)
      .post(`/files/${source.id}/copy`)
      .set(auth(alice))
      .send({ folderId: null })

    expect(response.status).toBe(201)
    expect(response.body.file.copied).toBe(true)
    expect(response.body.file.id).not.toBe(source.id)
    expect(response.body.file.name).toBe('source.txt')
    expect(response.body.file.provider).toBe('fake1')
    expect(response.body.file.providerFileId).not.toBe('src-file')
  })

  it('returns existing file if destination already exists', async () => {
    const account = await createAccount(alice.id, 'fake1')
    const app = buildApp()

    const source = await prisma.file.create({
      data: {
        userId: alice.id,
        connectedAccountId: account,
        provider: 'fake1',
        providerFileId: 'src-file-dup',
        name: 'source-dup.txt',
        mimeType: 'text/plain',
        sizeBytes: 30n,
        status: 'active',
      },
    })
    const existing = await prisma.file.create({
      data: {
        userId: alice.id,
        connectedAccountId: account,
        provider: 'fake1',
        providerFileId: 'existing-file',
        name: 'source-dup.txt', // same name
        mimeType: 'text/plain',
        sizeBytes: 30n,
        status: 'active',
      },
    })

    const response = await request(app)
      .post(`/files/${source.id}/copy`)
      .set(auth(alice))
      .send({ folderId: null })

    expect(response.status).toBe(200)
    expect(response.body.file.copied).toBe(false)
    expect(response.body.file.id).toBe(existing.id)
  })
})

describe('GET /files (filtering, sorting, pagination)', () => {
  it('filters by provider and accountId, sorts, and paginates with cursor', async () => {
    const acc1 = await createAccount(alice.id, 'fake1')
    const acc2 = await createAccount(alice.id, 'fake2')
    const app = buildApp()

    // create files on both accounts
    await prisma.file.createMany({
      data: [
        {
          userId: alice.id,
          connectedAccountId: acc1,
          provider: 'fake1',
          providerFileId: 'f1-a',
          name: 'alpha.txt',
          mimeType: 'text/plain',
          sizeBytes: 10n,
          status: 'active',
          createdAt: new Date(Date.now() - 2000), // older
        },
        {
          userId: alice.id,
          connectedAccountId: acc1,
          provider: 'fake1',
          providerFileId: 'f1-b',
          name: 'bravo.txt',
          mimeType: 'text/plain',
          sizeBytes: 20n,
          status: 'active',
          createdAt: new Date(Date.now() - 1000),
        },
        {
          userId: alice.id,
          connectedAccountId: acc2,
          provider: 'fake2',
          providerFileId: 'f2-a',
          name: 'charlie.txt',
          mimeType: 'text/plain',
          sizeBytes: 30n,
          status: 'active',
          createdAt: new Date(Date.now()), // newest
        },
      ],
    })

    // filter by provider=fake1, sort by name asc
    let response = await request(app)
      .get('/files?provider=fake1&sort=name&order=asc')
      .set(auth(alice))
    expect(response.status).toBe(200)
    expect(response.body.files).toHaveLength(2)
    expect(response.body.files.map((f: { name: string }) => f.name)).toEqual(['alpha.txt', 'bravo.txt'])
    expect(response.body.nextCursor).toBeDefined()

    // paginate: limit=1
    response = await request(app)
      .get('/files?provider=fake1&sort=name&order=asc&limit=1')
      .set(auth(alice))
    expect(response.status).toBe(200)
    expect(response.body.files).toHaveLength(1)
    expect(response.body.files[0].name).toBe('alpha.txt')
    expect(response.body.nextCursor).toBeDefined()

    // use cursor to get next
    const cursor = response.body.nextCursor
    response = await request(app)
      .get(`/files?provider=fake1&sort=name&order=asc&cursor=${cursor}`)
      .set(auth(alice))
    expect(response.status).toBe(200)
    expect(response.body.files).toHaveLength(1)
    expect(response.body.files[0].name).toBe('bravo.txt')
    expect(response.body.nextCursor).toBeNull()

    // filter by accountId=acc2
    response = await request(app)
      .get(`/files?accountId=${acc2}`)
      .set(auth(alice))
    expect(response.status).toBe(200)
    expect(response.body.files).toHaveLength(1)
    expect(response.body.files[0].provider).toBe('fake2')
    expect(response.body.files[0].name).toBe('charlie.txt')
  })
})
