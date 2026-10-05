import express from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { env } from '../../../config/env.js'
import { prisma } from '../../../config/prisma.js'
import { errorMiddleware } from '../../../middleware/error.middleware.js'
import { closeRateLimitStore } from '../../../middleware/security.middleware.js'
import { connectedAccountRouter } from '../../../modules/connected-accounts/connected-account.routes.js'
import { providerRouter } from '../../../modules/providers/provider.routes.js'
import { encryptText, hashToken, randomToken } from '../../../utils/crypto.js'
import { signAccessToken } from '../../../utils/jwt.js'
import { enableLocalEndpoint, restoreEndpointEnv, startFakeS3, type FakeS3 } from '../../providers/s3/helpers.js'

const runId = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`

type Actor = { id: string; token: string }

type ProviderView = {
  id: string
  provider: string
  displayName: string | null
  email: string
  status: string
  authMode: string
  capabilities: string[]
  quota: { totalBytes: string | null; usedBytes: string; availableBytes: string | null } | null
  health: { state: string; latencyMs: number | null; checkedAt: string } | null
  lastSyncedAt: string | null
}

let userA: Actor
let userB: Actor
let fakeS3: FakeS3
let s3AccountId: string
let googleConfigId: string
let pcloudConfigId: string

const createdUserIds: string[] = []

function buildApp() {
  const app = express()
  app.set('trust proxy', 1)
  app.use(express.json())
  app.use('/providers', providerRouter)
  app.use('/connected-accounts', connectedAccountRouter)
  app.use(errorMiddleware)
  return app
}

function auth(actor: Actor) {
  return { Authorization: `Bearer ${actor.token}`, 'X-Forwarded-For': `10.63.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}` }
}

async function createActor(label: string): Promise<Actor> {
  const user = await prisma.user.create({
    data: { name: `Providers ${label}`, email: `providers-${label}-${runId}@9drive.test`, passwordHash: 'unused-hash' },
  })
  createdUserIds.push(user.id)
  const session = await prisma.userSession.create({
    data: { userId: user.id, refreshTokenHash: hashToken(randomToken()), expiresAt: new Date(Date.now() + 3600_000) },
  })
  return { id: user.id, token: signAccessToken({ sub: user.id, sid: session.id }) }
}

function s3Body(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Wave5 Bucket',
    bucket: 'test-bucket',
    region: 'us-east-1',
    endpoint: fakeS3.baseUrl,
    accessKeyId: 'test-access-key-id',
    secretAccessKey: 'test-secret-access-key',
    ...overrides,
  }
}

beforeAll(async () => {
  enableLocalEndpoint()
  fakeS3 = await startFakeS3()
  userA = await createActor('a')
  userB = await createActor('b')

  const googleConfig = await prisma.providerConfig.create({
    data: {
      userId: null,
      provider: 'google_drive',
      clientIdEncrypted: encryptText('global-google-client-id'),
      clientSecretEncrypted: encryptText('global-google-client-secret'),
      redirectUri: `${env.FRONTEND_URL}/connected-accounts/google/callback`,
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    },
  })
  googleConfigId = googleConfig.id

  const pcloudConfig = await prisma.providerConfig.create({
    data: {
      userId: userA.id,
      provider: 'pcloud',
      clientIdEncrypted: encryptText('pcloud-app-key'),
      clientSecretEncrypted: encryptText('pcloud-app-secret'),
      redirectUri: `${env.FRONTEND_URL}/connected-accounts/pcloud/callback`,
      scopes: [],
    },
  })
  pcloudConfigId = pcloudConfig.id
})

afterAll(async () => {
  const providerConfigs = await prisma.providerConfig.findMany({
    where: { OR: [{ id: { in: [googleConfigId, pcloudConfigId] } }, { userId: { in: createdUserIds } }] },
    select: { id: true },
  })
  const configIds = providerConfigs.map((config) => config.id)
  const accounts = await prisma.connectedAccount.findMany({
    where: { userId: { in: createdUserIds } },
    select: { id: true },
  })
  const accountIds = accounts.map((account) => account.id)
  if (accountIds.length > 0) {
    await prisma.providerHealth.deleteMany({ where: { connectedAccountId: { in: accountIds } } })
    await prisma.storageAccount.deleteMany({ where: { connectedAccountId: { in: accountIds } } })
    await prisma.s3StorageConfig.deleteMany({ where: { connectedAccountId: { in: accountIds } } })
  }
  await prisma.oauthState.deleteMany({ where: { providerConfigId: { in: configIds } } })
  if (accountIds.length > 0) await prisma.connectedAccount.deleteMany({ where: { id: { in: accountIds } } })
  if (configIds.length > 0) await prisma.providerConfig.deleteMany({ where: { id: { in: configIds } } })
  await prisma.userSession.deleteMany({ where: { userId: { in: createdUserIds } } })
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
  await fakeS3.close()
  restoreEndpointEnv()
  await closeRateLimitStore()
  await prisma.$disconnect()
})

describe('GET /providers/catalog', () => {
  it('is public and returns the frozen catalog verbatim', async () => {
    const res = await request(buildApp()).get('/providers/catalog')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    const pcloud = (res.body as Array<Record<string, unknown>>).find((entry) => entry.id === 'pcloud')
    expect(pcloud?.status).toBe('SUPPORTED')
    expect(pcloud?.authMode).toBe('oauth2')
    expect(pcloud?.displayName).toBeTruthy()
    expect((res.body as unknown[]).length).toBeGreaterThanOrEqual(20)
  })
})

describe('POST /providers/:provider/connect-url', () => {
  it('requires authentication', async () => {
    const res = await request(buildApp()).post('/providers/pcloud/connect-url').send({})
    expect(res.status).toBe(401)
  })

  it('rejects a provider without any OAuth client configuration', async () => {
    const res = await request(buildApp()).post('/providers/dropbox/connect-url').set(auth(userA)).send({})
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('PROVIDER_NOT_AVAILABLE')
  })

  it('creates a user-scoped OAuth client config from inline credentials', async () => {
    const res = await request(buildApp())
      .post('/providers/dropbox/connect-url')
      .set(auth(userA))
      .send({ clientId: 'dropbox-key', clientSecret: 'dropbox-secret' })
    expect(res.status).toBe(200)
    expect(Object.keys(res.body).sort()).toEqual(['state', 'url'])
    const url = new URL(String(res.body.url))
    expect(url.searchParams.get('client_id')).toBe('dropbox-key')
    expect(url.searchParams.get('state')).toBe(String(res.body.state))
    expect(url.searchParams.get('redirect_uri')).toContain('/connected-accounts/dropbox/callback')
    expect(url.searchParams.get('state')).toBeTruthy()

    const created = await prisma.providerConfig.findFirst({
      where: { userId: userA.id, provider: 'dropbox', status: 'active' },
      orderBy: { createdAt: 'desc' },
    })
    expect(created).not.toBeNull()
    expect(created!.redirectUri).toContain('/connected-accounts/dropbox/callback')
  })

  it('rejects non-oauth2 and unplanned providers', async () => {
    const s3 = await request(buildApp()).post('/providers/s3/connect-url').set(auth(userA)).send({})
    expect(s3.status).toBe(400)
    expect(s3.body.code).toBe('AUTH_MODE_UNSUPPORTED')

    const box = await request(buildApp()).post('/providers/box/connect-url').set(auth(userA)).send({})
    expect(box.status).toBe(409)
    expect(box.body.code).toBe('PROVIDER_NOT_AVAILABLE')

    const unknown = await request(buildApp()).post('/providers/not-a-provider/connect-url').set(auth(userA)).send({})
    expect(unknown.status).toBe(404)
    expect(unknown.body.code).toBe('PROVIDER_NOT_FOUND')
  })

  it('rejects half-configured inline credentials', async () => {
    const res = await request(buildApp()).post('/providers/pcloud/connect-url').set(auth(userA)).send({ clientId: 'only-key' })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('VALIDATION_FAILED')
  })
})

describe('POST /providers/:provider/accounts', () => {
  it('creates an S3 account and returns the §4.1 view', async () => {
    const res = await request(buildApp()).post('/providers/s3/accounts').set(auth(userA)).send(s3Body())
    expect(res.status).toBe(201)
    const view = res.body.account as ProviderView
    expect(view.provider).toBe('s3')
    expect(view.status).toBe('connected')
    expect(view.authMode).toBe('access_key')
    expect(view.quota?.usedBytes).toBe('0')
    expect(view.quota?.totalBytes).toBeNull()
    expect(view.capabilities).toContain('upload')
    s3AccountId = view.id

    const stored = await prisma.connectedAccount.findUnique({ where: { id: s3AccountId } })
    expect(stored?.providerConfigId).toBeNull()
  })

  it('rejects blocked endpoints with SSRF_BLOCKED and stores nothing', async () => {
    const before = await prisma.connectedAccount.count({ where: { userId: userA.id } })
    const res = await request(buildApp())
      .post('/providers/s3/accounts')
      .set(auth(userA))
      .send(s3Body({ bucket: 'blocked-bucket', endpoint: 'http://localhost:9000' }))
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('SSRF_BLOCKED')
    const after = await prisma.connectedAccount.count({ where: { userId: userA.id } })
    expect(after).toBe(before)
  })

  it('validates the body with zod', async () => {
    const res = await request(buildApp()).post('/providers/s3/accounts').set(auth(userA)).send({ name: 'Broken' })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('VALIDATION_FAILED')
    expect(res.body.message).toMatch(/bucket/)
  })

  it('refuses OAuth2, unknown and planned providers', async () => {
    const google = await request(buildApp()).post('/providers/google_drive/accounts').set(auth(userA)).send(s3Body())
    expect(google.status).toBe(400)
    expect(google.body.code).toBe('AUTH_MODE_UNSUPPORTED')

    const box = await request(buildApp()).post('/providers/box/accounts').set(auth(userA)).send(s3Body())
    expect(box.status).toBe(409)
    expect(box.body.code).toBe('PROVIDER_NOT_AVAILABLE')

    const unknown = await request(buildApp()).post('/providers/not-a-provider/accounts').set(auth(userA)).send(s3Body())
    expect(unknown.status).toBe(404)
    expect(unknown.body.code).toBe('PROVIDER_NOT_FOUND')
  })

  it('has no /quota route (§4.1 does not define one)', async () => {
    const res = await request(buildApp()).post(`/providers/accounts/${s3AccountId}/quota`).set(auth(userA)).send({})
    expect(res.status).toBe(404)
  })
})

describe('GET /providers', () => {
  it('requires authentication', async () => {
    const res = await request(buildApp()).get('/providers')
    expect(res.status).toBe(401)
  })

  it('returns only the current user accounts with the exact §4.1 shape', async () => {
    const res = await request(buildApp()).get('/providers').set(auth(userA))
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    const views = res.body as ProviderView[]
    const view = views.find((entry) => entry.id === s3AccountId)
    expect(view).toBeDefined()
    expect(Object.keys(view!).sort()).toEqual([
      'authMode',
      'capabilities',
      'displayName',
      'email',
      'health',
      'id',
      'lastSyncedAt',
      'provider',
      'quota',
      'status',
    ])
    expect(view!.quota).toEqual({ totalBytes: null, usedBytes: '0', availableBytes: null })
    expect(view!.health).toBeNull()
    expect(view!.lastSyncedAt).toBeTruthy()
    expect(JSON.stringify(res.body)).not.toContain('accessTokenEncrypted')
    expect(JSON.stringify(res.body)).not.toContain('secretAccessKey')
  })

  it('never lists another tenant accounts', async () => {
    const res = await request(buildApp()).get('/providers').set(auth(userB))
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })
})

describe('per-account routes', () => {
  it('returns capabilities from the registry', async () => {
    const res = await request(buildApp()).get(`/providers/accounts/${s3AccountId}/capabilities`).set(auth(userA))
    expect(res.status).toBe(200)
    expect(res.body.capabilities).toContain('upload')
    expect(res.body.capabilities).toContain('healthCheck')
    expect(Array.isArray(res.body.capabilities)).toBe(true)
  })

  it('enforces ownership on capabilities, health and delete', async () => {
    const capabilities = await request(buildApp()).get(`/providers/accounts/${s3AccountId}/capabilities`).set(auth(userB))
    expect(capabilities.status).toBe(404)
    expect(String(capabilities.body.code)).toMatch(/NOT_FOUND/)

    const health = await request(buildApp()).post(`/providers/accounts/${s3AccountId}/health`).set(auth(userB)).send({})
    expect(health.status).toBe(404)
    expect(String(health.body.code)).toMatch(/NOT_FOUND/)

    const remove = await request(buildApp()).delete(`/providers/accounts/${s3AccountId}`).set(auth(userB))
    expect(remove.status).toBe(404)
    expect(String(remove.body.code)).toMatch(/NOT_FOUND/)

    const unknown = await request(buildApp()).get('/providers/accounts/not-a-uuid/capabilities').set(auth(userA))
    expect(unknown.status).toBe(404)
  })

  it('runs a health check and persists the result', async () => {
    const res = await request(buildApp()).post(`/providers/accounts/${s3AccountId}/health`).set(auth(userA)).send({})
    expect(res.status).toBe(200)
    expect(res.body.state).toBe('healthy')
    expect(typeof res.body.latencyMs).toBe('number')
    expect(res.body.checkedAt).toBeTruthy()

    const list = await request(buildApp()).get('/providers').set(auth(userA))
    const view = (list.body as ProviderView[]).find((entry) => entry.id === s3AccountId)
    expect(view?.health?.state).toBe('healthy')
    expect(view?.health?.checkedAt).toBeTruthy()
  })

  it('syncs quota through the legacy alias', async () => {
    const res = await request(buildApp()).post(`/connected-accounts/${s3AccountId}/sync-quota`).set(auth(userA)).send({})
    expect(res.status).toBe(200)
    expect(res.body.quota.usedBytes).toBe('0')
  })

  it('disconnects the account through DELETE /providers/accounts/:accountId', async () => {
    const res = await request(buildApp()).delete(`/providers/accounts/${s3AccountId}`).set(auth(userA))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'ok' })

    const list = await request(buildApp()).get('/providers').set(auth(userA))
    expect((list.body as ProviderView[]).some((entry) => entry.id === s3AccountId)).toBe(false)

    const again = await request(buildApp()).delete(`/providers/accounts/${s3AccountId}`).set(auth(userA))
    expect(again.status).toBe(404)
    expect(String(again.body.code)).toMatch(/NOT_FOUND/)
  })
})

describe('legacy connected-accounts compatibility', () => {
  it('POST /connected-accounts/s3 still answers 201 and never links a Google ProviderConfig', async () => {
    const res = await request(buildApp()).post('/connected-accounts/s3').set(auth(userB)).send(s3Body())
    expect(res.status).toBe(201)
    expect(res.body.account.provider).toBe('s3')
    expect(res.body.account.storageAccount.usedBytes).toBe('0')
    expect(res.body.account.storageAccount.totalBytes).toBeNull()

    const stored = await prisma.connectedAccount.findUnique({ where: { id: res.body.account.id } })
    expect(stored).not.toBeNull()
    expect(stored!.providerConfigId).toBeNull()
    expect(googleConfigId).toBeTruthy()
  })

  it('GET /connected-accounts/google/connect-url still answers { url } only', async () => {
    const res = await request(buildApp()).get('/connected-accounts/google/connect-url').set(auth(userA))
    expect(res.status).toBe(200)
    expect(Object.keys(res.body)).toEqual(['url'])
    expect(String(res.body.url)).toContain('accounts.google.com')
  })

  it('GET /connected-accounts/:provider/connect-url answers { url, state }', async () => {
    const res = await request(buildApp()).get('/connected-accounts/pcloud/connect-url').set(auth(userA))
    expect(res.status).toBe(200)
    expect(Object.keys(res.body).sort()).toEqual(['state', 'url'])
    expect(String(res.body.url)).toContain('my.pcloud.com')
    expect(String(res.body.state)).toBeTruthy()

    const scoped = await request(buildApp())
      .get('/connected-accounts/pcloud/connect-url')
      .query({ providerConfigId: pcloudConfigId })
      .set(auth(userA))
    expect(scoped.status).toBe(200)
    expect(String(scoped.body.state)).toBeTruthy()
  })

  it('GET /connected-accounts/:provider/callback rejects an unknown state', async () => {
    const res = await request(buildApp()).get('/connected-accounts/pcloud/callback').query({ state: 'bogus-state' })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('OAUTH_STATE_INVALID')
  })

  it('DELETE /connected-accounts/:id still answers { status: ok }', async () => {
    const list = await request(buildApp()).get('/connected-accounts').set(auth(userB))
    const account = (list.body.accounts as Array<{ id: string }>)[0]
    expect(account).toBeDefined()
    const res = await request(buildApp()).delete(`/connected-accounts/${account.id}`).set(auth(userB))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'ok' })
  })
})
