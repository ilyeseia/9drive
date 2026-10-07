/**
 * TeraBox storage adapter — provider-contract §4 (StorageProvider) and §11.
 *
 * Auth is the web session cookie (`ndus` / `STOKEN`): the `apiKey` credential
 * field stores either the bare `ndus` value or a whole cookie header, and the
 * client normalises it. The API itself is reverse-engineered (no official
 * self-serve surface), so every request shape is documented in
 * docs/architecture/providers/terabox.md §4 and mirrors the two live-tested
 * reference implementations.
 *
 * Importing this module has no side effects; `registerTeraBoxProvider()` puts
 * the adapter on the shared registry (§6).
 *
 * Quirks: `remoteId` is the POSIX path (`/`, `/dir/file.txt`) because TeraBox
 * has no public object ids in its list responses; the root folder and direct
 * children of it report `parentId: null` (Dropbox parity); `delete(permanent)`
 * is accepted and ignored — TeraBox only offers the shared recycle bin;
 * uploads are always overwrite (`rtype=3`) and stream in 4 MiB chunks with
 * per-chunk md5 verification; shares are not supported by the cookie API.
 */

import { createHash } from 'node:crypto';
import { ProviderError } from '../errors.js';
import { mapErrorToHealthState } from '../health.js';
import { registry } from '../registry.js';
import {
  ALL_CAPABILITIES,
  type AccountInfo,
  type AuthMode,
  type Capability,
  type CopyInput,
  type CreateFolderInput,
  type CreateShareInput,
  type DeleteInput,
  type DownloadInput,
  type DownloadResult,
  type GetMetadataInput,
  type HealthResult,
  type ListInput,
  type ListResult,
  type MoveInput,
  type ProviderContext,
  type ProviderId,
  type QuotaInfo,
  type RemoteFileMeta,
  type RenameInput,
  type RevokeShareInput,
  type ShareResult,
  type StorageProvider,
  type UploadInput,
  type UploadResult,
} from '../types.js';
import {
  TRANSFER_TIMEOUT_MS,
  TeraBoxClient,
  buildMultipartBody,
  gatedDownload,
  readBodyText,
  parseJson,
} from './client.js';
import { isTeraBoxConflict, mapTeraBoxErrno } from './errors.js';
import { controlMd5, decodeMd5, signDownload } from './sign.js';

const FILE_MIME_TYPE = 'application/octet-stream';
const FOLDER_MIME_TYPE = 'inode/directory';
const ROOT_PATH = '/';
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1000;
const CHUNK_UPLOAD_ATTEMPTS = 3;
const TASK_POLL_ATTEMPTS = 3;
/** Free-tier chunk size (rclone `getChunkSize`): 4 MiB regardless of file size. */
export const TERABOX_CHUNK_BYTES = 4 * 1024 * 1024;
const FREE_TIER_MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024;
const PREMIUM_MAX_FILE_BYTES = 128 * 1024 * 1024 * 1024;
/** Placeholder block_list entries both reference clients send at precreate. */
const PRECREATE_BLOCK_1 = '5910a591dd8fc18c32a8f3df4fdc1761';
const PRECREATE_BLOCK_2 = 'a5fc157d78e6ad1c7e114b056c92821e';

/** TeraBox exposes no share API over the cookie session. */
export const TERABOX_CAPABILITIES: readonly Capability[] = ALL_CAPABILITIES.filter(
  (capability) => capability !== 'uploadResumable' && capability !== 'createShare' && capability !== 'revokeShare',
);

interface TeraBoxItem {
  fs_id?: number | string;
  server_filename?: string;
  filename?: string;
  path?: string;
  md5?: string;
  size?: number;
  isdir?: number;
  server_ctime?: number;
  server_mtime?: number;
  dlink?: string;
}

interface TeraBoxMetaResult {
  item: TeraBoxItem;
  meta: RemoteFileMeta;
}

export interface TeraBoxProviderOptions {
  capabilities?: Iterable<Capability>;
}

/** Leading slash, no trailing slash, `/` for empty. */
export function tbPath(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  const withSlash = raw === '' ? ROOT_PATH : raw.startsWith('/') ? raw : `/${raw}`;
  return withSlash.length > 1 && withSlash.endsWith('/') ? withSlash.slice(0, -1) : withSlash;
}

/** Parent path of a path; `/` and direct children of the root map to null. */
export function parentOf(path: string): string | null {
  const normalized = tbPath(path);
  if (normalized === ROOT_PATH) return null;
  const separator = normalized.lastIndexOf('/');
  return separator <= 0 ? null : normalized.slice(0, separator);
}

function joinPath(parentPath: string, name: string): string {
  const base = parentPath === ROOT_PATH ? '' : parentPath;
  return `${base}/${name}`;
}

function requireRemoteId(value: unknown): string {
  const remoteId = typeof value === 'string' ? value.trim() : '';
  if (!remoteId) throw new ProviderError('ERR_INVALID_INPUT', 'remoteId is required');
  return remoteId;
}

function requireEntryName(value: unknown, field: string): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) throw new ProviderError('ERR_INVALID_INPUT', `${field} is required`);
  if (name.includes('/')) throw new ProviderError('ERR_INVALID_INPUT', `${field} must not contain '/'`);
  if (name === '.' || name === '..') throw new ProviderError('ERR_INVALID_INPUT', `${field} is not a valid name`);
  return name;
}

function normalizeParentId(parentId: unknown): string {
  if (parentId === undefined || parentId === null || parentId === ROOT_PATH || parentId === '') return ROOT_PATH;
  if (typeof parentId !== 'string' || parentId.trim() === '') {
    throw new ProviderError('ERR_INVALID_INPUT', 'parentId must be a string or null');
  }
  return tbPath(parentId);
}

function assertRange(range: { start: number; end?: number } | null | undefined): void {
  if (!range) return;
  if (!Number.isInteger(range.start) || range.start < 0) {
    throw new ProviderError('ERR_INVALID_INPUT', 'range start must be a non-negative integer');
  }
  if (range.end !== undefined && (!Number.isInteger(range.end) || range.end < range.start)) {
    throw new ProviderError('ERR_INVALID_INPUT', 'range end must not precede range start');
  }
}

function positiveLimit(limit: unknown): number {
  const value = limit ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new ProviderError('ERR_INVALID_INPUT', 'limit must be a positive integer');
  }
  return value as number;
}

function pageFromCursor(cursor: unknown): number {
  if (cursor === undefined || cursor === null || cursor === '') return 1;
  const page = typeof cursor === 'string' && /^\d{1,9}$/.test(cursor) ? Number(cursor) : NaN;
  if (!Number.isInteger(page) || page < 1) {
    throw new ProviderError('ERR_INVALID_INPUT', 'invalid pagination cursor');
  }
  return page;
}

function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value < 0n ? value : value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.max(0, Math.round(value)));
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  return 0n;
}

function timestampIso(seconds: unknown): string | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null;
  const date = new Date(Math.round(seconds) * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function itemToMeta(item: TeraBoxItem, knownParent?: string | null): RemoteFileMeta {
  const path = tbPath(item?.path ?? '');
  const isFolder = item?.isdir === 1;
  const fallbackName = path === ROOT_PATH ? '' : (path.slice(path.lastIndexOf('/') + 1) || '');
  return {
    remoteId: path,
    name: item?.server_filename ?? item?.filename ?? fallbackName,
    mimeType: isFolder ? FOLDER_MIME_TYPE : FILE_MIME_TYPE,
    sizeBytes: isFolder ? 0n : toBigInt(item?.size ?? 0),
    parentId: knownParent !== undefined ? knownParent : parentOf(path),
    isFolder,
    createdAt: timestampIso(item?.server_ctime),
    modifiedAt: timestampIso(item?.server_mtime) ?? timestampIso(item?.server_ctime),
    checksum: typeof item?.md5 === 'string' && item.md5 !== '' ? item.md5 : null,
    webUrl: null,
  };
}

function rootFolderMeta(): RemoteFileMeta {
  return {
    remoteId: ROOT_PATH,
    name: '',
    mimeType: FOLDER_MIME_TYPE,
    sizeBytes: 0n,
    parentId: null,
    isFolder: true,
    createdAt: null,
    modifiedAt: null,
    checksum: null,
    webUrl: null,
  };
}

function synthesizedFolder(path: string): RemoteFileMeta {
  const meta = itemToMeta({ path, isdir: 1 }, parentOf(path));
  return { ...meta, name: path === ROOT_PATH ? '' : path.slice(path.lastIndexOf('/') + 1) };
}

/** Directory part of a file path, with the trailing slash the API expects. */
function targetDirOf(path: string): string {
  const normalized = tbPath(path);
  const separator = normalized.lastIndexOf('/');
  return normalized.slice(0, separator + 1) || ROOT_PATH;
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function* streamChunks(
  stream: AsyncIterable<Buffer | string>,
  chunkSize: number,
): AsyncGenerator<Buffer> {
  const buffers: Buffer[] = [];
  let size = 0;
  for await (const raw of stream) {
    const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    buffers.push(buffer);
    size += buffer.byteLength;
    while (size >= chunkSize) {
      const merged = Buffer.concat(buffers, size);
      yield merged.subarray(0, chunkSize);
      buffers.length = 0;
      const rest = merged.byteLength - chunkSize;
      if (rest > 0) {
        buffers.push(merged.subarray(chunkSize));
        size = rest;
      } else {
        size = 0;
      }
    }
  }
  if (size > 0) yield Buffer.concat(buffers, size);
}

function headerString(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  const text = Array.isArray(value) ? (value[0] ?? '') : value;
  return text === '' ? null : text;
}

function parseContentRange(value: string | null): { start: number; end: number; total: number | null } | null {
  if (!value) return null;
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/.exec(value.trim());
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = match[3] === '*' ? null : Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
  return { start, end, total: total !== null && Number.isSafeInteger(total) ? total : null };
}

export class TeraBoxProvider implements StorageProvider {
  readonly id: ProviderId = 'terabox';
  readonly displayName = 'TeraBox';
  readonly authMode: AuthMode = 'api_key';
  readonly capabilities: ReadonlySet<Capability>;

  constructor(options: TeraBoxProviderOptions = {}) {
    this.capabilities = new Set(options.capabilities ?? TERABOX_CAPABILITIES);
  }

  getCapabilities(): ReadonlySet<Capability> {
    return this.capabilities;
  }

  #require(capability: Capability): void {
    if (!this.capabilities.has(capability)) {
      throw new ProviderError(
        'ERR_CAPABILITY_UNSUPPORTED',
        `provider '${this.id}' does not declare capability '${capability}'`,
      );
    }
  }

  async #client(ctx: ProviderContext): Promise<TeraBoxClient> {
    if (ctx.credentials.kind !== 'api_key') {
      throw new ProviderError(
        'ERR_INVALID_INPUT',
        `provider '${this.id}' requires api_key credentials, received '${ctx.credentials.kind}'`,
      );
    }
    return new TeraBoxClient({ cookie: ctx.credentials.apiKey, signal: ctx.signal, logger: ctx.logger });
  }

  /** `filemetas` by path; `dlink` opts into the temporary download link field. */
  async #fetchMeta(client: TeraBoxClient, path: string, dlink = false): Promise<TeraBoxMetaResult> {
    const normalized = tbPath(path);
    if (normalized === ROOT_PATH) return { item: { path: ROOT_PATH, isdir: 1 }, meta: rootFolderMeta() };
    const data = await client.get<{ info?: Array<TeraBoxItem & { errno?: number }> }>(
      '/api/filemetas',
      { target: JSON.stringify([normalized]), dlink: dlink ? 1 : 0 },
      { preferInfoErrno: true },
    );
    const item = Array.isArray(data?.info) ? data.info[0] : undefined;
    if (!item || typeof item.path !== 'string' || item.path === '') {
      throw new ProviderError('ERR_NOT_FOUND', `path '${normalized}' was not found`);
    }
    return { item, meta: itemToMeta(item) };
  }

  /** `/api/filemanager` with jsToken acquisition and async-task polling. */
  async #filemanager(
    client: TeraBoxClient,
    opera: 'delete' | 'move' | 'rename' | 'copy',
    filelist: unknown,
    isCopy = false,
  ): Promise<void> {
    await client.ensureJsToken();
    const response = await client.postForm<{ taskid?: number; info?: Array<{ errno?: number }> }>(
      '/api/filemanager',
      {
        query: { opera, async: isCopy ? 2 : 1, onnest: 'fail' },
        form: { filelist: JSON.stringify(filelist) },
      },
    );
    if (typeof response?.taskid === 'number' && response.taskid > 0) {
      await this.#awaitTask(client, response.taskid);
      return;
    }
    for (const entry of response?.info ?? []) {
      const errno = entry?.errno;
      if (typeof errno === 'number' && errno !== 0) {
        throw mapTeraBoxErrno(errno, `TeraBox ${opera} failed`, entry);
      }
    }
  }

  async #awaitTask(client: TeraBoxClient, taskid: number): Promise<void> {
    for (let attempt = 0; attempt < TASK_POLL_ATTEMPTS; attempt++) {
      const response = await client.get<{ status?: string; list?: Array<{ error_code?: number }> }>(
        '/share/taskquery',
        { taskid },
      );
      if (response?.status === 'running') {
        await delay(attempt * 1_000);
        continue;
      }
      for (const entry of response?.list ?? []) {
        const code = entry?.error_code;
        if (typeof code === 'number' && code !== 0) {
          throw mapTeraBoxErrno(code, 'TeraBox async task failed', entry);
        }
      }
      return;
    }
    throw new ProviderError('ERR_TIMEOUT', 'TeraBox async operation did not finish in time');
  }

  async getAccountInfo(ctx: ProviderContext): Promise<AccountInfo> {
    this.#require('getAccountInfo');
    const client = await this.#client(ctx);
    const login = await client.get<{ errno?: number; uk?: number | string }>('/api/check/login');
    const uk = login?.uk;
    const providerAccountId = uk === undefined || uk === null ? '' : String(uk);
    if (providerAccountId === '') {
      throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'TeraBox returned no account id');
    }
    let displayName: string | null = null;
    if (/^\d+$/.test(providerAccountId)) {
      try {
        const info = await client.get<{ records?: Array<{ uname?: string }> }>('/api/user/getinfo', {
          user_list: JSON.stringify([Number(providerAccountId)]),
          need_relation: 0,
          need_secret_info: 1,
        });
        displayName = info?.records?.[0]?.uname ?? null;
      } catch (error) {
        if (ProviderError.is(error) && error.code === 'ERR_AUTH_EXPIRED') throw error;
        ctx.logger('TeraBox user info unavailable', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { providerAccountId, email: null, displayName, avatarUrl: null };
  }

  async getQuota(ctx: ProviderContext): Promise<QuotaInfo> {
    this.#require('getQuota');
    const client = await this.#client(ctx);
    const data = await client.get<{ total?: number; used?: number; free?: number }>(
      '/api/quota',
      { checkexpire: 1, checkfree: 1 },
    );
    const totalBytes = typeof data?.total === 'number' ? toBigInt(data.total) : null;
    const usedBytes = toBigInt(data?.used ?? 0);
    const availableBytes =
      typeof data?.free === 'number' ? toBigInt(data.free) : totalBytes !== null && totalBytes > usedBytes ? totalBytes - usedBytes : null;
    return {
      totalBytes,
      usedBytes,
      availableBytes,
      // TeraBox reports no trash total; the recycle bin shares one quota pool.
      trashBytes: null,
      raw: (data ?? {}) as Record<string, unknown>,
    };
  }

  async list(ctx: ProviderContext, input: ListInput): Promise<ListResult> {
    this.#require('list');
    const dir = normalizeParentId(input?.parentId);
    const take = Math.min(positiveLimit(input?.limit), MAX_PAGE_SIZE);
    const client = await this.#client(ctx);
    let page = pageFromCursor(input?.cursor);
    const entries: RemoteFileMeta[] = [];
    let nextCursor: string | null = null;

    while (entries.length < take) {
      const pageSize = Math.min(take - entries.length, MAX_PAGE_SIZE);
      const response = await client.get<{ list?: TeraBoxItem[] }>('/api/list', {
        dir,
        page,
        num: pageSize,
        order: 'name',
        desc: 0,
      });
      const items = Array.isArray(response?.list) ? response.list : [];
      for (const item of items) {
        if (typeof item?.path !== 'string' || item.path === '') continue;
        entries.push(itemToMeta(item));
      }
      if (items.length < pageSize) {
        nextCursor = null; // short page: the listing is exhausted
        break;
      }
      nextCursor = String(page + 1);
      page += 1;
    }
    return { entries, nextCursor };
  }

  async search(
    ctx: ProviderContext,
    input: { query: string; cursor?: string | null; limit?: number },
  ): Promise<ListResult> {
    this.#require('search');
    const term = typeof input?.query === 'string' ? input.query.trim() : '';
    if (term === '') throw new ProviderError('ERR_INVALID_INPUT', 'query is required');
    const take = Math.min(positiveLimit(input?.limit), MAX_PAGE_SIZE);
    const client = await this.#client(ctx);
    let page = pageFromCursor(input?.cursor);
    const entries: RemoteFileMeta[] = [];
    let nextCursor: string | null = null;

    while (entries.length < take) {
      const pageSize = Math.min(take - entries.length, MAX_PAGE_SIZE);
      const response = await client.get<{ list?: TeraBoxItem[] }>('/api/search', {
        key: term,
        recursion: 1,
        order: 'name',
        desc: 0,
        num: pageSize,
        page,
      });
      const items = Array.isArray(response?.list) ? response.list : [];
      for (const item of items) {
        if (typeof item?.path !== 'string' || item.path === '') continue;
        entries.push(itemToMeta(item));
      }
      if (items.length < pageSize) {
        nextCursor = null; // short page: the listing is exhausted
        break;
      }
      nextCursor = String(page + 1);
      page += 1;
    }
    return { entries, nextCursor };
  }

  async getMetadata(ctx: ProviderContext, input: GetMetadataInput): Promise<RemoteFileMeta> {
    this.#require('getMetadata');
    const path = tbPath(requireRemoteId(input?.remoteId));
    const client = await this.#client(ctx);
    return (await this.#fetchMeta(client, path)).meta;
  }

  async createFolder(ctx: ProviderContext, input: CreateFolderInput): Promise<RemoteFileMeta> {
    this.#require('createFolder');
    const name = requireEntryName(input?.name, 'name');
    const parent = normalizeParentId(input?.parentId);
    const path = joinPath(parent, name);
    const client = await this.#client(ctx);
    await client.ensureJsToken();
    try {
      await client.postForm('/api/create', {
        query: { a: 'commit' },
        form: { path, isdir: 1, rtype: 0, block_list: '[]' },
      });
    } catch (error) {
      if (isTeraBoxConflict(error)) {
        try {
          const existing = await this.#fetchMeta(client, path);
          if (existing.meta.isFolder) return existing.meta;
        } catch (lookupError) {
          if (ProviderError.is(lookupError) && lookupError.code === 'ERR_NOT_FOUND') {
            throw new ProviderError('ERR_INVALID_INPUT', `path '${path}' already exists`, { cause: error });
          }
          throw lookupError;
        }
      }
      throw error;
    }
    try {
      return (await this.#fetchMeta(client, path)).meta;
    } catch (error) {
      if (ProviderError.is(error) && error.code === 'ERR_NOT_FOUND') return synthesizedFolder(path);
      throw error;
    }
  }

  async rename(ctx: ProviderContext, input: RenameInput): Promise<RemoteFileMeta> {
    this.#require('rename');
    const path = tbPath(requireRemoteId(input?.remoteId));
    const newName = requireEntryName(input?.newName, 'newName');
    if (path === ROOT_PATH) throw new ProviderError('ERR_INVALID_INPUT', 'the root folder cannot be renamed');
    const client = await this.#client(ctx);
    const { meta } = await this.#fetchMeta(client, path);
    if (meta.name === newName) return meta;
    await this.#filemanager(client, 'rename', [{ path, newname: newName }]);
    return (await this.#fetchMeta(client, joinPath(parentOf(path) ?? ROOT_PATH, newName))).meta;
  }

  async move(ctx: ProviderContext, input: MoveInput): Promise<RemoteFileMeta> {
    this.#require('move');
    const path = tbPath(requireRemoteId(input?.remoteId));
    if (path === ROOT_PATH) throw new ProviderError('ERR_INVALID_INPUT', 'the root folder cannot be moved');
    const destination = normalizeParentId(input?.newParentId);
    const client = await this.#client(ctx);
    const { meta } = await this.#fetchMeta(client, path);
    const currentParent = parentOf(path) ?? ROOT_PATH;
    if (destination === currentParent) return meta;
    if (meta.isFolder && (destination === path || destination.startsWith(`${path}/`))) {
      throw new ProviderError('ERR_INVALID_INPUT', 'cannot move a folder into itself');
    }
    await this.#filemanager(client, 'move', [{ path, dest: destination, newname: meta.name }]);
    return (await this.#fetchMeta(client, joinPath(destination, meta.name))).meta;
  }

  async copy(ctx: ProviderContext, input: CopyInput): Promise<RemoteFileMeta> {
    this.#require('copy');
    const path = tbPath(requireRemoteId(input?.remoteId));
    if (path === ROOT_PATH) throw new ProviderError('ERR_INVALID_INPUT', 'the root folder cannot be copied');
    const destination = normalizeParentId(input?.newParentId);
    const client = await this.#client(ctx);
    const { meta } = await this.#fetchMeta(client, path);
    const name =
      input.newName !== undefined && input.newName !== null && input.newName !== ''
        ? requireEntryName(input.newName, 'newName')
        : meta.name;
    if (meta.isFolder && (destination === path || destination.startsWith(`${path}/`))) {
      throw new ProviderError('ERR_INVALID_INPUT', 'cannot copy a folder into itself');
    }
    await this.#filemanager(client, 'copy', [{ path, dest: destination, newname: name }], true);
    return (await this.#fetchMeta(client, joinPath(destination, name))).meta;
  }

  async delete(ctx: ProviderContext, input: DeleteInput): Promise<void> {
    this.#require('delete');
    const path = tbPath(requireRemoteId(input?.remoteId));
    if (path === ROOT_PATH) throw new ProviderError('ERR_INVALID_INPUT', 'the root folder cannot be deleted');
    // `permanent` is accepted and ignored: TeraBox only offers the shared
    // recycle bin (contract §11 / provider doc).
    const client = await this.#client(ctx);
    await this.#filemanager(client, 'delete', [path]);
  }

  async upload(ctx: ProviderContext, input: UploadInput): Promise<UploadResult> {
    this.#require('upload');
    if (!input || typeof input.fileName !== 'string') {
      throw new ProviderError('ERR_INVALID_INPUT', 'fileName is required');
    }
    const name = requireEntryName(input.fileName, 'fileName');
    if (!input.stream || typeof (input.stream as { pipe?: unknown }).pipe !== 'function') {
      throw new ProviderError('ERR_INVALID_INPUT', 'stream is required');
    }
    if (typeof input.sizeBytes !== 'bigint' || input.sizeBytes < 0n) {
      throw new ProviderError('ERR_INVALID_INPUT', 'sizeBytes must be a non-negative bigint');
    }
    if (input.sizeBytes > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new ProviderError('ERR_INVALID_INPUT', 'sizeBytes exceeds the supported upload size');
    }
    if (input.resumeToken) this.#require('uploadResumable');

    const client = await this.#client(ctx);
    const parent = normalizeParentId(input.parentId);
    const path = joinPath(parent, name);
    const declared = Number(input.sizeBytes);
    if (declared > PREMIUM_MAX_FILE_BYTES) {
      throw new ProviderError(
        'ERR_QUOTA_EXCEEDED',
        `TeraBox accepts files up to ${PREMIUM_MAX_FILE_BYTES} bytes`,
      );
    }
    if (declared > FREE_TIER_MAX_FILE_BYTES && !(await this.#isPremium(client, ctx))) {
      throw new ProviderError(
        'ERR_QUOTA_EXCEEDED',
        `TeraBox free accounts accept files up to ${FREE_TIER_MAX_FILE_BYTES} bytes`,
      );
    }

    // 1. Reserve the upload session (placeholder block_list, real md5s at create).
    const chunkCount = Math.ceil(declared / TERABOX_CHUNK_BYTES);
    const placeholders = chunkCount <= 1 ? [PRECREATE_BLOCK_1] : [PRECREATE_BLOCK_1, PRECREATE_BLOCK_2];
    await client.ensureJsToken();
    const precreate = await client.postForm<{ uploadid?: string; return_type?: number }>('/api/precreate', {
      form: {
        path,
        autoinit: 1,
        size: declared,
        file_limit_switch_v34: 'true',
        block_list: chunkCount === 0 ? '[]' : JSON.stringify(placeholders),
        target_path: targetDirOf(path),
        local_mtime: Math.floor(Date.now() / 1000),
      },
    });
    const uploadId = typeof precreate?.uploadid === 'string' ? precreate.uploadid.trim() : '';
    if (uploadId === '') {
      throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'TeraBox returned no upload session id');
    }

    // 2. Stream the source in 4 MiB chunks, hashing each one as it goes.
    const blockList: string[] = [];
    let sent = 0;
    for await (const chunk of streamChunks(input.stream as AsyncIterable<Buffer | string>, TERABOX_CHUNK_BYTES)) {
      if (sent + chunk.byteLength > declared) {
        throw new ProviderError('ERR_INVALID_INPUT', `stream is longer than the declared ${declared} bytes`);
      }
      const md5 = await this.#uploadChunk(client, path, uploadId, blockList.length, chunk, ctx);
      blockList.push(md5);
      sent += chunk.byteLength;
    }
    if (sent !== declared) {
      throw new ProviderError('ERR_INVALID_INPUT', `stream ended after ${sent} bytes, expected ${declared}`);
    }

    // 3. Commit with rtype=3 (overwrite), then verify the whole-file md5.
    const created = await client.postForm<{ md5?: string; size?: number }>('/api/create', {
      form: {
        path,
        size: declared,
        isdir: 0,
        block_list: JSON.stringify(blockList),
        uploadid: uploadId,
        rtype: 3,
        target_path: targetDirOf(path),
        local_mtime: Math.floor(Date.now() / 1000),
      },
    });
    const serverMd5 = typeof created?.md5 === 'string' ? created.md5 : '';
    if (serverMd5 !== '' && blockList.length > 0) {
      const decoded = decodeMd5(serverMd5);
      const expected = controlMd5(blockList);
      if (decoded !== expected) {
        ctx.logger('TeraBox whole-file md5 mismatch', { path, expected, decoded });
      }
    }
    return { remoteId: path, sizeBytes: input.sizeBytes, resumeToken: null };
  }

  /** Premium status is only consulted past the free-tier size limit. */
  async #isPremium(client: TeraBoxClient, ctx: ProviderContext): Promise<boolean> {
    try {
      const response = await client.get<{ data?: { member_info?: { is_vip?: number } } }>(
        '/rest/2.0/membership/proxy/user',
        { method: 'query', membership_version: '1.0' },
      );
      const vip = response?.data?.member_info?.is_vip;
      return typeof vip === 'number' && vip > 0;
    } catch (error) {
      if (ProviderError.is(error) && (error.code === 'ERR_AUTH_EXPIRED' || error.code === 'ERR_TIMEOUT')) throw error;
      ctx.logger('TeraBox membership status unavailable', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  async #uploadChunk(
    client: TeraBoxClient,
    path: string,
    uploadId: string,
    partseq: number,
    chunk: Buffer,
    ctx: ProviderContext,
  ): Promise<string> {
    const expected = createHash('md5').update(chunk).digest('hex');
    let lastError: unknown = null;
    for (let attempt = 0; attempt < CHUNK_UPLOAD_ATTEMPTS; attempt++) {
      const url = await client.chunkUploadUrl({
        path: tbPath(path),
        uploadid: uploadId,
        partseq,
        uploadsign: 0,
      });
      const { body, contentType } = buildMultipartBody(`9drive-terabox-${partseq}-${attempt}`, {}, {
        name: 'blob',
        buffer: chunk,
      });
      try {
        const payload = await client.post<{ md5?: string }>(url, {
          body,
          contentType,
          errnoField: 'error_code',
          timeoutMs: TRANSFER_TIMEOUT_MS,
        });
        const received = typeof payload?.md5 === 'string' ? payload.md5 : '';
        if (received !== '' && received !== expected) {
          lastError = new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'TeraBox stored a different chunk md5', {
            detail: { expected, received },
          });
          continue;
        }
        return received === '' ? expected : received;
      } catch (error) {
        // Auth/input failures cannot be fixed by re-sending the same chunk.
        if (ProviderError.is(error) && (error.code === 'ERR_AUTH_EXPIRED' || error.code === 'ERR_INVALID_INPUT')) {
          throw error;
        }
        lastError = error;
        ctx.logger('TeraBox chunk upload attempt failed', {
          partseq,
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (ProviderError.is(lastError)) throw lastError;
    throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'TeraBox chunk upload failed', { cause: lastError });
  }

  async download(ctx: ProviderContext, input: DownloadInput): Promise<DownloadResult> {
    this.#require('download');
    assertRange(input?.range);
    if (input?.range) this.#require('downloadRange');
    const path = tbPath(requireRemoteId(input?.remoteId));
    const client = await this.#client(ctx);
    const { item, meta } = await this.#fetchMeta(client, path, true);
    if (meta.isFolder) {
      throw new ProviderError('ERR_INVALID_INPUT', `remoteId '${path}' is a folder`);
    }
    const total = meta.sizeBytes;

    let url = typeof item.dlink === 'string' ? item.dlink.trim() : '';
    if (url === '') {
      url = await this.#signedDownloadLink(client, item);
    }

    if (input.range) {
      if (total === 0n || BigInt(input.range.start) >= total) {
        throw new ProviderError('ERR_INVALID_INPUT', 'range start is outside the object');
      }
    }

    const headers: Record<string, string> = { ...client.downloadHeaders() };
    if (input.range) {
      headers.Range =
        input.range.end !== undefined ? `bytes=${input.range.start}-${input.range.end}` : `bytes=${input.range.start}-`;
    }
    const download = await gatedDownload(url, {
      headers,
      signal: ctx.signal,
      timeoutMs: TRANSFER_TIMEOUT_MS,
    });

    if (download.statusCode >= 300) {
      if (download.statusCode >= 400) {
        const text = await readBodyText(download.body).catch(() => '');
        throw new ProviderError(
          download.statusCode === 401 || download.statusCode === 403 ? 'ERR_AUTH_EXPIRED' : download.statusCode === 404 ? 'ERR_NOT_FOUND' : 'ERR_UPSTREAM_UNAVAILABLE',
          'TeraBox download failed',
          { upstreamStatus: download.statusCode, detail: parseJson(text) ?? text.slice(0, 300) },
        );
      }
      await download.body.dump({ limit: 64 * 1024 }).catch(() => undefined);
      throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'TeraBox download redirect had no location');
    }

    const mimeType = headerString(download.headers['content-type']);
    const contentLength = headerString(download.headers['content-length']);
    const contentRange = parseContentRange(headerString(download.headers['content-range']));

    if (!input.range) {
      return { stream: download.body, sizeBytes: total, mimeType };
    }
    if (download.statusCode === 206 && contentRange) {
      const rangeTotal = contentRange.total ?? Number(total);
      return {
        stream: download.body,
        sizeBytes: BigInt(contentRange.end - contentRange.start + 1),
        mimeType,
        range: { start: contentRange.start, end: contentRange.end, total: rangeTotal },
      };
    }
    // The CDN ignored the Range header: serve the whole object from byte 0.
    const rangeTotal = total > 0n ? Number(total) : contentLength !== null ? Number(contentLength) : null;
    return {
      stream: download.body,
      sizeBytes: total > 0n ? total : contentLength !== null ? BigInt(contentLength) : null,
      mimeType,
      range: rangeTotal !== null && rangeTotal > 0 ? { start: 0, end: rangeTotal - 1, total: rangeTotal } : undefined,
    };
  }

  /** `/api/filemetas` without a dlink → signed `/api/download` fallback. */
  async #signedDownloadLink(client: TeraBoxClient, item: TeraBoxItem): Promise<string> {
    const home = await client.get<{ data?: { sign1?: string; sign3?: string; timestamp?: number } }>('/api/home/info');
    const sign3 = home?.data?.sign3 ?? '';
    const sign1 = home?.data?.sign1 ?? '';
    const sign = signDownload(sign3, sign1);
    const fsId = Number(item?.fs_id);
    if (sign === '' || !Number.isFinite(fsId)) {
      throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'TeraBox returned no download signature');
    }
    const response = await client.get<{
      dlink?: Array<{ fs_id?: number | string; dlink?: string }>;
      file_info?: { size?: number; filename?: string };
    }>('/api/download', {
      type: 'dlink',
      vip: 2,
      sign,
      timestamp: home?.data?.timestamp ?? Math.floor(Date.now() / 1000),
      need_speed: 1,
      fidlist: JSON.stringify([fsId]),
    });
    const links = Array.isArray(response?.dlink) ? response.dlink : [];
    const match = links.find((link) => String(link?.fs_id) === String(item?.fs_id)) ?? links[0];
    const url = typeof match?.dlink === 'string' ? match.dlink.trim() : '';
    if (url === '') throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'TeraBox returned no download link');
    return url;
  }

  async healthCheck(ctx: ProviderContext): Promise<HealthResult> {
    this.#require('healthCheck');
    const startedAt = Date.now();
    try {
      const client = await this.#client(ctx);
      await client.get('/api/check/login');
      return {
        state: 'healthy',
        latencyMs: Date.now() - startedAt,
        message: null,
        checkedAt: new Date().toISOString(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        state: mapErrorToHealthState(error),
        latencyMs: Date.now() - startedAt,
        message: message.slice(0, 300),
        checkedAt: new Date().toISOString(),
      };
    }
  }

  async createShare(_ctx: ProviderContext, _input: CreateShareInput): Promise<ShareResult> {
    this.#require('createShare');
    throw new ProviderError(
      'ERR_CAPABILITY_UNSUPPORTED',
      `provider '${this.id}' does not expose sharing over the cookie session`,
    );
  }

  async revokeShare(_ctx: ProviderContext, _input: RevokeShareInput): Promise<void> {
    this.#require('revokeShare');
    throw new ProviderError(
      'ERR_CAPABILITY_UNSUPPORTED',
      `provider '${this.id}' does not expose sharing over the cookie session`,
    );
  }
}

export const teraboxProvider = new TeraBoxProvider();

export function createTeraBoxProvider(options: TeraBoxProviderOptions = {}): TeraBoxProvider {
  return new TeraBoxProvider(options);
}

export function registerTeraBoxProvider(): TeraBoxProvider {
  registry.register(teraboxProvider);
  return teraboxProvider;
}
