/**
 * Transfer queue: tracks uploads and downloads, runs a bounded number at a time, and exposes an observable
 * snapshot for the UI.
 *
 * Honest by construction:
 *  - `sent` is the server-confirmed byte count for uploads and the written byte count for downloads.
 *  - A transfer is `completed` only after the server confirmed it (upload) or the file is fully on disk (download).
 *  - Failures stay `failed` until the user retries; nothing is retried silently beyond the transient-error policy
 *    inside the runner.
 *  - Unfinished uploads are persisted (names and local paths, no tokens or file contents) so they can be resumed
 *    after the app is restarted. They come back `paused` and never restart on their own.
 *  - The OS may suspend or kill the app in the background; resumable uploads are how that is recovered. There is no
 *    guarantee of uninterrupted background transfer.
 */

import { ApiError, type ApiErrorKind } from '../api/errors';
import type { FileItem } from '../api/endpoints/files';
import { describeErrorDetail } from '../core/errorDetail';
import { log } from '../core/logger';
import { UploadRunner, type UploadJob, type UploadSource } from './upload';

export type TransferKind = 'upload' | 'download';
export type TransferStatus = 'queued' | 'active' | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface TransferItem {
  id: string;
  kind: TransferKind;
  name: string;
  total: number;
  sent: number;
  status: TransferStatus;
  errorKind: ApiErrorKind | null;
  errorCode: string | null;
  /** Short technical description of the last failure (see core/errorDetail). Shown to help support; never secret. */
  errorDetail: string | null;
  /** Upload: the created file. Download: nothing. */
  file: FileItem | null;
  /** Download: the local copy once finished. */
  localUri: string | null;
}

export interface UploadMeta {
  uri: string;
  name: string;
  mimeType: string;
  size: number;
}

interface PersistedUpload {
  id: string;
  meta: UploadMeta;
  folderId: string | null;
  clientUploadId: string;
  sessionId: string | null;
}

export interface TransferPersistence {
  load(): Promise<PersistedUpload[]>;
  save(items: PersistedUpload[]): Promise<void>;
}

export interface DownloadFn {
  (spec: { fileId: string; name: string }, onProgress: (written: number, total: number) => void, signal: AbortSignal): Promise<string>;
}

export interface TransferDeps {
  runner: UploadRunner;
  makeSource: (meta: UploadMeta) => UploadSource;
  download: DownloadFn;
  newId: () => string;
  persistence?: TransferPersistence;
  onUploaded?: (file: FileItem | null) => void;
  /** Maximum simultaneous transfers. */
  concurrency?: number;
}

interface Internal {
  item: TransferItem;
  controller: AbortController | null;
  upload?: { job: UploadJob; meta: UploadMeta };
  download?: { fileId: string };
}

export class TransferManager {
  private readonly entries = new Map<string, Internal>();
  private readonly listeners = new Set<() => void>();
  private snapshot: TransferItem[] = [];
  private readonly concurrency: number;

  constructor(private readonly deps: TransferDeps) {
    this.concurrency = deps.concurrency ?? 2;
  }

  // ---- observable --------------------------------------------------------------------------

  getSnapshot = (): TransferItem[] => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private emit(): void {
    // A new array identity per change makes useSyncExternalStore re-render.
    this.snapshot = [...this.entries.values()].map((e) => e.item);
    for (const listener of [...this.listeners]) listener();
  }

  private update(id: string, patch: Partial<TransferItem>): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.item = { ...entry.item, ...patch };
    this.emit();
  }

  // ---- commands -----------------------------------------------------------------------------

  enqueueUploads(metas: UploadMeta[], folderId: string | null): string[] {
    const ids: string[] = [];
    for (const meta of metas) {
      const id = this.deps.newId();
      const job: UploadJob = { source: this.deps.makeSource(meta), folderId, clientUploadId: this.deps.newId() };
      this.add({ id, kind: 'upload', name: meta.name, total: meta.size, status: 'queued', upload: { job, meta } });
      ids.push(id);
    }
    this.afterChange();
    return ids;
  }

  enqueueDownload(file: { id: string; name: string; size: number }): string {
    const id = this.deps.newId();
    this.add({ id, kind: 'download', name: file.name, total: file.size, status: 'queued', download: { fileId: file.id } });
    this.afterChange();
    return id;
  }

  /** Cancels a queued or running transfer. Completed transfers are unaffected. */
  cancel(id: string): void {
    const entry = this.entries.get(id);
    if (!entry || !['queued', 'active', 'paused'].includes(entry.item.status)) return;
    entry.controller?.abort();
    this.update(id, { status: 'cancelled', errorKind: null, errorCode: null, errorDetail: null });
    this.afterChange();
  }

  /** User-initiated retry/resume of a failed, cancelled or interrupted transfer. */
  retry(id: string): void {
    const entry = this.entries.get(id);
    if (!entry || !['failed', 'cancelled', 'paused'].includes(entry.item.status)) return;
    this.update(id, { status: 'queued', errorKind: null, errorCode: null, errorDetail: null });
    this.afterChange();
  }

  dismiss(id: string): void {
    const entry = this.entries.get(id);
    if (!entry || entry.item.status === 'active') return;
    this.entries.delete(id);
    this.emit();
    this.persist();
  }

  clearFinished(): void {
    for (const [id, entry] of [...this.entries]) {
      if (['completed', 'cancelled'].includes(entry.item.status)) this.entries.delete(id);
    }
    this.emit();
    this.persist();
  }

  /** Called on sign-out: aborts everything and forgets all state. */
  reset(): void {
    for (const entry of this.entries.values()) entry.controller?.abort();
    this.entries.clear();
    this.emit();
    void this.deps.persistence?.save([]);
  }

  /** Restores unfinished uploads from the previous run as `paused` (the user decides whether to resume). */
  async restore(): Promise<void> {
    const saved = (await this.deps.persistence?.load()) ?? [];
    for (const p of saved) {
      if (this.entries.has(p.id)) continue;
      const job: UploadJob = {
        source: this.deps.makeSource(p.meta),
        folderId: p.folderId,
        clientUploadId: p.clientUploadId,
        sessionId: p.sessionId,
      };
      this.add({ id: p.id, kind: 'upload', name: p.meta.name, total: p.meta.size, status: 'paused', upload: { job, meta: p.meta } });
    }
    this.emit();
  }

  // ---- internals ---------------------------------------------------------------------------

  private add(spec: {
    id: string;
    kind: TransferKind;
    name: string;
    total: number;
    status: TransferStatus;
    upload?: Internal['upload'];
    download?: Internal['download'];
  }): void {
    this.entries.set(spec.id, {
      item: {
        id: spec.id,
        kind: spec.kind,
        name: spec.name,
        total: spec.total,
        sent: 0,
        status: spec.status,
        errorKind: null,
        errorCode: null,
        errorDetail: null,
        file: null,
        localUri: null,
      },
      controller: null,
      upload: spec.upload,
      download: spec.download,
    });
    this.emit();
  }

  private afterChange(): void {
    this.persist();
    this.pump();
  }

  private pump(): void {
    const active = [...this.entries.values()].filter((e) => e.item.status === 'active').length;
    let free = this.concurrency - active;
    for (const entry of this.entries.values()) {
      if (free <= 0) break;
      if (entry.item.status !== 'queued') continue;
      free -= 1;
      void this.start(entry);
    }
  }

  private async start(entry: Internal): Promise<void> {
    const id = entry.item.id;
    const controller = new AbortController();
    entry.controller = controller;
    this.update(id, { status: 'active', sent: entry.item.status === 'queued' ? entry.item.sent : 0 });
    try {
      if (entry.upload) {
        const out = await this.deps.runner.run(
          entry.upload.job,
          {
            onSession: () => this.persist(),
            onProgress: (sent, total) => this.update(id, { sent, total }),
          },
          controller.signal,
        );
        this.update(id, { status: 'completed', sent: entry.item.total, file: out.file });
        this.deps.onUploaded?.(out.file);
      } else if (entry.download) {
        const uri = await this.deps.download(
          { fileId: entry.download.fileId, name: entry.item.name },
          (written, total) => this.update(id, { sent: written, total: total || entry.item.total }),
          controller.signal,
        );
        this.update(id, { status: 'completed', sent: entry.item.total, localUri: uri });
      }
    } catch (error) {
      if (controller.signal.aborted || (ApiError.is(error) && error.kind === 'cancelled')) {
        // Already marked cancelled by cancel()/reset(); do not overwrite a user decision.
        if (this.entries.get(id)?.item.status === 'active') this.update(id, { status: 'cancelled' });
      } else {
        this.update(id, {
          status: 'failed',
          errorKind: ApiError.is(error) ? error.kind : 'unknown',
          errorCode: ApiError.is(error) ? error.code : null,
          errorDetail: describeErrorDetail(error),
        });
        log.warn('Transfer failed', { kind: ApiError.is(error) ? error.kind : 'unknown', detail: describeErrorDetail(error) });
      }
    } finally {
      entry.controller = null;
      this.afterChange();
    }
  }

  private persist(): void {
    if (!this.deps.persistence) return;
    const unfinished: PersistedUpload[] = [];
    for (const entry of this.entries.values()) {
      if (!entry.upload || ['completed', 'cancelled'].includes(entry.item.status)) continue;
      unfinished.push({
        id: entry.item.id,
        meta: entry.upload.meta,
        folderId: entry.upload.job.folderId,
        clientUploadId: entry.upload.job.clientUploadId,
        sessionId: entry.upload.job.sessionId ?? null,
      });
    }
    void this.deps.persistence.save(unfinished).catch(() => undefined);
  }
}

/** Human-meaningful progress 0..1 (never above 1, 0 for unknown totals). */
export function progressFraction(item: Pick<TransferItem, 'sent' | 'total'>): number {
  if (!(item.total > 0)) return 0;
  return Math.min(1, Math.max(0, item.sent / item.total));
}
