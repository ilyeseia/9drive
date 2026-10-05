/**
 * Route-local error mapping for the providers module — api-contract §2.2 / §2.1.
 * errorMiddleware only understands ZodError and Prisma P2025, so provider-facing
 * routes translate ProviderError and tagged request errors here before replying.
 */

import { ProviderError } from '../../providers/index.js'

export class RequestError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'RequestError'
    this.status = status
    this.code = code
  }
}

export interface RouteErrorPayload {
  status: number
  code: string
  message: string
}

function providerErrorPayload(error: ProviderError): RouteErrorPayload {
  switch (error.code) {
    case 'ERR_AUTH_EXPIRED':
    case 'ERR_AUTH_REVOKED':
      return { status: 401, code: 'UNAUTHENTICATED', message: 'Provider credentials expired. Reconnect the account.' }
    case 'ERR_CAPABILITY_UNSUPPORTED':
      return { status: 400, code: 'CAPABILITY_UNSUPPORTED', message: 'The provider does not support this operation.' }
    case 'ERR_NOT_FOUND':
      return { status: 404, code: 'NOT_FOUND', message: 'Resource not found.' }
    case 'ERR_QUOTA_EXCEEDED':
      return { status: 507, code: 'QUOTA_EXCEEDED', message: 'Provider quota exceeded.' }
    case 'ERR_RATE_LIMITED':
      return { status: 429, code: 'RATE_LIMITED', message: 'The provider rate-limited this request.' }
    case 'ERR_TIMEOUT':
    case 'ERR_UPSTREAM_UNAVAILABLE':
      return { status: 503, code: 'PROVIDER_UNAVAILABLE', message: 'The provider is unavailable.' }
    case 'ERR_SSRF_BLOCKED':
      return { status: 400, code: 'SSRF_BLOCKED', message: 'Blocked disallowed endpoint.' }
    case 'ERR_INVALID_INPUT':
      return { status: 400, code: 'VALIDATION_FAILED', message: 'Invalid request payload.' }
    default:
      return { status: 500, code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' }
  }
}

export function resolveRouteError(error: unknown): RouteErrorPayload | null {
  if (ProviderError.is(error)) return providerErrorPayload(error)
  if (error instanceof Error) {
    const status = (error as Error & { status?: unknown }).status
    const code = (error as Error & { code?: unknown }).code
    if (typeof status === 'number' && typeof code === 'string') {
      return { status, code, message: error.message }
    }
  }
  return null
}
