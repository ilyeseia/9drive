/**
 * TeraBox device-code connect flow (QR scan) — official doc §2.
 *
 * Why not the redirect flow: the authorization-code mode documents no
 * `redirect_uri` and no `state`, so CSRF protection cannot be delegated to it.
 * Here the browser only ever holds an opaque 256-bit handle that is bound to the
 * authenticated 9Drive user; the `device_code` stays server-side, encrypted at rest
 * in Redis with a TTL equal to the code's lifetime. Polls are throttled to the
 * interval TeraBox dictates and serialised with a short lock so a device code is
 * never exchanged twice.
 *
 * Provider-specific secrets: client id/secret come from `ProviderConfig`
 * (seeded from env), the signing `private_secret` only from `TERABOX_PRIVATE_SECRET`.
 */

import type { ProviderConfig } from '@prisma/client'
import { prisma } from '../../config/prisma.js'
import { pollDeviceToken, readPrivateSecret, startDeviceAuthorization, type DeviceAuthorization, type DevicePollResult, type TeraBoxAppCredentials } from '../../providers/terabox-open/auth.js'
import { buildContext, refreshQuota, registry } from '../../providers/index.js'
import type { OAuth2TokenResult } from '../../providers/oauth2.js'
import { getAppConnection } from '../../queues/connection.js'
import { decryptText, encryptText, hashToken, randomToken } from '../../utils/crypto.js'
import { RequestError } from './http-error.js'

export const TERABOX_OPEN_PROVIDER = 'terabox_open'
const KEY_PREFIX = '9drive:tbdev:'
const LOCK_MS = 15_000
const HANDLE_PATTERN = /^[A-Za-z0-9_-]{43}$/

export interface DeviceSession {
  userId: string
  providerConfigId: string
  deviceCode: string
  intervalSeconds: number
  expiresAt: number
  lastPollAt: number
}

export interface DeviceFlowStore {
  /** Store a session and make it the user's only active one; returns the replaced handle hash. */
  put(handleHash: string, session: DeviceSession, ttlMs: number): Promise<string | null>
  get(handleHash: string): Promise<DeviceSession | null>
  update(handleHash: string, session: DeviceSession, ttlMs: number): Promise<void>
  delete(handleHash: string): Promise<void>
  tryLock(handleHash: string, ttlMs: number): Promise<boolean>
  unlock(handleHash: string): Promise<void>
}

export interface DeviceFlowDeps {
  store: DeviceFlowStore
  now: () => number
  loadApp: (userId: string) => Promise<{ config: ProviderConfig; creds: TeraBoxAppCredentials }>
  start: (clientId: string) => Promise<DeviceAuthorization>
  poll: (creds: TeraBoxAppCredentials, deviceCode: string) => Promise<DevicePollResult>
  finalize: (userId: string, config: ProviderConfig, tokens: OAuth2TokenResult) => Promise<{ accountId: string }>
}

export interface DeviceFlowStartResult {
  handle: string
  qrCodeDataUrl: string
  expiresInSeconds: number
  intervalSeconds: number
}

export type DeviceFlowPollResult =
  | { status: 'pending'; retryAfterSeconds: number }
  | { status: 'connected'; accountId: string }

/** Redis-backed store; sessions are AES-GCM encrypted with the application's token key. */
export function createRedisDeviceFlowStore(): DeviceFlowStore {
  const redis = () => getAppConnection()
  const key = (hash: string) => `${KEY_PREFIX}${hash}`
  const userKey = (userId: string) => `${KEY_PREFIX}user:${userId}`
  const lockKey = (hash: string) => `${KEY_PREFIX}lock:${hash}`
  return {
    async put(handleHash, session, ttlMs) {
      const client = redis()
      const previous = await client.get(userKey(session.userId))
      await client.set(key(handleHash), encryptText(JSON.stringify(session)), 'PX', ttlMs)
      await client.set(userKey(session.userId), handleHash, 'PX', ttlMs)
      if (previous && previous !== handleHash) {
        await client.del(key(previous))
        return previous
      }
      return null
    },
    async get(handleHash) {
      const raw = await redis().get(key(handleHash))
      if (!raw) return null
      try {
        return JSON.parse(decryptText(raw)) as DeviceSession
      } catch {
        return null
      }
    },
    async update(handleHash, session, ttlMs) {
      await redis().set(key(handleHash), encryptText(JSON.stringify(session)), 'PX', Math.max(1, ttlMs))
    },
    async delete(handleHash) {
      const client = redis()
      const session = await this.get(handleHash)
      await client.del(key(handleHash))
      if (session && (await client.get(userKey(session.userId))) === handleHash) await client.del(userKey(session.userId))
    },
    async tryLock(handleHash, ttlMs) {
      return (await redis().set(lockKey(handleHash), '1', 'PX', ttlMs, 'NX')) === 'OK'
    },
    async unlock(handleHash) {
      await redis().del(lockKey(handleHash))
    },
  }
}

function decryptStored(value: string): string {
  return decryptText(value.startsWith('v1:') ? value.slice(3) : value)
}

async function loadApp(userId: string): Promise<{ config: ProviderConfig; creds: TeraBoxAppCredentials }> {
  let privateSecret: string
  try {
    privateSecret = readPrivateSecret()
  } catch {
    throw new RequestError(409, 'PROVIDER_NOT_CONFIGURED', 'TeraBox is not configured on this server (missing application credentials).')
  }
  const owned = await prisma.providerConfig.findFirst({
    where: { userId, provider: TERABOX_OPEN_PROVIDER, status: 'active' },
    orderBy: { createdAt: 'desc' },
  })
  const config =
    owned ??
    (await prisma.providerConfig.findFirst({
      where: { userId: null, provider: TERABOX_OPEN_PROVIDER, status: 'active' },
      orderBy: { createdAt: 'desc' },
    }))
  if (!config) {
    throw new RequestError(409, 'PROVIDER_NOT_CONFIGURED', 'TeraBox is not configured on this server (missing application credentials).')
  }
  return {
    config,
    creds: {
      clientId: decryptStored(config.clientIdEncrypted),
      clientSecret: decryptStored(config.clientSecretEncrypted),
      privateSecret,
    },
  }
}

/**
 * Mirrors the tail of `handleConnectCallback` (connect-flow.ts) for token-bearing
 * accounts: pending row → profile lookup → de-duplicate on providerAccountId → quota sync.
 * Kept separate so the Google/Dropbox redirect path is untouched.
 */
export async function finalizeAccount(userId: string, config: ProviderConfig, tokens: OAuth2TokenResult): Promise<{ accountId: string }> {
  const pending = await prisma.connectedAccount.create({
    data: {
      userId,
      providerConfigId: config.id,
      provider: TERABOX_OPEN_PROVIDER,
      providerAccountId: `pending:${randomToken(12)}`,
      email: '',
      accessTokenEncrypted: encryptText(tokens.accessToken),
      refreshTokenEncrypted: tokens.refreshToken ? encryptText(tokens.refreshToken) : null,
      tokenExpiresAt: tokens.expiresAt === null ? null : new Date(tokens.expiresAt),
      scopes: [],
      status: 'pending',
    },
  })
  const discard = () => prisma.connectedAccount.delete({ where: { id: pending.id } }).catch(() => undefined)

  let remoteId = ''
  let info: Awaited<ReturnType<ReturnType<typeof registry.get>['getAccountInfo']>> | null = null
  try {
    const context = await buildContext(pending.id)
    info = await registry.get(TERABOX_OPEN_PROVIDER).getAccountInfo(context)
    remoteId = String(info.providerAccountId ?? '').trim()
  } catch {
    info = null
  }
  if (!info || !remoteId) {
    await discard()
    throw new RequestError(502, 'ACCOUNT_PROFILE_FAILED', 'TeraBox authorized the device but the account profile could not be read.')
  }

  const duplicate = await prisma.connectedAccount.findFirst({
    where: { userId, provider: TERABOX_OPEN_PROVIDER, providerAccountId: remoteId, NOT: { id: pending.id } },
  })
  let accountId = pending.id
  if (duplicate) {
    // Reauthorization of an existing account: replace its credentials, keep its history and settings.
    await prisma.connectedAccount.update({
      where: { id: duplicate.id },
      data: {
        providerConfigId: config.id,
        displayName: info.displayName ?? duplicate.displayName,
        avatarUrl: info.avatarUrl ?? duplicate.avatarUrl,
        accessTokenEncrypted: encryptText(tokens.accessToken),
        ...(tokens.refreshToken ? { refreshTokenEncrypted: encryptText(tokens.refreshToken) } : {}),
        tokenExpiresAt: tokens.expiresAt === null ? null : new Date(tokens.expiresAt),
        status: 'connected',
        lastError: null,
      },
    })
    await discard()
    accountId = duplicate.id
  } else {
    await prisma.connectedAccount.update({
      where: { id: pending.id },
      data: {
        providerAccountId: remoteId,
        email: info.email?.trim() || '',
        displayName: info.displayName,
        avatarUrl: info.avatarUrl,
        status: 'connected',
        lastError: null,
      },
    })
  }
  await refreshQuota(accountId).catch(() => undefined)
  return { accountId }
}

export function defaultDeviceFlowDeps(): DeviceFlowDeps {
  return {
    store: createRedisDeviceFlowStore(),
    now: () => Date.now(),
    loadApp,
    start: (clientId) => startDeviceAuthorization(clientId),
    poll: (creds, deviceCode) => pollDeviceToken(creds, deviceCode),
    finalize: finalizeAccount,
  }
}

export async function startTeraBoxDeviceFlow(
  userId: string,
  deps: DeviceFlowDeps = defaultDeviceFlowDeps(),
): Promise<DeviceFlowStartResult> {
  const { config, creds } = await deps.loadApp(userId)
  const auth = await deps.start(creds.clientId)
  const handle = randomToken(32)
  const now = deps.now()
  const ttlMs = auth.expiresInSeconds * 1000
  await deps.store.put(
    hashToken(handle),
    {
      userId,
      providerConfigId: config.id,
      deviceCode: auth.deviceCode,
      intervalSeconds: auth.intervalSeconds,
      expiresAt: now + ttlMs,
      lastPollAt: 0,
    },
    ttlMs,
  )
  return {
    handle,
    qrCodeDataUrl: auth.qrCodeDataUrl,
    expiresInSeconds: auth.expiresInSeconds,
    intervalSeconds: auth.intervalSeconds,
  }
}

function notFound(): RequestError {
  return new RequestError(404, 'DEVICE_FLOW_NOT_FOUND', 'The TeraBox authorization expired or does not exist. Start again.')
}

export async function pollTeraBoxDeviceFlow(
  userId: string,
  handle: string,
  deps: DeviceFlowDeps = defaultDeviceFlowDeps(),
): Promise<DeviceFlowPollResult> {
  if (typeof handle !== 'string' || !HANDLE_PATTERN.test(handle)) throw notFound()
  const handleHash = hashToken(handle)
  const session = await deps.store.get(handleHash)
  // A handle that belongs to another user is indistinguishable from an unknown one.
  if (!session || session.userId !== userId) throw notFound()

  const now = deps.now()
  const remainingMs = session.expiresAt - now
  if (remainingMs <= 0) {
    await deps.store.delete(handleHash)
    throw notFound()
  }
  const waitMs = session.lastPollAt + session.intervalSeconds * 1000 - now
  if (waitMs > 0) return { status: 'pending', retryAfterSeconds: Math.ceil(waitMs / 1000) }

  if (!(await deps.store.tryLock(handleHash, LOCK_MS))) {
    return { status: 'pending', retryAfterSeconds: session.intervalSeconds }
  }
  try {
    await deps.store.update(handleHash, { ...session, lastPollAt: now }, remainingMs)
    const { config, creds } = await deps.loadApp(userId)
    const result = await deps.poll(creds, session.deviceCode)
    if (result.status === 'pending') return { status: 'pending', retryAfterSeconds: session.intervalSeconds }
    // Tokens are single-use material: drop the device session before persisting anything.
    await deps.store.delete(handleHash)
    const { accountId } = await deps.finalize(userId, config, result.tokens)
    return { status: 'connected', accountId }
  } finally {
    await deps.store.unlock(handleHash).catch(() => undefined)
  }
}

/** In-memory store for tests and single-process tooling. */
export function createMemoryDeviceFlowStore(): DeviceFlowStore & { size(): number } {
  const sessions = new Map<string, DeviceSession>()
  const active = new Map<string, string>()
  const locks = new Set<string>()
  return {
    async put(handleHash, session) {
      const previous = active.get(session.userId) ?? null
      if (previous) sessions.delete(previous)
      sessions.set(handleHash, session)
      active.set(session.userId, handleHash)
      return previous
    },
    async get(handleHash) {
      return sessions.get(handleHash) ?? null
    },
    async update(handleHash, session) {
      sessions.set(handleHash, session)
    },
    async delete(handleHash) {
      const session = sessions.get(handleHash)
      sessions.delete(handleHash)
      if (session && active.get(session.userId) === handleHash) active.delete(session.userId)
    },
    async tryLock(handleHash) {
      if (locks.has(handleHash)) return false
      locks.add(handleHash)
      return true
    },
    async unlock(handleHash) {
      locks.delete(handleHash)
    },
    size: () => sessions.size,
  }
}
