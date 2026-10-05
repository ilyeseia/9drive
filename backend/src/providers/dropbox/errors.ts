/**
 * Dropbox upstream failures → provider-contract §5 taxonomy.
 * Raw payloads are kept on ProviderError.detail and are never returned verbatim.
 */

import { ProviderError, fromHttpStatus, isTimeoutError } from '../errors.js';

const RATE_LIMIT_MARKERS = [
  'rate_limit',
  'too_many_write_operations',
  'throttl',
  'busy',
  'concurrency',
] as const;

const QUOTA_MARKERS = ['insufficient_space', 'no_space'] as const;

const NOT_FOUND_MARKERS = ['not_found', 'unavailable_path', 'lookup_failed'] as const;

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
 * Dropbox's `error_summary` (`reason/subreason/detail`) from either envelope:
 * `{"error": {"error_summary": …}}` or a flat `{"error_summary": …}`.
 */
export function dropboxErrorSummary(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const root = payload as Record<string, unknown>;
  const nested = root.error && typeof root.error === 'object' ? (root.error as Record<string, unknown>) : null;
  const source = nested ?? root;
  const summary = source.error_summary;
  if (typeof summary === 'string' && summary.length > 0) return summary;
  const tag = source['.tag'];
  if (typeof tag === 'string' && tag.length > 0) return tag;
  return null;
}

/** True when the error summary reports a name/path conflict (create_folder, …). */
export function isDropboxConflictError(error: unknown): boolean {
  if (!ProviderError.is(error)) return false;
  const summary = (dropboxErrorSummary(error.detail) ?? '').toLowerCase();
  if (summary.includes('conflict') || summary.includes('already_exists') || summary.includes('folder_exists')) {
    return true;
  }
  return error.upstreamStatus === 409;
}

/** True when a shared link for the path already exists (create_shared_link_with_settings). */
export function isDropboxSharedLinkExists(error: unknown): boolean {
  if (!ProviderError.is(error)) return false;
  const summary = (dropboxErrorSummary(error.detail) ?? '').toLowerCase();
  return summary.includes('shared_link_already_exists') || summary.includes('shared_link/already_exists');
}

export function mapDropboxHttpError(status: number, payload: unknown, fallbackMessage = ''): ProviderError {
  const summary = (dropboxErrorSummary(payload) ?? '').toLowerCase();
  const message = truncate(`Dropbox API ${status}: ${summary || fallbackMessage || 'request failed'}`);
  const opts = { upstreamStatus: status, detail: payload ?? fallbackMessage };
  const has = (...markers: string[]) => markers.some((marker) => summary.includes(marker));

  if (has('revoked')) return new ProviderError('ERR_AUTH_REVOKED', message, opts);
  if (has('expired_access_token', 'invalid_access_token')) return new ProviderError('ERR_AUTH_EXPIRED', message, opts);
  if (has(...NOT_FOUND_MARKERS)) return new ProviderError('ERR_NOT_FOUND', message, opts);
  if (has(...RATE_LIMIT_MARKERS)) return new ProviderError('ERR_RATE_LIMITED', message, opts);
  if (status === 429) return new ProviderError('ERR_RATE_LIMITED', message, opts);
  if (has(...QUOTA_MARKERS)) return new ProviderError('ERR_QUOTA_EXCEEDED', message, opts);
  if (status === 401) return new ProviderError('ERR_AUTH_EXPIRED', message, opts);
  if (status === 403) return new ProviderError('ERR_AUTH_REVOKED', message, opts);
  if (status === 404) return new ProviderError('ERR_NOT_FOUND', message, opts);
  if (status === 413) return new ProviderError('ERR_QUOTA_EXCEEDED', message, opts);
  return new ProviderError(fromHttpStatus(status, message).code, message, opts);
}

export function mapDropboxTransportError(error: unknown): ProviderError {
  if (ProviderError.is(error)) return error;
  const source = error as { name?: string; code?: string; cause?: unknown } | undefined;
  const cause = source?.cause;
  if (ProviderError.is(cause)) return cause;
  const code = String(source?.code ?? (cause as { code?: string } | undefined)?.code ?? '');
  const name = String(source?.name ?? '');
  if (name === 'TimeoutError' || name === 'AbortError' || TIMEOUT_CODES.has(code) || isTimeoutError(error)) {
    return new ProviderError('ERR_TIMEOUT', 'Dropbox request timed out', { cause: error });
  }
  if (name === 'SyntaxError') {
    return new ProviderError('ERR_INTERNAL', 'Dropbox returned a malformed response', { cause: error });
  }
  return new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'Dropbox request failed', { cause: error });
}
