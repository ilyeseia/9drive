/**
 * Provider registry — see docs/architecture/contracts/provider-contract.md §6, §7 and §10.
 *
 * Capability snapshots are persisted in `provider_capabilities` (database-contract §3.2);
 * health results are persisted in `provider_health`. The registry is the ONLY way
 * modules obtain a provider instance.
 */

import type { PrismaClient } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { catalog, PROVIDER_CATALOG, type ProviderCatalogEntry } from './catalog.js';
import { ProviderError } from './errors.js';
import { ALL_CAPABILITIES, isCapability, type Capability, type HealthState, type ProviderId, type StorageProvider } from './types.js';

export class ProviderRegistry {
  private readonly providers = new Map<ProviderId, StorageProvider>();

  /** Re-registering an id replaces the previously registered adapter. */
  register(provider: StorageProvider): void {
    if (!provider || typeof provider.id !== 'string' || provider.id.trim() === '') {
      throw new ProviderError('ERR_INVALID_INPUT', 'cannot register a provider without a non-empty id');
    }
    this.providers.set(provider.id, provider);
  }

  unregister(id: ProviderId): boolean {
    return this.providers.delete(id);
  }

  get(id: ProviderId): StorageProvider {
    const provider = this.providers.get(id);
    if (!provider) throw new ProviderError('ERR_NOT_FOUND', `provider '${id}' is not registered`);
    return provider;
  }

  tryGet(id: ProviderId): StorageProvider | null {
    return this.providers.get(id) ?? null;
  }

  has(id: ProviderId): boolean {
    return this.providers.has(id);
  }

  /** Registered ids whose catalog status allows use (SUPPORTED / VIA_S3, or uncatalogued test doubles). */
  supportedIds(): ProviderId[] {
    return [...this.providers.keys()].filter((id) => {
      const entry = catalog.get(id);
      return entry === null || entry.status === 'SUPPORTED' || entry.status === 'VIA_S3';
    });
  }

  capabilities(id: ProviderId): ReadonlySet<Capability> {
    return this.get(id).capabilities;
  }

  hasCapability(id: ProviderId, capability: Capability): boolean {
    return this.capabilities(id).has(capability);
  }

  all(): StorageProvider[] {
    return [...this.providers.values()];
  }

  clear(): void {
    this.providers.clear();
  }
}

export const registry = new ProviderRegistry();

/** Hard cap for ProviderHealth.message / ConnectedAccount.lastError (security-contract §9). */
export const MAX_STORED_MESSAGE_LENGTH = 500;

export function truncateStoredMessage(message: string | null | undefined): string | null {
  if (message === null || message === undefined) return null;
  const text = String(message);
  return text.length > MAX_STORED_MESSAGE_LENGTH ? text.slice(0, MAX_STORED_MESSAGE_LENGTH) : text;
}

export interface CapabilitySeedOptions {
  db?: PrismaClient;
  entries?: readonly ProviderCatalogEntry[];
}

export interface CapabilitySeedResult {
  providers: number;
  rows: number;
}

/** Idempotently upsert the static catalog into `provider_capabilities` (notes are never clobbered). */
export async function seedProviderCapabilities(options: CapabilitySeedOptions = {}): Promise<CapabilitySeedResult> {
  const db = options.db ?? prisma;
  const entries = options.entries ?? PROVIDER_CATALOG;
  const rows = entries.flatMap((entry) => {
    const declared = new Set<Capability>(entry.capabilities);
    return ALL_CAPABILITIES.map((capability) => ({ provider: entry.id, capability, supported: declared.has(capability) }));
  });
  if (rows.length === 0) return { providers: 0, rows: 0 };
  const existing = await db.providerCapability.findMany({ select: { provider: true, capability: true, supported: true } });
  const current = new Map(existing.map((row) => [`${row.provider} ${row.capability}`, row.supported]));
  const missing: typeof rows = [];
  const changed: typeof rows = [];
  for (const row of rows) {
    const seen = current.get(`${row.provider} ${row.capability}`);
    if (seen === undefined) missing.push(row);
    else if (seen !== row.supported) changed.push(row);
  }
  const writes = [
    ...(missing.length > 0 ? [db.providerCapability.createMany({ data: missing, skipDuplicates: true })] : []),
    ...changed.map((row) =>
      db.providerCapability.update({
        where: { provider_capability: { provider: row.provider, capability: row.capability } },
        data: { supported: row.supported },
      }),
    ),
  ];
  if (writes.length > 0) await db.$transaction(writes);
  return { providers: entries.length, rows: rows.length };
}

export async function loadProviderCapabilityRows(providerId: ProviderId, db: PrismaClient = prisma) {
  return db.providerCapability.findMany({ where: { provider: providerId }, orderBy: { capability: 'asc' } });
}

export async function loadSupportedCapabilities(providerId: ProviderId, db: PrismaClient = prisma): Promise<Capability[]> {
  const rows = await db.providerCapability.findMany({
    where: { provider: providerId, supported: true },
    orderBy: { capability: 'asc' },
  });
  return rows.map((row) => row.capability).filter(isCapability);
}

export interface ProviderHealthInput {
  provider: ProviderId;
  connectedAccountId?: string | null;
  state: HealthState;
  latencyMs?: number | null;
  message?: string | null;
  checkedAt?: Date;
}

/** Upsert the latest `provider_health` row for an account (or for the provider when no account is bound). */
export async function recordProviderHealth(input: ProviderHealthInput, db: PrismaClient = prisma) {
  const data = {
    provider: input.provider,
    state: input.state,
    latencyMs: input.latencyMs ?? null,
    message: truncateStoredMessage(input.message),
    checkedAt: input.checkedAt ?? new Date(),
  };
  const connectedAccountId = input.connectedAccountId ?? null;
  if (connectedAccountId !== null) {
    return db.providerHealth.upsert({
      where: { connectedAccountId },
      create: { ...data, connectedAccountId },
      update: { ...data },
    });
  }
  const existing = await db.providerHealth.findFirst({
    where: { provider: input.provider, connectedAccountId: null },
    orderBy: { updatedAt: 'desc' },
  });
  if (existing) return db.providerHealth.update({ where: { id: existing.id }, data });
  return db.providerHealth.create({ data: { ...data, connectedAccountId: null } });
}
