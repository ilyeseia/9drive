import { createHash } from 'node:crypto'
import type { Request, Response } from 'express'
import {
  HOUR,
  MINUTE,
  ipKeyGenerator,
  rateLimit,
  type Options,
  type RateLimitExceededEventHandler,
  type RateLimitRequestHandler,
  type Store,
} from 'express-rate-limit'
import Redis from 'ioredis'
import { env } from '../config/env.js'

const KEY_PREFIX = '9drive:rl:'
const LOGIN_FAILURE_WINDOW_MS = 15 * MINUTE
const LOGIN_FAILURE_THRESHOLD = 10

const redis = new Redis(env.REDIS_URL, {
  connectTimeout: 3000,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  retryStrategy: (times) => Math.min(times * 1000, 10_000),
})
redis.on('error', () => undefined)

const INCREMENT_SCRIPT = `
local hits = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {hits, ttl}
`

type CounterValue = { hits: number; resetAt: number }

class CounterStore {
  private memory = new Map<string, CounterValue>()
  private localOnly = new Set<string>()

  private memoryIncr(key: string, windowMs: number): CounterValue {
    const now = Date.now()
    if (this.memory.size > 5000) {
      for (const [entryKey, entry] of this.memory) {
        if (entry.resetAt <= now) this.memory.delete(entryKey)
      }
    }
    const current = this.memory.get(key)
    if (!current || current.resetAt <= now) {
      const created = { hits: 1, resetAt: now + windowMs }
      this.memory.set(key, created)
      return created
    }
    current.hits += 1
    return current
  }

  private memoryDecr(key: string) {
    const current = this.memory.get(key)
    if (current && current.hits > 0) current.hits -= 1
  }

  async incr(key: string, windowMs: number): Promise<CounterValue> {
    if (!this.localOnly.has(key)) {
      try {
        const reply = (await redis.eval(INCREMENT_SCRIPT, 1, key, String(windowMs))) as [number, number]
        const hits = Number(reply[0])
        const ttl = Number(reply[1])
        return { hits, resetAt: Date.now() + (ttl > 0 ? ttl : windowMs) }
      } catch {
        this.localOnly.add(key)
      }
    }
    return this.memoryIncr(key, windowMs)
  }

  async decr(key: string): Promise<void> {
    if (!this.localOnly.has(key)) {
      try {
        await redis.decr(key)
        return
      } catch {
        this.localOnly.add(key)
      }
    }
    this.memoryDecr(key)
  }

  async del(key: string): Promise<void> {
    this.localOnly.delete(key)
    this.memory.delete(key)
    try {
      await redis.del(key)
    } catch {
      return
    }
  }

  async peek(key: string): Promise<CounterValue | undefined> {
    if (!this.localOnly.has(key)) {
      try {
        const [raw, ttl] = await Promise.all([redis.get(key), redis.pttl(key)])
        if (raw === null) return undefined
        return { hits: Number(raw), resetAt: Date.now() + (ttl > 0 ? ttl : 0) }
      } catch {
        this.localOnly.add(key)
      }
    }
    const current = this.memory.get(key)
    if (!current || current.resetAt <= Date.now()) return undefined
    return current
  }
}

const counters = new CounterStore()

export class RedisRateLimitStore implements Store {
  localKeys = false
  readonly prefix: string
  private windowMs = MINUTE

  constructor(scope: string) {
    this.prefix = `${KEY_PREFIX}${scope}:`
  }

  init(options: Options) {
    this.windowMs = options.windowMs
  }

  async increment(key: string) {
    const value = await counters.incr(`${this.prefix}${key}`, this.windowMs)
    return { totalHits: value.hits, resetTime: new Date(value.resetAt) }
  }

  async decrement(key: string) {
    await counters.decr(`${this.prefix}${key}`)
  }

  async resetKey(key: string) {
    await counters.del(`${this.prefix}${key}`)
  }
}

const rateLimited: RateLimitExceededEventHandler = (_req: Request, res: Response) => {
  res.status(429).json({ code: 'RATE_LIMITED', message: 'Too many requests. Please try again later.' })
}

function createLimiter(scope: string, options: Partial<Options> & { limit: number; windowMs: number }): RateLimitRequestHandler {
  return rateLimit({
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    store: new RedisRateLimitStore(scope),
    handler: rateLimited,
    ...options,
  })
}

type KeyedRequest = Request & { user?: { id: string }; apiKey?: { id: string } }

function bodyValue(req: Request, field: string): string {
  const body = req.body as Record<string, unknown> | undefined
  const value = body?.[field]
  return typeof value === 'string' ? value.trim() : ''
}

function shortHash(value: string) {
  return createHash('sha256').update(value).digest('hex').slice(0, 32)
}

function loginKey(req: Request) {
  const email = bodyValue(req, 'email').toLowerCase()
  return `${ipKeyGenerator(req.ip ?? '')}|${email ? shortHash(email) : 'anonymous'}`
}

function refreshKey(req: Request) {
  const token = bodyValue(req, 'refreshToken')
  return `${ipKeyGenerator(req.ip ?? '')}|${token ? shortHash(token) : 'anonymous'}`
}

function userKey(req: Request) {
  const user = (req as KeyedRequest).user
  return user?.id ? `user:${user.id}` : ipKeyGenerator(req.ip ?? '')
}

function apiKeyKey(req: Request) {
  const apiKey = (req as KeyedRequest).apiKey
  return apiKey?.id ? `key:${apiKey.id}` : ipKeyGenerator(req.ip ?? '')
}

export const defaultRateLimiter = createLimiter('default', { limit: 300, windowMs: MINUTE })
export const authLoginLimiter = createLimiter('auth:login', { limit: 10, windowMs: 15 * MINUTE, keyGenerator: loginKey })
export const registerLimiter = createLimiter('auth:register', { limit: 5, windowMs: HOUR })
export const refreshLimiter = createLimiter('auth:refresh', { limit: 30, windowMs: 15 * MINUTE, keyGenerator: refreshKey })
export const googleExchangeLimiter = createLimiter('auth:google', { limit: 20, windowMs: 15 * MINUTE })
export const inviteLimiter = createLimiter('invite', { limit: 30, windowMs: 15 * MINUTE, keyGenerator: userKey })
export const publicTokenLimiter = createLimiter('public:token', { limit: 60, windowMs: MINUTE })
export const uploadLimiter = createLimiter('upload', { limit: 30, windowMs: MINUTE, keyGenerator: userKey })
export const adminSystemLimiter = createLimiter('admin:system', { limit: 20, windowMs: MINUTE, keyGenerator: userKey })
export const apiKeyRateLimiter = createLimiter('api:key', { limit: 120, windowMs: MINUTE, keyGenerator: apiKeyKey })

function loginFailureKey(email: string) {
  return `${KEY_PREFIX}auth:lock:${shortHash(email.toLowerCase())}`
}

export async function registerLoginFailure(email: string): Promise<number> {
  const value = await counters.incr(loginFailureKey(email), LOGIN_FAILURE_WINDOW_MS)
  return value.hits
}

export async function isLoginLocked(email: string): Promise<boolean> {
  const value = await counters.peek(loginFailureKey(email))
  return (value?.hits ?? 0) >= LOGIN_FAILURE_THRESHOLD
}

export async function clearLoginFailures(email: string): Promise<void> {
  await counters.del(loginFailureKey(email))
}

export async function closeRateLimitStore(): Promise<void> {
  try {
    await redis.quit()
  } catch {
    redis.disconnect()
  }
}
