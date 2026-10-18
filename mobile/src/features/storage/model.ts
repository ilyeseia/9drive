/**
 * Pure presentation rules for storage accounts and routing. No invented numbers: when the server does not report a
 * quota, the UI says so instead of guessing.
 */

import { bytesToNumber } from '../../api/schemas';
import type { AccountView, RoutingMode } from '../../api/endpoints/providers';
import type { MessageKey } from '../../i18n/messages';

export type QuotaDisplay =
  | { kind: 'unknown' }
  | { kind: 'usedOnly'; used: number }
  | { kind: 'known'; used: number; total: number; available: number; fraction: number };

export function quotaOf(account: Pick<AccountView, 'quota'>): QuotaDisplay {
  const q = account.quota;
  if (!q) return { kind: 'unknown' };
  const used = bytesToNumber(q.usedBytes);
  if (q.totalBytes === null) return { kind: 'usedOnly', used };
  const total = bytesToNumber(q.totalBytes);
  if (total <= 0) return { kind: 'usedOnly', used };
  const available = q.availableBytes !== null ? bytesToNumber(q.availableBytes) : Math.max(0, total - used);
  return { kind: 'known', used, total, available, fraction: Math.min(1, used / total) };
}

/** Totals across accounts, counting only accounts whose capacity the server actually reported. */
export function summarize(accounts: Pick<AccountView, 'quota'>[]): { total: number; used: number; counted: number; skipped: number } {
  let total = 0;
  let used = 0;
  let counted = 0;
  for (const account of accounts) {
    const q = quotaOf(account);
    if (q.kind === 'known') {
      total += q.total;
      used += q.used;
      counted += 1;
    }
  }
  return { total, used, counted, skipped: accounts.length - counted };
}

export type Severity = 'ok' | 'warn' | 'bad' | 'unknown';

export function statusSeverity(status: string): Severity {
  if (status === 'connected') return 'ok';
  if (status === 'error' || status === 'disconnected' || status === 'revoked') return 'bad';
  if (status === 'pending' || status === 'expired' || status === 'needs_reauth') return 'warn';
  return 'unknown';
}

export function healthSeverity(state: string | undefined): Severity {
  if (!state) return 'unknown';
  if (state === 'healthy' || state === 'ok') return 'ok';
  if (state === 'degraded' || state === 'rate_limited') return 'warn';
  if (state === 'unauthorized' || state === 'unreachable' || state === 'error') return 'bad';
  return 'unknown';
}

export const MODE_LABEL: Record<RoutingMode, MessageKey> = {
  most_available: 'modeMostAvailable',
  least_used: 'modeLeastUsed',
  round_robin: 'modeRoundRobin',
  priority: 'modePriority',
  provider_preference: 'modeProviderPreference',
  file_size: 'modeFileSize',
  file_type: 'modeFileType',
  health_aware: 'modeHealthAware',
  user_policy: 'modeUserPolicy',
};

export const MODE_HELP: Record<RoutingMode, MessageKey> = {
  most_available: 'modeMostAvailableHelp',
  least_used: 'modeLeastUsedHelp',
  round_robin: 'modeRoundRobinHelp',
  priority: 'modePriorityHelp',
  provider_preference: 'modeProviderPreferenceHelp',
  file_size: 'modeFileSizeHelp',
  file_type: 'modeFileTypeHelp',
  health_aware: 'modeHealthAwareHelp',
  user_policy: 'modeUserPolicyHelp',
};

/** Policy modes the server may store that this app version does not know: shown raw, never guessed. */
export function isKnownMode(mode: string): mode is RoutingMode {
  return (Object.keys(MODE_LABEL) as string[]).includes(mode);
}

/** Orders accounts by a saved priority list; accounts missing from the list go last, stale ids are dropped. */
export function orderByPriority<T extends { id: string }>(accounts: T[], priorityIds: string[]): T[] {
  const rank = new Map(priorityIds.map((id, index) => [id, index]));
  return [...accounts].sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER));
}

/** Moves one id up or down; returns a new list (or the same order when it cannot move). */
export function moveId(ids: string[], id: string, direction: -1 | 1): string[] {
  const index = ids.indexOf(id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= ids.length) return ids;
  const next = [...ids];
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item!);
  return next;
}

/** Parses a user-entered size in megabytes ("1.5", "1,5") into bytes; null for anything that is not a positive number. */
export function megabytesToBytes(input: string): number | null {
  const normalised = input.trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(normalised)) return null;
  const value = Number(normalised);
  if (!Number.isFinite(value) || value <= 0 || value > 5 * 1024 * 1024) return null;
  return Math.round(value * 1024 * 1024);
}

const PRETTY: Record<string, string> = {
  s3: 'S3-compatible',
  google_drive: 'Google Drive',
  dropbox: 'Dropbox',
  onedrive: 'OneDrive',
  pcloud: 'pCloud',
  terabox: 'TeraBox',
  terabox_open: 'TeraBox',
};

/** Display name for a provider id: the server catalog wins, then a small built-in map, then the raw id. */
export function providerLabel(id: string, catalog?: { id: string; displayName: string }[]): string {
  return catalog?.find((c) => c.id === id)?.displayName ?? PRETTY[id] ?? id;
}

export function validateS3(form: {
  name: string;
  bucket: string;
  region: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
}): Partial<Record<keyof typeof form, MessageKey>> {
  const errors: Partial<Record<keyof typeof form, MessageKey>> = {};
  if (form.name.trim() === '') errors.name = 'errRequired';
  if (form.bucket.trim() === '') errors.bucket = 'errRequired';
  if (form.region.trim() === '') errors.region = 'errRequired';
  if (form.accessKeyId.trim() === '') errors.accessKeyId = 'errRequired';
  if (form.secretAccessKey === '') errors.secretAccessKey = 'errRequired';
  const endpoint = form.endpoint.trim();
  if (endpoint !== '') {
    try {
      const url = new URL(endpoint);
      // The server decides whether an endpoint is allowed (SSRF policy); the app only rejects what is malformed.
      if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) errors.endpoint = 'errEndpointInvalid';
    } catch {
      errors.endpoint = 'errEndpointInvalid';
    }
  }
  return errors;
}

/** True for a plain-http endpoint: allowed by some self-hosted setups, but the S3 traffic is then not encrypted. */
export function isInsecureEndpoint(endpoint: string): boolean {
  try {
    return new URL(endpoint.trim()).protocol === 'http:';
  } catch {
    return false;
  }
}
