/**
 * Upload account selection — provider-contract.md §9 over UploadRoutingPolicy.
 * Evaluation order: connected → provider SUPPORTED → capabilities → quota
 * headroom → policy mode → health exclusion → deterministic tie-break.
 */

import type { ConnectedAccount, StorageAccount, UploadRoutingPolicy } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { getAppConnection } from '../queues/connection.js';
import { ProviderError } from './errors.js';
import { registry } from './registry.js';
import type { Capability, ProviderId, StorageProvider } from './types.js';

type Candidate = ConnectedAccount & { storageAccount: StorageAccount | null };

export const ROUTING_MODES = [
  'most_available',
  'least_used',
  'round_robin',
  'priority',
  'provider_preference',
  'file_size',
  'file_type',
  'health_aware',
  'user_policy',
] as const;

export type RoutingMode = (typeof ROUTING_MODES)[number];

const DEFAULT_MODE: RoutingMode = 'most_available';
const RESERVED_KEY_PREFIX = '9drive:acct:';
const RESERVED_KEY_SUFFIX = ':reserved';
const RESERVATION_TIMEOUT_MS = 1_000;
const DISALLOWED_HEALTH_STATES: ReadonlySet<string> = new Set(['unauthorized', 'unreachable']);
const HEALTH_RANK: Record<string, number> = {
  healthy: 0,
  degraded: 1,
  unknown: 2,
  unreachable: 3,
  unauthorized: 4,
};

function normalizeMode(mode: string): RoutingMode {
  return (ROUTING_MODES as readonly string[]).includes(mode) ? (mode as RoutingMode) : DEFAULT_MODE;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item !== '');
}

function availableOf(account: Candidate): bigint | null {
  return account.storageAccount?.availableBytes ?? null;
}

function usedOf(account: Candidate): bigint {
  return account.storageAccount?.usedBytes ?? 0n;
}

function fits(account: Candidate, reserved: bigint, requiredBytes: bigint): boolean {
  const available = availableOf(account);
  if (available === null) return true;
  return available - reserved >= requiredBytes;
}

function compareBigint(a: bigint, b: bigint): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compareStable(a: Candidate, b: Candidate): number {
  const byTime = a.createdAt.getTime() - b.createdAt.getTime();
  if (byTime !== 0) return byTime;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function chain(
  ...comparators: Array<(a: Candidate, b: Candidate) => number>
): (a: Candidate, b: Candidate) => number {
  return (a, b) => {
    for (const comparator of comparators) {
      const result = comparator(a, b);
      if (result !== 0) return result;
    }
    return 0;
  };
}

const byMostAvailable = (a: Candidate, b: Candidate): number => {
  const left = availableOf(a);
  const right = availableOf(b);
  if (left === null && right !== null) return -1;
  if (right === null && left !== null) return 1;
  if (left !== null && right !== null) return -compareBigint(left, right);
  return 0;
};

const byBestFit = (a: Candidate, b: Candidate): number => {
  const left = availableOf(a);
  const right = availableOf(b);
  if (left === null && right !== null) return 1;
  if (right === null && left !== null) return -1;
  if (left !== null && right !== null) return compareBigint(left, right);
  return 0;
};

function byPriority(priority: string[]): (a: Candidate, b: Candidate) => number {
  const order = new Map(priority.map((id, index) => [id, index]));
  return (a, b) => {
    const left = order.get(a.id) ?? priority.length;
    const right = order.get(b.id) ?? priority.length;
    if (left !== right) return left - right;
    return 0;
  };
}

function byProviderPreference(preferred: ProviderId[]): (a: Candidate, b: Candidate) => number {
  const rank = new Map(preferred.map((id, index) => [id, index]));
  return (a, b) => {
    const left = rank.get(a.provider) ?? preferred.length;
    const right = rank.get(b.provider) ?? preferred.length;
    return left - right;
  };
}

function extractProviderPreference(policy: UploadRoutingPolicy): ProviderId[] {
  const rules = policy.fileTypeRules;
  if (Array.isArray(rules)) {
    const providers: ProviderId[] = [];
    for (const rule of rules) {
      if (!rule || typeof rule !== 'object' || Array.isArray(rule)) continue;
      const preferred = (rule as Record<string, unknown>).preferProvider;
      if (typeof preferred === 'string' && preferred !== '' && !providers.includes(preferred)) {
        providers.push(preferred);
      }
    }
    return providers;
  }
  if (rules && typeof rules === 'object') {
    const preferred = (rules as Record<string, unknown>).providerPreference;
    if (Array.isArray(preferred)) {
      return preferred.filter((item): item is string => typeof item === 'string' && item !== '');
    }
  }
  return [];
}

function orderCandidates(
  mode: RoutingMode,
  rows: Candidate[],
  policy: UploadRoutingPolicy,
  requiredBytes: bigint,
): Candidate[] {
  const priority = normalizeStringList(policy.priorityAccountIds);
  const preferredProviders = extractProviderPreference(policy);
  const sorted = [...rows];
  switch (mode) {
    case 'least_used':
      return sorted.sort(
        chain((a, b) => compareBigint(usedOf(a), usedOf(b)), compareStable),
      );
    case 'priority':
    case 'round_robin':
      return sorted.sort(chain(byPriority(priority), compareStable));
    case 'provider_preference':
    case 'file_type':
      return sorted.sort(
        chain(byProviderPreference(preferredProviders), byMostAvailable, compareStable),
      );
    case 'user_policy':
      return sorted.sort(
        chain(byPriority(priority), byProviderPreference(preferredProviders), byMostAvailable, compareStable),
      );
    case 'file_size': {
      const withinWindow =
        (policy.minFileSizeBytes === null || requiredBytes >= policy.minFileSizeBytes) &&
        (policy.maxFileSizeBytes === null || requiredBytes <= policy.maxFileSizeBytes);
      return withinWindow
        ? sorted.sort(chain(byBestFit, byMostAvailable, compareStable))
        : sorted.sort(chain(byMostAvailable, compareStable));
    }
    case 'health_aware':
      return sorted.sort(chain(byMostAvailable, compareStable));
    default:
      return sorted.sort(chain(byMostAvailable, compareStable));
  }
}

async function applyHealthFilter(rows: Candidate[], mode: RoutingMode): Promise<Candidate[]> {
  if (rows.length === 0) return rows;
  const healthRows = await prisma.providerHealth.findMany({
    where: { connectedAccountId: { in: rows.map((row) => row.id) } },
    select: { connectedAccountId: true, state: true },
  });
  const states = new Map<string, string>();
  for (const row of healthRows) {
    if (row.connectedAccountId) states.set(row.connectedAccountId, row.state);
  }
  if (mode === 'health_aware') {
    return [...rows].sort(
      (a, b) => (HEALTH_RANK[states.get(a.id) ?? 'unknown'] ?? 2) - (HEALTH_RANK[states.get(b.id) ?? 'unknown'] ?? 2),
    );
  }
  return rows.filter((row) => !DISALLOWED_HEALTH_STATES.has(states.get(row.id) ?? 'unknown'));
}

async function readReservations(accountIds: string[]): Promise<Map<string, bigint>> {
  const reservations = new Map<string, bigint>();
  if (accountIds.length === 0) return reservations;
  try {
    const client = getAppConnection();
    const pending = Promise.all(
      accountIds.map((id) => client.get(`${RESERVED_KEY_PREFIX}${id}${RESERVED_KEY_SUFFIX}`)),
    );
    pending.catch(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('reservation lookup timed out')), RESERVATION_TIMEOUT_MS);
      timer.unref?.();
    });
    let values: Array<string | null>;
    try {
      values = await Promise.race([pending, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    accountIds.forEach((id, index) => {
      const raw = values[index];
      if (raw && /^\d+$/.test(raw)) reservations.set(id, BigInt(raw));
    });
  } catch {
    return reservations;
  }
  return reservations;
}

async function resolveTargetAccountId(input: {
  userId: string;
  targetAccountId?: string | null;
  folderId?: string | null;
}): Promise<string | null> {
  if (input.targetAccountId) return input.targetAccountId;
  if (!input.folderId) return null;
  const folder = await prisma.folder.findFirst({
    where: { id: input.folderId, userId: input.userId, deletedAt: null },
    select: { connectedAccountId: true },
  });
  return folder?.connectedAccountId ?? null;
}

async function finalizeSelection(
  mode: RoutingMode,
  rows: Candidate[],
  policy: UploadRoutingPolicy,
): Promise<Candidate | null> {
  if (rows.length === 0) return null;
  if (mode !== 'round_robin') return rows[0];
  const cursor = Number.isFinite(policy.roundRobinCursor) ? policy.roundRobinCursor : 0;
  const index = ((cursor % rows.length) + rows.length) % rows.length;
  try {
    await prisma.uploadRoutingPolicy.update({
      where: { id: policy.id },
      data: { roundRobinCursor: cursor + 1 },
    });
  } catch (err) {
    console.error('[routing] failed to advance round-robin cursor', err instanceof Error ? err.message : err);
  }
  return rows[index];
}

export async function selectAccount(input: {
  userId: string;
  requiredBytes: bigint;
  requiredCapabilities: Capability[];
  targetAccountId?: string | null;
  folderId?: string | null;
}): Promise<{ account: ConnectedAccount; provider: StorageProvider } | null> {
  try {
    if (!input || typeof input.userId !== 'string' || input.userId === '') {
      throw new ProviderError('ERR_INVALID_INPUT', 'userId is required');
    }
    if (typeof input.requiredBytes !== 'bigint') {
      throw new ProviderError('ERR_INVALID_INPUT', 'requiredBytes must be a bigint');
    }
    if (input.requiredBytes < 0n) {
      throw new ProviderError('ERR_INVALID_INPUT', 'requiredBytes must not be negative');
    }
    const requiredCapabilities = input.requiredCapabilities ?? [];

    const policy = await prisma.uploadRoutingPolicy.upsert({
      where: { userId: input.userId },
      create: { userId: input.userId, mode: DEFAULT_MODE, priorityAccountIds: [] },
      update: {},
    });
    const mode = normalizeMode(policy.mode);
    const targetAccountId = await resolveTargetAccountId(input);

    const accounts = await prisma.connectedAccount.findMany({
      where: {
        userId: input.userId,
        status: 'connected',
        ...(targetAccountId ? { id: targetAccountId } : {}),
      },
      include: { storageAccount: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

    const supported = new Set(registry.supportedIds());
    let candidates = accounts.filter((account) => supported.has(account.provider));
    candidates = candidates.filter((account) => {
      const capabilities = registry.capabilities(account.provider);
      return requiredCapabilities.every((capability) => capabilities.has(capability));
    });

    const reservations = await readReservations(candidates.map((account) => account.id));
    candidates = candidates.filter((account) =>
      fits(account, reservations.get(account.id) ?? 0n, input.requiredBytes),
    );
    if (candidates.length === 0) return null;

    const ordered = targetAccountId ? candidates : orderCandidates(mode, candidates, policy, input.requiredBytes);
    const eligible = await applyHealthFilter(ordered, mode);
    if (eligible.length === 0) return null;

    const selected = targetAccountId ? eligible[0] : await finalizeSelection(mode, eligible, policy);
    if (!selected) return null;
    return { account: selected, provider: registry.get(selected.provider) };
  } catch (err) {
    throw ProviderError.is(err)
      ? err
      : new ProviderError('ERR_INTERNAL', 'account routing failed', { cause: err });
  }
}
