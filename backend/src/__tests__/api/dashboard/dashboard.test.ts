/**
 * Wave 5 dashboard integration tests — api-contract.md §4.2.
 * The summary aggregates capacity, accounts, health, files, jobs and recent
 * operations for one tenant only; every byte counter serialises as a string.
 */

import express from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '../../../config/prisma.js'
import { errorMiddleware } from '../../../middleware/error.middleware.js'
import { closeRateLimitStore } from '../../../middleware/security.middleware.js'
import { dashboardRouter } from '../../../modules/dashboard/dashboard.routes.js'
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

let degradedAccountId = ''
let unauthorizedAccountId = ''
let apiKeySecret = ''

function buildApp() {
  const app = express()
  app.set('trust proxy', 1)
  app.use(express.json())
  app.use('/dashboard', dashboardRouter)
  app.use(errorMiddleware)
  return app
}

async function createActor(label: string): Promise<Actor> {
  const user = await prisma.user.create({
    data: { name: `Dash ${label}`, email: `dash-${label}-${runId}@9drive.test`, passwordHash: 'unused-hash' },
  })
  userIds.push(user.id)
  const session = await prisma.userSession.create({
    data: { userId: user.id, refreshTokenHash: hashToken(randomToken()), expiresAt: new Date(Date.now() + 3_600_000) },
  })
  return { id: user.id, token: signAccessToken({ sub: user.id, sid: session.id }) }
}

async function createAccount(
  userId: string,
  options: {
    provider: string
    seq: number
    status?: string
    totalBytes: bigint
    usedBytes: bigint
    availableBytes: bigint
    health?: string
  },
): Promise<string> {
  const account = await prisma.connectedAccount.create({
    data: {
      userId,
      provider: options.provider,
      providerAccountId: `dash-${options.seq}-${runId}`,
      email: `dash-${options.seq}-${runId}@storage.test`,
      scopes: [],
      ...(options.status ? { status: options.status } : {}),
    },
  })
  accountIds.push(account.id)
  await prisma.storageAccount.create({
    data: {
      connectedAccountId: account.id,
      totalBytes: options.totalBytes,
      usedBytes: options.usedBytes,
      availableBytes: options.availableBytes,
      lastSyncedAt: new Date(),
    },
  })
  if (options.health) {
    await prisma.providerHealth.create({
      data: {
        provider: options.provider,
        connectedAccountId: account.id,
        state: options.health,
        checkedAt: new Date(),
      },
    })
  }
  return account.id
}

beforeAll(async () => {
  alice = await createActor('alice')
  bob = await createActor('bob')

  const aliceAccount = await createAccount(alice.id, {
    provider: 's3',
    seq: 1,
    totalBytes: 1_000n,
    usedBytes: 400n,
    availableBytes: 600n,
  })
  degradedAccountId = await createAccount(alice.id, {
    provider: 'google_drive',
    seq: 2,
    totalBytes: 2_000n,
    usedBytes: 1_000n,
    availableBytes: 1_000n,
    health: 'degraded',
  })
  unauthorizedAccountId = await createAccount(alice.id, {
    provider: 'dropbox',
    seq: 3,
    status: 'unauthorized',
    totalBytes: 5_000n,
    usedBytes: 0n,
    availableBytes: 5_000n,
    health: 'unauthorized',
  })

  await prisma.file.create({
    data: {
      userId: alice.id,
      connectedAccountId: aliceAccount,
      provider: 's3',
      providerFileId: `dash-f1-${runId}`,
      name: 'photo.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 100n,
    },
  })
  await prisma.file.create({
    data: {
      userId: alice.id,
      connectedAccountId: aliceAccount,
      provider: 's3',
      providerFileId: `dash-f2-${runId}`,
      name: 'notes.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 250n,
    },
  })
  await prisma.file.create({
    data: {
      userId: alice.id,
      connectedAccountId: aliceAccount,
      provider: 's3',
      providerFileId: `dash-f3-${runId}`,
      name: 'trashed.bin',
      mimeType: 'application/octet-stream',
      sizeBytes: 999n,
      status: 'trashed',
    },
  })

  for (const status of ['queued', 'failed', 'completed']) {
    await prisma.job.create({
      data: { userId: alice.id, type: 'CLEANUP', status, payload: { userId: alice.id, scope: 'all' } },
    })
  }

  for (let i = 0; i < 12; i += 1) {
    await prisma.storageOperation.create({
      data: {
        userId: alice.id,
        accountId: aliceAccount,
        provider: 's3',
        operation: 'upload',
        status: i % 3 === 0 ? 'error' : 'ok',
        createdAt: new Date(Date.now() - i * 1_000),
      },
    })
  }

  apiKeySecret = `9d_live_${randomToken(16)}`
  await prisma.apiKey.create({
    data: {
      userId: alice.id,
      name: 'dash-providers-key',
      keyPrefix: apiKeySecret.slice(0, 16),
      keyHash: hashToken(apiKeySecret),
      scopes: ['providers:read'],
    },
  })
})

afterAll(async () => {
  await closeQueues()
  await prisma.providerHealth.deleteMany({ where: { connectedAccountId: { in: accountIds } } })
  await prisma.storageOperation.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.job.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.userSession.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  await closeConnections()
  await closeRateLimitStore()
  await prisma.$disconnect()
})

describe('GET /dashboard/summary', () => {
  it('aggregates capacity, accounts, files, jobs and recent operations', async () => {
    const res = await request(buildApp()).get('/dashboard/summary').set('Authorization', `Bearer ${alice.token}`)
    expect(res.status).toBe(200)
    const body = res.body

    expect(body.capacity).toEqual({ totalBytes: '3000', usedBytes: '1400', availableBytes: '1600' })
    expect(typeof body.capacity.totalBytes).toBe('string')

    expect(body.accounts).toEqual({ total: 3, connected: 2, degraded: 1, unauthorized: 1 })

    expect(body.byProvider).toEqual([
      { provider: 'google_drive', accounts: 1, usedBytes: '1000', totalBytes: '2000' },
      { provider: 's3', accounts: 1, usedBytes: '400', totalBytes: '1000' },
    ])

    expect(body.files).toEqual({ count: 2, bytes: '350' })

    expect(body.health).toHaveLength(3)
    const healthByAccount = new Map<string, string>(
      (body.health as Array<{ accountId: string; state: string }>).map((row) => [row.accountId, row.state]),
    )
    expect(healthByAccount.get(degradedAccountId)).toBe('degraded')
    expect(healthByAccount.get(unauthorizedAccountId)).toBe('unauthorized')
    const unknownHealth = [...healthByAccount.values()].filter((state) => state === 'unknown')
    expect(unknownHealth).toHaveLength(1)

    expect(body.jobs).toEqual({ queued: 1, active: 0, failed: 1, completed: 1 })

    expect(body.recentOperations).toHaveLength(10)
    const timestamps = (body.recentOperations as Array<{ createdAt: string }>).map((row) => Date.parse(row.createdAt))
    for (let i = 1; i < timestamps.length; i += 1) {
      expect(timestamps[i]).toBeLessThanOrEqual(timestamps[i - 1])
    }
    expect(body.recentOperations[0].status).toMatch(/ok|error/)
  })

  it('never mixes another tenant into the summary', async () => {
    const res = await request(buildApp()).get('/dashboard/summary').set('Authorization', `Bearer ${bob.token}`)
    expect(res.status).toBe(200)
    expect(res.body.capacity).toEqual({ totalBytes: '0', usedBytes: '0', availableBytes: '0' })
    expect(res.body.accounts).toEqual({ total: 0, connected: 0, degraded: 0, unauthorized: 0 })
    expect(res.body.byProvider).toEqual([])
    expect(res.body.files).toEqual({ count: 0, bytes: '0' })
    expect(res.body.health).toEqual([])
    expect(res.body.recentOperations).toEqual([])
  })

  it('accepts an API key with the providers:read scope', async () => {
    const res = await request(buildApp()).get('/dashboard/summary').set('Authorization', `Bearer ${apiKeySecret}`)
    expect(res.status).toBe(200)
    expect(res.body.accounts.total).toBe(3)
  })

  it('requires authentication', async () => {
    const res = await request(buildApp()).get('/dashboard/summary')
    expect(res.status).toBe(401)
  })
})
