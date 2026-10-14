/**
 * TeraBox Open Platform error normalisation.
 *
 * Only error codes printed in the official document are mapped explicitly
 * (OAuth: 2, 100001, 100002, 200001-200005, 300001, 400001, 500001;
 * filemanager: -7, -8, -9). Every other non-zero `errno` becomes
 * `ERR_UPSTREAM_UNAVAILABLE`; the raw code is kept on `ProviderError.detail`
 * (never returned to clients) so unknown behaviour is visible, not guessed.
 */

import { fromHttpStatus, isTimeoutError, ProviderError } from '../errors.js';

export const TERABOX_ERRNO = {
  MISSING_PARAMS: 2,
  INVALID_CLIENT: 100001,
  INVALID_CODE: 100002,
  UNSUPPORTED_GRANT: 200001,
  INVALID_ACCESS_TOKEN: 200002,
  ACCESS_TOKEN_EXPIRED: 200003,
  INVALID_REFRESH_TOKEN: 200004,
  REFRESH_TOKEN_EXPIRED: 200005,
  EXCHANGE_TOO_FREQUENT: 300001,
  DEVICE_AUTH_PENDING: 400001,
  INTERNAL: 500001,
  INVALID_FILE_NAME: -7,
  FILE_EXISTS: -8,
  FILE_NOT_FOUND: -9,
} as const;

export function mapTeraBoxErrno(errno: number, detail?: unknown): ProviderError {
  const opts = { detail: sanitizeDetail(detail) };
  switch (errno) {
    case TERABOX_ERRNO.MISSING_PARAMS:
      return new ProviderError('ERR_INVALID_INPUT', 'TeraBox rejected the request: required parameters missing', opts);
    case TERABOX_ERRNO.INVALID_CLIENT:
      return new ProviderError('ERR_INTERNAL', 'TeraBox rejected the application credentials (client_id/client_secret)', {
        ...opts,
        retryable: false,
      });
    case TERABOX_ERRNO.INVALID_CODE:
      return new ProviderError('ERR_AUTH_EXPIRED', 'TeraBox authorization code or device code is invalid or expired', opts);
    case TERABOX_ERRNO.UNSUPPORTED_GRANT:
      return new ProviderError('ERR_INTERNAL', 'TeraBox does not support this grant type', { ...opts, retryable: false });
    case TERABOX_ERRNO.INVALID_ACCESS_TOKEN:
    case TERABOX_ERRNO.ACCESS_TOKEN_EXPIRED:
      return new ProviderError('ERR_AUTH_EXPIRED', 'TeraBox access token is invalid or expired', opts);
    case TERABOX_ERRNO.INVALID_REFRESH_TOKEN:
    case TERABOX_ERRNO.REFRESH_TOKEN_EXPIRED:
      return new ProviderError('ERR_AUTH_REVOKED', 'TeraBox refresh token is invalid or expired; reauthorize the account', opts);
    case TERABOX_ERRNO.EXCHANGE_TOO_FREQUENT:
      return new ProviderError('ERR_RATE_LIMITED', 'TeraBox token endpoint rate limit reached', opts);
    case TERABOX_ERRNO.INTERNAL:
      return new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'TeraBox internal service error', opts);
    case TERABOX_ERRNO.INVALID_FILE_NAME:
      return new ProviderError('ERR_INVALID_INPUT', 'TeraBox rejected the file name or path', opts);
    case TERABOX_ERRNO.FILE_EXISTS:
      return new ProviderError('ERR_INVALID_INPUT', 'A file already exists at the destination', opts);
    case TERABOX_ERRNO.FILE_NOT_FOUND:
      return new ProviderError('ERR_NOT_FOUND', 'File or folder not found in the TeraBox application folder', opts);
    default:
      return new ProviderError('ERR_UPSTREAM_UNAVAILABLE', `TeraBox request failed (errno ${errno})`, opts);
  }
}

export function mapTeraBoxHttpStatus(status: number): ProviderError {
  // Documented API answers errors with errno bodies; HTTP codes only come from gateways.
  if (status === 401 || status === 403) {
    return new ProviderError('ERR_AUTH_EXPIRED', 'TeraBox rejected the credentials', { upstreamStatus: status });
  }
  return fromHttpStatus(status, 'TeraBox request failed');
}

export function mapTeraBoxTransportError(error: unknown): ProviderError {
  if (ProviderError.is(error)) return error;
  if (isTimeoutError(error)) return new ProviderError('ERR_TIMEOUT', 'TeraBox request timed out', { cause: error });
  return new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'TeraBox is unreachable', { cause: error });
}

const SECRET_KEYS = /(token|secret|sign|code|authorization|dlink)/i;

/** Keep upstream payloads for diagnostics but never retain credential-bearing fields. */
export function sanitizeDetail(detail: unknown, depth = 0): unknown {
  if (detail === null || typeof detail !== 'object') {
    return typeof detail === 'string' ? detail.slice(0, 300) : detail;
  }
  if (depth > 3) return '[truncated]';
  if (Array.isArray(detail)) return detail.slice(0, 10).map((item) => sanitizeDetail(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail as Record<string, unknown>)) {
    out[key] = SECRET_KEYS.test(key) ? '[redacted]' : sanitizeDetail(value, depth + 1);
  }
  return out;
}

export function isTeraBoxAuthError(error: unknown): boolean {
  return ProviderError.is(error) && (error.code === 'ERR_AUTH_EXPIRED' || error.code === 'ERR_AUTH_REVOKED');
}
