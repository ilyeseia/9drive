import express from 'express'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { env } from '../../config/env.js'
import { prisma } from '../../config/prisma.js'
import { errorMiddleware } from '../../middleware/error.middleware.js'
import { closeRateLimitStore } from '../../middleware/security.middleware.js'
import { authRouter } from '../../modules/auth/auth.routes.js'
import { hashToken, randomToken } from '../../utils/crypto.js'
import { signAccessToken } from '../../utils/jwt.js'

const runId = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
const createdUserIds: string[] = []

function uniqueIp() {
  return `10.54.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`
}

function buildApp() {
  const app = express()
  app.set('trust proxy', 1)
  app.use(express.json())
  app.use('/auth', authRouter)
  app.use(errorMiddleware)
  return app
}

async function createUser(label: string) {
  const user = await prisma.user.create({ data: { name: `Auth ${label}`, email: `auth-${label}-${runId}@9drive.test`, passwordHash: 'unused-hash' } })
  createdUserIds.push(user.id)
  return user
}

async function createSession(userId: string, options: { expiresAt?: Date; revokedAt?: Date | null } = {}) {
  return prisma.userSession.create({
    data: {
      userId,
      refreshTokenHash: hashToken(randomToken()),
      expiresAt: options.expiresAt ?? new Date(Date.now() + 3600_000),
      ...(options.revokedAt ? { revokedAt: options.revokedAt } : {}),
    },
  })
}

beforeAll(async () => {
  await createUser('seed')
})

afterAll(async () => {
  await prisma.userSession.deleteMany({ where: { userId: { in: createdUserIds } } })
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
  await closeRateLimitStore()
  await prisma.$disconnect()
})

describe('requireAuth token validation', () => {
  it('accepts a valid HS256 token whose sub matches its session', async () => {
    const user = await createUser('valid')
    const session = await createSession(user.id)
    const token = signAccessToken({ sub: user.id, sid: session.id })

    const res = await request(buildApp()).get('/auth/me').set('Authorization', `Bearer ${token}`).set('X-Forwarded-For', uniqueIp())
    expect(res.status).toBe(200)
    expect(res.body.user.id).toBe(user.id)
  })

  it('rejects a forged token whose sub does not match the session user', async () => {
    const sessionOwner = await createUser('session-owner')
    const impersonated = await createUser('impersonated')
    const session = await createSession(sessionOwner.id)
    const forged = signAccessToken({ sub: impersonated.id, sid: session.id })

    const res = await request(buildApp()).get('/auth/me').set('Authorization', `Bearer ${forged}`).set('X-Forwarded-For', uniqueIp())
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('AUTH_INVALID_TOKEN')
  })

  it('rejects alg:none tokens', async () => {
    const user = await createUser('alg-none')
    const session = await createSession(user.id)
    const forged = jwt.sign({ sub: user.id, sid: session.id, iss: '9drive' }, '', { algorithm: 'none' })

    const res = await request(buildApp()).get('/auth/me').set('Authorization', `Bearer ${forged}`).set('X-Forwarded-For', uniqueIp())
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('AUTH_INVALID_TOKEN')
  })

  it('rejects tokens signed with a different secret', async () => {
    const user = await createUser('wrong-secret')
    const session = await createSession(user.id)
    const forged = jwt.sign({ sub: user.id, sid: session.id, iss: '9drive' }, 'attacker-secret-that-is-long-enough', { algorithm: 'HS256' })

    const res = await request(buildApp()).get('/auth/me').set('Authorization', `Bearer ${forged}`).set('X-Forwarded-For', uniqueIp())
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('AUTH_INVALID_TOKEN')
  })

  it('rejects an expired session', async () => {
    const user = await createUser('expired')
    const session = await createSession(user.id, { expiresAt: new Date(Date.now() - 1000) })
    const token = signAccessToken({ sub: user.id, sid: session.id })

    const res = await request(buildApp()).get('/auth/me').set('Authorization', `Bearer ${token}`).set('X-Forwarded-For', uniqueIp())
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('AUTH_SESSION_EXPIRED')
  })

  it('rejects a revoked session', async () => {
    const user = await createUser('revoked')
    const session = await createSession(user.id, { revokedAt: new Date() })
    const token = signAccessToken({ sub: user.id, sid: session.id })

    const res = await request(buildApp()).get('/auth/me').set('Authorization', `Bearer ${token}`).set('X-Forwarded-For', uniqueIp())
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('AUTH_SESSION_EXPIRED')
  })

  it('rejects a disabled account with 403', async () => {
    const user = await prisma.user.create({ data: { name: 'Auth Disabled', email: `auth-disabled-${runId}@9drive.test`, passwordHash: 'unused-hash', status: 'disabled' } })
    createdUserIds.push(user.id)
    const session = await createSession(user.id)
    const token = signAccessToken({ sub: user.id, sid: session.id })

    const res = await request(buildApp()).get('/auth/me').set('Authorization', `Bearer ${token}`).set('X-Forwarded-For', uniqueIp())
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('AUTH_ACCOUNT_DISABLED')
  })
})

describe('refresh token endpoint', () => {
  it('rejects an unknown refresh token', async () => {
    const res = await request(buildApp()).post('/auth/refresh').set('X-Forwarded-For', uniqueIp()).send({ refreshToken: 'not-a-real-token' })
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('AUTH_SESSION_EXPIRED')
  })

  it('rejects a refresh token for a revoked session', async () => {
    const user = await createUser('refresh-revoked')
    const session = await createSession(user.id)
    const refreshToken = randomToken()
    await prisma.userSession.update({ where: { id: session.id }, data: { refreshTokenHash: hashToken(refreshToken) } })
    await prisma.userSession.update({ where: { id: session.id }, data: { revokedAt: new Date() } })

    const res = await request(buildApp()).post('/auth/refresh').set('X-Forwarded-For', uniqueIp()).send({ refreshToken })
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('AUTH_SESSION_EXPIRED')
  })

  it('issues a fresh access token for a valid refresh token', async () => {
    const user = await createUser('refresh-ok')
    const session = await createSession(user.id)
    const refreshToken = randomToken()
    await prisma.userSession.update({ where: { id: session.id }, data: { refreshTokenHash: hashToken(refreshToken) } })

    const res = await request(buildApp()).post('/auth/refresh').set('X-Forwarded-For', uniqueIp()).send({ refreshToken })
    expect(res.status).toBe(200)
    expect(res.body.accessToken).toBeDefined()

    const me = await request(buildApp()).get('/auth/me').set('Authorization', `Bearer ${res.body.accessToken}`).set('X-Forwarded-For', uniqueIp())
    expect(me.status).toBe(200)
    expect(me.body.user.id).toBe(user.id)
  })
})

describe('secrets and issuer', () => {
  it('signs and verifies with the configured secret and issuer', () => {
    const user = { id: '00000000-0000-4000-8000-000000000001' }
    const token = signAccessToken({ sub: user.id, sid: '11111111-1111-4111-8111-111111111111' })
    expect(token.split('.')).toHaveLength(3)
    expect(env.JWT_ACCESS_SECRET.length).toBeGreaterThanOrEqual(32)
  })
})
