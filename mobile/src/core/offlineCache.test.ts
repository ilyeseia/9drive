import { QueryClient } from '@tanstack/react-query';
import { buildSnapshot, clearOfflineCache, loadOfflineSetting, restoreSnapshot, saveOfflineSetting, saveSnapshot } from './offlineCache';
import { isOnlineState } from './network';
import { readPref, writePref } from './prefs';

const file = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `${id}.pdf`,
  mimeType: 'application/pdf',
  sizeBytes: '10',
  provider: 'google_drive',
  createdAt: '2026-10-18T10:00:00Z',
  ...extra,
});
const page = (ids: string[], nextCursor?: string) => ({ files: ids.map((i) => file(i)), ...(nextCursor ? { nextCursor } : {}) });
const account = {
  id: 'a1',
  provider: 'google_drive',
  displayName: 'Main',
  email: 'me@example.com',
  status: 'connected',
  capabilities: [],
  quota: null,
  health: null,
  lastSyncedAt: null,
  routingEnabled: null,
  experimental: false,
  quotaPolicy: 'optional',
};

const fresh = () => new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
const FILES_KEY = ['files', 'list', { folderId: null, q: '', sort: 'createdAt', order: 'desc' }];

function seed(qc: QueryClient, updatedAt = Date.now()) {
  qc.setQueryData(FILES_KEY, { pages: [page(['f1', 'f2'], 'cursor'), page(['f3'])], pageParams: [undefined, 'cursor'] }, { updatedAt });
  qc.setQueryData(['folders', 'children', null], [{ id: 'd1', name: 'Taxes', parentId: null }], { updatedAt });
  qc.setQueryData(['storage', 'accounts'], [account], { updatedAt });
  // things that must never be persisted
  qc.setQueryData(['files', 'detail', 'f1'], { file: file('f1') }, { updatedAt });
  qc.setQueryData(['shares'], [{ id: 's1' }], { updatedAt });
  qc.setQueryData(['ai', 'conversations'], [{ id: 'c1', title: 'private chat' }], { updatedAt });
}

describe('offline cache — what is saved', () => {
  it('is off by default', async () => {
    await expect(loadOfflineSetting()).resolves.toBe(false);
  });

  it('keeps only allow-listed list queries, only their first page, and nothing else', () => {
    const qc = fresh();
    seed(qc);
    const snapshot = buildSnapshot(qc);
    const keys = snapshot.entries.map((e) => `${e.key[0]}/${e.key[1]}`).sort();
    expect(keys).toEqual(['files/list', 'folders/children', 'storage/accounts']);
    const files = snapshot.entries.find((e) => e.key[0] === 'files')!.data as { pages: { files: unknown[] }[] };
    expect(files.pages).toHaveLength(1);
    expect(files.pages[0]!.files).toHaveLength(2);
    const text = JSON.stringify(snapshot);
    expect(text).not.toContain('private chat');
    expect(text).not.toContain('"s1"');
  });

  it('drops unexpected fields, so a stray secret in cached data is not written to disk', () => {
    const qc = fresh();
    qc.setQueryData(FILES_KEY, {
      pages: [{ files: [file('f1', { accessToken: 'TOPSECRET', signedUrl: 'https://x?sig=abc' })] }],
      pageParams: [undefined],
    });
    expect(JSON.stringify(buildSnapshot(qc))).not.toMatch(/TOPSECRET|signedUrl|sig=abc/);
  });

  it('ignores failed or empty queries and respects the size budget', () => {
    const qc = fresh();
    const big = Array.from({ length: 4000 }, (_, i) => file(`f${i}`, { name: `${'x'.repeat(100)}${i}.pdf` }));
    qc.setQueryData(FILES_KEY, { pages: [{ files: big }], pageParams: [undefined] });
    qc.setQueryData(['storage', 'accounts'], [account]);
    const snapshot = buildSnapshot(qc);
    expect(JSON.stringify(snapshot).length).toBeLessThan(450_000);
    expect(snapshot.entries.some((e) => e.key[0] === 'storage')).toBe(true);
  });
});

describe('offline cache — restore', () => {
  it('round-trips through storage with the original timestamps', async () => {
    const a = fresh();
    const stamp = Date.now() - 60_000;
    seed(a, stamp);
    await saveSnapshot(a);
    const b = fresh();
    await expect(restoreSnapshot(b)).resolves.toBe(3);
    expect(b.getQueryData(['storage', 'accounts'])).toEqual([account]);
    expect(b.getQueryState(['storage', 'accounts'])?.dataUpdatedAt).toBe(stamp);
    expect((b.getQueryData(FILES_KEY) as { pages: unknown[] }).pages).toHaveLength(1);
  });

  it('never overwrites fresher live data', async () => {
    const a = fresh();
    seed(a, Date.now() - 120_000);
    await saveSnapshot(a);
    const b = fresh();
    b.setQueryData(['storage', 'accounts'], [{ ...account, displayName: 'Live' }], { updatedAt: Date.now() });
    await restoreSnapshot(b);
    expect((b.getQueryData(['storage', 'accounts']) as { displayName: string }[])[0]?.displayName).toBe('Live');
  });

  it('rejects tampered data: wrong shapes, unknown keys and garbage are dropped', async () => {
    const now = Date.now();
    const raw = JSON.stringify({
      version: 1,
      savedAt: now,
      entries: [
        { key: ['storage', 'accounts'], data: [{ id: 1, nope: true }], updatedAt: now },
        { key: ['files', 'list', {}], data: { pages: 'x' }, updatedAt: now },
        { key: ['ai', 'conversations'], data: [{ id: 'c1' }], updatedAt: now },
        { key: ['folders', 'all'], data: [{ id: 'd1', name: 'Ok', parentId: null }], updatedAt: now },
      ],
    });
    await writePref('offlineCache', raw);
    const qc = fresh();
    await expect(restoreSnapshot(qc)).resolves.toBe(1);
    expect(qc.getQueryData(['storage', 'accounts'])).toBeUndefined();
    expect(qc.getQueryData(['ai', 'conversations'])).toBeUndefined();
    expect(qc.getQueryData(['folders', 'all'])).toEqual([{ id: 'd1', name: 'Ok', parentId: null }]);
  });

  it('ignores malformed JSON, wrong versions and expired copies', async () => {
    for (const raw of ['{not json', JSON.stringify({ version: 2, savedAt: Date.now(), entries: [] }), '']) {
      await writePref('offlineCache', raw);
      await expect(restoreSnapshot(fresh())).resolves.toBe(0);
    }
    const old = Date.now() - 8 * 24 * 60 * 60 * 1000;
    await writePref(
      'offlineCache',
      JSON.stringify({ version: 1, savedAt: old, entries: [{ key: ['storage', 'accounts'], data: [account], updatedAt: old }] }),
    );
    await expect(restoreSnapshot(fresh())).resolves.toBe(0);
  });
});

describe('offline cache — lifecycle', () => {
  it('turning it off (or signing out) deletes the saved copy', async () => {
    const qc = fresh();
    seed(qc);
    await saveSnapshot(qc);
    expect(await readPref('offlineCache')).toContain('Taxes');
    await saveOfflineSetting(true);
    await expect(loadOfflineSetting()).resolves.toBe(true);
    await saveOfflineSetting(false);
    expect(await readPref('offlineCache')).toBeFalsy();
    await expect(loadOfflineSetting()).resolves.toBe(false);

    await saveSnapshot(qc);
    await clearOfflineCache();
    expect(await readPref('offlineCache')).toBeFalsy();
  });

  it('writes nothing when there is nothing worth saving', async () => {
    await saveSnapshot(fresh());
    expect(await readPref('offlineCache')).toBeFalsy();
  });
});

describe('isOnlineState', () => {
  it('only a definite "no" counts as offline', () => {
    expect(isOnlineState({ isConnected: true, isInternetReachable: true })).toBe(true);
    expect(isOnlineState({ isConnected: true, isInternetReachable: null })).toBe(true);
    expect(isOnlineState({ isConnected: false, isInternetReachable: false })).toBe(false);
    expect(isOnlineState({ isConnected: true, isInternetReachable: false })).toBe(false);
    expect(isOnlineState({ isConnected: null, isInternetReachable: null })).toBe(true);
  });
});
