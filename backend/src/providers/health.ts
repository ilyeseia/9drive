/**
 * Account health and quota refresh — provider-contract.md §10.
 * Scheduled by the HEALTH_CHECK and QUOTA_REFRESH jobs (job-contract.md §2).
 */

import type { PrismaClient, ProviderHealth } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { buildContext } from './context.js';
import { ProviderError, isTimeoutError } from './errors.js';
import { recordProviderHealth, registry, truncateStoredMessage } from './registry.js';
import { incrementMetric } from '../queues/metrics.js';
import { createLogger } from '../queues/logger.js';
import type { HealthState } from './types.js';

export type ProviderHealthRecord = ProviderHealth;

const UNAUTHORIZED_CODES: ReadonlySet<string> = new Set(['ERR_AUTH_EXPIRED', 'ERR_AUTH_REVOKED']);
const UNREACHABLE_CODES: ReadonlySet<string> = new Set(['ERR_TIMEOUT', 'ERR_UPSTREAM_UNAVAILABLE']);
const DEGRADED_CODES: ReadonlySet<string> = new Set([
  'ERR_RATE_LIMITED',
  'ERR_QUOTA_EXCEEDED',
  'ERR_SSRF_BLOCKED',
  'ERR_NOT_FOUND',
]);
const NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

const HEALTH_STATES: ReadonlySet<string> = new Set([
  'healthy',
  'degraded',
  'unauthorized',
  'unreachable',
  'unknown',
]);

/** Per-account circuit breaker: tracks failures and enforces backoff before retry. */
type CircuitBreakerState = 'closed' | 'open' | 'half-open';

interface CircuitBreakerConfig {
  failureThreshold: number;
  recoveryTimeoutMs: number;
  retryAfterHeaderMs?: number; // Retry-After value from upstream, if any
}

const DEFAULT_CIRCUIT_BREAKER: CircuitBreakerConfig = {
  failureThreshold: 5,
  recoveryTimeoutMs: 30_000,
  retryAfterHeaderMs: undefined,
};

type AccountCircuitBreaker = {
  state: CircuitBreakerState;
  consecutiveFailures: number;
  lastFailureAt: number;
  lastSuccessAt: number;
  scheduledRetryAt: number; // when the account is allowed to be checked again
};

export function mapErrorToHealthState(err: unknown): HealthState {
  if (ProviderError.is(err)) {
    if (UNAUTHORIZED_CODES.has(err.code)) return 'unauthorized';
    if (UNREACHABLE_CODES.has(err.code)) return 'unreachable';
    if (DEGRADED_CODES.has(err.code)) return 'degraded';
    return 'unknown';
  }
  if (isTimeoutError(err)) return 'unreachable';
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && NETWORK_CODES.has(code)) return 'unreachable';
  return 'unknown';
}

function toLatency(value: unknown): number | null {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return null;
  return Math.min(Math.round(num), 2_147_483_647);
}

function toParseableDate(value: unknown): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(String(value ?? ''));
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function toBigIntOrNull(value: unknown): bigint | null {
  if (value === null || value === undefined) return null;
  try {
    const bytes = BigInt(typeof value === 'bigint' ? value : String(value));
    return bytes < 0n ? 0n : bytes;
  } catch {
    return null;
  }
}

async function loadAccount(accountId: string) {
  if (typeof accountId !== 'string' || accountId.trim() === '') {
    throw new ProviderError('ERR_INVALID_INPUT', 'accountId is required');
  }
  const account = await prisma.connectedAccount.findUnique({
    where: { id: accountId },
    select: { id: true, provider: true, status: true },
  });
  if (!account) {
    throw new ProviderError('ERR_NOT_FOUND', `connected account '${accountId}' not found`);
  }
  return account;
}

function accountStatusUpdate(
  account: { id: string; status: string },
  state: HealthState,
  message: string | null,
): { status?: string; lastError?: string | null } {
  if (state === 'unauthorized' && account.status !== 'disconnected') {
    return { status: 'unauthorized', lastError: truncateStoredMessage(message) };
  }
  if (state === 'healthy' && account.status === 'unauthorized') {
    return { status: 'connected', lastError: null };
  }
  return {};
}

export async function checkAccount(accountId: string): Promise<ProviderHealthRecord> {
  try {
    const account = await loadAccount(accountId);
    const provider = registry.get(account.provider);

    // Circuit breaker: skip check if account is currently open (too soon after last failure)
    const breakerState = checkCircuitBreaker(account.id);
    if (breakerState === 'open') {
      throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'account health check circuit breaker is open; please retry later');
    }

    const healthInput = {
      provider: account.provider,
      connectedAccountId: account.id,
      state: 'unknown' as HealthState,
      latencyMs: null as number | null,
      message: null as string | null,
      checkedAt: new Date(),
    };

    if (!provider.capabilities.has('healthCheck')) {
      healthInput.message = `provider '${provider.id}' does not declare capability 'healthCheck'`;
    } else {
      const startedAt = Date.now();
      try {
        const ctx = await buildContext(account.id);
        const result = await provider.healthCheck(ctx);
        healthInput.state =
          typeof result.state === 'string' && HEALTH_STATES.has(result.state) ? result.state : 'unknown';
        healthInput.latencyMs = toLatency(result.latencyMs ?? Date.now() - startedAt);
        healthInput.message = result.message ?? null;
        healthInput.checkedAt = toParseableDate(result.checkedAt);
        // Record success and close circuit breaker on success
        recordSuccess(account.id);
      } catch (err) {
        healthInput.state = mapErrorToHealthState(err);
        healthInput.latencyMs = toLatency(Date.now() - startedAt);
        healthInput.message = errorText(err);
        healthInput.checkedAt = new Date();
        // Record failure and open circuit breaker
        recordFailure(account.id, undefined);
        throw err;
      }
    }

    const statusUpdate = accountStatusUpdate(account, healthInput.state, healthInput.message);
    if (Object.keys(statusUpdate).length > 0) {
      return await prisma.$transaction(async (tx) => {
        const record = await recordProviderHealth(healthInput, tx as unknown as PrismaClient);
        await tx.connectedAccount.update({ where: { id: account.id }, data: statusUpdate });
        // Record metrics for the health check outcome
        await incrementMetric(`healthcheck:${account.provider}:${healthInput.state}:${account.id}`, 1).catch(() => undefined);
        return record;
      });
    }
    // Record metrics for successful health check with no state change
    await incrementMetric(`healthcheck:${account.provider}:healthy`, 1).catch(() => undefined);
    return await recordProviderHealth(healthInput);
  } catch (err) {
    throw ProviderError.is(err)
      ? err
      : new ProviderError('ERR_INTERNAL', 'health check failed', { cause: err });
  }
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** In-memory per-account circuit breaker store (process-local). */
const accountCircuitBreakers = new Map<string, AccountCircuitBreaker>();

/** Reset a circuit breaker to closed after a successful operation. */
function resetCircuitBreaker(accountId: string): void {
  accountCircuitBreakers.delete(accountId);
}

/** Open the circuit breaker after a failure and schedule the next allowed check. */
function openCircuitBreaker(accountId: string, config: CircuitBreakerConfig): void {
  const now = Date.now();
  const { failureThreshold, recoveryTimeoutMs, retryAfterHeaderMs } = config ?? DEFAULT_CIRCUIT_BREAKER;
  const retryAfter = retryAfterHeaderMs ?? recoveryTimeoutMs;
  const scheduledRetryAt = now + retryAfter;

  accountCircuitBreakers.set(accountId, {
    state: 'open',
    consecutiveFailures: 1,
    lastFailureAt: now,
    lastSuccessAt: now - retryAfter, // allow immediate transition to half-open after timeout
    scheduledRetryAt,
  });
}

/** Transition from open to half-open if the recovery timeout has elapsed. */
function checkCircuitBreaker(accountId: string, config?: CircuitBreakerConfig): 'open' | 'half-open' {
  const cb = accountCircuitBreakers.get(accountId);
  if (!cb) return 'half-open'; // no breaker = allowed

  const { failureThreshold, recoveryTimeoutMs, retryAfterHeaderMs } = config ?? DEFAULT_CIRCUIT_BREAKER;
  const now = Date.now();

  if (cb.state === 'open') {
    // If a Retry-After header was provided and the timeout hasn't elapsed, stay open
    if (retryAfterHeaderMs && now < cb.scheduledRetryAt) {
      return 'open';
    }
    // Otherwise, transition to half-open after the recovery timeout
    if (now >= cb.scheduledRetryAt) {
      return 'half-open';
    }
    return 'open';
  }

  // half-open: allow one check, then on success close, on failure re-open
  return 'half-open';
}

/** Record a successful operation and close the circuit breaker. */
function recordSuccess(accountId: string): void {
  accountCircuitBreakers.delete(accountId);
}

/** Record a failure and update the circuit breaker state. */
function recordFailure(accountId: string, config: CircuitBreakerConfig = DEFAULT_CIRCUIT_BREAKER): void {
  const now = Date.now();
  const cb = accountCircuitBreakers.get(accountId);
  const { failureThreshold, recoveryTimeoutMs, retryAfterHeaderMs } = config;

  if (cb) {
    const { state, consecutiveFailures } = cb;
    const newFailures = consecutiveFailures + 1;

    if (newFailures >= failureThreshold && state !== 'open') {
      // Threshold reached: open the circuit
      openCircuitBreaker(accountId, config);
    } else if (state === 'half-open') {
      // In half-open, one failure re-opens the circuit
      openCircuitBreaker(accountId, config);
    } else {
      // Update failure count for closed state
      accountCircuitBreakers.set(accountId, {
        ...cb,
        consecutiveFailures: newFailures,
      });
    }
  } else {
    // First failure: open after threshold
    if (1 >= failureThreshold) {
      openCircuitBreaker(accountId, config);
    } else {
      accountCircuitBreakers.set(accountId, {
        state: 'open' as const,
        consecutiveFailures: 1,
        lastFailureAt: now,
        lastSuccessAt: now - (recoveryTimeoutMs ?? 30_000),
        scheduledRetryAt: now + (retryAfterHeaderMs ?? recoveryTimeoutMs ?? 30_000),
      });
    }
  }
}

export async function refreshQuota(accountId: string): Promise<void> {
  const account = await loadAccount(accountId);
  try {
    const provider = registry.get(account.provider);

    // Circuit breaker: skip refresh if account is currently open (too soon after last failure)
    const breakerState = checkCircuitBreaker(account.id);
    if (breakerState === 'open') {
      createLogger({ component: 'provider.health', accountId, provider: account.provider }).warn(
        'quota refresh skipped: circuit breaker open',
      );
      throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'quota refresh circuit breaker is open; please retry later');
    }

    if (!provider.capabilities.has('getQuota')) {
      throw new ProviderError(
        'ERR_CAPABILITY_UNSUPPORTED',
        `provider '${provider.id}' does not declare capability 'getQuota'`,
      );
    }
    const ctx = await buildContext(account.id);
    let quota;
    try {
      quota = await provider.getQuota(ctx);
      // Record success and close circuit breaker on success
      recordSuccess(account.id);
    } catch (err) {
      // Record failure and open circuit breaker
      recordFailure(account.id, undefined);
      throw ProviderError.is(err)
        ? err
        : isTimeoutError(err)
          ? new ProviderError('ERR_TIMEOUT', 'quota refresh timed out', { cause: err })
          : new ProviderError('ERR_INTERNAL', 'quota refresh failed', { cause: err });
    }

    const totalBytes = toBigIntOrNull(quota.totalBytes);
    const usedBytes = toBigIntOrNull(quota.usedBytes) ?? 0n;
    const availableBytes = toBigIntOrNull(quota.availableBytes);
    const trashBytes = toBigIntOrNull(quota.trashBytes);
    const now = new Date();
    const data = { totalBytes, usedBytes, availableBytes, trashBytes, lastSyncedAt: now };
    await prisma.storageAccount.upsert({
      where: { connectedAccountId: account.id },
      create: { connectedAccountId: account.id, ...data },
      update: data,
    });
    if (account.status === 'unauthorized') {
      await prisma.connectedAccount
        .update({ where: { id: account.id }, data: { status: 'connected', lastError: null } })
        .catch(() => undefined);
    }
    // Record metrics for quota refresh outcome
    if (account.status === 'unauthorized') {
      await incrementMetric(`quotarefresh:${account.provider}:unauthorized`, 1).catch(() => undefined);
    } else {
      await incrementMetric(`quotarefresh:${account.provider}:success`, 1).catch(() => undefined);
    }
  } catch (err) {
    if (ProviderError.is(err) && (err.code === 'ERR_AUTH_EXPIRED' || err.code === 'ERR_AUTH_REVOKED')) {
      const message = errorText(err);
      await prisma.connectedAccount
        .update({
          where: { id: accountId },
          data: { status: 'unauthorized', lastError: message.slice(0, 500) },
        })
        .catch(() => undefined)
      await recordProviderHealth({
        provider: account.provider,
        connectedAccountId: account.id,
        state: 'unauthorized',
        latencyMs: null,
        message,
        checkedAt: new Date(),
      }).catch(() => undefined)
      await incrementMetric(`quotarefresh:${account.provider}:auth_failed`, 1).catch(() => undefined);
    }
    throw ProviderError.is(err)
      ? err
      : new ProviderError('ERR_INTERNAL', 'quota refresh failed', { cause: err });
  }
}
