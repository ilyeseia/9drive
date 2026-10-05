import express from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { env } from '../../config/env.js'
import { prisma } from '../../config/prisma.js'
import { errorMiddleware } from '../../middleware/error.middleware.js'
import { closeRateLimitStore } from '../../middleware/security.middleware.js'
import { zipEntryName } from '../../modules/files/file.routes.js'
import { uploadRouter } from '../../modules/uploads/upload.routes.js'
import { hashToken, randomToken } from '../../utils/crypto.js'
import { signAccessToken } from '../../utils/jwt.js'

const runId = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
const createdUserIds: string[] = []
let accountId: string | null = null
let userToken = ''

function uniqueIp() {
  return `10.56.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`
}

function buildApp() {
  const app = express()
  app.set('trust proxy', 1)
  app.use(express.json())
  app.use('/uploads', uploadRouter)
  app.use(errorMiddleware)
  return app
}

beforeAll(async () => {
  const user = await prisma.user.create({ data: { name: 'Upload User', email: `upload-${runId}@9drive.test`, passwordHash: 'unused-hash' } })
  createdUserIds.push(user.id)
  const session = await prisma.userSession.create({
    data: { userId: user.id, refreshTokenHash: hashToken(randomToken()), expiresAt: new Date(Date.now() + 3600_000) },
  })
  userToken = signAccessToken({ sub: user.id, sid: session.id })
  const account = await prisma.connectedAccount.create({
    data: { userId: user.id, provider: 's3', providerAccountId: `upload-${runId}`, email: `upload-${runId}@storage.test`, scopes: [] },
  })
  accountId = account.id
})

afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 1000))
  await prisma.userSession.deleteMany({ where: { userId: { in: createdUserIds } } })
  if (accountId) await prisma.connectedAccount.deleteMany({ where: { id: accountId } })
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
  await closeRateLimitStore()
  await prisma.$disconnect()
})

describe('upload safety', () => {
  it('requires authentication', async () => {
    const res = await request(buildApp()).post('/uploads').set('X-Forwarded-For', uniqueIp())
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('AUTH_REQUIRED')
  })

  it('answers 400 instead of crashing when sizeBytes is not a number', async () => {
    const res = await request(buildApp())
      .post('/uploads')
      .set('Authorization', `Bearer ${userToken}`)
      .set('X-Forwarded-For', uniqueIp())
      .field('sizeBytes', 'not-a-number')
      .field('fileName', 'broken.bin')
      .field('mimeType', 'application/octet-stream')
      .attach('file', Buffer.from('hello world'), { filename: 'broken.bin', contentType: 'application/octet-stream' })

    expect(res.status).toBe(400)
    expect(res.body.code).toBe('VALIDATION_FAILED')
  })

  it('answers 400 instead of crashing when filesMeta is not JSON', async () => {
    const res = await request(buildApp())
      .post('/uploads')
      .set('Authorization', `Bearer ${userToken}`)
      .set('X-Forwarded-For', uniqueIp())
      .field('filesMeta', '{ this is not json')
      .attach('file', Buffer.from('hello world'), { filename: 'broken.bin', contentType: 'application/octet-stream' })

    expect(res.status).toBe(400)
    expect(res.body.code).toBe('VALIDATION_FAILED')
  })

  it('rejects a declared size above MAX_UPLOAD_BYTES', async () => {
    const res = await request(buildApp())
      .post('/uploads')
      .set('Authorization', `Bearer ${userToken}`)
      .set('X-Forwarded-For', uniqueIp())
      .field('sizeBytes', String(BigInt(env.MAX_UPLOAD_BYTES) + 1n))
      .field('fileName', 'huge.bin')
      .field('mimeType', 'application/octet-stream')
      .attach('file', Buffer.from('small'), { filename: 'huge.bin', contentType: 'application/octet-stream' })

    expect(res.status).toBe(400)
    expect(res.body.code).toBe('UPLOAD_TOO_LARGE')
  })

  it('answers 413 when the body exceeds the parser size limit', async () => {
    const originalMax = env.MAX_UPLOAD_BYTES
    env.MAX_UPLOAD_BYTES = 64
    try {
      const res = await request(buildApp())
        .post('/uploads')
        .set('Authorization', `Bearer ${userToken}`)
        .set('X-Forwarded-For', uniqueIp())
        .field('sizeBytes', '32')
        .field('fileName', 'oversized.bin')
        .field('mimeType', 'application/octet-stream')
        .attach('file', Buffer.alloc(512), { filename: 'oversized.bin', contentType: 'application/octet-stream' })

      expect(res.status).toBe(413)
      expect(res.body.code).toBe('UPLOAD_TOO_LARGE')
    } finally {
      env.MAX_UPLOAD_BYTES = originalMax
    }
  })
})

describe('zip entry name sanitisation', () => {
  it('strips path traversal segments', () => {
    expect(zipEntryName('../../etc/passwd')).toBe('etc/passwd')
    expect(zipEntryName('a/../../b.txt')).toBe('a/b.txt')
    expect(zipEntryName('..\\..\\windows\\system32\\evil.dll')).toBe('windows/system32/evil.dll')
  })

  it('strips control characters and leading dots', () => {
    expect(zipEntryName('evil\u0000name.txt')).toBe('evilname.txt')
    expect(zipEntryName('.hidden')).toBe('hidden')
    expect(zipEntryName('..')).toBe('file')
    expect(zipEntryName('')).toBe('file')
  })

  it('caps very long names', () => {
    expect(zipEntryName('x'.repeat(500)).length).toBeLessThanOrEqual(200)
  })
})
