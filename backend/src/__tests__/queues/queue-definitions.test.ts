import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { JOB_TYPES, SYSTEM_USER_ID, isJobType, jobPayloadSchemas } from '../../queues/job-types.js'
import {
  DEFAULT_BACKOFF,
  DEFAULT_MAX_ATTEMPTS,
  JOB_DEFINITIONS,
  QUEUE_DEFINITIONS,
  WEBHOOK_BACKOFF_DELAYS_MS,
  queueNameForType,
  workerBackoffStrategy,
} from '../../queues/queues.js'
import { collectSchedules } from '../../worker/schedules.js'

describe('job type registry', () => {
  it('has a definition for every job type', () => {
    for (const type of JOB_TYPES) {
      expect(JOB_DEFINITIONS[type]).toBeDefined()
      expect(JOB_DEFINITIONS[type].type).toBe(type)
    }
    expect(Object.keys(JOB_DEFINITIONS).sort()).toEqual([...JOB_TYPES].sort())
  })

  it('maps every job type to a queue that declares it', () => {
    for (const type of JOB_TYPES) {
      const queueName = queueNameForType(type)
      const queue = QUEUE_DEFINITIONS[queueName]
      expect(queue).toBeDefined()
      expect(queue.jobTypes).toContain(type)
      expect(queue.concurrencyEnvKey).toBe(JOB_DEFINITIONS[type].concurrencyEnvKey)
      expect(queue.lockDurationMs).toBe(JOB_DEFINITIONS[type].lockDurationMs)
    }
  })

  it('uses contract defaults for attempts and backoff', () => {
    for (const type of JOB_TYPES) {
      expect(JOB_DEFINITIONS[type].maxAttempts).toBe(DEFAULT_MAX_ATTEMPTS)
      expect(JOB_DEFINITIONS[type].jobIdStrategy).toBe('mirror-row-id')
    }
    expect(DEFAULT_MAX_ATTEMPTS).toBe(5)
    expect(DEFAULT_BACKOFF).toEqual({ type: 'exponential', delay: 30_000, jitter: 0.2 })
    expect(JOB_DEFINITIONS.WEBHOOK_DELIVERY.backoff).toEqual({ type: 'webhook-delivery', delay: 30_000 })
    expect(JOB_DEFINITIONS.UPLOAD.lockDurationMs).toBe(300_000)
    expect(JOB_DEFINITIONS.DOWNLOAD.lockDurationMs).toBe(300_000)
    expect(JOB_DEFINITIONS.REPLICATION.lockDurationMs).toBe(300_000)
    expect(JOB_DEFINITIONS.MIGRATION.lockDurationMs).toBe(60_000)
  })

  it('keeps the queue family table from the contract', () => {
    expect(QUEUE_DEFINITIONS.transfer.jobTypes).toEqual(['UPLOAD', 'DOWNLOAD'])
    expect(QUEUE_DEFINITIONS.sync.jobTypes).toEqual(['SYNC', 'METADATA_INDEXING'])
    expect(QUEUE_DEFINITIONS.maintenance.jobTypes).toEqual(['QUOTA_REFRESH', 'HEALTH_CHECK', 'CLEANUP'])
    expect(QUEUE_DEFINITIONS.replication.jobTypes).toEqual(['REPLICATION'])
    expect(QUEUE_DEFINITIONS.migration.jobTypes).toEqual(['MIGRATION'])
    expect(QUEUE_DEFINITIONS.webhook.jobTypes).toEqual(['WEBHOOK_DELIVERY'])
    expect(QUEUE_DEFINITIONS.retry.jobTypes).toEqual(['RETRY'])
  })

  it('recognizes job type strings', () => {
    expect(isJobType('UPLOAD')).toBe(true)
    expect(isJobType('upload')).toBe(false)
    expect(isJobType('NOPE')).toBe(false)
    expect(isJobType(42)).toBe(false)
    expect(SYSTEM_USER_ID).toBe('00000000-0000-0000-0000-000000000000')
  })
})

describe('payload schemas', () => {
  it('rejects payloads without userId', () => {
    expect(() => jobPayloadSchemas.CLEANUP.parse({ scope: 'all' })).toThrow(z.ZodError)
  })

  it('accepts a contract-valid CLEANUP payload', () => {
    const parsed = jobPayloadSchemas.CLEANUP.parse({ userId: 'user-1', scope: 'expired_tokens' })
    expect(parsed).toEqual({ userId: 'user-1', scope: 'expired_tokens' })
    expect(() => jobPayloadSchemas.CLEANUP.parse({ userId: 'user-1', scope: 'other' })).toThrow(z.ZodError)
  })

  it('requires decimal string sizeBytes for UPLOAD', () => {
    const base = {
      userId: 'user-1',
      spoolKey: 'spool/1',
      fileName: 'a.txt',
      mimeType: 'text/plain',
      sizeBytes: '1024',
    }
    expect(jobPayloadSchemas.UPLOAD.parse(base)).toEqual(base)
    expect(() => jobPayloadSchemas.UPLOAD.parse({ ...base, sizeBytes: '12.5' })).toThrow(z.ZodError)
    expect(() => jobPayloadSchemas.UPLOAD.parse({ ...base, sizeBytes: undefined })).toThrow(z.ZodError)
  })

  it('validates WEBHOOK_DELIVERY and RETRY payloads', () => {
    expect(jobPayloadSchemas.WEBHOOK_DELIVERY.parse({ userId: 'u', deliveryId: 'd1' })).toEqual({
      userId: 'u',
      deliveryId: 'd1',
    })
    expect(jobPayloadSchemas.RETRY.parse({ userId: 'u', kind: 'upload', refId: 'r1' })).toEqual({
      userId: 'u',
      kind: 'upload',
      refId: 'r1',
    })
    expect(() => jobPayloadSchemas.RETRY.parse({ userId: 'u', kind: '', refId: 'r1' })).toThrow(z.ZodError)
  })
})

describe('workerBackoffStrategy', () => {
  it('follows the webhook ladder and clamps past the end', () => {
    expect(workerBackoffStrategy(1, 'webhook-delivery')).toBe(30_000)
    expect(workerBackoffStrategy(2, 'webhook-delivery')).toBe(120_000)
    expect(workerBackoffStrategy(3, 'webhook-delivery')).toBe(600_000)
    expect(workerBackoffStrategy(4, 'webhook-delivery')).toBe(3_600_000)
    expect(workerBackoffStrategy(5, 'webhook-delivery')).toBe(18_000_000)
    expect(workerBackoffStrategy(9, 'webhook-delivery')).toBe(WEBHOOK_BACKOFF_DELAYS_MS[4])
    expect(workerBackoffStrategy(0, 'webhook-delivery')).toBe(30_000)
  })

  it('keeps exponential backoff within jitter bounds', () => {
    for (let i = 0; i < 50; i++) {
      const delay1 = workerBackoffStrategy(1)
      expect(delay1).toBeGreaterThanOrEqual(24_000)
      expect(delay1).toBeLessThanOrEqual(30_000)
      const delay3 = workerBackoffStrategy(3)
      expect(delay3).toBeGreaterThanOrEqual(96_000)
      expect(delay3).toBeLessThanOrEqual(120_000)
    }
    expect(workerBackoffStrategy(0)).toBeGreaterThanOrEqual(24_000)
    expect(workerBackoffStrategy(0)).toBeLessThanOrEqual(30_000)
  })
})

describe('periodic schedules', () => {
  it('registers the five contract schedules with contract intervals', () => {
    const schedules = collectSchedules()
    expect(schedules.map((s) => s.id).sort()).toEqual([
      'cleanup-expired-tokens',
      'cleanup-old-operations',
      'cleanup-stale-sessions',
      'health-check',
      'quota-refresh',
    ])
    const byId = Object.fromEntries(schedules.map((s) => [s.id, s.everyMs]))
    expect(byId['quota-refresh']).toBe(900_000)
    expect(byId['health-check']).toBe(300_000)
    expect(byId['cleanup-expired-tokens']).toBe(3_600_000)
    expect(byId['cleanup-stale-sessions']).toBe(21_600_000)
    expect(byId['cleanup-old-operations']).toBe(86_400_000)
  })

  it('targets only scheduled job types with system payloads', () => {
    for (const schedule of collectSchedules()) {
      const definition = JOB_DEFINITIONS[schedule.type]
      const payload = definition.schedules?.find((entry) => entry.id === schedule.id)?.payload
      expect(payload?.userId).toBe(SYSTEM_USER_ID)
    }
  })
})
