/**
 * Account health and quota refresh — provider-contract.md §10.
 * Scheduled by the HEALTH_CHECK and QUOTA_REFRESH jobs (job-contract.md §2).
 */

import type { PrismaClient, ProviderHealth } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { buildContext } from './context.js';
import { ProviderError, isTimeoutError } from './errors.js';
import { recordProviderHealth, registry, truncateStoredMessage } from './registry.js';
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
      } catch (err) {
        healthInput.state = mapErrorToHealthState(err);
        healthInput.latencyMs = toLatency(Date.now() - startedAt);
        healthInput.message = errorText(err);
        healthInput.checkedAt = new Date();
      }
    }

    const statusUpdate = accountStatusUpdate(account, healthInput.state, healthInput.message);
    if (Object.keys(statusUpdate).length > 0) {
      return await prisma.$transaction(async (tx) => {
        const record = await recordProviderHealth(healthInput, tx as unknown as PrismaClient);
        await tx.connectedAccount.update({ where: { id: account.id }, data: statusUpdate });
        return record;
      });
    }
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

export async function refreshQuota(accountId: string): Promise<void> {
  try {
    const account = await loadAccount(accountId);
    const provider = registry.get(account.provider);
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
    } catch (err) {
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
  } catch (err) {
    throw ProviderError.is(err)
      ? err
      : new ProviderError('ERR_INTERNAL', 'quota refresh failed', { cause: err });
  }
}
