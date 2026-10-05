import express from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { env } from '../../config/env.js'
import { prisma } from '../../config/prisma.js'
import { errorMiddleware } from '../../middleware/error.middleware.js'
import { closeRateLimitStore } from '../../middleware/security.middleware.js'
import { authRouter } from '../../modules/auth/auth.routes.js'
import { fileRouter } from '../../modules/files/file.routes.js'
import { hashToken, randomToken } from '../../utils/crypto.js'
import { hashPassword } from '../../utils/password.js'
import { signAccessToken } from '../../utils/jwt.js'

const runId = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
const createdUserIds: string[] = []
let fileId: string | null = null
let accountId: string | null = null
const originalCaptchaSecret = env.RECAPTCHA_SECRET_KEY

function uniqueIp() {
  return `10.53.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`
}

function buildApp() {
  const app = express()
  app.set('trust proxy', 1)
  app.use(express.json())
  app.use('/auth', authRouter)
  app.use('/files', fileRouter)
  app.use(errorMiddleware)
  return app
}

beforeAll(async () => {
  env.RECAPTCHA_SECRET_KEY = undefined

  const user = await prisma.user.create({
    data: { name: 'Case Test', email: `case-user-${runId}@9drive.test`, passwordHash: await hashPassword('CaseTest-Passw0rd!') },
  })
  createdUserIds.push(user.id)

  const session = await prisma.userSession.create({
    data: { userId: user.id, refreshTokenHash: hashToken(randomToken()), expiresAt: new Date(Date.now() + 3600_000) },
  })
  const token = signAccessToken({ sub: user.id, sid: session.id })

  const account = await prisma.connectedAccount.create({
    data: { userId: user.id, provider: 's3', providerAccountId: `case-${runId}`, email: `case-${runId}@storage.test`, scopes: [] },
  })
  accountId = account.id

  const file = await prisma.file.create({
    data: { userId: user.id, connectedAccountId: account.id, provider: 's3', providerFileId: `case-${runId}`, name: 'Q3 SecretReport-Alpha.PDF', mimeType: 'application/pdf', sizeBytes: 1024n },
  })
  fileId = file.id

  return { token }
})

afterAll(async () => {
  env.RECAPTCHA_SECRET_KEY = originalCaptchaSecret
  if (fileId) await prisma.file.deleteMany({ where: { id: fileId } })
  if (accountId) await prisma.connectedAccount.deleteMany({ where: { id: accountId } })
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
  await closeRateLimitStore()
  await prisma.$disconnect()
})

async function loginToken() {
  const user = await prisma.user.findFirstOrThrow({ where: { email: `case-user-${runId}@9drive.test` } })
  const session = await prisma.userSession.create({
    data: { userId: user.id, refreshTokenHash: hashToken(randomToken()), expiresAt: new Date(Date.now() + 3600_000) },
  })
  return signAccessToken({ sub: user.id, sid: session.id })
}

describe('case-insensitive emails', () => {
  it('rejects a duplicate registration that only differs by case', async () => {
    const app = buildApp()
    const first = await request(app)
      .post('/auth/register')
      .set('X-Forwarded-For', uniqueIp())
      .send({ name: 'Case Duplicate', email: `dup-${runId}@Example.COM`, password: 'CaseTest-Passw0rd!' })
    expect(first.status).toBe(201)
    createdUserIds.push(first.body.user.id)

    const second = await request(app)
      .post('/auth/register')
      .set('X-Forwarded-For', uniqueIp())
      .send({ name: 'Case Duplicate 2', email: `DUP-${runId}@example.com`, password: 'CaseTest-Passw0rd!' })
    expect(second.status).toBe(409)
    expect(second.body.code).toBe('AUTH_EMAIL_TAKEN')
  })

  it('accepts a login where the case differs from the stored email', async () => {
    const res = await request(buildApp())
      .post('/auth/login')
      .set('X-Forwarded-For', uniqueIp())
      .send({ email: `CASE-USER-${runId}@9DRIVE.TEST`, password: 'CaseTest-Passw0rd!' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.accessToken).toBeDefined()
    expect(res.body.user.id).toBeDefined()
  })
})

describe('case-insensitive file search', () => {
  it('matches stored file names regardless of query case', async () => {
    const token = await loginToken()
    const res = await request(buildApp())
      .get('/files')
      .query({ q: 'secretreport-alpha' })
      .set('Authorization', `Bearer ${token}`)
      .set('X-Forwarded-For', uniqueIp())

    expect(res.status).toBe(200)
    const names = (res.body.files as Array<{ name: string }>).map((file) => file.name)
    expect(names).toContain('Q3 SecretReport-Alpha.PDF')
  })

  it('still excludes files that do not match', async () => {
    const token = await loginToken()
    const res = await request(buildApp())
      .get('/files')
      .query({ q: 'nomatch-anywhere' })
      .set('Authorization', `Bearer ${token}`)
      .set('X-Forwarded-For', uniqueIp())

    expect(res.status).toBe(200)
    expect(res.body.files).toHaveLength(0)
  })
})
