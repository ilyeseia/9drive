/**
 * Optional offline copy of NON-SECRET metadata (file/folder names, sizes, dates, account labels).
 *
 * Privacy-first design:
 *  - OFF by default; the user opts in from Settings.
 *  - Only an allowlist of list queries is saved, and only their first page; file contents, tokens, share links and
 *    credentials are never part of it.
 *  - It is stored in the app's private AsyncStorage (not encrypted by the app) — the Settings text says what it holds.
 *  - Everything restored is re-validated with the same schemas as live responses, so a tampered copy cannot inject
 *    unexpected shapes into the UI. Anything invalid is dropped.
 *  - Copies older than 7 days are ignored. The cache is deleted on sign-out and when the user turns the option off.
 */

import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { z } from 'zod';
import { filesPageSchema, folderSchema } from '../api/endpoints/files';
import { accountViewSchema } from '../api/endpoints/providers';
import { readPref, writePref } from './prefs';

const SETTING_KEY = 'offlineCacheEnabled';
const DATA_KEY = 'offlineCache';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BYTES = 400_000;

/** Observable in-memory mirror of the setting so UI and the cache controller stay in sync. */
let settingValue: boolean | null = null;
const settingListeners = new Set<() => void>();
export const offlineSettingStore = {
  get: (): boolean | null => settingValue,
  subscribe: (listener: () => void) => {
    settingListeners.add(listener);
    return () => settingListeners.delete(listener);
  },
  set: (value: boolean) => {
    settingValue = value;
    for (const l of [...settingListeners]) l();
  },
};

export async function loadOfflineSetting(): Promise<boolean> {
  const enabled = (await readPref(SETTING_KEY)) === '1';
  offlineSettingStore.set(enabled);
  return enabled;
}

export async function saveOfflineSetting(enabled: boolean): Promise<void> {
  await writePref(SETTING_KEY, enabled ? '1' : '0');
  if (!enabled) await clearOfflineCache();
  offlineSettingStore.set(enabled);
}

export async function clearOfflineCache(): Promise<void> {
  await writePref(DATA_KEY, '');
}

interface Rule {
  match: (key: QueryKey) => boolean;
  validate: (data: unknown) => unknown | null;
  /** Reduces live data to what is worth keeping (first page only). */
  trim: (data: unknown) => unknown;
}

const infiniteOf = z.object({ pages: z.array(filesPageSchema).min(1), pageParams: z.array(z.unknown()) });
const foldersOf = z.array(folderSchema);
const accountsOf = z.array(accountViewSchema);

const RULES: Rule[] = [
  {
    match: (k) => k[0] === 'files' && k[1] === 'list',
    validate: (d) => {
      const r = infiniteOf.safeParse(d);
      return r.success ? r.data : null;
    },
    trim: (d) => {
      const r = infiniteOf.safeParse(d);
      return r.success ? { pages: r.data.pages.slice(0, 1), pageParams: r.data.pageParams.slice(0, 1) } : null;
    },
  },
  {
    match: (k) => k[0] === 'folders' && (k[1] === 'children' || k[1] === 'all'),
    validate: (d) => {
      const r = foldersOf.safeParse(d);
      return r.success ? r.data : null;
    },
    trim: (d) => d,
  },
  {
    match: (k) => k[0] === 'storage' && k[1] === 'accounts',
    validate: (d) => {
      const r = accountsOf.safeParse(d);
      return r.success ? r.data : null;
    },
    trim: (d) => d,
  },
];

const snapshotSchema = z.object({
  version: z.literal(1),
  savedAt: z.number(),
  entries: z.array(z.object({ key: z.array(z.unknown()), data: z.unknown(), updatedAt: z.number() })),
});

export interface Snapshot {
  version: 1;
  savedAt: number;
  entries: { key: unknown[]; data: unknown; updatedAt: number }[];
}

/** Builds the snapshot from the live query cache (pure given the cache; exported for tests). */
export function buildSnapshot(queryClient: QueryClient, now = Date.now()): Snapshot {
  const entries: Snapshot['entries'] = [];
  let size = 0;
  for (const query of queryClient.getQueryCache().findAll()) {
    if (query.state.status !== 'success' || query.state.data === undefined) continue;
    const rule = RULES.find((r) => r.match(query.queryKey));
    if (!rule) continue;
    const data = rule.trim(query.state.data);
    if (data === null) continue;
    const entry = { key: [...query.queryKey], data, updatedAt: query.state.dataUpdatedAt };
    const bytes = JSON.stringify(entry).length;
    if (size + bytes > MAX_BYTES) continue;
    size += bytes;
    entries.push(entry);
  }
  return { version: 1, savedAt: now, entries };
}

export async function saveSnapshot(queryClient: QueryClient): Promise<void> {
  const snapshot = buildSnapshot(queryClient);
  await writePref(DATA_KEY, snapshot.entries.length > 0 ? JSON.stringify(snapshot) : '');
}

/** Loads a saved copy into the query cache without overwriting anything fresher. Returns how many entries were used. */
export async function restoreSnapshot(queryClient: QueryClient, now = Date.now()): Promise<number> {
  const raw = await readPref(DATA_KEY);
  if (!raw) return 0;
  let parsed: z.infer<typeof snapshotSchema>;
  try {
    const result = snapshotSchema.safeParse(JSON.parse(raw));
    if (!result.success) return 0;
    parsed = result.data;
  } catch {
    return 0;
  }
  if (now - parsed.savedAt > MAX_AGE_MS) return 0;
  let restored = 0;
  for (const entry of parsed.entries) {
    if (now - entry.updatedAt > MAX_AGE_MS) continue;
    const rule = RULES.find((r) => r.match(entry.key as QueryKey));
    const data = rule?.validate(entry.data);
    if (!rule || data === null || data === undefined) continue;
    const existing = queryClient.getQueryState(entry.key as QueryKey);
    if (existing?.data !== undefined && existing.dataUpdatedAt >= entry.updatedAt) continue;
    queryClient.setQueryData(entry.key as QueryKey, data, { updatedAt: entry.updatedAt });
    restored += 1;
  }
  return restored;
}

/** Saves a snapshot a couple of seconds after the cache last changed. Returns an unsubscribe function. */
export function autoSaveSnapshots(queryClient: QueryClient, delayMs = 2000): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const unsubscribe = queryClient.getQueryCache().subscribe(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void saveSnapshot(queryClient).catch(() => undefined), delayMs);
  });
  return () => {
    unsubscribe();
    if (timer) clearTimeout(timer);
  };
}
