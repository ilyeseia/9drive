/**
 * Resumable chunked upload against the provider-neutral protocol of the 9Drive backend
 * (backend/src/modules/uploads/upload.routes.ts):
 *
 *   POST /uploads/resumable/init            -> { sessionId, chunkSize, offset, status?, file? }
 *   PUT  /uploads/resumable/chunk/:id       Content-Range: bytes a-b/total  -> { status, offset, file? }
 *   GET  /uploads/resumable/status/:id      -> { status, offset }
 *
 * Guarantees implemented here:
 *  - Progress is what the SERVER has confirmed (its `offset`), never an optimistic guess.
 *  - After any failed chunk we ask the server where it is and continue from THAT offset, so a chunk that was
 *    applied but whose response was lost is never sent twice, and a server that rewound is followed.
 *  - Only transient failures are retried, with bounded backoff; everything else surfaces to the user.
 *  - `clientUploadId` (stable per file) makes init/finalise idempotent on the server: re-initialising after a
 *    crash cannot create a duplicate file.
 *  - Cancellation aborts the in-flight request. There is no server endpoint to delete a session; an abandoned
 *    one is simply never completed.
 *  - Large files are read one chunk at a time; the file is never loaded into memory.
 */

import { z } from 'zod';
import type { ApiClient } from '../api/client';
import { ApiError } from '../api/errors';
import { fileSchema, type FileItem } from '../api/endpoints/files';
import { DEFAULT_RETRY, backoffDelay } from '../api/retry';

export interface UploadSource {
  name: string;
  mimeType: string;
  size: number;
  /** Reads bytes [start, end) — end exclusive. */
  read(start: number, end: number): Promise<BodyInit>;
}

export interface InitResult {
  sessionId: string;
  chunkSize: number;
  offset: number;
  status: 'uploading' | 'completed';
  file: FileItem | null;
}

export interface ChunkResult {
  status: 'uploading' | 'completed';
  offset: number;
  file: FileItem | null;
}

export interface SessionStatus {
  status: 'uploading' | 'completed' | 'failed';
  offset: number;
}

export interface UploadApi {
  init(
    spec: {
      fileName: string;
      mimeType: string;
      size: number;
      folderId: string | null;
      targetAccountId?: string | null;
      clientUploadId: string;
    },
    signal?: AbortSignal,
  ): Promise<InitResult>;
  status(sessionId: string, signal?: AbortSignal): Promise<SessionStatus>;
  putChunk(
    sessionId: string,
    body: BodyInit,
    range: { start: number; end: number; total: number },
    signal?: AbortSignal,
  ): Promise<ChunkResult>;
}

export interface UploadJob {
  source: UploadSource;
  folderId: string | null;
  targetAccountId?: string | null;
  clientUploadId: string;
  /** Set once the server created a session; lets a later run resume instead of starting over. */
  sessionId?: string | null;
}

export interface UploadHooks {
  onSession?(sessionId: string): void;
  onProgress?(confirmedBytes: number, totalBytes: number): void;
}

export interface UploadOutcome {
  file: FileItem | null;
}

export interface RunnerOptions {
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  maxChunkRetries?: number;
  /** Consecutive loop iterations without the server offset advancing before giving up. */
  maxStalls?: number;
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new ApiError('cancelled', null, null, 'Cancelled.'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new ApiError('cancelled', null, null, 'Cancelled.'));
    });
  });

const RESYNC_CODES = new Set(['INVALID_OFFSET', 'INVALID_CONTENT_RANGE', 'MISSING_CONTENT_RANGE']);

export class UploadRunner {
  private readonly sleep: NonNullable<RunnerOptions['sleep']>;
  private readonly random: () => number;
  private readonly maxChunkRetries: number;
  private readonly maxStalls: number;

  constructor(
    private readonly api: UploadApi,
    options: RunnerOptions = {},
  ) {
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.maxChunkRetries = options.maxChunkRetries ?? 4;
    this.maxStalls = options.maxStalls ?? 5;
  }

  async run(job: UploadJob, hooks: UploadHooks = {}, signal?: AbortSignal): Promise<UploadOutcome> {
    const { source } = job;
    const total = source.size;
    if (!Number.isFinite(total) || total <= 0)
      throw new ApiError('validation', null, 'UPLOAD_SIZE_REQUIRED', 'The file is empty or its size is unknown.');
    this.throwIfCancelled(signal);

    let sessionId = job.sessionId ?? null;
    let chunkSize = 5 * 1024 * 1024;
    let offset = 0;

    if (sessionId) {
      const status = await this.api.status(sessionId, signal);
      if (status.status === 'completed') return { file: null };
      if (status.status === 'failed') sessionId = null;
      else offset = status.offset;
    }
    if (!sessionId) {
      const init = await this.api.init(
        {
          fileName: source.name,
          mimeType: source.mimeType,
          size: total,
          folderId: job.folderId,
          targetAccountId: job.targetAccountId ?? null,
          clientUploadId: job.clientUploadId,
        },
        signal,
      );
      sessionId = init.sessionId;
      job.sessionId = sessionId;
      hooks.onSession?.(sessionId);
      if (init.status === 'completed') {
        hooks.onProgress?.(total, total);
        return { file: init.file };
      }
      chunkSize = init.chunkSize > 0 ? init.chunkSize : chunkSize;
      offset = init.offset;
    }
    hooks.onProgress?.(Math.min(offset, total), total);

    let stalls = 0;
    let failures = 0; // consecutive transient failures; reset by any successful chunk
    while (offset < total) {
      this.throwIfCancelled(signal);
      const start = offset;
      const end = Math.min(start + chunkSize, total);
      const body = await source.read(start, end);

      let result: ChunkResult;
      try {
        result = await this.api.putChunk(sessionId, body, { start, end: end - 1, total }, signal);
        failures = 0;
      } catch (error) {
        if (!ApiError.is(error) || error.kind === 'cancelled') throw error;
        const resync = error.code !== null && RESYNC_CODES.has(error.code);
        if (!resync) {
          if (!error.transient || failures >= this.maxChunkRetries) throw error;
          await this.sleep(backoffDelay(failures, DEFAULT_RETRY, error.retryAfterMs, this.random), signal);
          failures += 1;
        }
        // The chunk may or may not have been applied: ask the server rather than guessing.
        const status = await this.api.status(sessionId, signal);
        if (status.status === 'completed') return { file: null };
        if (status.status === 'failed')
          throw new ApiError('server', null, 'UPLOAD_SESSION_FAILED', 'The upload session failed on the server. Start the upload again.');
        result = { status: 'uploading', offset: status.offset, file: null };
      }

      if (result.status === 'completed') {
        hooks.onProgress?.(total, total);
        return { file: result.file };
      }
      const confirmed = Math.max(0, Math.min(result.offset, total));
      stalls = confirmed === start ? stalls + 1 : 0;
      if (stalls >= this.maxStalls)
        throw new ApiError('server', null, 'UPLOAD_STALLED', 'The server is not accepting data. Try again later.');
      offset = confirmed;
      hooks.onProgress?.(offset, total);
    }

    // All bytes confirmed but no completion payload: ask the server for the final state.
    const final = await this.api.status(sessionId, signal);
    if (final.status === 'completed') return { file: null };
    throw new ApiError('server', null, 'UPLOAD_INCOMPLETE', 'The server did not finish processing the upload.');
  }

  private throwIfCancelled(signal?: AbortSignal): void {
    if (signal?.aborted) throw new ApiError('cancelled', null, null, 'Cancelled.');
  }
}

// ---- real API over ApiClient --------------------------------------------------------------------

const initSchema = z.object({
  sessionId: z.string().min(1),
  chunkSize: z.number().int().positive(),
  offset: z.string().regex(/^\d+$/),
  status: z.enum(['uploading', 'completed']).optional(),
  file: fileSchema.optional(),
});

const chunkSchema = z.object({
  status: z.enum(['uploading', 'completed']),
  offset: z.string().regex(/^\d+$/),
  file: fileSchema.optional(),
});
const statusSchema = z.object({ status: z.enum(['uploading', 'completed', 'failed']), offset: z.string().regex(/^\d+$/) });

export function createUploadApi(client: ApiClient, chunkFetch?: typeof fetch): UploadApi {
  return {
    async init(spec, signal) {
      const r = await client.request({
        method: 'POST',
        path: '/uploads/resumable/init',
        body: {
          fileName: spec.fileName,
          mimeType: spec.mimeType || 'application/octet-stream',
          sizeBytes: String(spec.size),
          folderId: spec.folderId,
          targetAccountId: spec.targetAccountId ?? null,
          clientUploadId: spec.clientUploadId,
        },
        // Safe to repeat: the same clientUploadId never creates a second file.
        idempotent: true,
        schema: initSchema,
        signal,
      });
      return {
        sessionId: r.sessionId,
        chunkSize: r.chunkSize,
        offset: Number(r.offset),
        status: r.status ?? 'uploading',
        file: r.file ?? null,
      };
    },

    async status(sessionId, signal) {
      const r = await client.request({ path: `/uploads/resumable/status/${encodeURIComponent(sessionId)}`, schema: statusSchema, signal });
      return { status: r.status, offset: Number(r.offset) };
    },

    async putChunk(sessionId, body, range, signal) {
      const r = await client.request({
        method: 'PUT',
        path: `/uploads/resumable/chunk/${encodeURIComponent(sessionId)}`,
        rawBody: body,
        headers: { 'Content-Range': `bytes ${range.start}-${range.end}/${range.total}`, 'Content-Type': 'application/octet-stream' },
        schema: chunkSchema,
        signal,
        timeoutMs: 120_000,
        // The runner owns retry because a failed chunk must be reconciled with the server offset first.
        retry: { maxRetries: 0 },
        fetchImpl: chunkFetch,
      });
      return { status: r.status, offset: Number(r.offset), file: r.file ?? null };
    },
  };
}
