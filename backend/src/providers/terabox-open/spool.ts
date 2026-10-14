/**
 * Upload spooling for the official TeraBox flow.
 *
 * `precreate` requires the md5 of EVERY shard before the first shard is sent
 * (official doc §3.4.1), which a one-shot stream cannot provide. The input is
 * therefore streamed (with backpressure) into a private temp file while shard
 * md5s and the whole-file md5 are computed; shards are then sent from disk,
 * one 4 MiB buffer at a time. The temp directory is mode 0700, the file 0600,
 * and both are removed by `cleanup()` (call it in `finally`) — nothing persists.
 * Location: `UPLOAD_SPOOL_DIR` (the same volume the upload routes use).
 *
 * Disk use per in-flight upload = file size, bounded by the semaphore below
 * (`TERABOX_UPLOAD_CONCURRENCY`, default 2).
 */

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ProviderError } from '../errors.js';

/** Shard size. The doc requires shards above 4 MB (except the last); 4 MiB satisfies it. */
export const SHARD_BYTES = 4 * 1024 * 1024;

export interface SpooledUpload {
  filePath: string;
  sizeBytes: number;
  shardMd5s: string[];
  fileMd5: string;
  readShard(index: number): Promise<Buffer>;
  cleanup(): Promise<void>;
}

class ShardHasher extends Transform {
  readonly shardMd5s: string[] = [];
  readonly whole = createHash('md5');
  total = 0;
  private current = createHash('md5');
  private inShard = 0;

  constructor(private readonly expected: number) {
    super();
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null, data?: Buffer) => void): void {
    this.total += chunk.length;
    if (this.total > this.expected) {
      cb(new ProviderError('ERR_INVALID_INPUT', 'upload stream is longer than the declared size', { retryable: false }));
      return;
    }
    this.whole.update(chunk);
    let offset = 0;
    while (offset < chunk.length) {
      const room = SHARD_BYTES - this.inShard;
      const take = Math.min(room, chunk.length - offset);
      this.current.update(chunk.subarray(offset, offset + take));
      this.inShard += take;
      offset += take;
      if (this.inShard === SHARD_BYTES) this.closeShard();
    }
    cb(null, chunk);
  }

  override _flush(cb: (err?: Error | null) => void): void {
    if (this.total !== this.expected) {
      cb(new ProviderError('ERR_INVALID_INPUT', 'upload stream is shorter than the declared size', { retryable: false }));
      return;
    }
    if (this.inShard > 0) this.closeShard();
    cb();
  }

  private closeShard(): void {
    this.shardMd5s.push(this.current.digest('hex'));
    this.current = createHash('md5');
    this.inShard = 0;
  }
}

/** Same directory the upload routes spool to (a volume in docker-compose); never the container's /tmp by default. */
export function spoolBaseDir(): string {
  return process.env.UPLOAD_SPOOL_DIR?.trim() || join(tmpdir(), '9drive-spool');
}

export async function spoolUpload(
  source: NodeJS.ReadableStream,
  sizeBytes: number,
  signal?: AbortSignal,
): Promise<SpooledUpload> {
  const base = spoolBaseDir();
  await mkdir(base, { recursive: true, mode: 0o700 }).catch(() => undefined);
  const dir = await mkdtemp(join(base, '9drive-tb-'), { encoding: 'utf8' });
  const filePath = join(dir, 'payload');
  const cleanup = async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  };
  try {
    const hasher = new ShardHasher(sizeBytes);
    await pipeline(
      source as NodeJS.ReadableStream,
      hasher,
      createWriteStream(filePath, { mode: 0o600 }),
      signal ? { signal } : {},
    );
    return {
      filePath,
      sizeBytes,
      shardMd5s: hasher.shardMd5s,
      fileMd5: hasher.whole.digest('hex'),
      async readShard(index: number): Promise<Buffer> {
        const start = index * SHARD_BYTES;
        const end = Math.min(start + SHARD_BYTES, sizeBytes) - 1;
        if (start >= sizeBytes) throw new ProviderError('ERR_INTERNAL', 'shard index out of range');
        const chunks: Buffer[] = [];
        for await (const chunk of createReadStream(filePath, { start, end })) chunks.push(chunk as Buffer);
        return Buffer.concat(chunks);
      },
      cleanup,
    };
  } catch (error) {
    await cleanup();
    if (ProviderError.is(error)) throw error;
    if ((error as { name?: string }).name === 'AbortError') {
      throw new ProviderError('ERR_TIMEOUT', 'upload was cancelled', { cause: error, retryable: false });
    }
    throw new ProviderError('ERR_INTERNAL', 'failed to stage upload', { cause: error });
  }
}

/** Bounded concurrency for staged uploads (disk and upstream protection). */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      throw new ProviderError('ERR_TIMEOUT', 'upload cancelled while queued', { retryable: false });
    }
    if (this.active < this.limit) {
      this.active += 1;
      return () => this.release();
    }
    // The releasing holder hands its slot over directly, so `active` never exceeds `limit`.
    await new Promise<void>((resolve, reject) => {
      const grant = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => {
        const idx = this.waiters.indexOf(grant);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new ProviderError('ERR_TIMEOUT', 'upload cancelled while queued', { retryable: false }));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(grant);
    });
    return () => this.release();
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.active -= 1;
  }
}

export function uploadConcurrencyLimit(): number {
  const raw = Number(process.env.TERABOX_UPLOAD_CONCURRENCY ?? 2);
  return Number.isInteger(raw) && raw >= 1 && raw <= 16 ? raw : 2;
}
