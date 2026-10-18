/**
 * Retry policy. Pure functions so the rules are unit-tested rather than buried in the client.
 *
 * Rules (from the engineering brief):
 *  - Only transient failures are retried: connectivity errors, timeouts, 429, 502/503/504.
 *  - Only requests that are safe to repeat are retried: GET/HEAD, or a request explicitly marked `idempotent`
 *    (it carries an idempotency key or is naturally repeatable). A POST/PATCH/DELETE without that mark is never
 *    retried automatically — the user decides.
 *  - Bounded exponential backoff with full jitter; a server `Retry-After` is honoured (already capped).
 */

import type { ApiError } from './errors';

export interface RetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { maxRetries: 2, baseDelayMs: 400, maxDelayMs: 5_000 };

export function isSafeToRepeat(method: string, idempotent: boolean | undefined): boolean {
  const m = method.toUpperCase();
  return m === 'GET' || m === 'HEAD' || idempotent === true;
}

export function shouldRetry(
  error: ApiError,
  method: string,
  idempotent: boolean | undefined,
  attempt: number,
  policy: RetryPolicy,
): boolean {
  if (attempt >= policy.maxRetries) return false;
  if (!isSafeToRepeat(method, idempotent)) return false;
  return error.transient;
}

/** Delay before retry number `attempt` (0-based): full jitter over an exponential window, or Retry-After. */
export function backoffDelay(
  attempt: number,
  policy: RetryPolicy,
  retryAfterMs: number | null,
  random: () => number = Math.random,
): number {
  if (retryAfterMs !== null) return Math.min(retryAfterMs, policy.maxDelayMs * 6);
  const window = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
  return Math.round(random() * window);
}
