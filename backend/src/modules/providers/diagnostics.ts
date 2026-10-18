/**
 * Privacy-safe provider diagnostic report for one user (docs/provider-audit, step 6).
 *
 * Contains identifiers, states, timestamps and booleans only: never tokens, keys, cookies, passwords, emails or
 * display names. `lastError` is the already-truncated message stored by the platform.
 */

import { prisma } from '../../config/prisma.js'
import { describeAccountState, type AccountState } from '../../providers/lifecycle.js'

const MAX_DIAGNOSTIC_ACCOUNTS = 1000
const QUOTA_MAX_AGE_MS = 30 * 60_000

export interface AccountDiagnostic {
  id: string
  provider: string
  status: string
  lifecycle: AccountState | null
  routable: boolean
  /** Why routing will not use this account, when it will not. */
  routingBlockedReason: string | null
  healthState: string | null
  healthCheckedAt: string | null
  quotaKnown: boolean
  quotaStale: boolean
  hasCredentials: boolean
  hasRefreshToken: boolean
  tokenExpiresAt: string | null
  lastError: string | null
  routingEnabled: boolean | null
}

export interface ProviderDiagnostics {
  generatedAt: string
  totalAccounts: number
  truncated: boolean
  byProvider: Record<string, Record<string, number>>
  accounts: AccountDiagnostic[]
}

function routingFlag(metadata: unknown): boolean | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const value = (metadata as Record<string, unknown>).routingEnabled
  return typeof value === 'boolean' ? value : null
}

function blockedReason(
  described: ReturnType<typeof describeAccountState>,
  status: string,
  routingEnabled: boolean | null,
  healthState: string | null,
): string | null {
  if (!described.routable) {
    if (described.needsReauthorization) return 'reauthorization required'
    return `status is ${described.state ?? status}`
  }
  if (routingEnabled === false) return 'routing disabled for this account'
  if (healthState === 'unauthorized' || healthState === 'unreachable') return `last health check: ${healthState}`
  return null
}

export async function buildProviderDiagnostics(userId: string, now: Date = new Date()): Promise<ProviderDiagnostics> {
  const total = await prisma.connectedAccount.count({ where: { userId, status: { notIn: ['pending'] } } })
  const rows = await prisma.connectedAccount.findMany({
    where: { userId, status: { notIn: ['pending'] } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: MAX_DIAGNOSTIC_ACCOUNTS,
    select: {
      id: true,
      provider: true,
      status: true,
      lastError: true,
      metadata: true,
      tokenExpiresAt: true,
      accessTokenEncrypted: true,
      refreshTokenEncrypted: true,
      storageAccount: { select: { availableBytes: true, totalBytes: true, lastSyncedAt: true } },
    },
  })
  const health = rows.length
    ? await prisma.providerHealth.findMany({
      where: { connectedAccountId: { in: rows.map((row) => row.id) } },
      select: { connectedAccountId: true, state: true, checkedAt: true },
    })
    : []
  const healthById = new Map(health.map((row) => [row.connectedAccountId ?? '', row]))

  const byProvider: Record<string, Record<string, number>> = {}
  const accounts = rows.map((row): AccountDiagnostic => {
    const described = describeAccountState(row.status, row.lastError)
    const routingEnabled = routingFlag(row.metadata)
    const h = healthById.get(row.id)
    const synced = row.storageAccount?.lastSyncedAt ?? null
    const bucket = (byProvider[row.provider] ??= {})
    const key = described.state ?? 'unknown'
    bucket[key] = (bucket[key] ?? 0) + 1
    return {
      id: row.id,
      provider: row.provider,
      status: row.status,
      lifecycle: described.state,
      routable: described.routable && routingEnabled !== false,
      routingBlockedReason: blockedReason(described, row.status, routingEnabled, h?.state ?? null),
      healthState: h?.state ?? null,
      healthCheckedAt: h?.checkedAt.toISOString() ?? null,
      quotaKnown: row.storageAccount?.availableBytes !== null && row.storageAccount?.availableBytes !== undefined,
      quotaStale: synced === null || now.getTime() - synced.getTime() > QUOTA_MAX_AGE_MS,
      hasCredentials: Boolean(row.accessTokenEncrypted),
      hasRefreshToken: Boolean(row.refreshTokenEncrypted),
      tokenExpiresAt: row.tokenExpiresAt?.toISOString() ?? null,
      lastError: row.lastError ?? null,
      routingEnabled,
    }
  })

  return {
    generatedAt: now.toISOString(),
    totalAccounts: total,
    truncated: total > rows.length,
    byProvider,
    accounts,
  }
}
