/**
 * Google Drive upstream failures → provider-contract §5 taxonomy.
 * Raw payloads are kept on ProviderError.detail and are never returned verbatim.
 */

import { ProviderError, fromHttpStatus, isTimeoutError } from '../errors.js';

const RATE_LIMIT_REASONS = new Set([
  'ratelimitexceeded',
  'userratelimitexceeded',
  'sharingratelimitexceeded',
  'dailylimitexceeded',
  'quotaexceeded',
  'rate_limit_exceeded',
  'resource_exhausted',
]);

const QUOTA_REASONS = new Set([
  'storagequotaexceeded',
  'userquotaexceeded',
  'teamdrivequotaexceeded',
  'downloadquotaexceeded',
  'fileownerquotaexceeded',
  'storage_quota_exceeded',
  'download_quota_exceeded',
]);

const NOT_FOUND_REASONS = new Set(['notfound', 'filenotfound', 'parentnotfound', 'not_found']);

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
  'UND_ERR_EXCEEDED_MAX_SIZE',
]);

function collectStrings(node: unknown, key: string, out: string[]): void {
  if (Array.isArray(node)) {
    for (const entry of node) collectStrings(entry, key, out);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const record = node as Record<string, unknown>;
  const value = record[key];
  if (typeof value === 'string' && value.length > 0) out.push(value);
  for (const [childKey, child] of Object.entries(record)) {
    if (childKey === key) continue;
    if (Array.isArray(child) || (child !== null && typeof child === 'object')) collectStrings(child, key, out);
  }
}

function envelopeOf(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object') return {};
  const root = payload as Record<string, unknown>;
  const nested = root.error && typeof root.error === 'object' ? (root.error as Record<string, unknown>) : null;
  return nested ? { ...root, ...nested } : root;
}

/** Reason strings from both the legacy (`errors[].reason`) and RPC (`details[].reason`) shapes. */
export function googleErrorReasons(payload: unknown): string[] {
  const reasons: string[] = [];
  collectStrings(payload, 'reason', reasons);
  return reasons;
}

/** Google RPC status code (`NOT_FOUND`, `PERMISSION_DENIED`, …) when present. */
export function googleErrorStatus(payload: unknown): string | null {
  const value = envelopeOf(payload).status;
  if (typeof value !== 'string') return null;
  return /^[A-Z][A-Z_]+$/.test(value) ? value : null;
}

export function googleErrorMessage(payload: unknown): string | null {
  const value = envelopeOf(payload).message;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function truncate(text: string, limit = 300): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function describe(status: number, payload: unknown, fallback: string): string {
  const reasons = googleErrorReasons(payload);
  const rpcStatus = googleErrorStatus(payload);
  const detail = reasons[0] ?? rpcStatus ?? googleErrorMessage(payload) ?? fallback ?? '';
  return truncate(`Google Drive API ${status}: ${detail}`.trim());
}

export function mapGoogleHttpError(status: number, payload: unknown, fallbackMessage = ''): ProviderError {
  const reasons = new Set(googleErrorReasons(payload).map((reason) => reason.toLowerCase()));
  const rpcStatus = (googleErrorStatus(payload) ?? '').toLowerCase();
  const message = describe(status, payload, fallbackMessage);
  const opts = { upstreamStatus: status, detail: payload ?? fallbackMessage };
  const has = (...names: string[]) => names.some((name) => reasons.has(name));

  if (status === 404 || rpcStatus === 'not_found' || has(...NOT_FOUND_REASONS)) {
    return new ProviderError('ERR_NOT_FOUND', message, opts);
  }
  if (status === 429 || has(...RATE_LIMIT_REASONS)) {
    return new ProviderError('ERR_RATE_LIMITED', message, opts);
  }
  if (has(...QUOTA_REASONS)) {
    return new ProviderError('ERR_QUOTA_EXCEEDED', message, opts);
  }
  if (status >= 500 || rpcStatus === 'unavailable' || has('backenderror', 'internalerror', 'backend_error')) {
    return new ProviderError('ERR_UPSTREAM_UNAVAILABLE', message, opts);
  }
  if (status === 401 || rpcStatus === 'unauthenticated') {
    return new ProviderError('ERR_AUTH_EXPIRED', message, opts);
  }
  if (status === 403 || rpcStatus === 'permission_denied') {
    return new ProviderError('ERR_AUTH_REVOKED', message, opts);
  }
  return fromHttpStatus(status, message);
}

export function mapGoogleTransportError(error: unknown): ProviderError {
  if (ProviderError.is(error)) return error;
  const source = error as { name?: string; code?: string; cause?: unknown } | undefined;
  const cause = source?.cause;
  if (ProviderError.is(cause)) return cause;
  const code = String(source?.code ?? (cause as { code?: string } | undefined)?.code ?? '');
  const name = String(source?.name ?? '');
  if (name === 'TimeoutError' || name === 'AbortError' || TIMEOUT_CODES.has(code) || isTimeoutError(error)) {
    return new ProviderError('ERR_TIMEOUT', 'Google Drive request timed out', { cause: error });
  }
  if (name === 'SyntaxError') {
    return new ProviderError('ERR_INTERNAL', 'Google Drive returned a malformed response', { cause: error });
  }
  if (NETWORK_CODES.has(code) || code.startsWith('UND_ERR') || error instanceof TypeError || error instanceof Error) {
    return new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'Google Drive request failed', { cause: error });
  }
  return new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'Google Drive request failed', { cause: error });
}

/** True when an upstream failure means a parent folder disappeared (stale root cache). */
export function isMissingParentError(error: unknown): boolean {
  if (!ProviderError.is(error)) return false;
  if (error.code === 'ERR_NOT_FOUND') return true;
  return googleErrorReasons(error.detail)
    .map((reason) => reason.toLowerCase())
    .includes('parentnotfound');
}
