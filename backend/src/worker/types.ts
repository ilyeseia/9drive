import type { Job as BullJob } from 'bullmq'
import type { JobPayloads, JobType } from '../queues/job-types.js'
import type { Logger } from '../queues/logger.js'

export interface JobContext<P> {
  payload: P
  job: BullJob
  logger: Logger
  reportProgress: (pct: number, meta?: Record<string, unknown>) => void
  signal: AbortSignal
}

export type JobHandler<P> = (ctx: JobContext<P>) => Promise<unknown>

export type HandlerMap = { [K in JobType]: JobHandler<JobPayloads[K]> }

export type PartialHandlerMap = { [K in JobType]?: JobHandler<JobPayloads[K]> }
