/**
 * One error type for everything that can go wrong talking to the 9Drive API, mapped to a small set of
 * kinds the UI can act on. The server's `{ code, message }` body is kept for diagnostics but the UI shows
 * translated, user-friendly text selected by `kind` (see i18n `errors.*`) — never a raw stack or server text.
 */

export type ApiErrorKind =
  | 'offline' // no connectivity / DNS / connection refused
  | 'timeout'
  | 'cancelled'
  | 'unauthorized' // session missing, expired or revoked (refresh failed)
  | 'disabled' // account not active
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'validation'
  | 'rate_limited'
  | 'quota' // storage full / no account can accept the upload
  | 'server' // 5xx
  | 'unavailable' // 502/503/504 maintenance
  | 'invalid_response' // body did not match the contract
  | 'unknown';

export class ApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    readonly status: number | null,
    /** Server error code such as `AUTH_SESSION_EXPIRED`, when the server sent one. */
    readonly code: string | null,
    message: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** True when repeating the same request later may succeed without any change by the user. */
  get transient(): boolean {
    return this.kind === 'offline' || this.kind === 'timeout' || this.kind === 'rate_limited' || this.kind === 'unavailable';
  }

  static is(value: unknown): value is ApiError {
    return value instanceof ApiError;
  }
}

const QUOTA_CODES = new Set(['QUOTA_EXCEEDED', 'NO_ACCOUNT_WITH_ENOUGH_SPACE', 'UPLOAD_TOO_LARGE']);
const SESSION_CODES = new Set(['AUTH_SESSION_EXPIRED', 'AUTH_INVALID_TOKEN', 'AUTH_REQUIRED', 'AUTH_SESSION_COMPROMISED']);

export function isSessionCode(code: string | null): boolean {
  return code !== null && SESSION_CODES.has(code);
}

/** Maps an HTTP status (and optional server code) to an error kind. */
export function kindForStatus(status: number, code: string | null): ApiErrorKind {
  if (code === 'AUTH_ACCOUNT_DISABLED') return 'disabled';
  if (code !== null && QUOTA_CODES.has(code)) return 'quota';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 400 || status === 422) return 'validation';
  if (status === 429) return 'rate_limited';
  if (status === 507) return 'quota';
  if (status === 502 || status === 503 || status === 504) return 'unavailable';
  if (status >= 500) return 'server';
  return 'unknown';
}

/** Parses a Retry-After header (seconds) into milliseconds, capped so a hostile server cannot stall the app. */
export function parseRetryAfter(header: string | null | undefined, capMs = 30_000): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(Math.round(seconds * 1000), capMs);
}
