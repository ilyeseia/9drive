import { randomUUID } from 'node:crypto'
import { getAppConnection } from './connection.js'

const RELEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"

const RENEW_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end"

export const DEFAULT_LOCK_TTL_MS = 30_000

export function lockKey(scope: string): string {
  return `9drive:lock:${scope}`
}

export interface LockHandle {
  name: string
  token: string
  release(): Promise<void>
  renew(ttlMs?: number): Promise<boolean>
}

export async function tryLock(name: string, ttlMs = DEFAULT_LOCK_TTL_MS): Promise<LockHandle | null> {
  const token = randomUUID()
  const result = await getAppConnection().set(lockKey(name), token, 'PX', ttlMs, 'NX')
  if (result !== 'OK') return null
  return {
    name,
    token,
    async release() {
      await getAppConnection().eval(RELEASE_SCRIPT, 1, lockKey(name), token)
    },
    async renew(ttl = ttlMs) {
      const outcome = await getAppConnection().eval(RENEW_SCRIPT, 1, lockKey(name), token, String(ttl))
      return Number(outcome) === 1
    },
  }
}

export interface WithLockOptions {
  ttlMs?: number
  waitMs?: number
  retryDelayMs?: number
}

export async function withLock<T>(
  name: string,
  fn: (handle: LockHandle) => Promise<T>,
  options: WithLockOptions = {},
): Promise<T | null> {
  const ttlMs = options.ttlMs ?? DEFAULT_LOCK_TTL_MS
  const waitMs = options.waitMs ?? 0
  const retryDelayMs = options.retryDelayMs ?? 250
  const attempts = Math.max(1, Math.ceil(waitMs / retryDelayMs) + 1)
  let handle: LockHandle | null = null
  for (let attempt = 0; attempt < attempts && !handle; attempt++) {
    handle = await tryLock(name, ttlMs)
    if (!handle && attempt < attempts - 1) await sleep(retryDelayMs)
  }
  if (!handle) return null
  const acquired: LockHandle = handle
  const renewEvery = Math.max(1_000, Math.floor(ttlMs / 3))
  const renewTimer = setInterval(() => {
    void acquired.renew(ttlMs)
  }, renewEvery)
  renewTimer.unref?.()
  try {
    return await fn(acquired)
  } finally {
    clearInterval(renewTimer)
    await acquired.release().catch(() => undefined)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}
