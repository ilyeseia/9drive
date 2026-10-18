import { ApiError, kindForStatus, parseRetryAfter } from './errors';
import { DEFAULT_RETRY, backoffDelay, isSafeToRepeat, shouldRetry } from './retry';

const err = (kind: ConstructorParameters<typeof ApiError>[0]) => new ApiError(kind, null, null, 'x');

describe('kindForStatus', () => {
  it.each([
    [401, null, 'unauthorized'],
    [403, null, 'forbidden'],
    [403, 'AUTH_ACCOUNT_DISABLED', 'disabled'],
    [404, null, 'not_found'],
    [409, null, 'conflict'],
    [400, 'VALIDATION_FAILED', 'validation'],
    [400, 'NO_ACCOUNT_WITH_ENOUGH_SPACE', 'quota'],
    [507, null, 'quota'],
    [429, null, 'rate_limited'],
    [503, null, 'unavailable'],
    [500, null, 'server'],
    [418, null, 'unknown'],
  ])('%s %s -> %s', (status, code, kind) => {
    expect(kindForStatus(status as number, code as string | null)).toBe(kind);
  });
});

describe('parseRetryAfter', () => {
  it('parses seconds, caps hostile values and ignores garbage', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter('9999')).toBe(30_000);
    expect(parseRetryAfter('-1')).toBeNull();
    expect(parseRetryAfter('soon')).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
  });
});

describe('retry policy', () => {
  it('only repeats requests that are safe to repeat', () => {
    expect(isSafeToRepeat('GET', undefined)).toBe(true);
    expect(isSafeToRepeat('get', undefined)).toBe(true);
    expect(isSafeToRepeat('POST', undefined)).toBe(false);
    expect(isSafeToRepeat('DELETE', undefined)).toBe(false);
    expect(isSafeToRepeat('POST', true)).toBe(true);
  });

  it('retries transient errors on safe requests, within the limit', () => {
    for (const kind of ['offline', 'timeout', 'rate_limited', 'unavailable'] as const) {
      expect(shouldRetry(err(kind), 'GET', undefined, 0, DEFAULT_RETRY)).toBe(true);
    }
    expect(shouldRetry(err('offline'), 'GET', undefined, DEFAULT_RETRY.maxRetries, DEFAULT_RETRY)).toBe(false);
  });

  it('never retries permanent errors or unsafe requests', () => {
    for (const kind of ['validation', 'forbidden', 'not_found', 'server', 'invalid_response', 'cancelled', 'quota'] as const) {
      expect(shouldRetry(err(kind), 'GET', undefined, 0, DEFAULT_RETRY)).toBe(false);
    }
    expect(shouldRetry(err('offline'), 'POST', undefined, 0, DEFAULT_RETRY)).toBe(false);
    expect(shouldRetry(err('offline'), 'POST', true, 0, DEFAULT_RETRY)).toBe(true);
  });

  it('backs off exponentially with full jitter and honours Retry-After', () => {
    expect(backoffDelay(0, DEFAULT_RETRY, null, () => 1)).toBe(400);
    expect(backoffDelay(1, DEFAULT_RETRY, null, () => 1)).toBe(800);
    expect(backoffDelay(10, DEFAULT_RETRY, null, () => 1)).toBe(DEFAULT_RETRY.maxDelayMs);
    expect(backoffDelay(2, DEFAULT_RETRY, null, () => 0)).toBe(0);
    expect(backoffDelay(0, DEFAULT_RETRY, 2000, () => 0.5)).toBe(2000);
  });
});
