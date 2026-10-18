import { AsyncLocalStorage } from 'node:async_hooks'

interface RequestContext {
  requestId: string
}

const storage = new AsyncLocalStorage<RequestContext>()

/** Runs `fn` with a correlation id that every structured log line written inside it will carry. */
export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return storage.run({ requestId }, fn)
}

export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId
}
