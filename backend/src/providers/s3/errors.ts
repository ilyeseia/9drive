/**
 * AWS SDK failures → provider-contract.md §5 taxonomy.
 * Raw SDK errors stay on ProviderError.detail and are never returned verbatim;
 * the message only carries the operation plus an error code/status (no URLs).
 */

import { ProviderError, fromHttpStatus, isTimeoutError } from '../errors.js';

const NOT_FOUND_CODES = new Set(['nosuchkey', 'nosuchbucket', 'nosuchupload', 'notfound', '404']);

const QUOTA_CODES = new Set(['quotaexceeded', '507']);

const RATE_LIMIT_CODES = new Set([
  'slowdown',
  'requestthrottled',
  'requestthrottledexception',
  'throttling',
  'throttlingexception',
  'toomanyrequests',
  'requestlimitexceeded',
  '429',
]);

const AUTH_REVOKED_CODES = new Set([
  'accessdenied',
  'signaturedoesnotmatch',
  'invalidaccesskeyid',
  'accountdisabled',
  'authexpired',
  'tokenrefreshrequired',
  '403',
]);

const TIMEOUT_CODES = new Set([
  'requesttimeout',
  'requesttimeoutexception',
  'etimedout',
  'esockettimedout',
  'und_err_headers_timeout',
  'und_err_body_timeout',
  'und_err_connect_timeout',
]);

const NETWORK_CODES = new Set([
  'enotfound',
  'eai_again',
  'econnrefused',
  'econnreset',
  'epipe',
  'ehostunreach',
  'enetunreach',
  'econnaborted',
  'und_err_socket',
  'und_err_closed',
  'und_err_destroyed',
  'und_err_exceeded_max_size',
]);

interface S3ErrorLike {
  name?: string;
  code?: string;
  Code?: string;
  statusCode?: number;
  $metadata?: { httpStatusCode?: number };
  cause?: unknown;
}

function statusCodeOf(source: S3ErrorLike, cause: S3ErrorLike): number | null {
  const candidates = [source.$metadata?.httpStatusCode, source.statusCode, cause.$metadata?.httpStatusCode];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 100 && candidate < 600) {
      return candidate;
    }
  }
  return null;
}

function codesOf(source: S3ErrorLike, cause: S3ErrorLike): string[] {
  const values = [source.name, source.Code, source.code, cause.code, cause.name];
  const out: string[] = [];
  for (const value of values) {
    if (typeof value === 'string' && value !== '' && !out.includes(value)) out.push(value);
  }
  return out;
}

/** Map any AWS SDK/S3-compatible failure onto the contract error taxonomy. */
export function mapS3Error(error: unknown, operation: string): ProviderError {
  if (ProviderError.is(error)) return error;
  const source = (error ?? {}) as S3ErrorLike;
  const cause = (source.cause ?? {}) as S3ErrorLike;
  if (ProviderError.is(cause)) return cause;

  const codes = codesOf(source, cause);
  const lowered = codes.map((code) => code.toLowerCase());
  const status = statusCodeOf(source, cause);
  const detail = { codes, status: status ?? undefined };
  const suffix = codes[0] ?? (status !== null ? `HTTP ${status}` : 'request failed');
  const message = `${operation} failed (${suffix})`;
  const opts = { upstreamStatus: status ?? undefined, detail, cause: error };
  const has = (set: ReadonlySet<string>) => lowered.some((code) => set.has(code));

  if (
    isTimeoutError(error) ||
    has(TIMEOUT_CODES) ||
    lowered.some((code) => code === 'aborterror' || code === 'timeouterror')
  ) {
    return new ProviderError('ERR_TIMEOUT', `${operation} timed out`, opts);
  }
  if (lowered.includes('invalidrange') || status === 416) {
    return new ProviderError('ERR_INVALID_INPUT', `${operation} requested a byte range outside the object`, opts);
  }
  if (has(NOT_FOUND_CODES) || status === 404) {
    return new ProviderError('ERR_NOT_FOUND', `${operation} target was not found`, opts);
  }
  if (has(QUOTA_CODES) || status === 507) {
    return new ProviderError('ERR_QUOTA_EXCEEDED', `${operation} exceeded the upstream quota`, opts);
  }
  if (has(RATE_LIMIT_CODES) || status === 429) {
    return new ProviderError('ERR_RATE_LIMITED', `${operation} was throttled by the upstream`, opts);
  }
  if (status === 401) {
    return new ProviderError('ERR_AUTH_EXPIRED', `${operation} credentials have expired`, opts);
  }
  if (status === 403 || has(AUTH_REVOKED_CODES)) {
    return new ProviderError('ERR_AUTH_REVOKED', `${operation} was denied by the upstream`, opts);
  }
  if (status !== null && status >= 500) {
    return new ProviderError('ERR_UPSTREAM_UNAVAILABLE', `${operation} hit an upstream ${status}`, opts);
  }
  if (has(NETWORK_CODES)) {
    return new ProviderError('ERR_UPSTREAM_UNAVAILABLE', `${operation} could not reach the endpoint`, opts);
  }
  if (error instanceof TypeError) {
    return new ProviderError('ERR_UPSTREAM_UNAVAILABLE', `${operation} could not reach the endpoint`, opts);
  }
  if (status !== null) {
    return fromHttpStatus(status, message);
  }
  return new ProviderError('ERR_INTERNAL', `${operation} failed unexpectedly`, opts);
}
