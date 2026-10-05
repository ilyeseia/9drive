/**
 * Wave 5 jobs API integration tests — api-contract.md §4.3, job-contract.md §6.
 * Real Postgres + Redis: session auth, cursor paging, retry/cancel/delete rules
 * and API-key scope enforcement are exercised end to end.
 */

import express from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '../../../config/prisma.js'
import { errorMiddleware } from '../../../middleware/error.middleware.js'
import { closeRateLimitStore } from '../../../middleware/security.middleware.js'
import { jobsRouter } from '../../../modules/jobs/jobs.routes.js'
import { closeConnections } from '../../../queues/connection.js'
import { isJobType } from '../../../queues/job-types.js'
import { closeQueues, enqueueJob, getQueue, queueNameForType } from '../../../queues/queues.js'
import { hashToken, randomToken } from '../../../utils/crypto.js'
import { signAccessToken } from '../../../utils/jwt.js'

const runId = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`

type Actor = { id: string; token: string }

let alice: Actor
let bob: Actor
const userIds: string[] = []

let completedJobId = ''
let invalidPayloadJobId = ''
let queuedJobId = ''
let deleteCandidateId = ''
let bobJobId = ''
let aliceKeySecret = ''
let wrongScopeKeySecret = ''

function buildApp() {
  const app = express()
  app.set('trust proxy', 1)
  app.use(express.json())
  app.use('/jobs', jobsRouter)
  app.use(errorMiddleware)
  return app
}

async function createActor(label: string): Promise<Actor> {
  const user = await prisma.user.create({
    data: { name: `Jobs ${label}`, email: `jobs-${label}-${runId}@9drive.test`, passwordHash: 'unused-hash' },
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

  queuedJobId = await enqueueJob('CLEANUP', { userId: alice.id, scope: 'all' })
  const completed = await prisma.job.create({
    data: {
      userId: alice.id,
      type: 'CLEANUP',
      status: 'completed',
      priority: 0,
      payload: { userId: alice.id, scope: 'all' },
      progress: 100,
      finishedAt: new Date(),
    },
  })
  completedJobId = completed.id
  const invalid = await prisma.job.create({
    data: {
      userId: alice.id,
      type: 'CLEANUP',
      status: 'failed',
      payload: { userId: alice.id },
      error: 'ValidationError: scope is required',
      finishedAt: new Date(),
    },
  })
  invalidPayloadJobId = invalid.id
  const deleteCandidate = await prisma.job.create({
    data: { userId: alice.id, type: 'SYNC', status: 'failed', payload: { userId: alice.id, accountId: 'acct-1' } },
  })
  deleteCandidateId = deleteCandidate.id
  bobJobId = await enqueueJob('HEALTH_CHECK', { userId: bob.id })

  aliceKeySecret = `9d_live_${randomToken(16)}`
  wrongScopeKeySecret = `9d_live_${randomToken(16)}`
  await prisma.apiKey.create({
    data: {
      userId: alice.id,
      name: 'jobs-read-key',
      keyPrefix: aliceKeySecret.slice(0, 16),
      keyHash: hashToken(aliceKeySecret),
      scopes: ['jobs:read'],
    },
  })
  await prisma.apiKey.create({
    data: {
      userId: alice.id,
      name: 'providers-read-key',
      keyPrefix: wrongScopeKeySecret.slice(0, 16),
      keyHash: hashToken(wrongScopeKeySecret),
      scopes: ['providers:read'],
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
  await prisma.job.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.userSession.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  await closeConnections()
  await closeRateLimitStore()
  await prisma.$disconnect()
})

describe('GET /jobs', () => {
  it('lists only the caller jobs with status and type filters', async () => {
    const list = await request(buildApp()).get('/jobs').set(auth(alice))
    expect(list.status).toBe(200)
    expect(list.body.items.length).toBeGreaterThanOrEqual(4)
    expect(list.body.items.every((job: { userId: string }) => job.userId === alice.id)).toBe(true)
    expect(list.body.items.some((job: { id: string }) => job.id === completedJobId)).toBe(true)
    expect(list.body.items.some((job: { id: string }) => job.id === bobJobId)).toBe(false)

    const completedOnly = await request(buildApp()).get('/jobs?status=completed').set(auth(alice))
    expect(completedOnly.status).toBe(200)
    expect(completedOnly.body.items.every((job: { status: string }) => job.status === 'completed')).toBe(true)

    const cleanupOnly = await request(buildApp()).get('/jobs?type=CLEANUP').set(auth(alice))
    expect(cleanupOnly.status).toBe(200)
    expect(cleanupOnly.body.items.every((job: { type: string }) => job.type === 'CLEANUP')).toBe(true)
  })

  it('rejects unknown status filters', async () => {
    const res = await request(buildApp()).get('/jobs?status=bogus').set(auth(alice))
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('VALIDATION_FAILED')
  })

  it('walks the cursor without overlaps', async () => {
    const first = await request(buildApp()).get('/jobs?limit=1').set(auth(alice))
    expect(first.status).toBe(200)
    expect(first.body.items).toHaveLength(1)
    expect(first.body.nextCursor).toBeTruthy()

    const second = await request(buildApp())
      .get(`/jobs?limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`)
      .set(auth(alice))
    expect(second.status).toBe(200)
    expect(second.body.items).toHaveLength(1)
    expect(second.body.items[0].id).not.toBe(first.body.items[0].id)

    const invalid = await request(buildApp()).get('/jobs?cursor=not-a-cursor').set(auth(alice))
    expect(invalid.status).toBe(400)
    expect(invalid.body.code).toBe('VALIDATION_FAILED')
  })

  it('requires authentication', async () => {
    const res = await request(buildApp()).get('/jobs')
    expect(res.status).toBe(401)
  })
})

describe('GET /jobs/:id', () => {
  it('returns the job to its owner only', async () => {
    const owned = await request(buildApp()).get(`/jobs/${completedJobId}`).set(auth(alice))
    expect(owned.status).toBe(200)
    expect(owned.body.job.id).toBe(completedJobId)
    expect(owned.body.job.type).toBe('CLEANUP')
    expect(owned.body.job.finishedAt).toBeTruthy()

    const foreign = await request(buildApp()).get(`/jobs/${completedJobId}`).set(auth(bob))
    expect(foreign.status).toBe(404)
    expect(foreign.body.code).toBe('NOT_FOUND')

    const malformed = await request(buildApp()).get('/jobs/not-a-uuid').set(auth(alice))
    expect(malformed.status).toBe(400)
  })

  it('404s for a job the caller does not own', async () => {
    const res = await request(buildApp()).get(`/jobs/${bobJobId}`).set(auth(alice))
    expect(res.status).toBe(404)
  })
})

describe('POST /jobs/:id/retry', () => {
  it('creates a new job from a finished one', async () => {
    const res = await request(buildApp()).post(`/jobs/${completedJobId}/retry`).set(auth(alice))
    expect(res.status).toBe(201)
    expect(res.body.retryOf).toBe(completedJobId)
    expect(res.body.job.id).not.toBe(completedJobId)
    expect(res.body.job.status).toBe('queued')
    expect(res.body.job.type).toBe('CLEANUP')

    const audit = await prisma.auditLog.findFirst({
      where: { userId: alice.id, action: 'RETRY_JOB', entityId: res.body.job.id },
    })
    expect(audit).not.toBeNull()

    const original = await prisma.job.findUnique({ where: { id: completedJobId } })
    expect(original?.status).toBe('completed')
  })

  it('rejects retrying unfinished jobs', async () => {
    const res = await request(buildApp()).post(`/jobs/${queuedJobId}/retry`).set(auth(alice))
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('CONFLICT')
  })

  it('rejects retrying jobs whose payload is no longer valid', async () => {
    const res = await request(buildApp()).post(`/jobs/${invalidPayloadJobId}/retry`).set(auth(alice))
    expect(res.status).toBe(409)
    expect(res.body.message).toContain('payload')
  })

  it('does not leak foreign jobs', async () => {
    const res = await request(buildApp()).post(`/jobs/${bobJobId}/retry`).set(auth(alice))
    expect(res.status).toBe(404)
  })
})

describe('POST /jobs/:id/cancel', () => {
  it('cancels a queued job', async () => {
    const cancelTarget = await enqueueJob('METADATA_INDEXING', { userId: alice.id, accountId: 'acct-1' })
    const res = await request(buildApp()).post(`/jobs/${cancelTarget}/cancel`).set(auth(alice))
    expect(res.status).toBe(200)
    expect(res.body.job.status).toBe('cancelled')

    const again = await request(buildApp()).post(`/jobs/${cancelTarget}/cancel`).set(auth(alice))
    expect(again.status).toBe(409)
  })

  it('rejects cancelling finished jobs', async () => {
    const res = await request(buildApp()).post(`/jobs/${completedJobId}/cancel`).set(auth(alice))
    expect(res.status).toBe(409)
  })

  it('does not cancel foreign jobs', async () => {
    const res = await request(buildApp()).post(`/jobs/${queuedJobId}/cancel`).set(auth(bob))
    expect(res.status).toBe(404)
    const stillQueued = await prisma.job.findUnique({ where: { id: queuedJobId } })
    expect(stillQueued?.status).toBe('queued')
  })
})

describe('DELETE /jobs/:id', () => {
  it('rejects deleting unfinished jobs', async () => {
    const res = await request(buildApp()).delete(`/jobs/${queuedJobId}`).set(auth(alice))
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('CONFLICT')
  })

  it('deletes finished jobs', async () => {
    const res = await request(buildApp()).delete(`/jobs/${deleteCandidateId}`).set(auth(alice))
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ok')
    const row = await prisma.job.findUnique({ where: { id: deleteCandidateId } })
    expect(row).toBeNull()
  })

  it('does not delete foreign jobs', async () => {
    const res = await request(buildApp()).delete(`/jobs/${bobJobId}`).set(auth(alice))
    expect(res.status).toBe(404)
    const row = await prisma.job.findUnique({ where: { id: bobJobId } })
    expect(row).not.toBeNull()
  })
})

describe('API key access', () => {
  it('accepts a key with the jobs:read scope', async () => {
    const res = await request(buildApp()).get('/jobs').set('Authorization', `Bearer ${aliceKeySecret}`)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.items)).toBe(true)
  })

  it('rejects a key without the jobs:read scope', async () => {
    const res = await request(buildApp()).get('/jobs').set('Authorization', `Bearer ${wrongScopeKeySecret}`)
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('API_KEY_FORBIDDEN')
  })

  it('rejects an invalid key', async () => {
    const res = await request(buildApp()).get('/jobs').set('Authorization', 'Bearer 9d_live_totally-invalid')
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('API_KEY_INVALID')
  })
})
