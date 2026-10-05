/**
 * pCloud upstream failures → provider-contract §5 taxonomy.
 *
 * pCloud's JSON methods answer with HTTP 200 and a `{ result: <4-digit code> }`
 * envelope, so the result code — not the HTTP status — carries the failure.
 * Codes follow the documented categories (docs.pcloud.com/errors) plus the
 * per-method tables for every operation this adapter calls; plain HTTP failures
 * are delegated to the shared `fromHttpStatus`.
 *
 * Taxonomy note: pCloud has no dedicated "permission denied" code (2003), and
 * §5 has no permission bucket either — 2003 maps to ERR_INVALID_INPUT, which
 * fails the job fast without telling the user to re-authorize for a problem
 * re-auth cannot fix.
 */

import { ProviderError, fromHttpStatus, isTimeoutError } from '../errors.js';

const TIMEOUT_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
]);

const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
]);

/** Known result codes, verbatim from the per-method error tables. */
const RESULT_DESCRIPTIONS: Readonly<Record<number, string>> = {
  1000: 'log in required',
  1001: 'no path or name/folderid provided',
  1002: 'no path or folderid provided',
  1004: 'no fileid or path provided',
  1005: 'unknown content-type requested',
  1013: 'date/time format not understood',
  1016: 'no destination provided',
  1017: "invalid 'folderid' provided",
  1030: "please provide 'linkid'",
  1037: 'no destination provided',
  2000: 'log in failed',
  2001: 'invalid file/folder name',
  2002: 'a component of the parent directory does not exist',
  2003: 'access denied',
  2004: 'file or folder already exists',
  2005: 'directory does not exist',
  2006: 'folder is not empty',
  2007: 'cannot delete the root folder',
  2008: 'user is over quota',
  2009: 'file not found',
  2010: 'invalid path',
  2011: 'speed limit too low',
  2014: 'please verify your email address',
  2015: 'cannot share the root folder',
  2023: 'shared folder cannot be placed into another shared folder',
  2026: 'you can only share your own files or folders',
  2027: 'invalid or already deleted link',
  2028: 'there are active shares or share requests for this folder',
  2041: 'connection broken',
  2042: 'cannot rename the root folder',
  2043: 'cannot move a folder to a subfolder of itself',
  2119: 'cannot create a non-encrypted file in an encrypted folder',
  2206: 'cannot copy a folder into itself',
  2207: 'cannot copy a folder into a subfolder of itself',
  2208: 'target folder does not exist',
  4000: 'too many login tries from this IP address',
  5000: 'internal error, try again later',
  5001: 'internal upload error',
  5002: 'internal error, no servers available',
};

/** Result codes that mean the referenced entity is gone. */
const NOT_FOUND_RESULTS = new Set([1017, 2002, 2005, 2009, 2027, 2208]);

/** Result codes that mean the caller supplied unusable input. */
const INVALID_INPUT_RESULTS = new Set([
  1013, 2001, 2004, 2006, 2007, 2010, 2011, 2014, 2015, 2023, 2026, 2028, 2042, 2043, 2119, 2206, 2207,
]);

function truncate(text: string, limit = 300): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** Recovers the pCloud `result` code from an error this module mapped. */
export function pcloudResultOf(error: unknown): number | null {
  if (!ProviderError.is(error)) return null;
  const detail = error.detail as { result?: unknown } | undefined;
  if (detail && typeof detail === 'object' && typeof detail.result === 'number') return detail.result;
  return null;
}

/** `2004` — a file or folder with that name already exists (conflict). */
export function isPcloudConflictError(error: unknown): boolean {
  return pcloudResultOf(error) === 2004;
}

/** `2006` — `deletefolder` refused because the folder still has children. */
export function isPcloudNotEmptyError(error: unknown): boolean {
  return pcloudResultOf(error) === 2006;
}

function describe(code: number): string {
  return RESULT_DESCRIPTIONS[code] ?? 'request failed';
}

/** Map a non-zero `result` from a pCloud JSON envelope onto §5. */
export function mapPcloudResultError(code: number, payload: unknown): ProviderError {
  const message = truncate(`pCloud error ${code}: ${describe(code)}`);
  const opts = payload === undefined ? {} : { detail: payload };

  if (code === 1000 || code === 2000) return new ProviderError('ERR_AUTH_EXPIRED', message, opts);
  if (code === 2003) return new ProviderError('ERR_INVALID_INPUT', message, opts);
  if (code === 2008) return new ProviderError('ERR_QUOTA_EXCEEDED', message, opts);
  if (NOT_FOUND_RESULTS.has(code)) return new ProviderError('ERR_NOT_FOUND', message, opts);
  if (INVALID_INPUT_RESULTS.has(code)) return new ProviderError('ERR_INVALID_INPUT', message, opts);

  // Documented categories (docs.pcloud.com/errors) as the fallback.
  if (code >= 1900 && code < 2000) {
    // "Safe to retry later" — transient synchronisation between API servers.
    return new ProviderError('ERR_UPSTREAM_UNAVAILABLE', message, opts);
  }
  if (code >= 1000 && code < 2000) {
    // "API client misbehaved" — reaching one of these is a bug in this adapter.
    return new ProviderError('ERR_INTERNAL', message, opts);
  }
  if (code >= 2000 && code < 3000) return new ProviderError('ERR_INVALID_INPUT', message, opts);
  if (code >= 3000 && code < 4000) {
    // "Report that the file is bad" — content the upstream cannot process.
    return new ProviderError('ERR_INVALID_INPUT', message, opts);
  }
  if (code >= 4000 && code < 5000) return new ProviderError('ERR_RATE_LIMITED', message, opts);
  if (code >= 5000 && code < 6000) return new ProviderError('ERR_UPSTREAM_UNAVAILABLE', message, opts);
  // 6xxx are conditional "action not required" answers; we never call those
  // methods, so seeing one means this adapter misfired.
  return new ProviderError('ERR_INTERNAL', message, opts);
}

/** Non-2xx HTTP response (rare for pCloud, which prefers 200 + result codes). */
export function mapPcloudHttpError(status: number, payload: unknown, fallbackMessage = ''): ProviderError {
  const base = truncate(fallbackMessage || `pCloud HTTP ${status}`);
  const mapped = fromHttpStatus(status, `pCloud HTTP ${status}: ${base}`);
  if (payload === undefined) return mapped;
  return new ProviderError(mapped.code, mapped.message, {
    retryable: mapped.retryable,
    upstreamStatus: status,
    detail: payload,
  });
}

/** Network-level failure of an API or CDN request. */
export function mapPcloudTransportError(error: unknown): ProviderError {
  if (ProviderError.is(error)) return error;
  const e = error as { name?: string; code?: string } | undefined;
  const code = e?.code ?? '';
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError' || TIMEOUT_CODES.has(code) || isTimeoutError(error)) {
    return new ProviderError('ERR_TIMEOUT', 'pCloud request timed out', { cause: error });
  }
  if (NETWORK_CODES.has(code)) {
    return new ProviderError('ERR_UPSTREAM_UNAVAILABLE', `pCloud network error (${code})`, { cause: error });
  }
  return new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'pCloud request failed', { cause: error });
}
