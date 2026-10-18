/**
 * `terabox_open` — adapter for the official TeraBox Open Platform.
 *
 * Contract: docs/terabox-integration-assessment.md §2/§3 (verified against
 * https://www.terabox.com/integrations/docs?lang=en). This adapter is entirely
 * separate from the cookie-session `terabox` adapter and never uses cookies.
 *
 * Scope: only files inside the application's own TeraBox folder are reachable
 * (official namespace restriction). `remoteId` is the path relative to that
 * folder. Operations the document does not describe (create-folder, share
 * creation, resumable upload, range download) are NOT declared as capabilities
 * and throw `ERR_CAPABILITY_UNSUPPORTED`.
 */

import { ProviderError, isRetryableProviderError } from '../errors.js';
import { mapErrorToHealthState } from '../health.js';
import { registry } from '../registry.js';
import type {
  AccountInfo,
  Capability,
  CopyInput,
  CreateFolderInput,
  CreateShareInput,
  DeleteInput,
  DownloadInput,
  DownloadResult,
  GetMetadataInput,
  HealthResult,
  ListInput,
  ListResult,
  MoveInput,
  ProviderContext,
  QuotaInfo,
  RemoteFileMeta,
  RenameInput,
  ShareResult,
  StorageProvider,
  UploadInput,
  UploadResult,
} from '../types.js';
import { fetchTokenInfo } from './auth.js';
import { TeraBoxOpenClient } from './client.js';
import { mapTeraBoxErrno } from './errors.js';
import './oauth2.js';
import { baseName, fromWirePath, joinPath, normalizeRelativePath, parentOf, toWirePath, validateFileName } from './paths.js';
import { Semaphore, spoolUpload, uploadConcurrencyLimit } from './spool.js';

export const TERABOX_OPEN_ID = 'terabox_open';

export const TERABOX_OPEN_CAPABILITIES: readonly Capability[] = [
  'authenticate',
  'getAccountInfo',
  'getQuota',
  'upload',
  'download',
  'list',
  'getMetadata',
  'search',
  'rename',
  'move',
  'copy',
  'delete',
  'healthCheck',
];

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 200;
const SHARD_ATTEMPTS = 3;
const SHARD_BACKOFF_MS = 500;

let uploadSemaphore = new Semaphore(uploadConcurrencyLimit());

/** Test seam: rebuild the upload semaphore after changing TERABOX_UPLOAD_CONCURRENCY. */
export function resetUploadSemaphore(): void {
  uploadSemaphore = new Semaphore(uploadConcurrencyLimit());
}

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : {};
}

function toBigInt(value: unknown, label: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^\d{1,20}$/.test(value)) return BigInt(value);
  throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', `TeraBox returned an invalid ${label}`);
}

function isoFromSeconds(value: unknown): string | null {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ProviderError('ERR_TIMEOUT', 'operation cancelled', { retryable: false }));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ProviderError('ERR_TIMEOUT', 'operation cancelled', { retryable: false }));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function mapEntry(raw: unknown): RemoteFileMeta {
  const item = asRecord(raw);
  const wirePath = typeof item.path === 'string' ? item.path : '';
  if (wirePath === '') throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'TeraBox returned an entry without a path');
  const relative = fromWirePath(wirePath);
  const isFolder = Number(item.isdir) === 1;
  const name =
    (typeof item.server_filename === 'string' && item.server_filename) ||
    (typeof item.filename === 'string' && item.filename) ||
    baseName(relative);
  return {
    remoteId: relative,
    name,
    mimeType: isFolder ? 'inode/directory' : 'application/octet-stream',
    sizeBytes: isFolder ? 0n : toBigInt(item.size ?? item.file_size ?? 0, 'size'),
    parentId: parentOf(relative),
    isFolder,
    createdAt: isoFromSeconds(item.server_ctime) ?? isoFromSeconds(item.local_ctime),
    modifiedAt: isoFromSeconds(item.server_mtime) ?? isoFromSeconds(item.local_mtime),
    checksum: typeof item.md5 === 'string' && item.md5 !== '' ? item.md5 : null,
    webUrl: null,
  };
}

export class TeraBoxOpenProvider implements StorageProvider {
  readonly id = TERABOX_OPEN_ID;
  readonly displayName = 'TeraBox (official Open Platform)';
  readonly authMode = 'oauth2' as const;
  readonly capabilities: ReadonlySet<Capability> = new Set(TERABOX_OPEN_CAPABILITIES);

  getCapabilities(): ReadonlySet<Capability> {
    return this.capabilities;
  }

  private gate(capability: Capability): void {
    if (!this.capabilities.has(capability)) {
      throw new ProviderError('ERR_CAPABILITY_UNSUPPORTED', `provider '${this.id}' does not declare capability '${capability}'`);
    }
  }

  private async client(ctx: ProviderContext): Promise<TeraBoxOpenClient> {
    if (ctx.credentials.kind !== 'oauth2' || !ctx.credentials.accessToken) {
      throw new ProviderError('ERR_AUTH_EXPIRED', 'TeraBox requires OAuth credentials');
    }
    return TeraBoxOpenClient.create({ accessToken: ctx.credentials.accessToken, signal: ctx.signal });
  }

  async getAccountInfo(ctx: ProviderContext): Promise<AccountInfo> {
    this.gate('getAccountInfo');
    const client = await this.client(ctx);
    let displayName: string | null = null;
    let avatarUrl: string | null = null;
    try {
      const body = await client.api('/openapi/uinfo');
      displayName = typeof body.uname === 'string' ? body.uname : null;
      avatarUrl = typeof body.avatar_url === 'string' ? body.avatar_url : null;
    } catch (error) {
      // The stable id comes from tokeninfo; the profile is cosmetic. Auth failures still surface.
      if (ProviderError.is(error) && (error.code === 'ERR_AUTH_EXPIRED' || error.code === 'ERR_AUTH_REVOKED')) throw error;
      ctx.logger('terabox_open profile lookup failed', { code: ProviderError.is(error) ? error.code : 'unknown' });
    }
    return { providerAccountId: client.info.userId, email: null, displayName, avatarUrl };
  }

  async getQuota(ctx: ProviderContext): Promise<QuotaInfo> {
    this.gate('getQuota');
    const client = await this.client(ctx);
    const body = await client.api('/openapi/api/quota');
    if (body.total === undefined || body.used === undefined) {
      throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'TeraBox quota response was incomplete');
    }
    const total = toBigInt(body.total, 'quota total');
    const used = toBigInt(body.used, 'quota used');
    return {
      totalBytes: total,
      usedBytes: used,
      availableBytes: total > used ? total - used : 0n,
      trashBytes: null,
    };
  }

  async list(ctx: ProviderContext, input: ListInput): Promise<ListResult> {
    this.gate('list');
    const client = await this.client(ctx);
    const page = decodePage(input.cursor);
    const num = clampLimit(input.limit);
    const body = await client.api('/openapi/api/list', {
      query: { dir: toWirePath(input.parentId ?? '/'), page, num, order: 'name', desc: 0 },
    });
    // The doc's parameter table says `info`, its example says `list`; accept either.
    const rows = Array.isArray(body.list) ? body.list : Array.isArray(body.info) ? body.info : [];
    const entries = rows.filter((row) => typeof asRecord(row).path === 'string').map(mapEntry);
    return { entries, nextCursor: rows.length >= num ? String(page + 1) : null };
  }

  async search(ctx: ProviderContext, input: { query: string; cursor?: string | null; limit?: number }): Promise<ListResult> {
    this.gate('search');
    const key = input.query?.trim();
    if (!key) throw new ProviderError('ERR_INVALID_INPUT', 'search query is required');
    const client = await this.client(ctx);
    const page = decodePage(input.cursor);
    const num = clampLimit(input.limit);
    const body = await client.api('/openapi/api/search', { query: { key, recursion: 1, page, num } });
    const rows = Array.isArray(body.list) ? body.list : [];
    const entries = rows.filter((row) => typeof asRecord(row).path === 'string').map(mapEntry);
    return { entries, nextCursor: Number(body.has_more) === 1 ? String(page + 1) : null };
  }

  async getMetadata(ctx: ProviderContext, input: GetMetadataInput): Promise<RemoteFileMeta> {
    this.gate('getMetadata');
    const client = await this.client(ctx);
    return this.metadataFor(client, input.remoteId);
  }

  private async metadataFor(client: TeraBoxOpenClient, remoteId: string): Promise<RemoteFileMeta> {
    const relative = normalizeRelativePath(remoteId);
    if (relative === '/') {
      return {
        remoteId: '/',
        name: '',
        mimeType: 'inode/directory',
        sizeBytes: 0n,
        parentId: null,
        isFolder: true,
        webUrl: null,
      };
    }
    const body = await client.api('/openapi/api/filemetas', {
      query: { target: JSON.stringify([toWirePath(relative)]), dlink: 0 },
    });
    const rows = Array.isArray(body.info) ? body.info : [];
    const item = asRecord(rows[0]);
    if (rows.length === 0) throw new ProviderError('ERR_NOT_FOUND', 'File or folder not found in the TeraBox application folder');
    const itemErrno = Number(item.errno ?? 0);
    if (itemErrno !== 0) throw mapTeraBoxErrno(itemErrno, item);
    return mapEntry({ ...item, path: typeof item.path === 'string' ? item.path : toWirePath(relative) });
  }

  async createFolder(_ctx: ProviderContext, _input: CreateFolderInput): Promise<RemoteFileMeta> {
    this.gate('createFolder');
    throw new ProviderError('ERR_CAPABILITY_UNSUPPORTED', 'unreachable');
  }

  async rename(ctx: ProviderContext, input: RenameInput): Promise<RemoteFileMeta> {
    this.gate('rename');
    const source = this.requireNonRoot(input.remoteId);
    const newName = validateFileName(input.newName);
    const client = await this.client(ctx);
    await this.fileManager(client, 'rename', [{ path: toWirePath(source), newname: newName }]);
    return this.metadataFor(client, joinPath(parentOf(source), newName));
  }

  async move(ctx: ProviderContext, input: MoveInput): Promise<RemoteFileMeta> {
    this.gate('move');
    const source = this.requireNonRoot(input.remoteId);
    const destParent = input.newParentId === null ? '/' : normalizeRelativePath(input.newParentId);
    if (destParent === source || destParent.startsWith(`${source}/`)) {
      throw new ProviderError('ERR_INVALID_INPUT', 'cannot move a folder into itself');
    }
    const name = baseName(source);
    const client = await this.client(ctx);
    await this.fileManager(client, 'move', [{ path: toWirePath(source), dest: toWirePath(destParent), newname: name }]);
    return this.metadataFor(client, joinPath(destParent === '/' ? null : destParent, name));
  }

  async copy(ctx: ProviderContext, input: CopyInput): Promise<RemoteFileMeta> {
    this.gate('copy');
    const source = this.requireNonRoot(input.remoteId);
    const destParent = input.newParentId === null ? '/' : normalizeRelativePath(input.newParentId);
    if (destParent === source || destParent.startsWith(`${source}/`)) {
      throw new ProviderError('ERR_INVALID_INPUT', 'cannot copy a folder into itself');
    }
    const name = input.newName === undefined ? baseName(source) : validateFileName(input.newName);
    const client = await this.client(ctx);
    await this.fileManager(client, 'copy', [{ path: toWirePath(source), dest: toWirePath(destParent), newname: name }]);
    return this.metadataFor(client, joinPath(destParent === '/' ? null : destParent, name));
  }

  async delete(ctx: ProviderContext, input: DeleteInput): Promise<void> {
    this.gate('delete');
    // `permanent` is accepted but cannot be honoured: the document does not say whether
    // delete is recoverable. Callers must not assume either behaviour.
    const source = this.requireNonRoot(input.remoteId);
    const client = await this.client(ctx);
    await this.fileManager(client, 'delete', [toWirePath(source)]);
  }

  private requireNonRoot(remoteId: string): string {
    const relative = normalizeRelativePath(remoteId);
    if (relative === '/') throw new ProviderError('ERR_INVALID_INPUT', 'the application root cannot be modified');
    return relative;
  }

  private async fileManager(
    client: TeraBoxOpenClient,
    opera: 'copy' | 'move' | 'rename' | 'delete',
    filelist: unknown[],
  ): Promise<void> {
    const body = await client.api('/openapi/api/filemanager', {
      method: 'POST',
      query: { opera, async: 0 },
      form: { filelist: JSON.stringify(filelist) },
    });
    const info = Array.isArray(body.info) ? body.info : [];
    for (const row of info) {
      const code = Number(asRecord(row).errno ?? 0);
      if (code !== 0) throw mapTeraBoxErrno(code, row);
    }
  }

  async download(ctx: ProviderContext, input: DownloadInput): Promise<DownloadResult> {
    this.gate('download');
    if (input.range) this.gate('downloadRange');
    const client = await this.client(ctx);
    const meta = await this.metadataFor(client, input.remoteId);
    if (meta.isFolder) throw new ProviderError('ERR_INVALID_INPUT', 'cannot download a folder');
    const fsId = await this.fsIdOf(client, meta.remoteId);
    const body = await client.api('/openapi/api/download', { query: { fidlist: `[${fsId}]`, type: 'dlink' } });
    const dlinks = Array.isArray(body.dlink) ? body.dlink : [];
    const link = asRecord(dlinks[0]).dlink;
    if (typeof link !== 'string' || link === '') {
      throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'TeraBox returned no download link');
    }
    const response = await client.openDownload(link);
    const length = Number(response.headers['content-length']);
    return {
      stream: response.body,
      sizeBytes: Number.isFinite(length) && length >= 0 ? BigInt(length) : meta.sizeBytes,
      mimeType: null,
    };
  }

  private async fsIdOf(client: TeraBoxOpenClient, relative: string): Promise<string> {
    const body = await client.api('/openapi/api/filemetas', {
      query: { target: JSON.stringify([toWirePath(relative)]), dlink: 0 },
    });
    const item = asRecord((Array.isArray(body.info) ? body.info : [])[0]);
    const raw = item.fs_id;
    const value = typeof raw === 'string' ? Number(raw) : raw;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
      throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'TeraBox returned an unusable file id');
    }
    return String(value);
  }

  async upload(ctx: ProviderContext, input: UploadInput): Promise<UploadResult> {
    this.gate('upload');
    if (input.resumeToken) this.gate('uploadResumable');
    const name = validateFileName(input.fileName);
    if (!input.stream || typeof (input.stream as { pipe?: unknown }).pipe !== 'function') {
      throw new ProviderError('ERR_INVALID_INPUT', 'upload stream is required');
    }
    if (typeof input.sizeBytes !== 'bigint' || input.sizeBytes < 0n || input.sizeBytes > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new ProviderError('ERR_INVALID_INPUT', 'sizeBytes must be a non-negative safe integer');
    }
    if (input.sizeBytes === 0n) {
      // The documented flow defines no empty-shard behaviour; refusing is safer than guessing.
      throw new ProviderError('ERR_INVALID_INPUT', 'zero-byte files are not supported by the TeraBox Open Platform upload flow', {
        retryable: false,
      });
    }
    const size = Number(input.sizeBytes);
    const target = joinPath(input.parentId, name);
    const wirePath = toWirePath(target);

    const release = await uploadSemaphore.acquire(ctx.signal);
    let spooled: Awaited<ReturnType<typeof spoolUpload>> | null = null;
    try {
      // Authenticate before staging so an expired account fails without consuming disk.
      const client = await this.client(ctx);
      spooled = await spoolUpload(input.stream, size, ctx.signal);

      const pre = await client.api('/openapi/api/precreate', {
        method: 'POST',
        form: { path: wirePath, autoinit: 1, block_list: JSON.stringify(spooled.shardMd5s) },
      });
      if (Number(pre.return_type) === 2) {
        // "The file already exists in the cloud, upload completed" (official doc).
        const existing = asRecord(pre.info);
        return {
          remoteId: fromWirePath(typeof existing.path === 'string' ? existing.path : wirePath),
          sizeBytes: toBigInt(existing.size ?? size, 'size'),
          resumeToken: null,
        };
      }
      const uploadId = typeof pre.uploadid === 'string' ? pre.uploadid : '';
      if (uploadId === '') throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'TeraBox did not return an upload id');

      const indices = shardIndices(pre.block_list, spooled.shardMd5s.length);
      for (const index of indices) {
        await this.sendShard(client, ctx, spooled, wirePath, uploadId, index);
      }

      // `create` is never retried automatically: with rtype=1 a replay after a lost response
      // would create "name(1)". The caller decides whether to re-run the whole upload.
      const created = await client.api('/openapi/api/create', {
        method: 'POST',
        form: {
          path: wirePath,
          size,
          uploadid: uploadId,
          block_list: JSON.stringify(spooled.shardMd5s),
          rtype: 1,
        },
      });
      const createdSize = created.size === undefined ? size : Number(created.size);
      if (createdSize !== size) {
        throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'TeraBox stored a different size than uploaded', {
          retryable: false,
          detail: { expected: size, actual: createdSize },
        });
      }
      if (typeof created.md5 === 'string' && /^[0-9a-f]{32}$/i.test(created.md5) && created.md5.toLowerCase() !== spooled.fileMd5) {
        // Informational only: the per-shard md5 echo above already proved the bytes.
        ctx.logger('terabox_open whole-file md5 differs from local digest', {});
      }
      return {
        remoteId: fromWirePath(typeof created.path === 'string' ? created.path : wirePath),
        sizeBytes: BigInt(size),
        resumeToken: null,
      };
    } finally {
      if (spooled) await spooled.cleanup();
      release();
    }
  }

  private async sendShard(
    client: TeraBoxOpenClient,
    ctx: ProviderContext,
    spooled: Awaited<ReturnType<typeof spoolUpload>>,
    wirePath: string,
    uploadId: string,
    index: number,
  ): Promise<void> {
    const data = await spooled.readShard(index);
    let lastError: unknown = null;
    for (let attempt = 0; attempt < SHARD_ATTEMPTS; attempt++) {
      try {
        const echoed = await client.uploadShard({ path: wirePath, uploadId, partSeq: index, data });
        if (echoed === spooled.shardMd5s[index]) return;
        lastError = new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'TeraBox shard md5 did not match the local digest');
      } catch (error) {
        // Shards are idempotent per (uploadid, partseq); only transient failures are replayed.
        if (!isRetryableProviderError(error)) throw error;
        lastError = error;
      }
      if (attempt < SHARD_ATTEMPTS - 1) await sleep(SHARD_BACKOFF_MS * 2 ** attempt, ctx.signal);
    }
    throw lastError instanceof Error ? lastError : new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'shard upload failed');
  }

  async createShare(_ctx: ProviderContext, _input: CreateShareInput): Promise<ShareResult> {
    this.gate('createShare');
    throw new ProviderError('ERR_CAPABILITY_UNSUPPORTED', 'unreachable');
  }

  async healthCheck(ctx: ProviderContext): Promise<HealthResult> {
    const started = Date.now();
    try {
      if (ctx.credentials.kind !== 'oauth2') throw new ProviderError('ERR_AUTH_EXPIRED', 'TeraBox requires OAuth credentials');
      await fetchTokenInfo(ctx.credentials.accessToken, ctx.signal);
      return { state: 'healthy', latencyMs: Date.now() - started, message: null, checkedAt: new Date().toISOString() };
    } catch (error) {
      return {
        state: mapErrorToHealthState(error),
        latencyMs: Date.now() - started,
        message: ProviderError.is(error) ? error.message : 'health check failed',
        checkedAt: new Date().toISOString(),
      };
    }
  }
}

function decodePage(cursor: string | null | undefined): number {
  if (cursor === undefined || cursor === null || cursor === '') return 1;
  if (!/^\d{1,9}$/.test(cursor) || Number(cursor) < 1) throw new ProviderError('ERR_INVALID_INPUT', 'invalid pagination cursor');
  return Number(cursor);
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1) throw new ProviderError('ERR_INVALID_INPUT', 'invalid page size');
  return Math.min(limit, MAX_PAGE_SIZE);
}

/** Shards TeraBox asks for; defaults to all of them, rejects out-of-range indices. */
function shardIndices(raw: unknown, count: number): number[] {
  if (!Array.isArray(raw) || raw.length === 0) return Array.from({ length: count }, (_, i) => i);
  const seen = new Set<number>();
  for (const value of raw) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0 || n >= count) {
      throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'TeraBox requested an invalid shard index');
    }
    seen.add(n);
  }
  return [...seen].sort((a, b) => a - b);
}

export const teraboxOpenProvider = new TeraBoxOpenProvider();

export function createTeraBoxOpenProvider(): TeraBoxOpenProvider {
  return new TeraBoxOpenProvider();
}

export function registerTeraBoxOpenProvider(): void {
  registry.registerAdapter(teraboxOpenProvider);
}
