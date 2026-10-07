import { randomUUID, createHmac } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { createServer, type Server } from 'node:http'
import type { Job as JobRow } from '@prisma/client'
import { Queue } from 'bullmq'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '../../config/prisma.js'
import { cancelMarkerKey, requestJobCancel } from '../../queues/cancel.js'
import { closeConnections, createRedisConnection, getAppConnection } from '../../queues/connection.js'
import { tryLock } from '../../queues/locks.js'
import { flushWrites } from '../../queues/mirror.js'
import { enqueueJob, getQueue, setQueuePrefix } from '../../queues/queues.js'
import type { JobPayloads } from '../../queues/job-types.js'
import { encryptText } from '../../utils/crypto.js'
import { PermanentJobError } from '../../worker/errors.js'
import { startWorkerRuntime, type WorkerRuntime } from '../../worker/runtime.js'
import type { JobHandler } from '../../worker/types.js'

const PREFIX = `9drive-test-${process.pid}-${Date.now()}`
const TEST_QUEUES = ['retry', 'maintenance', 'webhook'] as const
const WEBHOOK_SECRET = 'test-webhook-secret'
const originalAllowInsecure = process.env.ALLOW_INSECURE_ENDPOINTS
const originalAllowlist = process.env.SSRF_ALLOWLIST

process.env.ALLOW_INSECURE_ENDPOINTS = 'true'
process.env.SSRF_ALLOWLIST = '127.0.0.1'
setQueuePrefix(PREFIX)

const createdJobIds: string[] = []
const createdStorageOperationIds: string[] = []
const createdDeliveryIds: string[] = []
const createdSubscriptionIds: string[] = []

type RetryMode = 'ok' | 'permanent' | 'retryable' | 'progress-fail'
let retryMode: RetryMode = 'ok'
let runtime: WorkerRuntime | undefined

const retryTestHandler: JobHandler<JobPayloads['RETRY']> = async (ctx) => {
  if (retryMode === 'ok') return { ok: true, kind: ctx.payload.kind, refId: ctx.payload.refId }
  if (retryMode === 'permanent') throw new PermanentJobError('permanent failure for test')
  if (retryMode === 'retryable') throw new Error('transient boom')
  ctx.reportProgress(42)
  throw new PermanentJobError('failed after progress')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForRow(id: string, predicate: (row: JobRow) => boolean, timeoutMs = 20_000): Promise<JobRow> {
  const deadline = Date.now() + timeoutMs
  let last: JobRow | null = null
  while (Date.now() < deadline) {
    last = await prisma.job.findUnique({ where: { id } })
    if (last && predicate(last)) return last
    await sleep(100)
  }
  throw new Error(
    `timed out waiting for job ${id}; last=${JSON.stringify(
      last && { status: last.status, attempts: last.attempts, error: last.error },
    )}`,
  )
}

function trackJob(id: string): string {
  createdJobIds.push(id)
  return id
}

interface CapturedRequest {
  method?: string
  url?: string
  headers: Record<string, string | string[] | undefined>
  body: string
}

const capturedRequests: CapturedRequest[] = []
let webhookServerMode: 'ok' | 'error' = 'ok'
let webhookServer: Server | null = null
let webhookPort = 0

beforeAll(async () => {
  webhookServer = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      capturedRequests.push({
        method: request.method,
        url: request.url,
        headers: { ...request.headers },
        body: Buffer.concat(chunks).toString('utf8'),
      })
      if (webhookServerMode === 'ok') {
        response.writeHead(200, { 'content-type': 'text/plain' })
        response.end('ok')
      } else {
        response.writeHead(500, { 'content-type': 'text/plain' })
        response.end('boom')
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    webhookServer?.once('error', reject)
    webhookServer?.listen(0, '127.0.0.1', () => resolve())
  })
  webhookPort = (webhookServer?.address() as AddressInfo).port

  runtime = await startWorkerRuntime({
    prefix: PREFIX,
    queues: TEST_QUEUES,
    schedules: false,
    healthPort: 0,
    handlers: { RETRY: retryTestHandler },
  })
  await runtime.start()
}, 30_000)

afterAll(async () => {
  if (runtime?.ready()) await runtime.shutdown('afterAll')
  const cleanupConnection = createRedisConnection('queue-test-cleanup')
  for (const queueName of ['retry', 'maintenance', 'webhook']) {
    const queue = new Queue(queueName, { connection: cleanupConnection, prefix: PREFIX })
    try {
      await queue.obliterate({ force: true })
    } catch {
      // obliterate is best-effort cleanup
    }
    await queue.close()
  }
  if (createdJobIds.length > 0) await getAppConnection().del(createdJobIds.map(cancelMarkerKey))
  await closeConnections()
  if (createdJobIds.length > 0) await prisma.job.deleteMany({ where: { id: { in: createdJobIds } } })
  if (createdStorageOperationIds.length > 0) {
    await prisma.storageOperation.deleteMany({ where: { id: { in: createdStorageOperationIds } } })
  }
  if (createdDeliveryIds.length > 0) {
    await prisma.webhookDelivery.deleteMany({ where: { id: { in: createdDeliveryIds } } })
  }
  if (createdSubscriptionIds.length > 0) {
    await prisma.webhookSubscription.deleteMany({ where: { id: { in: createdSubscriptionIds } } })
  }
  await new Promise<void>((resolve) => {
    if (!webhookServer) return resolve()
    webhookServer.close(() => resolve())
  })
  if (originalAllowInsecure === undefined) delete process.env.ALLOW_INSECURE_ENDPOINTS
  else process.env.ALLOW_INSECURE_ENDPOINTS = originalAllowInsecure
  if (originalAllowlist === undefined) delete process.env.SSRF_ALLOWLIST
  else process.env.SSRF_ALLOWLIST = originalAllowlist
}, 60_000)

describe('worker lifecycle against live Redis', () => {
  it('completes a RETRY job and mirrors the completed state', async () => {
    retryMode = 'ok'
    const id = trackJob(await enqueueJob('RETRY', { userId: randomUUID(), kind: 'unit-ok', refId: 'ref-ok' }))
    const row = await waitForRow(id, (candidate) => candidate.status === 'completed')
    expect(row.attempts).toBe(1)
    expect(row.maxAttempts).toBe(5)
    expect(row.progress).toBe(100)
    expect(row.result).toEqual({ ok: true, kind: 'unit-ok', refId: 'ref-ok' })
    expect(row.error).toBeNull()
    expect(row.startedAt).not.toBeNull()
    expect(row.finishedAt).not.toBeNull()
    expect(row.bullJobId).toBe(id)
    expect(row.userId).not.toBeNull()
  }, 30_000)

  it('fails permanently without consuming remaining attempts', async () => {
    retryMode = 'permanent'
    const id = trackJob(await enqueueJob('RETRY', { userId: randomUUID(), kind: 'unit-permanent', refId: 'r1' }))
    const row = await waitForRow(id, (candidate) => candidate.status === 'failed')
    expect(row.attempts).toBe(1)
    expect(row.error).toContain('PermanentJobError')
    expect(row.error).toContain('permanent failure for test')
    expect(row.finishedAt).not.toBeNull()
  }, 30_000)

  it('marks a retryable failure as delayed with the error recorded', async () => {
    retryMode = 'retryable'
    const id = trackJob(
      await enqueueJob('RETRY', { userId: randomUUID(), kind: 'unit-retryable', refId: 'r2' }, { maxAttempts: 2 }),
    )
    const row = await waitForRow(id, (candidate) => candidate.status === 'delayed')
    expect(row.attempts).toBe(1)
    expect(row.maxAttempts).toBe(2)
    expect(row.error).toContain('Error: transient boom')
    expect(row.finishedAt).toBeNull()
    const bullJob = row.bullJobId ? await getQueue('retry').getJob(row.bullJobId) : null
    await bullJob?.remove()
  }, 30_000)

  it('persists progress reported before a permanent failure', async () => {
    retryMode = 'progress-fail'
    const id = trackJob(await enqueueJob('RETRY', { userId: randomUUID(), kind: 'unit-progress', refId: 'r3' }))
    const row = await waitForRow(id, (candidate) => candidate.status === 'failed')
    await flushWrites()
    expect(row.progress).toBe(42)
    expect(row.error).toContain('failed after progress')
  }, 30_000)

  it('fails stub processors immediately with NOT_IMPLEMENTED', async () => {
    const id = trackJob(await enqueueJob('SYNC', { userId: randomUUID(), accountId: 'acct-stub' }))
    const row = await waitForRow(id, (candidate) => candidate.status === 'failed')
    expect(row.attempts).toBe(1)
    expect(row.error).toContain('NOT_IMPLEMENTED')
    expect(row.finishedAt).not.toBeNull()
  }, 30_000)

  it('cancels a delayed job and removes it from BullMQ', async () => {
    const id = trackJob(
      await enqueueJob('CLEANUP', { userId: randomUUID(), scope: 'all' }, { delay: 60_000 }),
    )
    const queued = await waitForRow(id, (candidate) => candidate.status === 'delayed')
    expect(queued.bullJobId).toBe(id)
    const outcome = await requestJobCancel(id)
    expect(outcome.removed).toBe(true)
    const cancelled = await waitForRow(id, (candidate) => candidate.status === 'cancelled')
    expect(cancelled.finishedAt).not.toBeNull()
    expect(await getQueue('maintenance').getJob(id)).toBeFalsy()
  }, 30_000)

  it('runs CLEANUP old_operations and prunes only expired rows', async () => {
    const oldRow = await prisma.storageOperation.create({
      data: { operation: 'queue-test', status: 'ok', createdAt: new Date(Date.now() - 31 * 86_400_000) },
    })
    const freshRow = await prisma.storageOperation.create({
      data: { operation: 'queue-test', status: 'ok' },
    })
    createdStorageOperationIds.push(oldRow.id, freshRow.id)
    const id = trackJob(await enqueueJob('CLEANUP', { userId: randomUUID(), scope: 'old_operations' }))
    const row = await waitForRow(id, (candidate) => candidate.status === 'completed')
    expect(row.result).toMatchObject({ scope: 'old_operations' })
    expect(await prisma.storageOperation.findUnique({ where: { id: oldRow.id } })).toBeNull()
    expect(await prisma.storageOperation.findUnique({ where: { id: freshRow.id } })).not.toBeNull()
  }, 30_000)

  it('acquires and releases distributed locks with SET NX semantics', async () => {
    const scope = `queue-test-lock-${randomUUID()}`
    const first = await tryLock(scope, 5_000)
    expect(first).not.toBeNull()
    expect(await tryLock(scope, 5_000)).toBeNull()
    await first!.release()
    const second = await tryLock(scope, 5_000)
    expect(second).not.toBeNull()
    await second!.release()
    const third = await tryLock(scope, 5_000)
    expect(third).not.toBeNull()
    await third!.release()
  }, 30_000)

  it('delivers a signed webhook POST and marks the delivery delivered', async () => {
    capturedRequests.length = 0
    webhookServerMode = 'ok'
    const subscription = await prisma.webhookSubscription.create({
      data: {
        userId: randomUUID(),
        url: `http://127.0.0.1:${webhookPort}/hook`,
        secretEncrypted: encryptText(WEBHOOK_SECRET),
        events: ['job.completed'],
        status: 'active',
      },
    })
    createdSubscriptionIds.push(subscription.id)
    const delivery = await prisma.webhookDelivery.create({
      data: {
        subscriptionId: subscription.id,
        event: 'job.completed',
        payload: { hello: 'world', count: 2 },
      },
    })
    createdDeliveryIds.push(delivery.id)
    const id = trackJob(
      await enqueueJob('WEBHOOK_DELIVERY', { userId: randomUUID(), deliveryId: delivery.id }),
    )
    await waitForRow(id, (candidate) => candidate.status === 'completed')
    const stored = await prisma.webhookDelivery.findUnique({ where: { id: delivery.id } })
    expect(stored?.status).toBe('delivered')
    expect(stored?.attempts).toBe(1)
    expect(stored?.deliveredAt).not.toBeNull()
    expect(stored?.lastError).toBeNull()
    expect(capturedRequests).toHaveLength(1)
    const request = capturedRequests[0]!
    expect(request.method).toBe('POST')
    expect(request.url).toBe('/hook')
    expect(request.headers['x-9drive-delivery']).toBe(`dlv_${delivery.id}`)
    expect(request.headers['user-agent']).toBe('9Drive-Webhooks/1')
    expect(request.headers['content-type']).toBe('application/json')
    const timestamp = Number(request.headers['x-9drive-timestamp'])
    expect(Number.isFinite(timestamp)).toBe(true)
    expect(Math.abs(Math.floor(Date.now() / 1000) - timestamp)).toBeLessThan(60)
    const expectedSignature = createHmac('sha256', WEBHOOK_SECRET)
      .update(`${timestamp}.${request.body}`)
      .digest('hex')
    expect(request.headers['x-9drive-signature']).toBe(`v1=${expectedSignature}`)
    const body = JSON.parse(request.body) as { id: string; type: string; data: { hello: string } }
    expect(body.id).toMatch(/^evt_[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(body.type).toBe('job.completed')
    expect(body.data.hello).toBe('world')
  }, 30_000)

  it('records webhook HTTP failures and schedules a retry', async () => {
    capturedRequests.length = 0
    webhookServerMode = 'error'
    const subscription = await prisma.webhookSubscription.create({
      data: {
        userId: randomUUID(),
        url: `http://127.0.0.1:${webhookPort}/hook`,
        secretEncrypted: encryptText(WEBHOOK_SECRET),
        events: ['job.completed'],
        status: 'active',
      },
    })
    createdSubscriptionIds.push(subscription.id)
    const delivery = await prisma.webhookDelivery.create({
      data: { subscriptionId: subscription.id, event: 'job.completed', payload: { hello: 'again' } },
    })
    createdDeliveryIds.push(delivery.id)
    const id = trackJob(
      await enqueueJob('WEBHOOK_DELIVERY', { userId: randomUUID(), deliveryId: delivery.id }),
    )
    const row = await waitForRow(id, (candidate) => candidate.status === 'delayed')
    const stored = await prisma.webhookDelivery.findUnique({ where: { id: delivery.id } })
    expect(stored?.status).toBe('pending')
    expect(stored?.attempts).toBe(1)
    expect(stored?.lastError).toContain('HTTP 500')
    expect(stored?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now())
    expect(capturedRequests).toHaveLength(1)
    const bullJob = row.bullJobId ? await getQueue('webhook').getJob(row.bullJobId) : null
    await bullJob?.remove()
    webhookServerMode = 'ok'
  }, 30_000)

  it('reports readiness on the health endpoint', async () => {
    const port = runtime!.healthPort()
    expect(port).not.toBeNull()
    const response = await fetch(`http://127.0.0.1:${port}/health/ready`)
    expect(response.status).toBe(200)
    const snapshot = (await response.json()) as { ready: boolean; workers: number; queues: string[] }
    expect(snapshot.ready).toBe(true)
    expect(snapshot.workers).toBe(3)
    expect(snapshot.queues).toEqual([...TEST_QUEUES])
  }, 30_000)

  it('shuts down gracefully and stops serving health', async () => {
    const port = runtime!.healthPort()
    await runtime!.shutdown('test')
    expect(runtime!.ready()).toBe(false)
    expect(runtime!.healthPort()).toBeNull()
    await expect(fetch(`http://127.0.0.1:${port}/health/ready`)).rejects.toThrow()
  }, 30_000)
})
