import express from 'express'
import request from 'supertest'
import { afterAll, describe, expect, it } from 'vitest'
import {
  authLoginLimiter,
  clearLoginFailures,
  closeRateLimitStore,
  isLoginLocked,
  publicTokenLimiter,
  registerLimiter,
  registerLoginFailure,
} from '../../middleware/security.middleware.js'

const runId = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`

function uniqueIp() {
  return `10.52.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`
}

function probeApp(limiter: express.RequestHandler) {
  const app = express()
  app.set('trust proxy', 1)
  app.use(express.json())
  app.post('/probe', limiter, (_req, res) => {
    res.status(201).json({ ok: true })
  })
  return app
}

afterAll(async () => {
  await closeRateLimitStore()
})

describe('rate limiting', () => {
  it('answers 429 with RATE_LIMITED after the register burst is exhausted', async () => {
    const app = probeApp(registerLimiter)
    const ip = uniqueIp()
    let lastStatus = 0
    let lastBody: Record<string, unknown> = {}
    let lastHeaders: Record<string, string | undefined> = {}

    for (let i = 0; i < 6; i++) {
      const res = await request(app).post('/probe').set('X-Forwarded-For', ip).send({})
      lastStatus = res.status
      lastBody = res.body
      lastHeaders = res.headers as Record<string, string | undefined>
      if (res.status === 429) break
    }

    expect(lastStatus).toBe(429)
    expect(lastBody.code).toBe('RATE_LIMITED')
    const headerValue = lastHeaders['ratelimit'] ?? lastHeaders['ratelimit-limit']
    expect(headerValue).toBeDefined()
  })

  it('keeps counters isolated per client address', async () => {
    const app = probeApp(registerLimiter)
    const exhaustedIp = uniqueIp()
    for (let i = 0; i < 5; i++) await request(app).post('/probe').set('X-Forwarded-For', exhaustedIp).send({})
    const blocked = await request(app).post('/probe').set('X-Forwarded-For', exhaustedIp).send({})
    expect(blocked.status).toBe(429)

    const other = await request(app).post('/probe').set('X-Forwarded-For', uniqueIp()).send({})
    expect(other.status).toBe(201)
  })

  it('trips the login limiter for one IP + email pair only', async () => {
    const app = probeApp(authLoginLimiter)
    const ip = uniqueIp()
    const email = `trip-${runId}@9drive.test`
    let blocked: { status: number; body: Record<string, unknown> } | undefined

    for (let i = 0; i < 11; i++) {
      const res = await request(app).post('/probe').set('X-Forwarded-For', ip).send({ email })
      if (res.status === 429) {
        blocked = { status: res.status, body: res.body }
        break
      }
    }

    expect(blocked).toBeDefined()
    expect(blocked!.status).toBe(429)
    expect(blocked!.body.code).toBe('RATE_LIMITED')

    const otherEmail = await request(app).post('/probe').set('X-Forwarded-For', ip).send({ email: `other-${runId}@9drive.test` })
    expect(otherEmail.status).toBe(201)
  })

  it('trips the public token limiter', async () => {
    const app = probeApp(publicTokenLimiter)
    const ip = uniqueIp()
    let blocked = false

    for (let i = 0; i < 61; i++) {
      const res = await request(app).post('/probe').set('X-Forwarded-For', ip).send({})
      if (res.status === 429) {
        blocked = true
        break
      }
    }

    expect(blocked).toBe(true)
  })
})

describe('login lockout', () => {
  it('locks an email after repeated failures and clears on reset', async () => {
    const email = `lock-${runId}@9drive.test`
    expect(await isLoginLocked(email)).toBe(false)

    for (let i = 0; i < 10; i++) await registerLoginFailure(email)
    expect(await isLoginLocked(email)).toBe(true)

    await clearLoginFailures(email)
    expect(await isLoginLocked(email)).toBe(false)
  })

  it('does not lock a different email', async () => {
    const email = `lock-other-${runId}@9drive.test`
    const bystander = `bystander-${runId}@9drive.test`
    for (let i = 0; i < 10; i++) await registerLoginFailure(email)
    expect(await isLoginLocked(bystander)).toBe(false)
    await clearLoginFailures(email)
  })
})
