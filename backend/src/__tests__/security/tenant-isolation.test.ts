import express from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '../../config/prisma.js'
import { errorMiddleware } from '../../middleware/error.middleware.js'
import { closeRateLimitStore } from '../../middleware/security.middleware.js'
import { apiKeyRouter } from '../../modules/api-keys/api-key.routes.js'
import { auditLogRouter } from '../../modules/audit-logs/audit-log.routes.js'
import { connectedAccountRouter } from '../../modules/connected-accounts/connected-account.routes.js'
import { fileRouter } from '../../modules/files/file.routes.js'
import { folderRouter } from '../../modules/folders/folder.routes.js'
import { inviteRouter } from '../../modules/invites/invite.routes.js'
import { hashToken, randomToken } from '../../utils/crypto.js'
import { signAccessToken } from '../../utils/jwt.js'

const runId = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`

type Actor = { id: string; token: string }

let userA: Actor
let userB: Actor
let aAccountId: string
let aFileId: string
let aFolderId: string
let aApiKeyId: string
let aAuditLogId: string
let aInviteId: string

const createdUserIds: string[] = []

function uniqueIp() {
  return `10.57.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`
}

function buildApp() {
  const app = express()
  app.set('trust proxy', 1)
  app.use(express.json())
  app.use('/files', fileRouter)
  app.use('/folders', folderRouter)
  app.use('/connected-accounts', connectedAccountRouter)
  app.use('/api-keys', apiKeyRouter)
  app.use('/audit-logs', auditLogRouter)
  app.use('/invites', inviteRouter)
  app.use(errorMiddleware)
  return app
}

async function createActor(label: string): Promise<Actor> {
  const user = await prisma.user.create({ data: { name: `Tenant ${label}`, email: `tenant-${label}-${runId}@9drive.test`, passwordHash: 'unused-hash' } })
  createdUserIds.push(user.id)
  const session = await prisma.userSession.create({
    data: { userId: user.id, refreshTokenHash: hashToken(randomToken()), expiresAt: new Date(Date.now() + 3600_000) },
  })
  return { id: user.id, token: signAccessToken({ sub: user.id, sid: session.id }) }
}

beforeAll(async () => {
  userA = await createActor('a')
  userB = await createActor('b')

  const account = await prisma.connectedAccount.create({
    data: { userId: userA.id, provider: 's3', providerAccountId: `tenant-a-${runId}`, email: `tenant-a-${runId}@storage.test`, scopes: [] },
  })
  aAccountId = account.id

  const folder = await prisma.folder.create({ data: { userId: userA.id, name: 'A Folder' } })
  aFolderId = folder.id

  const file = await prisma.file.create({
    data: { userId: userA.id, connectedAccountId: aAccountId, folderId: aFolderId, provider: 's3', providerFileId: `tenant-a-${runId}`, name: 'A Secret.pdf', mimeType: 'application/pdf', sizeBytes: 2048n },
  })
  aFileId = file.id

  const apiKeyResponse = await request(buildApp()).post('/api-keys').set('Authorization', `Bearer ${userA.token}`).set('X-Forwarded-For', uniqueIp()).send({ name: 'tenant-a-key' })
  aApiKeyId = apiKeyResponse.body.apiKey.id

  const audit = await prisma.auditLog.create({ data: { userId: userA.id, action: 'TRASH_FILE', entityType: 'file', entityId: aFileId, metadata: { name: 'A Secret.pdf' } } })
  aAuditLogId = audit.id

  const inviteResponse = await request(buildApp())
    .post('/invites')
    .set('Authorization', `Bearer ${userA.token}`)
    .set('X-Forwarded-For', uniqueIp())
    .send({ email: `invitee-${runId}@9drive.test`, role: 'viewer', targetType: 'file', targetId: aFileId })
  aInviteId = inviteResponse.body.invite.id
  expect(inviteResponse.status).toBe(201)
  expect(inviteResponse.body.invite.status).toBe('pending')
})

afterAll(async () => {
  await prisma.userSession.deleteMany({ where: { userId: { in: createdUserIds } } })
  await prisma.auditLog.deleteMany({ where: { userId: { in: createdUserIds } } })
  await prisma.file.deleteMany({ where: { id: aFileId } })
  await prisma.folder.deleteMany({ where: { id: aFolderId } })
  await prisma.connectedAccount.deleteMany({ where: { id: aAccountId } })
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
  await closeRateLimitStore()
  await prisma.$disconnect()
})

function expectNotFound(res: { status: number; body: Record<string, unknown> }) {
  expect(res.status).toBe(404)
  expect(String(res.body.code ?? '')).toMatch(/NOT_FOUND/)
  expect(JSON.stringify(res.body)).not.toContain('PrismaClient')
  expect(JSON.stringify(res.body)).not.toContain('stack')
}

describe('tenant isolation: user B against user A resources', () => {
  it('file read -> 404', async () => {
    const res = await request(buildApp()).get(`/files/${aFileId}`).set('Authorization', `Bearer ${userB.token}`).set('X-Forwarded-For', uniqueIp())
    expectNotFound(res)
  })

  it('file rename/move -> 404', async () => {
    const res = await request(buildApp()).patch(`/files/${aFileId}`).set('Authorization', `Bearer ${userB.token}`).set('X-Forwarded-For', uniqueIp()).send({ name: 'stolen.pdf' })
    expectNotFound(res)
  })

  it('file trash -> 404', async () => {
    const res = await request(buildApp()).delete(`/files/${aFileId}`).set('Authorization', `Bearer ${userB.token}`).set('X-Forwarded-For', uniqueIp())
    expectNotFound(res)
  })

  it('file share create -> 404', async () => {
    const res = await request(buildApp()).post(`/files/${aFileId}/share`).set('Authorization', `Bearer ${userB.token}`).set('X-Forwarded-For', uniqueIp()).send({})
    expectNotFound(res)
  })

  it('file share revoke -> 404', async () => {
    const res = await request(buildApp()).delete(`/files/${aFileId}/share`).set('Authorization', `Bearer ${userB.token}`).set('X-Forwarded-For', uniqueIp())
    expectNotFound(res)
  })

  it('file preview token minting -> 404', async () => {
    const res = await request(buildApp()).post(`/files/${aFileId}/preview-token`).set('Authorization', `Bearer ${userB.token}`).set('X-Forwarded-For', uniqueIp()).send({})
    expectNotFound(res)
  })

  it('folder rename -> 404', async () => {
    const res = await request(buildApp()).patch(`/folders/${aFolderId}`).set('Authorization', `Bearer ${userB.token}`).set('X-Forwarded-For', uniqueIp()).send({ name: 'stolen folder' })
    expectNotFound(res)
  })

  it('folder delete -> 404', async () => {
    const res = await request(buildApp()).delete(`/folders/${aFolderId}`).set('Authorization', `Bearer ${userB.token}`).set('X-Forwarded-For', uniqueIp())
    expectNotFound(res)
  })

  it('connected-account delete -> 404', async () => {
    const res = await request(buildApp()).delete(`/connected-accounts/${aAccountId}`).set('Authorization', `Bearer ${userB.token}`).set('X-Forwarded-For', uniqueIp())
    expectNotFound(res)
  })

  it('connected-account sync-quota -> 404', async () => {
    const res = await request(buildApp()).post(`/connected-accounts/${aAccountId}/sync-quota`).set('Authorization', `Bearer ${userB.token}`).set('X-Forwarded-For', uniqueIp()).send({})
    expectNotFound(res)
  })

  it('api-key revoke -> 404', async () => {
    const res = await request(buildApp()).delete(`/api-keys/${aApiKeyId}`).set('Authorization', `Bearer ${userB.token}`).set('X-Forwarded-For', uniqueIp())
    expectNotFound(res)
  })

  it('invite revoke -> 404', async () => {
    const res = await request(buildApp()).delete(`/invites/${aInviteId}`).set('Authorization', `Bearer ${userB.token}`).set('X-Forwarded-For', uniqueIp())
    expectNotFound(res)
  })

  it('invite accept -> 404', async () => {
    const res = await request(buildApp()).post(`/invites/${aInviteId}/accept`).set('Authorization', `Bearer ${userB.token}`).set('X-Forwarded-For', uniqueIp()).send({})
    expectNotFound(res)
  })

  it('invitee can explicitly accept their own invite', async () => {
    const invitee = await prisma.user.create({ data: { name: 'Tenant invitee', email: `invitee-${runId}@9drive.test`, passwordHash: 'unused-hash' } })
    createdUserIds.push(invitee.id)
    const session = await prisma.userSession.create({
      data: { userId: invitee.id, refreshTokenHash: hashToken(randomToken()), expiresAt: new Date(Date.now() + 3600_000) },
    })
    const token = signAccessToken({ sub: invitee.id, sid: session.id })
    const res = await request(buildApp()).post(`/invites/${aInviteId}/accept`).set('Authorization', `Bearer ${token}`).set('X-Forwarded-For', uniqueIp()).send({})
    expect(res.status).toBe(200)
    expect(res.body.invite.status).toBe('accepted')
    expect(res.body.invite.acceptedAt).toBeTruthy()
  })

  it('audit-log list never exposes another tenant rows', async () => {
    const bLog = await prisma.auditLog.create({ data: { userId: userB.id, action: 'TRASH_FILE', entityType: 'file', metadata: { name: 'B file' } } })
    const res = await request(buildApp()).get('/audit-logs').set('Authorization', `Bearer ${userB.token}`).set('X-Forwarded-For', uniqueIp())
    expect(res.status).toBe(200)
    const ids = (res.body.logs as Array<{ id: string }>).map((log) => log.id)
    expect(ids).toContain(bLog.id)
    expect(ids).not.toContain(aAuditLogId)
  })
})

describe('tenant isolation: owner still has access', () => {
  it('owner can read their own file', async () => {
    const res = await request(buildApp()).get(`/files/${aFileId}`).set('Authorization', `Bearer ${userA.token}`).set('X-Forwarded-For', uniqueIp())
    expect(res.status).toBe(200)
    expect(res.body.file.id).toBe(aFileId)
  })

  it('owner can still see their account, key and invite', async () => {
    const app = buildApp()
    const accounts = await request(app).get('/connected-accounts').set('Authorization', `Bearer ${userA.token}`).set('X-Forwarded-For', uniqueIp())
    expect(accounts.status).toBe(200)
    expect((accounts.body.accounts as Array<{ id: string }>).some((account) => account.id === aAccountId)).toBe(true)

    const keys = await request(app).get('/api-keys').set('Authorization', `Bearer ${userA.token}`).set('X-Forwarded-For', uniqueIp())
    expect(keys.status).toBe(200)
    expect((keys.body.apiKeys as Array<{ id: string }>).some((key) => key.id === aApiKeyId)).toBe(true)

    const invites = await request(app).get('/invites').set('Authorization', `Bearer ${userA.token}`).set('X-Forwarded-For', uniqueIp())
    expect(invites.status).toBe(200)
    expect((invites.body.sent as Array<{ id: string }>).some((invite) => invite.id === aInviteId)).toBe(true)
  })
})
