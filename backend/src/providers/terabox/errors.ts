/**
 * TeraBox upstream failures → provider-contract §5 taxonomy.
 *
 * TeraBox answers every endpoint with `{ errno, … }` instead of HTTP statuses;
 * the numeric table below comes from the reverse-engineered web API
 * (docs/architecture/providers/terabox.md §3). Raw payloads stay on
 * ProviderError.detail and are never returned verbatim.
 */

import { ProviderError, isTimeoutError } from '../errors.js';

/** errno values that mean "refresh jsToken and retry once". */
export const TOKEN_REFRESH_ERRNOS: ReadonlySet<number> = new Set([4000023, 450016, 400810, 4000020]);

/** errno values that mean the cookie/session is gone. */
export const AUTH_ERRNOS: ReadonlySet<number> = new Set([-1, -6, 104, 132]);

/** errno values that mean the path/name is unusable (create, filemanager). */
export const INVALID_PATH_ERRNOS: ReadonlySet<number> = new Set([-7, -11, 4, 5]);

/** errno values that mean "already exists" (mkdir, upload, copy). */
export const CONFLICT_ERRNOS: ReadonlySet<number> = new Set([-8, 12, 36014]);

/** errno values that mean the object is gone. */
export const NOT_FOUND_ERRNOS: ReadonlySet<number> = new Set([-9, 102, 36010]);

/** errno values that mean the account is out of space (or over a plan limit). */
export const QUOTA_ERRNOS: ReadonlySet<number> = new Set([-10, -32, 58, 31116, 36009, 36011]);

/** errno values that mean "slow down". */
export const RATE_LIMIT_ERRNOS: ReadonlySet<number> = new Set([111, 31034, 36013, 36022, 36024]);

const TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_ABORTED',
]);

const NETWORK_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'UND_ERR_DESTROYED',
]);

function truncate(text: string, limit = 300): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** Failure code carried by a TeraBox payload (chunk uploads use `error_code`). */
export function teraboxErrno(payload: unknown, field: 'errno' | 'error_code' = 'errno'): number | null {
  if (!payload || typeof payload !== 'object') return null;
  const code = (payload as Record<string, unknown>)[field];
  return typeof code === 'number' && Number.isFinite(code) ? code : null;
}

/** Map a non-zero TeraBox `errno` onto the provider taxonomy. */
export function mapTeraBoxErrno(
  errno: number,
  fallbackMessage = 'TeraBox request failed',
  detail?: unknown,
): ProviderError {
  if (errno === 0) {
    throw new ProviderError('ERR_INTERNAL', 'mapTeraBoxErrno called with errno 0');
  }
  const message = truncate(`TeraBox error ${errno}: ${fallbackMessage}`);
  const opts = { detail: detail ?? { errno } };

  if (AUTH_ERRNOS.has(errno)) return new ProviderError('ERR_AUTH_EXPIRED', message, opts);
  if (NOT_FOUND_ERRNOS.has(errno)) return new ProviderError('ERR_NOT_FOUND', message, opts);
  if (INVALID_PATH_ERRNOS.has(errno) || CONFLICT_ERRNOS.has(errno)) {
    return new ProviderError('ERR_INVALID_INPUT', message, opts);
  }
  if (QUOTA_ERRNOS.has(errno)) return new ProviderError('ERR_QUOTA_EXCEEDED', message, opts);
  if (RATE_LIMIT_ERRNOS.has(errno)) return new ProviderError('ERR_RATE_LIMITED', message, opts);
  if (errno === 2) return new ProviderError('ERR_INTERNAL', message, opts);
  // Unknown upstream codes are transient: the job retry cap bounds the damage.
  return new ProviderError('ERR_UPSTREAM_UNAVAILABLE', message, opts);
}

/** True when the failure reports a name/path conflict (mkdir, upload, copy). */
export function isTeraBoxConflict(error: unknown): boolean {
  if (!ProviderError.is(error)) return false;
  const detail = error.detail;
  const errno = detail && typeof detail === 'object' ? (detail as { errno?: unknown }).errno : undefined;
  return typeof errno === 'number' && CONFLICT_ERRNOS.has(errno);
}

/** True when the failure means the session/cookie is no longer accepted. */
export function isTeraBoxAuthError(error: unknown): boolean {
  if (!ProviderError.is(error)) return false;
  if (error.code === 'ERR_AUTH_EXPIRED' || error.code === 'ERR_AUTH_REVOKED') return true;
  const detail = error.detail;
  const errno = detail && typeof detail === 'object' ? (detail as { errno?: unknown }).errno : undefined;
  return typeof errno === 'number' && AUTH_ERRNOS.has(errno);
}

/**
 * Non-2xx HTTP answer. TeraBox normally answers 200 with a non-zero errno, so
 * this is the fallback for gateways, redirects and WAF challenges.
 */
export function mapTeraBoxHttpStatus(status: number, payload: unknown, text = ''): ProviderError {
  const errno = teraboxErrno(payload);
  if (errno !== null && errno !== 0) return mapTeraBoxErrno(errno, text || 'request failed', payload);

  const message = truncate(`TeraBox HTTP ${status}: ${text || 'request failed'}`);
  const opts = { upstreamStatus: status, detail: payload ?? text };
  if (status === 401 || status === 403) return new ProviderError('ERR_AUTH_EXPIRED', message, opts);
  if (status === 404) return new ProviderError('ERR_NOT_FOUND', message, opts);
  if (status === 429) return new ProviderError('ERR_RATE_LIMITED', message, opts);
  if (status === 413) return new ProviderError('ERR_QUOTA_EXCEEDED', message, opts);
  if (status >= 500) return new ProviderError('ERR_UPSTREAM_UNAVAILABLE', message, opts);
  if (status >= 400) return new ProviderError('ERR_INVALID_INPUT', message, opts);
  return new ProviderError('ERR_INTERNAL', message, opts);
}

export function mapTeraBoxTransportError(error: unknown): ProviderError {
  if (ProviderError.is(error)) return error;
  const source = error as { name?: string; code?: string; cause?: unknown } | undefined;
  const cause = source?.cause;
  if (ProviderError.is(cause)) return cause;
  const code = String(source?.code ?? (cause as { code?: string } | undefined)?.code ?? '');
  const name = String(source?.name ?? '');
  if (name === 'TimeoutError' || name === 'AbortError' || TIMEOUT_CODES.has(code) || isTimeoutError(error)) {
    return new ProviderError('ERR_TIMEOUT', 'TeraBox request timed out', { cause: error });
  }
  if (name === 'SyntaxError') {
    return new ProviderError('ERR_INTERNAL', 'TeraBox returned a malformed response', { cause: error });
  }
  if (NETWORK_CODES.has(code)) {
    return new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'TeraBox request failed', { cause: error });
  }
  return new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'TeraBox request failed', { cause: error });
}
