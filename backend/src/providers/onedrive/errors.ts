/**
 * OneDrive / Microsoft Graph failures → provider-contract §5 taxonomy.
 * Raw payloads are kept on ProviderError.detail and are never returned verbatim
 * (detail is preserved even on the `fromHttpStatus` fallback so summary-based
 * detection keeps working).
 */

import { ProviderError, fromHttpStatus, isTimeoutError } from '../errors.js';

const RATE_LIMIT_MARKERS = [
  'activitylimitreached',
  'toomanyrequests',
  'throttl',
  'limitexceeded',
  'busy',
] as const;

const QUOTA_MARKERS = ['quotaexceeded', 'storagequota', 'insufficientstorage', 'notenoughspace'] as const;

const NOT_FOUND_MARKERS = ['itemnotfound', 'resourcenotfound', 'notfound', 'deletedresource'] as const;

const CONFLICT_MARKERS = ['namealreadyexists', 'alreadyexists', 'conflict', 'resourcemodified'] as const;

const AUTH_EXPIRED_MARKERS = ['invalidauthenticationtoken', 'unauthenticated', 'invalidsessiontoken'] as const;

const AUTH_REVOKED_MARKERS = ['accessdenied', 'authorizationfailed', 'unauthorized'] as const;

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

/**
 * Graph's `{error: {code, message}}` envelope (and the flat variant) reduced to
 * one lower-cased `code: message` string used by the markers below.
 */
export function onedriveErrorSummary(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const root = payload as Record<string, unknown>;
  const nested = root.error && typeof root.error === 'object' ? (root.error as Record<string, unknown>) : null;
  const source = nested ?? root;
  const code = typeof source.code === 'string' ? source.code : '';
  const message = typeof source.message === 'string' ? source.message : '';
  const summary = [code, message].filter((part) => part !== '').join(': ');
  if (summary !== '') return summary.toLowerCase();
  const inner = source.innerError && typeof source.innerError === 'object'
    ? (source.innerError as Record<string, unknown>)
    : null;
  const innerCode = inner && typeof inner.code === 'string' ? inner.code : '';
  return innerCode !== '' ? innerCode.toLowerCase() : null;
}

/** True when the failure reports a name/path conflict (create folder, rename, …). */
export function isOnedriveConflictError(error: unknown): boolean {
  if (!ProviderError.is(error)) return false;
  const summary = onedriveErrorSummary(error.detail) ?? '';
  if (CONFLICT_MARKERS.some((marker) => summary.includes(marker))) return true;
  return error.upstreamStatus === 409;
}

export function mapOnedriveHttpError(status: number, payload: unknown, fallbackMessage = ''): ProviderError {
  const summary = onedriveErrorSummary(payload) ?? '';
  const detailText = summary !== '' ? summary : fallbackMessage;
  const message = truncate(`OneDrive API ${status}: ${detailText || 'request failed'}`);
  const opts = { upstreamStatus: status, detail: payload ?? fallbackMessage };
  const has = (...markers: string[]) => markers.some((marker) => summary.includes(marker));

  if (status === 401 || has(...AUTH_EXPIRED_MARKERS)) return new ProviderError('ERR_AUTH_EXPIRED', message, opts);
  if (status === 403 || has(...AUTH_REVOKED_MARKERS)) return new ProviderError('ERR_AUTH_REVOKED', message, opts);
  if (status === 404 || has(...NOT_FOUND_MARKERS)) return new ProviderError('ERR_NOT_FOUND', message, opts);
  if (status === 429 || has(...RATE_LIMIT_MARKERS)) return new ProviderError('ERR_RATE_LIMITED', message, opts);
  if (status === 413 || has(...QUOTA_MARKERS)) return new ProviderError('ERR_QUOTA_EXCEEDED', message, opts);
  return new ProviderError(fromHttpStatus(status, message).code, message, opts);
}

export function mapOnedriveTransportError(error: unknown): ProviderError {
  if (ProviderError.is(error)) return error;
  const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : '';
  const name = typeof (error as { name?: unknown })?.name === 'string' ? (error as { name: string }).name : '';
  const errno = code !== '' ? code : name;
  if (isTimeoutError(error) || TIMEOUT_CODES.has(errno)) {
    return new ProviderError('ERR_TIMEOUT', 'OneDrive request timed out', { cause: error });
  }
  if (NETWORK_CODES.has(errno)) {
    return new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'OneDrive endpoint is unreachable', { cause: error });
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return new ProviderError('ERR_TIMEOUT', 'OneDrive request was aborted', { cause: error });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ProviderError('ERR_UPSTREAM_UNAVAILABLE', truncate(`OneDrive request failed: ${message}`), {
    cause: error,
  });
}
