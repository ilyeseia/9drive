/**
 * Connected-account views and credential flows shared by the providers module
 * and the legacy connected-accounts routes (api-contract §4.1, security §3.4).
 */

import type { ConnectedAccount, ProviderHealth, StorageAccount } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../../config/prisma.js'
import { catalog, ProviderError, registry } from '../../providers/index.js'
import { describeAccountState, type AccountState } from '../../providers/lifecycle.js'
import { teraboxPassportLogin } from '../../providers/terabox/login.js'
import type { AuthMode, Capability } from '../../providers/types.js'
import { encryptText, hashToken, randomToken } from '../../utils/crypto.js'
import { assertFetchAllowed } from '../../utils/ssrf.js'
import { syncS3Quota, testS3Connection } from '../s3/s3.service.js'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Written over S3 keys on disconnect so no usable secret remains (the column is non-null). */
const DISCONNECTED_PLACEHOLDER = '__disconnected__'
const S3_TOKEN_TTL_MS = 100 * 365 * 24 * 60 * 60 * 1000

export const s3ConnectSchema = z.object({
  name: z.string().trim().min(1).max(191),
  bucket: z.string().trim().min(1).max(191),
  region: z.string().trim().min(1).max(191),
  endpoint: z.string().url().optional().or(z.literal('')),
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
  forcePathStyle: z.boolean().optional(),
  quotaBytes: z.string().regex(/^\d+$/).optional().nullable(),
})

export const apiKeyConnectSchema = z
  .object({
    apiKey: z.string().min(1).max(4096).optional(),
    name: z.string().trim().min(1).max(191).optional(),
    /** TeraBox passport login: stored (encrypted) for automatic session renewal. */
    email: z.string().trim().email().max(320).optional(),
    password: z.string().min(1).max(512).optional(),
  })
  .refine((value) => Boolean(value.apiKey) || Boolean(value.email && value.password), {
    message: 'provide a session cookie/api key, or both email and password',
  })

export type S3ConnectInput = z.infer<typeof s3ConnectSchema>
export type ApiKeyConnectInput = z.infer<typeof apiKeyConnectSchema>

export class S3ConnectionTestError extends Error {
  readonly status = 400
  readonly code = 'S3_CONNECTION_FAILED'

  constructor(cause?: unknown) {
    super('Could not connect to the S3 endpoint with these credentials.', cause !== undefined ? { cause } : undefined)
    this.name = 'S3ConnectionTestError'
  }
}

export function authModeFor(provider: string): AuthMode {
  return catalog.get(provider)?.authMode ?? registry.tryGet(provider)?.authMode ?? 'oauth2'
}

export function capabilitiesFor(provider: string): Capability[] {
  const registered = registry.tryGet(provider)
  if (registered) return [...registered.capabilities]
  return catalog.get(provider)?.capabilities ?? []
}

export interface ProviderAccountView {
  id: string
  provider: string
  displayName: string | null
  email: string
  status: string
  /** Explicit lifecycle state derived from `status` (legacy names mapped), or null if unrecognised. */
  lifecycle: AccountState | null
  needsReauthorization: boolean
  /** Connected, but the last provider call failed for a non-credential reason (outage, throttling). */
  hasTransientIssue: boolean
  routable: boolean
  lastError: string | null
  authMode: AuthMode
  capabilities: Capability[]
  quota: { totalBytes: bigint | null; usedBytes: bigint; availableBytes: bigint | null } | null
  health: { state: string; latencyMs: number | null; checkedAt: Date } | null
  lastSyncedAt: Date | null
  /** `null` = provider default (experimental providers default to off). */
  routingEnabled: boolean | null
  experimental: boolean
  quotaPolicy: 'required' | 'optional'
}

export function toProviderAccountView(
  account: { id: string; provider: string; displayName: string | null; email: string; status: string; lastError?: string | null; metadata?: unknown },
  storageAccount: StorageAccount | null | undefined,
  health: ProviderHealth | null | undefined,
): ProviderAccountView {
  const described = describeAccountState(account.status, account.lastError)
  return {
    id: account.id,
    provider: account.provider,
    displayName: account.displayName,
    email: account.email,
    status: account.status,
    lifecycle: described.state,
    needsReauthorization: described.needsReauthorization,
    hasTransientIssue: described.hasTransientIssue,
    routable: described.routable,
    lastError: account.lastError ?? null,
    authMode: authModeFor(account.provider),
    capabilities: capabilitiesFor(account.provider),
    quota: storageAccount
      ? {
        totalBytes: storageAccount.totalBytes,
        usedBytes: storageAccount.usedBytes,
        availableBytes: storageAccount.availableBytes,
      }
      : null,
    health: health
      ? { state: health.state, latencyMs: health.latencyMs, checkedAt: health.checkedAt }
      : null,
    lastSyncedAt: storageAccount?.lastSyncedAt ?? null,
    routingEnabled: routingFlagOf(account.metadata),
    experimental: catalog.get(account.provider)?.experimental === true,
    quotaPolicy: catalog.get(account.provider)?.quotaPolicy ?? 'optional',
  }
}

function routingFlagOf(metadata: unknown): boolean | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const value = (metadata as Record<string, unknown>).routingEnabled
  return typeof value === 'boolean' ? value : null
}

export const MAX_ACCOUNT_PAGE_SIZE = 500

export async function listProviderAccountViews(
  userId: string,
  page: { limit?: number; offset?: number } = {},
): Promise<ProviderAccountView[]> {
  const limit = Math.min(Math.max(Math.trunc(page.limit ?? MAX_ACCOUNT_PAGE_SIZE), 1), MAX_ACCOUNT_PAGE_SIZE)
  const offset = Math.max(Math.trunc(page.offset ?? 0), 0)
  const accounts = await prisma.connectedAccount.findMany({
    where: { userId, status: { notIn: ['disconnected', 'pending'] } },
    include: { storageAccount: true },
    // `id` as tiebreaker keeps pages stable when many accounts share a creation timestamp.
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    take: limit,
    skip: offset,
  })
  const ids = accounts.map((account) => account.id)
  const healthRows = ids.length > 0
    ? await prisma.providerHealth.findMany({ where: { connectedAccountId: { in: ids } } })
    : []
  const healthById = new Map(healthRows.map((row) => [row.connectedAccountId ?? '', row]))
  return accounts.map((account) => toProviderAccountView(account, account.storageAccount, healthById.get(account.id)))
}

export async function findOwnedAccount(userId: string, accountId: string): Promise<ConnectedAccount | null> {
  if (!UUID_PATTERN.test(accountId)) return null
  return prisma.connectedAccount.findFirst({ where: { id: accountId, userId } })
}

export async function disconnectOwnedAccount(userId: string, accountId: string): Promise<boolean> {
  if (!UUID_PATTERN.test(accountId)) return false
  // Already-disconnected accounts do not match: a second disconnect reports "not found" and does not re-run cleanup.
  const result = await prisma.connectedAccount.updateMany({
    where: { id: accountId, userId, status: { not: 'disconnected' } },
    data: { status: 'disconnected' },
  })
  if (result.count > 0) {
    // Stop holding credentials for any provider (OAuth tokens, API key/password, S3 keys). Reconnecting supplies
    // fresh credentials and revives the same row. Provider-side revocation is not performed (see audit doc, F10).
    await prisma.connectedAccount.updateMany({
      where: { id: accountId, userId },
      data: { accessTokenEncrypted: null, refreshTokenEncrypted: null, tokenExpiresAt: null },
    })
    await prisma.s3StorageConfig.updateMany({
      where: { connectedAccountId: accountId, userId },
      data: {
        accessKeyIdEncrypted: encryptText(DISCONNECTED_PLACEHOLDER),
        secretAccessKeyEncrypted: encryptText(DISCONNECTED_PLACEHOLDER),
        status: 'disabled',
      },
    })
  }
  return result.count > 0
}

export interface S3AccountDeps {
  testConnection: typeof testS3Connection
  syncQuota: typeof syncS3Quota
}

const defaultS3Deps: S3AccountDeps = { testConnection: testS3Connection, syncQuota: syncS3Quota }

export async function createS3Account(
  userId: string,
  body: S3ConnectInput,
  deps: S3AccountDeps = defaultS3Deps,
): Promise<{ account: ConnectedAccount; quota: StorageAccount }> {
  if (body.endpoint) {
    try {
      await assertFetchAllowed(body.endpoint)
    } catch (error) {
      throw new ProviderError('ERR_SSRF_BLOCKED', 'Blocked disallowed S3 endpoint.', { cause: error })
    }
  }
  const providerAccountId = `${body.bucket}:${body.endpoint || body.region}`
  const accessKeyIdEncrypted = encryptText(body.accessKeyId)
  const secretAccessKeyEncrypted = encryptText(body.secretAccessKey)
  const forcePathStyle = body.forcePathStyle ?? Boolean(body.endpoint)
  const quotaBytes = body.quotaBytes ? BigInt(body.quotaBytes) : null

  // Verify the credentials BEFORE anything is written: a failed attempt must never alter a working account.
  const candidate = {
    id: 'candidate',
    userId,
    connectedAccountId: 'candidate',
    name: body.name,
    bucket: body.bucket,
    region: body.region,
    endpoint: body.endpoint || null,
    accessKeyIdEncrypted,
    secretAccessKeyEncrypted,
    forcePathStyle,
    quotaBytes,
    status: 'active',
  } as unknown as Parameters<typeof testS3Connection>[0]
  try {
    await deps.testConnection(candidate)
  } catch (error) {
    throw new S3ConnectionTestError(error)
  }

  const existing = await prisma.connectedAccount.findUnique({
    where: { userId_provider_providerAccountId: { userId, provider: 's3', providerAccountId } },
    select: { id: true },
  })
  const data = {
    providerConfigId: null,
    email: `${body.bucket} (S3)`,
    displayName: body.name,
    accessTokenEncrypted: encryptText('s3'),
    refreshTokenEncrypted: encryptText(randomToken()),
    tokenExpiresAt: new Date(Date.now() + S3_TOKEN_TTL_MS),
    scopes: [],
    status: 'connected',
    lastError: null,
  }
  const configData = {
    name: body.name,
    bucket: body.bucket,
    region: body.region,
    endpoint: body.endpoint || null,
    accessKeyIdEncrypted,
    secretAccessKeyEncrypted,
    forcePathStyle,
    quotaBytes,
  }
  // Account and config are written together or not at all (no account row without its config).
  const account = await prisma.$transaction(async (tx) => {
    const row = await tx.connectedAccount.upsert({
      where: { userId_provider_providerAccountId: { userId, provider: 's3', providerAccountId } },
      create: { userId, provider: 's3', providerAccountId, ...data },
      update: data,
    })
    await tx.s3StorageConfig.upsert({
      where: { connectedAccountId: row.id },
      create: { userId, connectedAccountId: row.id, ...configData },
      update: { ...configData, status: 'active' },
    })
    return row
  })
  try {
    const quota = await deps.syncQuota(account.id)
    return { account, quota }
  } catch (error) {
    if (!existing) await prisma.connectedAccount.delete({ where: { id: account.id } }).catch(() => undefined)
    throw new S3ConnectionTestError(error)
  }
}

export async function createApiKeyAccount(
  userId: string,
  provider: string,
  body: ApiKeyConnectInput,
): Promise<ConnectedAccount> {
  let apiKey = body.apiKey?.trim() ?? ''
  let displayName = body.name
  let email = `${provider} (API key)`
  let apiSecret: string | null = null

  if (provider === 'terabox') {
    // Password mode: log in now to mint the cookie, and keep the credentials
    // so every -6 ("user not login") renews the session automatically.
    if (body.email && body.password) {
      apiSecret = JSON.stringify({ email: body.email, password: body.password })
      email = body.email
    }
    if (!apiKey) {
      if (!body.email || !body.password) {
        throw new ProviderError('ERR_INVALID_INPUT', 'TeraBox requires a session cookie or an email + password')
      }
      const login = await teraboxPassportLogin({ email: body.email, password: body.password })
      apiKey = login.cookie
      if (!displayName && login.displayName) displayName = login.displayName
    }
  } else if (!apiKey) {
    throw new ProviderError('ERR_INVALID_INPUT', `provider '${provider}' requires an API key`)
  }

  const providerAccountId = `apikey:${hashToken(apiKey).slice(0, 32)}`
  const data = {
    providerConfigId: null,
    email,
    accessTokenEncrypted: encryptText(apiKey),
    refreshTokenEncrypted: apiSecret ? encryptText(apiSecret) : null,
    tokenExpiresAt: null,
    scopes: [],
    status: 'connected',
    lastError: null,
    ...(displayName ? { displayName } : {}),
  }
  const existing = await prisma.connectedAccount.findUnique({
    where: { userId_provider_providerAccountId: { userId, provider, providerAccountId } },
  })
  if (existing) return prisma.connectedAccount.update({ where: { id: existing.id }, data })

  const reconnect = await findReconnectTarget(userId, provider, body.name, body.email)
  if (reconnect) {
    return prisma.connectedAccount.update({ where: { id: reconnect.id }, data: { ...data, providerAccountId } })
  }
  return prisma.connectedAccount.create({ data: { userId, provider, providerAccountId, ...data } })
}

/**
 * A fresh credential under the same label revives the existing account row
 * (files keep their connected_account_id link). Falls back to the caller's
 * create only when there is no label and more than one account exists.
 */
async function findReconnectTarget(
  userId: string,
  provider: string,
  name?: string,
  loginEmail?: string,
): Promise<{ id: string } | null> {
  const rows = await prisma.connectedAccount.findMany({
    where: { userId, provider },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: { id: true, displayName: true, email: true },
  })
  // A stable remote identity beats a label: the same login email is the same remote account.
  const wantedEmail = loginEmail?.trim().toLowerCase()
  if (wantedEmail) {
    const byEmail = rows.find((row) => row.email.trim().toLowerCase() === wantedEmail)
    if (byEmail) return byEmail
  }
  const label = name?.trim().toLowerCase()
  if (label) return rows.find((row) => (row.displayName ?? '').trim().toLowerCase() === label) ?? null
  return rows.length === 1 ? (rows[0] ?? null) : null
}
