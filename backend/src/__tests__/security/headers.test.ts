import express from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '../../config/prisma.js'
import { errorMiddleware } from '../../middleware/error.middleware.js'
import { closeRateLimitStore, noStoreHeaders, securityHeaders } from '../../middleware/security.middleware.js'
import { fileRouter } from '../../modules/files/file.routes.js'
import { publicRouter } from '../../modules/public/public.routes.js'
import { hashToken, randomToken } from '../../utils/crypto.js'
import { signAccessToken } from '../../utils/jwt.js'

const runId = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
const createdUserIds: string[] = []
let userToken = ''

function uniqueIp() {
  return `10.55.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`
}

const headerApp = express()
headerApp.set('trust proxy', 1)
headerApp.use(securityHeaders)
headerApp.get('/probe', (_req, res) => {
  res.json({ ok: true })
})

const leakApp = express()
leakApp.set('trust proxy', 1)
leakApp.get('/boom', (_req, _res, next) => {
  next(new Error('db connection failed at 10.0.0.5:5432 with password=super-secret'))
})
leakApp.use(errorMiddleware)

const noStoreApp = express()
noStoreApp.set('trust proxy', 1)
noStoreApp.use(noStoreHeaders)
noStoreApp.get('/probe', (_req, res) => {
  res.json({ ok: true })
})

function buildDataApp() {
  const app = express()
  app.set('trust proxy', 1)
  app.use(express.json())
  app.use('/files', fileRouter)
  app.use('/public', publicRouter)
  app.use(errorMiddleware)
  return app
}

beforeAll(async () => {
  const user = await prisma.user.create({ data: { name: 'Header User', email: `header-${runId}@9drive.test`, passwordHash: 'unused-hash' } })
  createdUserIds.push(user.id)
  const session = await prisma.userSession.create({
    data: { userId: user.id, refreshTokenHash: hashToken(randomToken()), expiresAt: new Date(Date.now() + 3600_000) },
  })
  userToken = signAccessToken({ sub: user.id, sid: session.id })
})

afterAll(async () => {
  await prisma.userSession.deleteMany({ where: { userId: { in: createdUserIds } } })
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
  await closeRateLimitStore()
  await prisma.$disconnect()
})

describe('security headers', () => {
  it('sets nosniff, CSP, frame guards and a locked-down referrer policy', async () => {
    const res = await request(headerApp).get('/probe')
    expect(res.status).toBe(200)
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN')
    expect(res.headers['referrer-policy']).toBe('no-referrer')
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin')
    expect(res.headers['cross-origin-embedder-policy']).toBeUndefined()

    const csp = res.headers['content-security-policy'] ?? ''
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("frame-ancestors 'self'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("script-src 'self'")
  })

  it('omits HSTS when the proxy does not terminate TLS', async () => {
    const res = await request(headerApp).get('/probe')
    expect(res.headers['strict-transport-security']).toBeUndefined()
  })
})

describe('no-store header', () => {
  it('marks middleware-protected responses as private', async () => {
    const res = await request(noStoreApp).get('/probe')
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it('marks public share lookups as no-store even on misses', async () => {
    const res = await request(buildDataApp()).get('/public/files/definitely-not-a-token').set('X-Forwarded-For', uniqueIp())
    expect(res.status).toBe(404)
    expect(res.body.code).toBe('NOT_FOUND')
    expect(res.headers['cache-control']).toContain('no-store')
  })
})

describe('error hygiene', () => {
  it('maps validation failures to 400 without leaking internals', async () => {
    const res = await request(buildDataApp())
      .get('/files')
      .query({ startDate: 'not-a-date' })
      .set('Authorization', `Bearer ${userToken}`)
      .set('X-Forwarded-For', uniqueIp())
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('VALIDATION_FAILED')
    expect(res.body.message).toContain('startDate')
    expect(JSON.stringify(res.body)).not.toContain('at Object')
    expect(JSON.stringify(res.body)).not.toContain('node_modules')
  })

  it('returns a generic message for unexpected server errors', async () => {
    const res = await request(leakApp).get('/boom')
    expect(res.status).toBe(500)
    expect(res.body).toEqual({ code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' })
  })

  it('never returns stack traces for malformed queries', async () => {
    const res = await request(buildDataApp())
      .get('/files')
      .query({ accountId: 'not-a-uuid' })
      .set('Authorization', `Bearer ${userToken}`)
      .set('X-Forwarded-For', uniqueIp())
    expect([400, 500]).toContain(res.status)
    const body = JSON.stringify(res.body)
    expect(body).not.toContain('PrismaClient')
    expect(body).not.toContain('stack')
    expect(body).not.toContain('node_modules')
  })
})
