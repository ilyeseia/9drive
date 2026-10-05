import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Worker, type Job as BullJob } from 'bullmq'
import { env } from '../config/env.js'
import { prisma } from '../config/prisma.js'
import { subscribeJobCancel } from '../queues/cancel.js'
import { closeConnections, getBullConnection, trackConnection } from '../queues/connection.js'
import { QUEUE_NAMES, type QueueName } from '../queues/job-types.js'
import { logger } from '../queues/logger.js'
import { flushMetrics, incrementMetric, startMetricsFlush } from '../queues/metrics.js'
import { flushWrites, markActive, markCompleted, markFailed } from '../queues/mirror.js'
import {
  QUEUE_DEFINITIONS,
  closeQueues,
  getQueuePrefix,
  setQueuePrefix,
  workerBackoffStrategy,
  type WorkerConcurrencyEnvKey,
} from '../queues/queues.js'
import { flushAllProgress } from './progress.js'
import { createProcessor } from './processor.js'
import { resolveHandlers } from './registry.js'
import { registerSchedules } from './schedules.js'
import type { PartialHandlerMap } from './types.js'

export interface WorkerRuntimeOptions {
  prefix?: string
  queues?: readonly QueueName[]
  handlers?: PartialHandlerMap
  concurrency?: Partial<Record<QueueName, number>>
  schedules?: boolean
  healthPort?: number
  healthEnabled?: boolean
}

export interface WorkerHealthSnapshot {
  ready: boolean
  shuttingDown: boolean
  workers: number
  queues: readonly string[]
  uptimeMs: number
}

export interface WorkerRuntime {
  readonly workers: readonly Worker[]
  start(): Promise<void>
  shutdown(reason: string): Promise<void>
  health(): WorkerHealthSnapshot
  ready(): boolean
  healthPort(): number | null
}

const SHUTDOWN_TIMEOUT_MS = 30_000
const METRICS_FLUSH_INTERVAL_MS = 60_000

function defaultConcurrency(key: WorkerConcurrencyEnvKey): number {
  const value = (env as unknown as Record<string, unknown>)[key]
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
}

function withTimeout(work: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`shutdown timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    timer.unref?.()
    work.then(
      () => {
        clearTimeout(timer)
        resolve()
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error as Error)
      },
    )
  })
}

export async function startWorkerRuntime(options: WorkerRuntimeOptions = {}): Promise<WorkerRuntime> {
  if (options.prefix) setQueuePrefix(options.prefix)
  const prefix = getQueuePrefix()
  const handlers = resolveHandlers(options.handlers)
  const processor = createProcessor(handlers)
  const queueNames = options.queues ?? QUEUE_NAMES
  const workers: Worker[] = []
  const startedAt = Date.now()
  let ready = false
  let shuttingDown = false
  let shutdownPromise: Promise<void> | null = null
  let healthServer: Server | null = null
  let healthPort: number | null = null
  let cancelUnsubscribe: (() => Promise<void>) | null = null
  let stopMetricsFlush: (() => void) | null = null

  for (const queueName of queueNames) {
    const definition = QUEUE_DEFINITIONS[queueName]
    const concurrency = options.concurrency?.[queueName] ?? defaultConcurrency(definition.concurrencyEnvKey)
    const worker = new Worker(queueName, processor, {
      connection: getBullConnection(),
      prefix,
      concurrency,
      lockDuration: definition.lockDurationMs,
      lockRenewTime: Math.max(1_000, Math.floor(definition.lockDurationMs / 2)),
      maxStalledCount: 1,
      settings: { backoffStrategy: workerBackoffStrategy },
      autorun: false,
    })
    worker.on('error', (error: Error) => {
      logger.error('worker error', { queue: queueName, error: error.message })
    })
    worker.on('stalled', (jobId: string) => {
      logger.warn('job stalled', { queue: queueName, jobId })
      void incrementMetric('stalled')
    })
    worker.on('active', (job: BullJob) => {
      markActive(job)
      void incrementMetric('active')
    })
    worker.on('completed', (job: BullJob, result: unknown) => {
      markCompleted(job, result)
      void incrementMetric('completed')
    })
    worker.on('failed', (job: BullJob | undefined, error: Error) => {
      if (job) markFailed(job, error)
      void incrementMetric('failed')
    })
    workers.push(worker)
  }

  const health = (): WorkerHealthSnapshot => ({
    ready,
    shuttingDown,
    workers: workers.length,
    queues: [...queueNames],
    uptimeMs: Date.now() - startedAt,
  })

  async function handleCancelMessage(jobId: string): Promise<void> {
    try {
      const row = await prisma.job.findUnique({ where: { id: jobId }, select: { bullJobId: true } })
      const bullJobId = row?.bullJobId ?? jobId
      for (const worker of workers) worker.cancelJob(bullJobId, 'cancel requested')
    } catch (error) {
      logger.error('cancel dispatch failed', { jobId, error: (error as Error).message })
    }
  }

  async function start(): Promise<void> {
    if (ready) return
    try {
      await Promise.all(workers.map((worker) => worker.waitUntilReady()))
      cancelUnsubscribe = subscribeJobCancel(handleCancelMessage)
      if (options.schedules !== false) await registerSchedules()
      stopMetricsFlush = startMetricsFlush(logger, METRICS_FLUSH_INTERVAL_MS)
      const wantsHealth = options.healthEnabled ?? true
      if (wantsHealth) {
        const requestedPort = options.healthPort ?? env.WORKER_HEALTH_PORT
        healthServer = createServer((request, response) => {
          const path = request.url?.split('?')[0]
          if (path === '/health/ready' || path === '/health' || path === '/ready') {
            const snapshot = health()
            const payload = JSON.stringify(snapshot)
            response.writeHead(snapshot.ready && !snapshot.shuttingDown ? 200 : 503, {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(payload),
            })
            response.end(payload)
            return
          }
          response.writeHead(404, { 'content-type': 'application/json' })
          response.end('{"error":"not_found"}')
        })
        await new Promise<void>((resolve, reject) => {
          healthServer?.once('error', reject)
          healthServer?.listen(requestedPort, '127.0.0.1', () => resolve())
        })
        healthPort = (healthServer?.address() as AddressInfo | null)?.port ?? null
      }
      for (const worker of workers) {
        void worker.run().catch((error: unknown) => {
          logger.error('worker run loop exited', { error: (error as Error).message })
        })
      }
      ready = true
      logger.info('worker runtime ready', {
        prefix,
        queues: [...queueNames],
        healthPort,
        concurrency: Object.fromEntries(
          queueNames.map((name) => [name, options.concurrency?.[name] ?? defaultConcurrency(QUEUE_DEFINITIONS[name].concurrencyEnvKey)]),
        ),
      })
    } catch (error) {
      logger.error('worker runtime failed to start', { error: (error as Error).message })
      await startShutdown('start failed').catch(() => undefined)
      throw error
    }
  }

  async function startShutdown(reason: string): Promise<void> {
    if (shutdownPromise) return shutdownPromise
    shuttingDown = true
    ready = false
    shutdownPromise = (async () => {
      logger.info('worker shutdown initiated', { reason, timeoutMs: SHUTDOWN_TIMEOUT_MS })
      stopMetricsFlush?.()
      stopMetricsFlush = null
      if (cancelUnsubscribe) {
        await cancelUnsubscribe().catch(() => undefined)
        cancelUnsubscribe = null
      }
      const graceful = (async () => {
        await Promise.all(workers.map((worker) => worker.pause()))
        await Promise.all(workers.map((worker) => worker.close()))
      })()
      try {
        await withTimeout(graceful, SHUTDOWN_TIMEOUT_MS)
      } catch (error) {
        logger.warn('graceful shutdown timed out, forcing worker close', {
          reason,
          error: (error as Error).message,
        })
        await Promise.all(workers.map((worker) => worker.close(true).catch(() => undefined)))
      }
      flushAllProgress()
      await flushWrites()
      try {
        await flushMetrics()
      } catch (error) {
        logger.warn('final metrics flush failed', { error: (error as Error).message })
      }
      if (healthServer) {
        healthServer.closeAllConnections?.()
        await new Promise<void>((resolve) => healthServer?.close(() => resolve()))
        healthServer = null
        healthPort = null
      }
      await closeQueues()
      await closeConnections()
      logger.info('worker shutdown complete', { reason })
    })()
    return shutdownPromise
  }

  return {
    workers,
    start,
    shutdown: (reason: string) => startShutdown(reason),
    health,
    ready: () => ready,
    healthPort: () => healthPort,
  }
}
