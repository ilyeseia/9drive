import express from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '../../config/prisma.js'
import { errorMiddleware } from '../../middleware/error.middleware.js'
import { closeRateLimitStore } from '../../middleware/security.middleware.js'
import { systemRouter } from '../../modules/system/system.routes.js'
import { hashToken, randomToken } from '../../utils/crypto.js'
import { signAccessToken } from '../../utils/jwt.js'

const runId = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
const createdUserIds: string[] = []
let adminToken = ''
let userToken = ''

function uniqueIp() {
  return `10.51.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`
}

function buildApp() {
  const app = express()
  app.set('trust proxy', 1)
  app.use(express.json())
  app.use('/system', systemRouter)
  app.use(errorMiddleware)
  return app
}

async function createSessionToken(userId: string) {
  const session = await prisma.userSession.create({
    data: { userId, refreshTokenHash: hashToken(randomToken()), expiresAt: new Date(Date.now() + 3600_000) },
  })
  return signAccessToken({ sub: userId, sid: session.id })
}

beforeAll(async () => {
  const admin = await prisma.user.create({ data: { name: 'Security Admin', email: `sec-admin-${runId}@9drive.test`, passwordHash: 'unused-hash', role: 'admin' } })
  const user = await prisma.user.create({ data: { name: 'Security User', email: `sec-user-${runId}@9drive.test`, passwordHash: 'unused-hash', role: 'user' } })
  createdUserIds.push(admin.id, user.id)
  adminToken = await createSessionToken(admin.id)
  userToken = await createSessionToken(user.id)
})

afterAll(async () => {
  await prisma.userSession.deleteMany({ where: { userId: { in: createdUserIds } } })
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
  await closeRateLimitStore()
  await prisma.$disconnect()
})

describe('system admin routes', () => {
  it('rejects requests without a bearer token with 401', async () => {
    const res = await request(buildApp()).get('/system/backup').set('X-Forwarded-For', uniqueIp())
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('AUTH_REQUIRED')
  })

  it('rejects non-admin users with 403 before any handler runs', async () => {
    const app = buildApp()
    const getRes = await request(app).get('/system/backup').set('Authorization', `Bearer ${userToken}`).set('X-Forwarded-For', uniqueIp())
    expect(getRes.status).toBe(403)
    expect(getRes.body.code).toBe('FORBIDDEN')

    const postRes = await request(app)
      .post('/system/update')
      .set('Authorization', `Bearer ${userToken}`)
      .set('X-Forwarded-For', uniqueIp())
      .send({ confirm: 'UPDATE' })
    expect(postRes.status).toBe(403)
    expect(postRes.body.code).toBe('FORBIDDEN')
  })

  it('rejects inactive accounts with 403', async () => {
    const suspended = await prisma.user.create({ data: { name: 'Suspended User', email: `sec-suspended-${runId}@9drive.test`, passwordHash: 'unused-hash', role: 'admin', status: 'suspended' } })
    createdUserIds.push(suspended.id)
    const token = await createSessionToken(suspended.id)
    const res = await request(buildApp()).get('/system/backup').set('Authorization', `Bearer ${token}`).set('X-Forwarded-For', uniqueIp())
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('AUTH_ACCOUNT_DISABLED')
  })

  it('lets admins through the role gate and refuses non-file database backups', async () => {
    const res = await request(buildApp()).get('/system/backup').set('Authorization', `Bearer ${adminToken}`).set('X-Forwarded-For', uniqueIp())
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('BACKUP_UNSUPPORTED')
    expect(res.headers['cache-control']).toContain('no-store')
  })

  it('requires an explicit confirmation before starting an update', async () => {
    const app = buildApp()
    const missing = await request(app).post('/system/update').set('Authorization', `Bearer ${adminToken}`).set('X-Forwarded-For', uniqueIp()).send({})
    expect(missing.status).toBe(400)
    expect(missing.body.code).toBe('CONFIRMATION_REQUIRED')

    const wrong = await request(app).post('/system/update').set('Authorization', `Bearer ${adminToken}`).set('X-Forwarded-For', uniqueIp()).send({ confirm: 'yes' })
    expect(wrong.status).toBe(400)
    expect(wrong.body.code).toBe('CONFIRMATION_REQUIRED')
  })

  it('refuses restore for non-file databases without reading any upload', async () => {
    const res = await request(buildApp())
      .post('/system/restore')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Forwarded-For', uniqueIp())
      .set('Content-Type', 'multipart/form-data; boundary=----9drive')
      .send('------9drive\r\nContent-Disposition: form-data; name="confirm"\r\n\r\nRESTORE\r\n------9drive--\r\n')
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('RESTORE_UNSUPPORTED')
  })
})
