import { ApiError } from '../api/errors';
import type { FileItem } from '../api/endpoints/files';
import { TransferManager, progressFraction, type TransferPersistence, type UploadMeta } from './manager';
import type { UploadHooks, UploadJob, UploadOutcome, UploadRunner, UploadSource } from './upload';

const FILE: FileItem = {
  id: 'f1',
  name: 'a.bin',
  mimeType: 'x',
  sizeBytes: '10',
  provider: 'google_drive',
  createdAt: '2026-10-18T10:00:00Z',
};
const meta = (name: string, size = 100): UploadMeta => ({ uri: `file:///cache/${name}`, name, mimeType: 'application/octet-stream', size });
const flush = () => new Promise<void>((r) => setImmediate(() => r()));

interface Pending {
  job: UploadJob;
  hooks: UploadHooks;
  signal: AbortSignal | undefined;
  resolve: (o: UploadOutcome) => void;
  reject: (e: unknown) => void;
}

function setup(opts: { concurrency?: number; persistence?: TransferPersistence } = {}) {
  const pending: Pending[] = [];
  const runner = {
    run: (job: UploadJob, hooks: UploadHooks = {}, signal?: AbortSignal) =>
      new Promise<UploadOutcome>((resolve, reject) => {
        pending.push({ job, hooks, signal, resolve, reject });
        signal?.addEventListener('abort', () => reject(new ApiError('cancelled', null, null, 'Cancelled.')));
      }),
  } as unknown as UploadRunner;
  let n = 0;
  const uploaded: (FileItem | null)[] = [];
  const downloads: {
    resolve: (uri: string) => void;
    reject: (e: unknown) => void;
    onProgress: (w: number, t: number) => void;
    signal: AbortSignal;
  }[] = [];
  const manager = new TransferManager({
    runner,
    makeSource: (m): UploadSource => ({
      name: m.name,
      mimeType: m.mimeType,
      size: m.size,
      read: async () => new Uint8Array() as unknown as BodyInit,
    }),
    download: (_spec, onProgress, signal) =>
      new Promise<string>((resolve, reject) => {
        downloads.push({ resolve, reject, onProgress, signal });
        signal.addEventListener('abort', () => reject(new ApiError('cancelled', null, null, 'Cancelled.')));
      }),
    newId: () => `id${++n}`,
    persistence: opts.persistence,
    onUploaded: (f) => uploaded.push(f),
    concurrency: opts.concurrency ?? 2,
  });
  return { manager, pending, uploaded, downloads };
}

const statuses = (m: TransferManager) => m.getSnapshot().map((i) => i.status);

describe('TransferManager — queue', () => {
  it('runs at most N transfers at once and starts the next when one finishes', async () => {
    const { manager, pending } = setup({ concurrency: 2 });
    manager.enqueueUploads([meta('a'), meta('b'), meta('c'), meta('d')], null);
    await flush();
    expect(statuses(manager)).toEqual(['active', 'active', 'queued', 'queued']);
    pending[0]!.resolve({ file: FILE });
    await flush();
    expect(statuses(manager)).toEqual(['completed', 'active', 'active', 'queued']);
    expect(pending).toHaveLength(3);
  });

  it('shows server-confirmed progress and marks completion only on success', async () => {
    const { manager, pending, uploaded } = setup();
    manager.enqueueUploads([meta('a', 100)], 'folder-1');
    await flush();
    pending[0]!.hooks.onProgress?.(40, 100);
    expect(manager.getSnapshot()[0]).toMatchObject({ status: 'active', sent: 40, total: 100 });
    expect(progressFraction(manager.getSnapshot()[0]!)).toBeCloseTo(0.4);
    expect(pending[0]!.job.folderId).toBe('folder-1');
    pending[0]!.resolve({ file: FILE });
    await flush();
    expect(manager.getSnapshot()[0]).toMatchObject({ status: 'completed', sent: 100, file: FILE });
    expect(uploaded).toEqual([FILE]);
  });

  it('gives each file its own stable idempotency id', async () => {
    const { manager, pending } = setup();
    manager.enqueueUploads([meta('a'), meta('b')], null);
    await flush();
    const ids = pending.map((p) => p.job.clientUploadId);
    expect(new Set(ids).size).toBe(2);
  });
});

describe('TransferManager — failure, retry, cancel', () => {
  it('marks a failure with its kind and never retries it by itself', async () => {
    const { manager, pending } = setup();
    manager.enqueueUploads([meta('a')], null);
    await flush();
    pending[0]!.reject(new ApiError('quota', 507, 'QUOTA_EXCEEDED', 'full'));
    await flush();
    expect(manager.getSnapshot()[0]).toMatchObject({ status: 'failed', errorKind: 'quota', errorCode: 'QUOTA_EXCEEDED' });
    await flush();
    expect(pending).toHaveLength(1);
  });

  it('retry resumes the same job (same session) rather than starting a new upload', async () => {
    const { manager, pending } = setup();
    const [id] = manager.enqueueUploads([meta('a')], null);
    await flush();
    pending[0]!.job.sessionId = 'S1';
    pending[0]!.reject(new ApiError('offline', null, null, 'x'));
    await flush();
    manager.retry(id!);
    await flush();
    expect(pending).toHaveLength(2);
    expect(pending[1]!.job).toBe(pending[0]!.job);
    expect(pending[1]!.job.sessionId).toBe('S1');
    expect(manager.getSnapshot()[0]?.status).toBe('active');
  });

  it('cancelling an active transfer aborts it and records a cancel, not a failure', async () => {
    const { manager, pending } = setup();
    const [id] = manager.enqueueUploads([meta('a')], null);
    await flush();
    manager.cancel(id!);
    await flush();
    expect(pending[0]!.signal?.aborted).toBe(true);
    expect(manager.getSnapshot()[0]).toMatchObject({ status: 'cancelled', errorKind: null });
  });

  it('cancelling a queued transfer means it never starts', async () => {
    const { manager, pending } = setup({ concurrency: 1 });
    const [, second] = manager.enqueueUploads([meta('a'), meta('b')], null);
    await flush();
    manager.cancel(second!);
    pending[0]!.resolve({ file: FILE });
    await flush();
    expect(pending).toHaveLength(1);
    expect(statuses(manager)).toEqual(['completed', 'cancelled']);
  });

  it('cannot cancel or retry a completed transfer', async () => {
    const { manager, pending } = setup();
    const [id] = manager.enqueueUploads([meta('a')], null);
    await flush();
    pending[0]!.resolve({ file: FILE });
    await flush();
    manager.cancel(id!);
    manager.retry(id!);
    await flush();
    expect(manager.getSnapshot()[0]?.status).toBe('completed');
    expect(pending).toHaveLength(1);
  });

  it('dismiss never removes a running transfer', async () => {
    const { manager } = setup();
    const [id] = manager.enqueueUploads([meta('a')], null);
    await flush();
    manager.dismiss(id!);
    expect(manager.getSnapshot()).toHaveLength(1);
  });
});

describe('TransferManager — persistence and sign-out', () => {
  function persistence() {
    const store: {
      saved: { id: string; sessionId: string | null; clientUploadId: string; meta: UploadMeta; folderId: string | null }[];
    } = { saved: [] };
    const p: TransferPersistence = {
      load: async () => store.saved,
      save: async (items) => void (store.saved = items as never),
    };
    return { p, store };
  }

  it('persists unfinished uploads (no tokens, no contents) and drops them when done', async () => {
    const { p, store } = persistence();
    const { manager, pending } = setup({ persistence: p });
    manager.enqueueUploads([meta('a')], 'F');
    await flush();
    pending[0]!.job.sessionId = 'S9';
    pending[0]!.hooks.onSession?.('S9');
    await flush();
    expect(store.saved).toHaveLength(1);
    expect(store.saved[0]).toMatchObject({ sessionId: 'S9', folderId: 'F', meta: { name: 'a' } });
    expect(JSON.stringify(store.saved)).not.toMatch(/token|bearer/i);
    pending[0]!.resolve({ file: FILE });
    await flush();
    expect(store.saved).toEqual([]);
  });

  it('restores interrupted uploads as paused, never auto-starting, and resumes the saved session on request', async () => {
    const { p, store } = persistence();
    store.saved = [{ id: 'old1', meta: meta('big.mov', 5000), folderId: null, clientUploadId: 'cid-old', sessionId: 'S-old' }];
    const { manager, pending } = setup({ persistence: p });
    await manager.restore();
    await flush();
    expect(manager.getSnapshot()[0]).toMatchObject({ id: 'old1', status: 'paused', total: 5000 });
    expect(pending).toHaveLength(0);
    manager.retry('old1');
    await flush();
    expect(pending[0]!.job).toMatchObject({ clientUploadId: 'cid-old', sessionId: 'S-old' });
  });

  it('reset (sign-out) aborts running transfers and forgets everything, including the saved list', async () => {
    const { p, store } = persistence();
    const { manager, pending } = setup({ persistence: p });
    manager.enqueueUploads([meta('a'), meta('b'), meta('c')], null);
    await flush();
    manager.reset();
    await flush();
    expect(pending.every((x) => x.signal?.aborted)).toBe(true);
    expect(manager.getSnapshot()).toEqual([]);
    expect(store.saved).toEqual([]);
  });
});

describe('TransferManager — downloads', () => {
  it('tracks progress and exposes the local file when finished', async () => {
    const { manager, downloads } = setup();
    manager.enqueueDownload({ id: 'f1', name: 'report.pdf', size: 1000 });
    await flush();
    downloads[0]!.onProgress(250, 1000);
    expect(manager.getSnapshot()[0]).toMatchObject({ kind: 'download', status: 'active', sent: 250 });
    downloads[0]!.resolve('file:///cache/report.pdf');
    await flush();
    expect(manager.getSnapshot()[0]).toMatchObject({ status: 'completed', localUri: 'file:///cache/report.pdf' });
  });

  it('reports a failed download and supports cancel', async () => {
    const { manager, downloads } = setup();
    const a = manager.enqueueDownload({ id: 'f1', name: 'a', size: 1 });
    const b = manager.enqueueDownload({ id: 'f2', name: 'b', size: 1 });
    await flush();
    downloads[0]!.reject(new ApiError('not_found', 404, 'NOT_FOUND', 'gone'));
    manager.cancel(b);
    await flush();
    expect(manager.getSnapshot().find((i) => i.id === a)).toMatchObject({ status: 'failed', errorKind: 'not_found' });
    expect(manager.getSnapshot().find((i) => i.id === b)?.status).toBe('cancelled');
    expect(downloads[1]!.signal.aborted).toBe(true);
  });
});

describe('progressFraction', () => {
  it('is clamped and safe for unknown totals', () => {
    expect(progressFraction({ sent: 5, total: 10 })).toBe(0.5);
    expect(progressFraction({ sent: 50, total: 10 })).toBe(1);
    expect(progressFraction({ sent: -1, total: 10 })).toBe(0);
    expect(progressFraction({ sent: 5, total: 0 })).toBe(0);
  });
});
