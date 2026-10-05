import { UnrecoverableError, type Job as BullJob, type Processor } from 'bullmq'
import { ProviderError, isRetryableProviderError } from '../providers/errors.js'
import { isCancelRequested } from '../queues/cancel.js'
import { isJobType } from '../queues/job-types.js'
import { logger as rootLogger, type Logger } from '../queues/logger.js'
import { resolveRowId } from '../queues/mirror.js'
import { JOB_DEFINITIONS } from '../queues/queues.js'
import { JobCancelledError, PermanentJobError } from './errors.js'
import { flushProgress, reportProgress } from './progress.js'
import type { HandlerMap, JobHandler } from './types.js'

function mapError(error: unknown, jobId: string, aborted: boolean): Error {
  const err = error instanceof Error ? error : new Error(String(error))
  if (aborted && !(err instanceof JobCancelledError)) return new JobCancelledError(jobId)
  if (err instanceof UnrecoverableError) return err
  if (ProviderError.is(err) && !isRetryableProviderError(err)) {
    return new PermanentJobError(`${err.code}: ${err.message}`)
  }
  return err
}

async function runJob(
  job: BullJob,
  signal: AbortSignal | undefined,
  handler: JobHandler<never>,
  log: Logger,
): Promise<unknown> {
  if (!isJobType(job.name)) {
    throw new PermanentJobError(`ERR_INVALID_INPUT: unknown job type "${job.name}"`)
  }
  const definition = JOB_DEFINITIONS[job.name]
  const parsed = definition.payloadSchema.safeParse(job.data)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ')
    throw new PermanentJobError(`ERR_INVALID_INPUT: invalid ${job.name} payload: ${issues}`)
  }
  const rowId = await resolveRowId(job)
  if (!rowId) throw new PermanentJobError(`ERR_INVALID_INPUT: could not resolve job row for ${job.name}`)
  if (await isCancelRequested(rowId)) throw new JobCancelledError(rowId)
  const payload = { ...parsed.data, jobId: rowId } as never
  const jobLogger = log.child({
    jobId: rowId,
    type: job.name,
    userId: parsed.data.userId,
    attempt: job.attemptsMade + 1,
  })
  const startedAt = Date.now()
  try {
    const result = await handler({
      payload,
      job,
      logger: jobLogger,
      reportProgress: (pct: number) => reportProgress(rowId, pct),
      signal: signal ?? AbortSignal.abort(),
    })
    if (signal?.aborted) throw new JobCancelledError(rowId)
    jobLogger.debug('job attempt succeeded', { durationMs: Date.now() - startedAt })
    return result
  } catch (error) {
    const mapped = mapError(error, rowId, Boolean(signal?.aborted))
    jobLogger.warn('job attempt failed', {
      durationMs: Date.now() - startedAt,
      errorName: mapped.name,
      error: mapped.message,
    })
    throw mapped
  } finally {
    flushProgress(rowId)
  }
}

export function createProcessor(handlers: HandlerMap): Processor {
  return async (job: BullJob, _token?: string, signal?: AbortSignal): Promise<unknown> => {
    const handler = handlers[job.name as keyof HandlerMap] as unknown as JobHandler<never> | undefined
    if (!handler) {
      throw new PermanentJobError(`ERR_INVALID_INPUT: no handler registered for job type "${job.name}"`)
    }
    return runJob(job, signal, handler, rootLogger)
  }
}
