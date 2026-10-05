/**
 * Job row serialisation for api-contract.md §4.3: mirrors the `Job` model plus
 * `provider`, `progress`, `attempts` and scrubbed `payload` / `error`.
 */

import type { Job } from '@prisma/client'
import { sanitizeErrorMessage, sanitizeSecrets } from './shared.js'

export const JOB_STATUSES = ['queued', 'active', 'completed', 'failed', 'delayed', 'cancelled'] as const

export const FINISHED_JOB_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled'])

export function serializeJob(job: Job) {
  return {
    id: job.id,
    userId: job.userId,
    type: job.type,
    status: job.status,
    priority: job.priority,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    progress: job.progress,
    provider: job.provider,
    relatedId: job.relatedId,
    bullJobId: job.bullJobId,
    payload: sanitizeSecrets(job.payload),
    result: sanitizeSecrets(job.result),
    error: sanitizeErrorMessage(job.error),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  }
}
