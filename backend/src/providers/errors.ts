/**
 * Provider error taxonomy — see docs/architecture/contracts/provider-contract.md §5.
 * This module is Coordinator-owned infrastructure: agents implement against it,
 * they do not change it without a contract proposal.
 */

export type ProviderErrorCode =
  | 'ERR_AUTH_EXPIRED'
  | 'ERR_AUTH_REVOKED'
  | 'ERR_CAPABILITY_UNSUPPORTED'
  | 'ERR_NOT_FOUND'
  | 'ERR_QUOTA_EXCEEDED'
  | 'ERR_RATE_LIMITED'
  | 'ERR_UPSTREAM_UNAVAILABLE'
  | 'ERR_TIMEOUT'
  | 'ERR_INVALID_INPUT'
  | 'ERR_SSRF_BLOCKED'
  | 'ERR_INTERNAL';

const DEFAULT_RETRYABLE: ReadonlySet<ProviderErrorCode> = new Set([
  'ERR_RATE_LIMITED',
  'ERR_UPSTREAM_UNAVAILABLE',
  'ERR_TIMEOUT',
]);

const HTTP_STATUS: Readonly<Record<ProviderErrorCode, number>> = {
  ERR_AUTH_EXPIRED: 401,
  ERR_AUTH_REVOKED: 401,
  ERR_CAPABILITY_UNSUPPORTED: 400,
  ERR_NOT_FOUND: 404,
  ERR_QUOTA_EXCEEDED: 507,
  ERR_RATE_LIMITED: 429,
  ERR_UPSTREAM_UNAVAILABLE: 503,
  ERR_TIMEOUT: 504,
  ERR_INVALID_INPUT: 400,
  ERR_SSRF_BLOCKED: 400,
  ERR_INTERNAL: 500,
};

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly retryable: boolean;
  readonly status: number;
  /** Upstream HTTP status when relevant. Never returned to clients. */
  readonly upstreamStatus?: number;
  /** Raw upstream detail. Never returned to clients verbatim. */
  readonly detail?: unknown;

  constructor(
    code: ProviderErrorCode,
    message: string,
    opts: { retryable?: boolean; upstreamStatus?: number; detail?: unknown; cause?: unknown } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'ProviderError';
    this.code = code;
    this.status = HTTP_STATUS[code];
    this.retryable = opts.retryable ?? DEFAULT_RETRYABLE.has(code);
    this.upstreamStatus = opts.upstreamStatus;
    this.detail = opts.detail;
  }

  static is(err: unknown): err is ProviderError {
    return err instanceof ProviderError;
  }
}

/** True when the error is worth retrying by a background job. */
export function isRetryableProviderError(err: unknown): boolean {
  if (ProviderError.is(err)) return err.retryable;
  // Unknown errors are treated as transient; the attempt cap bounds the damage.
  return true;
}

/** Map an upstream HTTP status onto the taxonomy when the adapter cannot be more specific. */
export function fromHttpStatus(status: number, message = 'upstream request failed'): ProviderError {
  if (status === 401) return new ProviderError('ERR_AUTH_EXPIRED', message, { upstreamStatus: status });
  if (status === 403) return new ProviderError('ERR_AUTH_REVOKED', message, { upstreamStatus: status });
  if (status === 404) return new ProviderError('ERR_NOT_FOUND', message, { upstreamStatus: status });
  if (status === 409 || status === 412) return new ProviderError('ERR_INVALID_INPUT', message, { upstreamStatus: status });
  if (status === 413) return new ProviderError('ERR_QUOTA_EXCEEDED', message, { upstreamStatus: status });
  if (status === 429) return new ProviderError('ERR_RATE_LIMITED', message, { upstreamStatus: status });
  if (status >= 500) return new ProviderError('ERR_UPSTREAM_UNAVAILABLE', message, { upstreamStatus: status });
  if (status >= 400) return new ProviderError('ERR_INVALID_INPUT', message, { upstreamStatus: status });
  return new ProviderError('ERR_INTERNAL', message, { upstreamStatus: status });
}

export function isTimeoutError(err: unknown): boolean {
  const e = err as { name?: string; code?: string; cause?: { code?: string } } | undefined;
  if (!e) return false;
  return (
    e.name === 'TimeoutError' ||
    e.name === 'AbortError' ||
    e.code === 'ETIMEDOUT' ||
    e.code === 'ESOCKETTIMEDOUT' ||
    e.cause?.code === 'ETIMEDOUT'
  );
}
