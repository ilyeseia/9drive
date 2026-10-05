import type { JobPayloads } from '../../queues/job-types.js'
import { NotImplementedError } from '../errors.js'
import type { JobHandler } from '../types.js'

export type RetryKindHandler = JobHandler<JobPayloads['RETRY']>

const retryKindHandlers = new Map<string, RetryKindHandler>()

export function registerRetryKind(kind: string, handler: RetryKindHandler): void {
  retryKindHandlers.set(kind, handler)
}

export function unregisterRetryKind(kind: string): void {
  retryKindHandlers.delete(kind)
}

export function registeredRetryKinds(): string[] {
  return [...retryKindHandlers.keys()]
}

export const retryHandler: JobHandler<JobPayloads['RETRY']> = async (ctx) => {
  const handler = retryKindHandlers.get(ctx.payload.kind)
  if (!handler) throw new NotImplementedError(`RETRY:${ctx.payload.kind}`)
  return handler(ctx)
}
