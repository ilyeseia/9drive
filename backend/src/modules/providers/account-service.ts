/**
 * Connected-account views and credential flows shared by the providers module
 * and the legacy connected-accounts routes (api-contract §4.1, security §3.4).
 */

import type { ConnectedAccount, ProviderHealth, StorageAccount } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../../config/prisma.js'
import { catalog, ProviderError, registry } from '../../providers/index.js'
import type { AuthMode, Capability } from '../../providers/types.js'
import { encryptText, hashToken, randomToken } from '../../utils/crypto.js'
import { assertFetchAllowed } from '../../utils/ssrf.js'
import { syncS3Quota, testS3Connection } from '../s3/s3.service.js'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
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

export const apiKeyConnectSchema = z.object({
  apiKey: z.string().min(1).max(4096),
  name: z.string().trim().min(1).max(191).optional(),
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
  lastError: string | null
  authMode: AuthMode
  capabilities: Capability[]
  quota: { totalBytes: bigint | null; usedBytes: bigint; availableBytes: bigint | null } | null
  health: { state: string; latencyMs: number | null; checkedAt: Date } | null
  lastSyncedAt: Date | null
}

export function toProviderAccountView(
  account: { id: string; provider: string; displayName: string | null; email: string; status: string; lastError?: string | null },
  storageAccount: StorageAccount | null | undefined,
  health: ProviderHealth | null | undefined,
): ProviderAccountView {
  return {
    id: account.id,
    provider: account.provider,
    displayName: account.displayName,
    email: account.email,
    status: account.status,
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
  }
}

export async function listProviderAccountViews(userId: string): Promise<ProviderAccountView[]> {
  const accounts = await prisma.connectedAccount.findMany({
    where: { userId, status: { notIn: ['disconnected', 'pending'] } },
    include: { storageAccount: true },
    orderBy: { createdAt: 'desc' },
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
  const result = await prisma.connectedAccount.updateMany({
    where: { id: accountId, userId },
    data: { status: 'disconnected' },
  })
  return result.count > 0
}

export async function createS3Account(
  userId: string,
  body: S3ConnectInput,
): Promise<{ account: ConnectedAccount; quota: StorageAccount }> {
  if (body.endpoint) {
    try {
      await assertFetchAllowed(body.endpoint)
    } catch (error) {
      throw new ProviderError('ERR_SSRF_BLOCKED', 'Blocked disallowed S3 endpoint.', { cause: error })
    }
  }
  const providerAccountId = `${body.bucket}:${body.endpoint || body.region}`
  const existing = await prisma.connectedAccount.findUnique({
    where: { userId_provider_providerAccountId: { userId, provider: 's3', providerAccountId } },
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
  }
  const account = existing
    ? await prisma.connectedAccount.update({ where: { id: existing.id }, data })
    : await prisma.connectedAccount.create({ data: { userId, provider: 's3', providerAccountId, ...data } })
  const config = await prisma.s3StorageConfig.upsert({
    where: { connectedAccountId: account.id },
    create: {
      userId,
      connectedAccountId: account.id,
      name: body.name,
      bucket: body.bucket,
      region: body.region,
      endpoint: body.endpoint || null,
      accessKeyIdEncrypted: encryptText(body.accessKeyId),
      secretAccessKeyEncrypted: encryptText(body.secretAccessKey),
      forcePathStyle: body.forcePathStyle ?? Boolean(body.endpoint),
      quotaBytes: body.quotaBytes ? BigInt(body.quotaBytes) : null,
    },
    update: {
      name: body.name,
      bucket: body.bucket,
      region: body.region,
      endpoint: body.endpoint || null,
      accessKeyIdEncrypted: encryptText(body.accessKeyId),
      secretAccessKeyEncrypted: encryptText(body.secretAccessKey),
      forcePathStyle: body.forcePathStyle ?? Boolean(body.endpoint),
      quotaBytes: body.quotaBytes ? BigInt(body.quotaBytes) : null,
      status: 'active',
    },
  })
  try {
    await testS3Connection(config)
    const quota = await syncS3Quota(account.id)
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
  const providerAccountId = `apikey:${hashToken(body.apiKey).slice(0, 32)}`
  const data = {
    providerConfigId: null,
    email: `${provider} (API key)`,
    accessTokenEncrypted: encryptText(body.apiKey),
    refreshTokenEncrypted: null,
    tokenExpiresAt: null,
    scopes: [],
    status: 'connected',
    lastError: null,
    ...(body.name ? { displayName: body.name } : {}),
  }
  const existing = await prisma.connectedAccount.findUnique({
    where: { userId_provider_providerAccountId: { userId, provider, providerAccountId } },
  })
  if (existing) return prisma.connectedAccount.update({ where: { id: existing.id }, data })

  const reconnect = await findReconnectTarget(userId, provider, body.name)
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
): Promise<{ id: string } | null> {
  const rows = await prisma.connectedAccount.findMany({
    where: { userId, provider },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: { id: true, displayName: true },
  })
  const label = name?.trim().toLowerCase()
  if (label) return rows.find((row) => (row.displayName ?? '').trim().toLowerCase() === label) ?? null
  return rows.length === 1 ? (rows[0] ?? null) : null
}
