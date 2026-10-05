import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { Queue, type BackoffOptions, type JobsOptions } from 'bullmq'
import { env } from '../config/env.js'
import { prisma } from '../config/prisma.js'
import { jsonSafe } from '../utils/serialize.js'
import { getBullConnection } from './connection.js'
import { emitJobEvent } from './events.js'
import {
  SYSTEM_USER_ID,
  jobPayloadSchemas,
  type EnqueueInput,
  type JobPayloadInput,
  type JobType,
  type QueueName,
} from './job-types.js'
import { logger } from './logger.js'

export type WorkerConcurrencyEnvKey =
  | 'WORKER_CONCURRENCY_TRANSFER'
  | 'WORKER_CONCURRENCY_SYNC'
  | 'WORKER_CONCURRENCY_MAINTENANCE'
  | 'WORKER_CONCURRENCY_REPLICATION'
  | 'WORKER_CONCURRENCY_MIGRATION'
  | 'WORKER_CONCURRENCY_WEBHOOK'
  | 'WORKER_CONCURRENCY_RETRY'

export const DEFAULT_MAX_ATTEMPTS = 5

export const DEFAULT_BACKOFF: BackoffOptions = { type: 'exponential', delay: 30_000, jitter: 0.2 }

export const WEBHOOK_BACKOFF_TYPE = 'webhook-delivery'

export const WEBHOOK_BACKOFF_DELAYS_MS = [30_000, 120_000, 600_000, 3_600_000, 18_000_000] as const

export const JOB_RETENTION = {
  removeOnComplete: { age: 604_800, count: 5_000 },
  removeOnFail: { age: 1_209_600, count: 5_000 },
} as const

export interface JobScheduleDefinition<T extends JobType = JobType> {
  id: string
  everyMs: number
  payload: EnqueueInput<T>
}

export interface JobTypeDefinition<T extends JobType = JobType> {
  type: T
  queue: QueueName
  priority: number
  maxAttempts: number
  backoff: BackoffOptions
  lockDurationMs: number
  concurrencyEnvKey: WorkerConcurrencyEnvKey
  jobIdStrategy: 'mirror-row-id'
  payloadSchema: { parse(data: unknown): JobPayloadInput<T>; safeParse(data: unknown): { success: true; data: JobPayloadInput<T> } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } }
  schedules?: ReadonlyArray<JobScheduleDefinition<T>>
}

const DEFAULT_LOCK_DURATION_MS = 60_000
const LONG_LOCK_DURATION_MS = 300_000

export const JOB_DEFINITIONS = {
  UPLOAD: {
    type: 'UPLOAD',
    queue: 'transfer',
    priority: 1,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    backoff: DEFAULT_BACKOFF,
    lockDurationMs: LONG_LOCK_DURATION_MS,
    concurrencyEnvKey: 'WORKER_CONCURRENCY_TRANSFER',
    jobIdStrategy: 'mirror-row-id',
    payloadSchema: jobPayloadSchemas.UPLOAD,
  },
  DOWNLOAD: {
    type: 'DOWNLOAD',
    queue: 'transfer',
    priority: 2,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    backoff: DEFAULT_BACKOFF,
    lockDurationMs: LONG_LOCK_DURATION_MS,
    concurrencyEnvKey: 'WORKER_CONCURRENCY_TRANSFER',
    jobIdStrategy: 'mirror-row-id',
    payloadSchema: jobPayloadSchemas.DOWNLOAD,
  },
  REPLICATION: {
    type: 'REPLICATION',
    queue: 'replication',
    priority: 5,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    backoff: DEFAULT_BACKOFF,
    lockDurationMs: LONG_LOCK_DURATION_MS,
    concurrencyEnvKey: 'WORKER_CONCURRENCY_REPLICATION',
    jobIdStrategy: 'mirror-row-id',
    payloadSchema: jobPayloadSchemas.REPLICATION,
  },
  MIGRATION: {
    type: 'MIGRATION',
    queue: 'migration',
    priority: 6,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    backoff: DEFAULT_BACKOFF,
    lockDurationMs: DEFAULT_LOCK_DURATION_MS,
    concurrencyEnvKey: 'WORKER_CONCURRENCY_MIGRATION',
    jobIdStrategy: 'mirror-row-id',
    payloadSchema: jobPayloadSchemas.MIGRATION,
  },
  WEBHOOK_DELIVERY: {
    type: 'WEBHOOK_DELIVERY',
    queue: 'webhook',
    priority: 8,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    backoff: { type: WEBHOOK_BACKOFF_TYPE, delay: 30_000 },
    lockDurationMs: DEFAULT_LOCK_DURATION_MS,
    concurrencyEnvKey: 'WORKER_CONCURRENCY_WEBHOOK',
    jobIdStrategy: 'mirror-row-id',
    payloadSchema: jobPayloadSchemas.WEBHOOK_DELIVERY,
  },
  SYNC: {
    type: 'SYNC',
    queue: 'sync',
    priority: 10,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    backoff: DEFAULT_BACKOFF,
    lockDurationMs: DEFAULT_LOCK_DURATION_MS,
    concurrencyEnvKey: 'WORKER_CONCURRENCY_SYNC',
    jobIdStrategy: 'mirror-row-id',
    payloadSchema: jobPayloadSchemas.SYNC,
  },
  METADATA_INDEXING: {
    type: 'METADATA_INDEXING',
    queue: 'sync',
    priority: 11,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    backoff: DEFAULT_BACKOFF,
    lockDurationMs: DEFAULT_LOCK_DURATION_MS,
    concurrencyEnvKey: 'WORKER_CONCURRENCY_SYNC',
    jobIdStrategy: 'mirror-row-id',
    payloadSchema: jobPayloadSchemas.METADATA_INDEXING,
  },
  QUOTA_REFRESH: {
    type: 'QUOTA_REFRESH',
    queue: 'maintenance',
    priority: 20,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    backoff: DEFAULT_BACKOFF,
    lockDurationMs: DEFAULT_LOCK_DURATION_MS,
    concurrencyEnvKey: 'WORKER_CONCURRENCY_MAINTENANCE',
    jobIdStrategy: 'mirror-row-id',
    payloadSchema: jobPayloadSchemas.QUOTA_REFRESH,
    schedules: [{ id: 'quota-refresh', everyMs: 900_000, payload: { userId: SYSTEM_USER_ID } }],
  },
  HEALTH_CHECK: {
    type: 'HEALTH_CHECK',
    queue: 'maintenance',
    priority: 21,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    backoff: DEFAULT_BACKOFF,
    lockDurationMs: DEFAULT_LOCK_DURATION_MS,
    concurrencyEnvKey: 'WORKER_CONCURRENCY_MAINTENANCE',
    jobIdStrategy: 'mirror-row-id',
    payloadSchema: jobPayloadSchemas.HEALTH_CHECK,
    schedules: [{ id: 'health-check', everyMs: 300_000, payload: { userId: SYSTEM_USER_ID } }],
  },
  CLEANUP: {
    type: 'CLEANUP',
    queue: 'maintenance',
    priority: 22,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    backoff: DEFAULT_BACKOFF,
    lockDurationMs: DEFAULT_LOCK_DURATION_MS,
    concurrencyEnvKey: 'WORKER_CONCURRENCY_MAINTENANCE',
    jobIdStrategy: 'mirror-row-id',
    payloadSchema: jobPayloadSchemas.CLEANUP,
    schedules: [
      { id: 'cleanup-expired-tokens', everyMs: 3_600_000, payload: { userId: SYSTEM_USER_ID, scope: 'expired_tokens' } },
      { id: 'cleanup-stale-sessions', everyMs: 21_600_000, payload: { userId: SYSTEM_USER_ID, scope: 'stale_sessions' } },
      { id: 'cleanup-old-operations', everyMs: 86_400_000, payload: { userId: SYSTEM_USER_ID, scope: 'old_operations' } },
    ],
  },
  RETRY: {
    type: 'RETRY',
    queue: 'retry',
    priority: 30,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    backoff: DEFAULT_BACKOFF,
    lockDurationMs: DEFAULT_LOCK_DURATION_MS,
    concurrencyEnvKey: 'WORKER_CONCURRENCY_RETRY',
    jobIdStrategy: 'mirror-row-id',
    payloadSchema: jobPayloadSchemas.RETRY,
  },
} as { [K in JobType]: JobTypeDefinition<K> }

export interface QueueDefinition {
  name: QueueName
  jobTypes: readonly JobType[]
  concurrencyEnvKey: WorkerConcurrencyEnvKey
  lockDurationMs: number
}

export const QUEUE_DEFINITIONS: Record<QueueName, QueueDefinition> = {
  transfer: {
    name: 'transfer',
    jobTypes: ['UPLOAD', 'DOWNLOAD'],
    concurrencyEnvKey: 'WORKER_CONCURRENCY_TRANSFER',
    lockDurationMs: LONG_LOCK_DURATION_MS,
  },
  sync: {
    name: 'sync',
    jobTypes: ['SYNC', 'METADATA_INDEXING'],
    concurrencyEnvKey: 'WORKER_CONCURRENCY_SYNC',
    lockDurationMs: DEFAULT_LOCK_DURATION_MS,
  },
  maintenance: {
    name: 'maintenance',
    jobTypes: ['QUOTA_REFRESH', 'HEALTH_CHECK', 'CLEANUP'],
    concurrencyEnvKey: 'WORKER_CONCURRENCY_MAINTENANCE',
    lockDurationMs: DEFAULT_LOCK_DURATION_MS,
  },
  replication: {
    name: 'replication',
    jobTypes: ['REPLICATION'],
    concurrencyEnvKey: 'WORKER_CONCURRENCY_REPLICATION',
    lockDurationMs: LONG_LOCK_DURATION_MS,
  },
  migration: {
    name: 'migration',
    jobTypes: ['MIGRATION'],
    concurrencyEnvKey: 'WORKER_CONCURRENCY_MIGRATION',
    lockDurationMs: DEFAULT_LOCK_DURATION_MS,
  },
  webhook: {
    name: 'webhook',
    jobTypes: ['WEBHOOK_DELIVERY'],
    concurrencyEnvKey: 'WORKER_CONCURRENCY_WEBHOOK',
    lockDurationMs: DEFAULT_LOCK_DURATION_MS,
  },
  retry: {
    name: 'retry',
    jobTypes: ['RETRY'],
    concurrencyEnvKey: 'WORKER_CONCURRENCY_RETRY',
    lockDurationMs: DEFAULT_LOCK_DURATION_MS,
  },
}

export function queueNameForType(type: JobType): QueueName {
  return JOB_DEFINITIONS[type].queue
}

export function workerBackoffStrategy(attemptsMade: number, type?: string): number {
  if (type === WEBHOOK_BACKOFF_TYPE) {
    const index = Math.min(Math.max(attemptsMade, 1), WEBHOOK_BACKOFF_DELAYS_MS.length) - 1
    return WEBHOOK_BACKOFF_DELAYS_MS[index]
  }
  const base = DEFAULT_BACKOFF.delay ?? 30_000
  const jitter = DEFAULT_BACKOFF.jitter ?? 0
  const maxDelay = Math.round(Math.pow(2, Math.max(attemptsMade, 1) - 1) * base)
  if (jitter <= 0) return maxDelay
  const minDelay = maxDelay * (1 - jitter)
  return Math.floor(Math.random() * maxDelay * jitter + minDelay)
}

let queuePrefix = '9drive'

export function getQueuePrefix(): string {
  return queuePrefix
}

export function setQueuePrefix(prefix: string): void {
  if (queues.size > 0) throw new Error('setQueuePrefix must be called before any queue is created')
  queuePrefix = prefix
}

const queues = new Map<QueueName, Queue>()

export function getQueue(name: QueueName): Queue {
  const existing = queues.get(name)
  if (existing) return existing
  const queue = new Queue(name, {
    connection: getBullConnection(),
    prefix: queuePrefix,
    defaultJobOptions: {
      attempts: DEFAULT_MAX_ATTEMPTS,
      backoff: DEFAULT_BACKOFF,
      removeOnComplete: JOB_RETENTION.removeOnComplete,
      removeOnFail: JOB_RETENTION.removeOnFail,
    },
  })
  queue.on('error', (error: Error) => {
    logger.error('queue error', { queue: name, error: error.message })
  })
  queues.set(name, queue)
  return queue
}

export async function closeQueues(): Promise<void> {
  const open = [...queues.values()]
  queues.clear()
  await Promise.all(open.map((queue) => queue.close().catch(() => undefined)))
}

export interface EnqueueOptions {
  priority?: number
  delay?: number
  maxAttempts?: number
  provider?: string
  relatedId?: string
}

export async function enqueueJob<T extends JobType>(
  type: T,
  payload: EnqueueInput<T>,
  options: EnqueueOptions = {},
): Promise<string> {
  const definition = JOB_DEFINITIONS[type]
  if (!definition) throw new Error(`Unknown job type: ${String(type)}`)
  const parsed = definition.payloadSchema.parse(payload)
  const jobId = randomUUID()
  const fullPayload = { ...parsed, jobId }
  const priority = options.priority ?? definition.priority
  const maxAttempts = options.maxAttempts ?? definition.maxAttempts
  const row = await prisma.job.create({
    data: {
      id: jobId,
      userId: parsed.userId === SYSTEM_USER_ID ? null : parsed.userId,
      type,
      status: options.delay && options.delay > 0 ? 'delayed' : 'queued',
      priority,
      attempts: 0,
      maxAttempts,
      progress: 0,
      payload: jsonSafe(fullPayload) as Prisma.InputJsonValue,
      provider: options.provider ?? null,
      relatedId: options.relatedId ?? null,
      bullJobId: jobId,
    },
  })
  const jobOptions: JobsOptions = {
    jobId,
    priority,
    attempts: maxAttempts,
    backoff: definition.backoff,
    ...(options.delay ? { delay: options.delay } : {}),
  }
  try {
    await getQueue(definition.queue).add(type, fullPayload, jobOptions)
  } catch (error) {
    logger.error('failed to enqueue job', {
      jobId: row.id,
      type,
      error: (error as Error).message,
    })
    throw error
  }
  emitJobEvent('job.queued', { jobId: row.id, type, userId: parsed.userId, attempts: 0 })
  return row.id
}
