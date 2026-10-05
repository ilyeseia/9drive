/**
 * Shared OAuth2 helpers — see docs/architecture/contracts/provider-contract.md §8.
 * This module is Coordinator-owned infrastructure: adapters register their token
 * endpoints here, they do not change it without a contract proposal.
 */

import { ProviderError } from './errors.js'
import type { ProviderId } from './types.js'

export interface OAuth2ClientConfig {
  id: ProviderId
  authorizationUrl: string
  tokenUrl: string
  scopes: string[]
  /** Extra query parameters appended to the authorization URL. */
  authorizationParams?: Record<string, string>
  /** Extra form fields posted to the token endpoint. */
  tokenParams?: Record<string, string>
}

export interface OAuth2TokenResult {
  accessToken: string
  refreshToken?: string
  /** Epoch milliseconds, or null when the upstream does not report an expiry. */
  expiresAt: number | null
  scope?: string
}

export interface AuthorizationUrlOptions {
  provider: ProviderId
  clientId: string
  redirectUri: string
  state: string
  scope?: string[]
  /** Overrides the registered config's authorization URL (used by tests). */
  authorizationUrl?: string
  extraParams?: Record<string, string>
}

export interface TokenExchangeOptions {
  provider: ProviderId
  clientId: string
  clientSecret: string
  redirectUri?: string
  code?: string
  refreshToken?: string
  /** Overrides the registered config's token URL (used by tests). */
  tokenUrl?: string
  extraBody?: Record<string, string>
  signal?: AbortSignal
}

const clients = new Map<ProviderId, OAuth2ClientConfig>()

export function registerOAuth2Client(config: OAuth2ClientConfig): void {
  clients.set(config.id, config)
}

export function getOAuth2Client(provider: ProviderId): OAuth2ClientConfig {
  const config = clients.get(provider)
  if (!config) {
    throw new ProviderError('ERR_INTERNAL', `No OAuth2 client registered for provider "${provider}"`)
  }
  return config
}

export function hasOAuth2Client(provider: ProviderId): boolean {
  return clients.has(provider)
}

export function buildAuthorizationUrl(options: AuthorizationUrlOptions): string {
  const config = options.authorizationUrl ? null : getOAuth2Client(options.provider)
  const base = options.authorizationUrl ?? config!.authorizationUrl
  const url = new URL(base)
  const scopes = options.scope ?? config?.scopes ?? []

  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', options.clientId)
  url.searchParams.set('redirect_uri', options.redirectUri)
  url.searchParams.set('state', options.state)
  if (scopes.length > 0) url.searchParams.set('scope', scopes.join(' '))

  const extra = { ...config?.authorizationParams, ...options.extraParams }
  for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value)

  return url.toString()
}

export function exchangeCode(options: TokenExchangeOptions): Promise<OAuth2TokenResult> {
  if (!options.code) {
    throw new ProviderError('ERR_INVALID_INPUT', 'An authorization code is required')
  }
  return requestToken(options, {
    grant_type: 'authorization_code',
    code: options.code,
    redirect_uri: options.redirectUri ?? '',
  })
}

export function refreshAccessToken(options: TokenExchangeOptions): Promise<OAuth2TokenResult> {
  if (!options.refreshToken) {
    throw new ProviderError('ERR_AUTH_EXPIRED', 'A refresh token is required')
  }
  return requestToken(options, {
    grant_type: 'refresh_token',
    refresh_token: options.refreshToken,
  })
}

async function requestToken(
  options: TokenExchangeOptions,
  grant: Record<string, string>,
): Promise<OAuth2TokenResult> {
  const config = options.tokenUrl ? null : getOAuth2Client(options.provider)
  const tokenUrl = options.tokenUrl ?? config!.tokenUrl
  const body = new URLSearchParams({
    client_id: options.clientId,
    client_secret: options.clientSecret,
    ...config?.tokenParams,
    ...options.extraBody,
    ...grant,
  })

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: options.signal,
  }).catch((error: unknown) => {
    throw new ProviderError('ERR_TIMEOUT', 'Token endpoint unreachable', { cause: error })
  })

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>

  if (!response.ok) {
    const description = String(payload.error_description ?? payload.error ?? '').toLowerCase()
    if (description.includes('invalid_grant') || description.includes('revoked')) {
      throw new ProviderError('ERR_AUTH_REVOKED', 'The upstream rejected the refresh token', {
        upstreamStatus: response.status,
        detail: payload,
      })
    }
    throw new ProviderError('ERR_AUTH_EXPIRED', 'Token exchange failed', {
      upstreamStatus: response.status,
      detail: payload,
    })
  }

  const accessToken = typeof payload.access_token === 'string' ? payload.access_token : ''
  if (!accessToken) {
    throw new ProviderError('ERR_AUTH_EXPIRED', 'Token endpoint returned no access token', {
      detail: payload,
    })
  }

  const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : Number(payload.expires_in)
  const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : null

  const result: OAuth2TokenResult = {
    accessToken,
    expiresAt,
  }
  if (typeof payload.refresh_token === 'string') result.refreshToken = payload.refresh_token
  if (typeof payload.scope === 'string') result.scope = payload.scope
  return result
}
