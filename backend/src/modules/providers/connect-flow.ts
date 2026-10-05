/**
 * Two-phase OAuth connect flow shared by /providers/:provider and the legacy
 * /connected-accounts aliases — provider-contract §8, api-contract §4.1.
 */

import { z } from 'zod'
import { env } from '../../config/env.js'
import { prisma } from '../../config/prisma.js'
import {
  buildAuthorizationUrl,
  buildContext,
  catalog,
  exchangeCode,
  getOAuth2Client,
  hasOAuth2Client,
  refreshQuota,
  registry,
} from '../../providers/index.js'
import type { AccountInfo } from '../../providers/types.js'
import { decryptText, encryptText, hashToken, randomToken } from '../../utils/crypto.js'
import { applyConnectCallbackHooks } from './connect-hooks.js'
import { RequestError } from './http-error.js'

const CONNECT_STATE_TTL_MS = 10 * 60_000

export const connectUrlInputSchema = z.object({
  providerConfigId: z.string().min(1).optional(),
  clientId: z.string().min(1).max(512).optional(),
  clientSecret: z.string().min(1).max(1024).optional(),
  redirectUri: z.string().url().optional(),
  scopes: z.array(z.string().min(1)).min(1).optional(),
})

export type ConnectUrlInput = z.infer<typeof connectUrlInputSchema>

export interface ConnectUrlResult {
  url: string
  state: string
}

export interface ConnectCallbackOutcome {
  ok: boolean
  reason?: string
}

function readString(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
  return ''
}

function normalizeScopes(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string')
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      if (Array.isArray(parsed)) return parsed.filter((entry): entry is string => typeof entry === 'string')
    } catch {
      return []
    }
  }
  return []
}

function decryptStored(value: string): string {
  return decryptText(value.startsWith('v1:') ? value.slice(3) : value)
}

function defaultRedirectUri(provider: string): string {
  return `${env.PUBLIC_BASE_URL}/connected-accounts/${encodeURIComponent(provider)}/callback`
}

function requireOAuthProvider(provider: string) {
  const entry = catalog.get(provider)
  if (!entry) throw new RequestError(404, 'PROVIDER_NOT_FOUND', 'Unknown provider.')
  if (entry.authMode !== 'oauth2') {
    throw new RequestError(400, 'AUTH_MODE_UNSUPPORTED', 'This provider does not connect through OAuth2.')
  }
  if (entry.status !== 'SUPPORTED') {
    throw new RequestError(409, 'PROVIDER_NOT_AVAILABLE', 'This provider is not available yet.')
  }
  if (!registry.tryGet(provider)) {
    throw new RequestError(409, 'PROVIDER_NOT_AVAILABLE', 'No adapter is registered for this provider.')
  }
  if (!hasOAuth2Client(provider)) {
    throw new RequestError(409, 'PROVIDER_NOT_AVAILABLE', 'No OAuth2 client is registered for this provider.')
  }
  return entry
}

async function resolveProviderConfig(userId: string, provider: string, input: ConnectUrlInput) {
  const hasInlineSecrets = input.clientId !== undefined || input.clientSecret !== undefined
  if (hasInlineSecrets && (!input.clientId || !input.clientSecret)) {
    throw new RequestError(400, 'VALIDATION_FAILED', 'clientId and clientSecret must be provided together.')
  }
  if (input.providerConfigId && hasInlineSecrets) {
    throw new RequestError(400, 'VALIDATION_FAILED', 'Provide either providerConfigId or inline credentials, not both.')
  }
  if (!hasInlineSecrets && (input.redirectUri || input.scopes)) {
    throw new RequestError(400, 'VALIDATION_FAILED', 'redirectUri and scopes require clientId and clientSecret.')
  }

  if (input.providerConfigId) {
    const scoped = await prisma.providerConfig.findFirst({
      where: { id: input.providerConfigId, provider, status: 'active', OR: [{ userId }, { userId: null }] },
    })
    if (!scoped) throw new RequestError(404, 'PROVIDER_NOT_FOUND', 'Provider configuration not found.')
    return scoped
  }

  if (input.clientId && input.clientSecret) {
    const data = {
      clientIdEncrypted: encryptText(input.clientId),
      clientSecretEncrypted: encryptText(input.clientSecret),
      redirectUri: input.redirectUri ?? defaultRedirectUri(provider),
      scopes: input.scopes ?? getOAuth2Client(provider).scopes,
    }
    const owned = await prisma.providerConfig.findFirst({
      where: { userId, provider, status: 'active' },
      orderBy: { createdAt: 'desc' },
    })
    if (owned) return prisma.providerConfig.update({ where: { id: owned.id }, data })
    return prisma.providerConfig.create({ data: { userId, provider, ...data } })
  }

  const owned = await prisma.providerConfig.findFirst({
    where: { userId, provider, status: 'active' },
    orderBy: { createdAt: 'desc' },
  })
  if (owned) return owned
  const global = await prisma.providerConfig.findFirst({
    where: { userId: null, provider, status: 'active' },
    orderBy: { createdAt: 'desc' },
  })
  if (global) return global
  throw new RequestError(
    409,
    'PROVIDER_NOT_AVAILABLE',
    'No OAuth client is configured for this provider yet. Supply clientId and clientSecret.',
  )
}

export async function createConnectUrl(
  userId: string,
  provider: string,
  input: ConnectUrlInput = {},
): Promise<ConnectUrlResult> {
  requireOAuthProvider(provider)
  const config = await resolveProviderConfig(userId, provider, input)
  const state = randomToken()
  await prisma.oauthState.create({
    data: {
      userId,
      providerConfigId: config.id,
      flow: 'connect',
      stateHash: hashToken(state),
      expiresAt: new Date(Date.now() + CONNECT_STATE_TTL_MS),
    },
  })
  const scopes = normalizeScopes(config.scopes)
  const url = buildAuthorizationUrl({
    provider,
    clientId: decryptStored(config.clientIdEncrypted),
    redirectUri: config.redirectUri,
    state,
    ...(scopes.length > 0 ? { scope: scopes } : {}),
  })
  return { url, state }
}

async function loadAccountInfo(provider: string, accountId: string): Promise<AccountInfo | null> {
  try {
    const context = await buildContext(accountId)
    return await registry.get(provider).getAccountInfo(context)
  } catch (error) {
    console.error(`[${provider}] connect account profile failed`, error instanceof Error ? error.message : 'unknown error')
    return null
  }
}

async function discardPending(pendingId: string): Promise<void> {
  await prisma.connectedAccount.delete({ where: { id: pendingId } }).catch(() => undefined)
}

export async function handleConnectCallback(
  provider: string,
  query: Record<string, unknown>,
): Promise<ConnectCallbackOutcome> {
  requireOAuthProvider(provider)

  const state = readString(query.state)
  if (!state) throw new RequestError(400, 'OAUTH_STATE_INVALID', 'OAuth state is missing.')

  const oauthState = await prisma.oauthState.findUnique({
    where: { stateHash: hashToken(state) },
    include: { providerConfig: true },
  })
  if (!oauthState || oauthState.usedAt || oauthState.expiresAt.getTime() < Date.now()) {
    throw new RequestError(400, 'OAUTH_STATE_INVALID', 'OAuth state is invalid or expired.')
  }
  if (oauthState.flow !== 'connect' || !oauthState.userId) {
    throw new RequestError(400, 'OAUTH_STATE_INVALID', 'OAuth state is not a connect state.')
  }
  if (oauthState.providerConfig.provider !== provider || oauthState.providerConfig.status !== 'active') {
    throw new RequestError(400, 'OAUTH_STATE_INVALID', 'OAuth state does not match this provider.')
  }

  const userId = oauthState.userId
  await prisma.oauthState.update({ where: { id: oauthState.id }, data: { usedAt: new Date() } })

  const denied = readString(query.error)
  if (denied) return { ok: false, reason: denied }

  const code = readString(query.code)
  if (!code) throw new RequestError(400, 'VALIDATION_FAILED', 'code: authorization code is required')

  const config = oauthState.providerConfig
  let tokens
  try {
    tokens = await exchangeCode({
      provider,
      clientId: decryptStored(config.clientIdEncrypted),
      clientSecret: decryptStored(config.clientSecretEncrypted),
      redirectUri: config.redirectUri,
      code,
    })
  } catch (error) {
    console.error(`[${provider}] connect token exchange failed`, error instanceof Error ? error.message : 'unknown error')
    return { ok: false, reason: 'token_exchange_failed' }
  }

  const metadata = applyConnectCallbackHooks(provider, query)
  const scopes = normalizeScopes(config.scopes)
  const pending = await prisma.connectedAccount.create({
    data: {
      userId,
      providerConfigId: config.id,
      provider,
      providerAccountId: `pending:${oauthState.id}`,
      email: '',
      accessTokenEncrypted: encryptText(tokens.accessToken),
      refreshTokenEncrypted: tokens.refreshToken ? encryptText(tokens.refreshToken) : null,
      tokenExpiresAt: tokens.expiresAt === null ? null : new Date(tokens.expiresAt),
      scopes,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      status: 'pending',
    },
  })

  const info = await loadAccountInfo(provider, pending.id)
  const remoteId = info ? String(info.providerAccountId ?? '').trim() : ''
  if (!info || !remoteId) {
    await discardPending(pending.id)
    return { ok: false, reason: 'account_profile_failed' }
  }

  const duplicate = await prisma.connectedAccount.findFirst({
    where: { userId, provider, providerAccountId: remoteId, NOT: { id: pending.id } },
  })
  if (duplicate) {
    await prisma.connectedAccount.update({
      where: { id: duplicate.id },
      data: {
        providerConfigId: config.id,
        email: info.email?.trim() || duplicate.email,
        displayName: info.displayName ?? duplicate.displayName,
        avatarUrl: info.avatarUrl ?? duplicate.avatarUrl,
        accessTokenEncrypted: encryptText(tokens.accessToken),
        ...(tokens.refreshToken ? { refreshTokenEncrypted: encryptText(tokens.refreshToken) } : {}),
        tokenExpiresAt: tokens.expiresAt === null ? null : new Date(tokens.expiresAt),
        scopes,
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
        status: 'connected',
        lastError: null,
      },
    })
    await discardPending(pending.id)
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

  await refreshQuota(duplicate ? duplicate.id : pending.id).catch(() => undefined)
  return { ok: true }
}

export function connectRedirectUrl(provider: string, outcome: ConnectCallbackOutcome): string {
  const url = new URL('/providers', env.FRONTEND_URL)
  url.searchParams.set('provider', provider)
  url.searchParams.set('status', outcome.ok ? 'success' : 'error')
  if (outcome.reason) url.searchParams.set('reason', outcome.reason)
  return url.toString()
}
