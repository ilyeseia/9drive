/**
 * Dropbox storage adapter — provider-contract §4 (StorageProvider) and §11:
 * files at or below the 150 MB simple-upload limit use `files/upload`, anything
 * larger (or any resumed attempt) uses `upload_session/*`; `download` streams the
 * response of `files/get_temporary_link`; `list` pages with `list_folder` cursors;
 * `search` pages with `files/search_v2` and `files/search/continue_v2`.
 *
 * Importing this module registers the OAuth2 client config (§8);
 * `registerDropboxProvider()` puts the adapter on the shared registry (§6).
 *
 * Quirks: `remoteId` is a Dropbox file ID (`id:…`); the root folder is addressed
 * by `parentId: null` and synthesised on `getMetadata('root')` because
 * `files/get_metadata` refuses the root path; `delete(permanent)` is ignored
 * because Dropbox only offers the recoverable deleted-files trash.
 */

import type { Readable } from 'node:stream';
import { assertFetchAllowed } from '../../utils/ssrf.js';
import { ProviderError } from '../errors.js';
import { mapErrorToHealthState } from '../health.js';
import { refreshAccessToken } from '../oauth2.js';
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
  DropboxClient,
  gatedRequest,
  parseJson,
  readBodyText,
  type DropboxSession,
} from './client.js';
import { isDropboxConflictError, isDropboxSharedLinkExists, mapDropboxHttpError, mapDropboxTransportError } from './errors.js';
import { registerDropboxOAuth2Client } from './oauth2.js';
import { dropboxTransport } from './transport.js';

const FILE_MIME_TYPE = 'application/octet-stream';
const FOLDER_MIME_TYPE = 'inode/directory';
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1000;
const ROOT_REMOTE_ID = 'root';
const FOUR_MIB = 4 * 1024 * 1024;

/** Files at or below this size use the simple upload endpoint (contract §11). */
export const DROPBOX_SIMPLE_UPLOAD_THRESHOLD_BYTES = 150n * 1024n * 1024n;
/** Upload-session chunk size: a multiple of 4 MiB and under the 150 MiB request cap. */
export const DROPBOX_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

interface DropboxName {
  display_name?: string;
}

interface DropboxEntry {
  '.tag'?: string;
  name?: string;
  id?: string;
  path_lower?: string | null;
  path_display?: string | null;
  size?: number;
  content_hash?: string | null;
  client_modified?: string;
  server_modified?: string;
}

interface DropboxListPage {
  entries?: DropboxEntry[];
  cursor?: string;
  has_more?: boolean;
}

interface DropboxSearchMatch {
  metadata?: unknown;
}

interface DropboxSearchPage {
  matches?: DropboxSearchMatch[];
  cursor?: string | null;
  has_more?: boolean;
  approximate_total_hits?: number;
}

interface DropboxSpaceUsage {
  used?: number | string;
  allocation?: {
    '.tag'?: string;
    individual?: { allocated?: number | string };
    team?: { allocated?: number | string };
  };
}

interface DropboxAccountPayload {
  account_id?: string;
  name?: DropboxName;
  email?: string;
  profile_photo_url?: string;
}

interface DropboxSharedLink {
  url?: string;
  expires?: string | null;
}

interface DropboxSessionStartResult {
  session_id?: string;
}

interface DropboxResumeState {
  sessionId: string;
  offset: number;
}

export interface DropboxProviderOptions {
  capabilities?: Iterable<Capability>;
  /** Files at or below this size are sent through `files/upload`. */
  simpleUploadThresholdBytes?: bigint;
  /** Upload-session chunk size; a positive multiple of 4 MiB, at most 150 MiB. */
  uploadChunkBytes?: number;
}

/** Opaque resume token for `upload()` — session id plus committed byte offset. */
export function encodeDropboxResumeToken(state: DropboxResumeState): string {
  return Buffer.from(JSON.stringify({ sid: state.sessionId, off: state.offset }), 'utf8').toString('base64url');
}

export function decodeDropboxResumeToken(token: string): DropboxResumeState | null {
  try {
    const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as { sid?: unknown; off?: unknown };
    if (typeof parsed.sid !== 'string' || parsed.sid.length === 0) return null;
    if (typeof parsed.off !== 'number' || !Number.isSafeInteger(parsed.off) || parsed.off < 0) return null;
    return { sessionId: parsed.sid, offset: parsed.off };
  } catch {
    return null;
  }
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

function assertRange(range: { start: number; end?: number } | null | undefined): void {
  if (!range) return;
  if (!Number.isInteger(range.start) || range.start < 0) {
    throw new ProviderError('ERR_INVALID_INPUT', 'range start must be a non-negative integer');
  }
  if (range.end !== undefined && (!Number.isInteger(range.end) || range.end < range.start)) {
    throw new ProviderError('ERR_INVALID_INPUT', 'range end must not precede range start');
  }
}

function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value < 0n ? 0n : value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.max(0, Math.round(value)));
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  return 0n;
}

function joinPath(parentPath: string, name: string): string {
  const base = parentPath === '/' ? '' : parentPath;
  return `${base}/${name}`;
}

function unwrapMetadata(data: unknown): DropboxEntry {
  const entry = data && typeof data === 'object' ? (data as { metadata?: DropboxEntry }).metadata : undefined;
  if (!entry || typeof entry !== 'object') {
    throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'Dropbox returned no metadata');
  }
  return entry;
}

/** `files/search_v2` wraps entries in a `MetadataV2` shell; accept the bare shape too. */
function unwrapSearchEntry(match: DropboxSearchMatch | undefined): DropboxEntry | null {
  const metadata = match?.metadata;
  if (!metadata || typeof metadata !== 'object') return null;
  const wrapped = (metadata as { metadata?: unknown }).metadata;
  if (wrapped && typeof wrapped === 'object') return wrapped as DropboxEntry;
  return metadata as DropboxEntry;
}

function rootFolderMeta(): RemoteFileMeta {
  return {
    remoteId: ROOT_REMOTE_ID,
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

function normalizeParentId(parentId: unknown): string | null {
  if (parentId === undefined || parentId === null || parentId === ROOT_REMOTE_ID) return null;
  if (typeof parentId !== 'string' || parentId.trim() === '') {
    throw new ProviderError('ERR_INVALID_INPUT', 'parentId must be a string or null');
  }
  return parentId;
}

function normalizeExpiry(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ProviderError('ERR_INVALID_INPUT', 'expiresAt must be an ISO 8601 timestamp');
  }
  if (parsed.getTime() <= Date.now()) {
    throw new ProviderError('ERR_INVALID_INPUT', 'expiresAt must be in the future');
  }
  return parsed.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function shareFromLink(link: DropboxSharedLink, requestedExpiry: string | null): ShareResult {
  const url = typeof link.url === 'string' ? link.url.trim() : '';
  if (!url) throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'Dropbox returned a shared link without a url');
  const expires = typeof link.expires === 'string' && link.expires.trim() !== '' ? link.expires : null;
  return { url, visibility: 'public_read', expiresAt: expires ?? requestedExpiry };
}

/** Yields the source stream in `chunkSize` pieces (the tail may be shorter). */
async function* streamChunks(stream: AsyncIterable<Buffer | string>, chunkSize: number): AsyncGenerator<Buffer> {
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

/** Discards the first `count` bytes of an upload (resume) before yielding data. */
async function* skippedChunks(chunks: AsyncGenerator<Buffer>, count: number): AsyncGenerator<Buffer> {
  let remaining = count;
  for await (const chunk of chunks) {
    if (remaining <= 0) {
      yield chunk;
      continue;
    }
    if (chunk.byteLength <= remaining) {
      remaining -= chunk.byteLength;
      continue;
    }
    yield chunk.subarray(remaining);
    remaining = 0;
  }
  if (remaining > 0) {
    throw new ProviderError('ERR_INVALID_INPUT', 'stream ended before the upload resume offset');
  }
}

export class DropboxProvider implements StorageProvider {
  readonly id: ProviderId = 'dropbox';
  readonly displayName = 'Dropbox';
  readonly authMode: AuthMode = 'oauth2';
  readonly capabilities: ReadonlySet<Capability>;

  readonly #simpleUploadThresholdBytes: bigint;
  readonly #uploadChunkBytes: number;

  constructor(options: DropboxProviderOptions = {}) {
    this.capabilities = new Set(options.capabilities ?? ALL_CAPABILITIES);
    this.#simpleUploadThresholdBytes = options.simpleUploadThresholdBytes ?? DROPBOX_SIMPLE_UPLOAD_THRESHOLD_BYTES;
    const chunk = options.uploadChunkBytes ?? DROPBOX_UPLOAD_CHUNK_BYTES;
    if (!Number.isSafeInteger(chunk) || chunk <= 0 || chunk % FOUR_MIB !== 0 || chunk > 150 * 1024 * 1024) {
      throw new ProviderError('ERR_INVALID_INPUT', 'uploadChunkBytes must be a positive multiple of 4 MiB and at most 150 MiB');
    }
    this.#uploadChunkBytes = chunk;
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

  async #client(ctx: ProviderContext): Promise<DropboxClient> {
    if (ctx.credentials.kind !== 'oauth2') {
      throw new ProviderError(
        'ERR_INVALID_INPUT',
        `provider '${this.id}' requires oauth2 credentials, received '${ctx.credentials.kind}'`,
      );
    }
    const credentials = ctx.credentials;
    const transport = dropboxTransport();
    const config = ctx.account.config ?? {};
    let accessToken = credentials.accessToken;
    return new DropboxClient({
      apiUrl: await this.#endpoint(config, ['apiBaseUrl', 'apiUrl'], transport.apiUrl),
      contentUrl: await this.#endpoint(config, ['contentBaseUrl', 'contentUrl'], transport.contentUrl),
      signal: ctx.signal,
      logger: ctx.logger,
      session: {
        accessToken: () => accessToken,
        renew: async () => {
          if (!credentials.refreshToken || !credentials.clientId || !credentials.clientSecret) return false;
          const refreshed = await refreshAccessToken({
            provider: this.id,
            clientId: credentials.clientId,
            clientSecret: credentials.clientSecret,
            redirectUri: credentials.redirectUri,
            refreshToken: credentials.refreshToken,
            tokenUrl: transport.tokenUrl,
            signal: ctx.signal,
          });
          accessToken = refreshed.accessToken;
          return true;
        },
      },
    });
  }

  /**
   * Account-configured endpoints are user input: they run through the full
   * SSRF gate (syntax + resolved addresses). The module transport seam and the
   * fixed official URLs are not user input and stay ungated (security-contract §7).
   */
  async #endpoint(config: Record<string, unknown>, keys: string[], fallback: string): Promise<string> {
    for (const key of keys) {
      const raw = config[key];
      if (typeof raw === 'string' && raw.trim()) {
        const allowed = await assertFetchAllowed(raw.trim());
        return allowed.toString().replace(/\/+$/, '');
      }
    }
    return fallback.replace(/\/+$/, '');
  }

  async getAccountInfo(ctx: ProviderContext): Promise<AccountInfo> {
    this.#require('getAccountInfo');
    const client = await this.#client(ctx);
    const response = await client.rpc<DropboxAccountPayload>('users/get_current_account', {});
    const accountId = typeof response.data.account_id === 'string' ? response.data.account_id.trim() : '';
    if (!accountId) {
      throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'Dropbox returned no account id');
    }
    return {
      providerAccountId: accountId,
      email: response.data.email ?? null,
      displayName: response.data.name?.display_name ?? null,
      avatarUrl: response.data.profile_photo_url ?? null,
    };
  }

  async getQuota(ctx: ProviderContext): Promise<QuotaInfo> {
    this.#require('getQuota');
    const client = await this.#client(ctx);
    const response = await client.rpc<DropboxSpaceUsage>('users/get_space_usage', {});
    const usage = response.data;
    const allocated = usage.allocation?.individual?.allocated ?? usage.allocation?.team?.allocated ?? null;
    const totalBytes = allocated === null ? null : toBigInt(allocated);
    const usedBytes = toBigInt(usage.used ?? 0);
    return {
      totalBytes,
      usedBytes,
      availableBytes: totalBytes === null ? null : totalBytes > usedBytes ? totalBytes - usedBytes : 0n,
      // Dropbox reports no separate trash total in space usage.
      trashBytes: null,
      raw: usage as Record<string, unknown>,
    };
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
    const client = await this.#client(ctx);
    const parentId = normalizeParentId(input.parentId);
    const destPath = await this.#destinationPath(client, parentId, name);
    const resumeToken =
      typeof input.resumeToken === 'string' && input.resumeToken.trim() !== '' ? input.resumeToken.trim() : null;
    if (resumeToken !== null) this.#require('uploadResumable');
    const resume = resumeToken ? decodeDropboxResumeToken(resumeToken) : null;
    if (resumeToken && !resume) {
      throw new ProviderError('ERR_INVALID_INPUT', 'resumeToken is not a valid Dropbox resume token');
    }
    if (resume && resume.offset > Number(input.sizeBytes)) {
      throw new ProviderError('ERR_INVALID_INPUT', 'resumeToken offset is beyond the declared sizeBytes');
    }

    try {
      if (input.sizeBytes <= this.#simpleUploadThresholdBytes && (resume === null || input.sizeBytes === 0n)) {
        const response = await client.content<DropboxEntry>(
          'files/upload',
          { path: destPath, mode: 'overwrite', autorename: false, mute: true, strict_conflict: false },
          {
            body: input.stream as Readable,
            headers: { 'Content-Type': input.mimeType || FILE_MIME_TYPE },
            timeoutMs: TRANSFER_TIMEOUT_MS,
          },
        );
        return this.#uploadResult(response.data, input.sizeBytes);
      }
      this.#require('uploadResumable');
      return await this.#sessionUpload(client, input, destPath, resume);
    } catch (error) {
      throw ProviderError.is(error) ? error : mapDropboxTransportError(error);
    }
  }

  async download(ctx: ProviderContext, input: DownloadInput): Promise<DownloadResult> {
    this.#require('download');
    assertRange(input?.range);
    if (input?.range) this.#require('downloadRange');
    const remoteId = requireRemoteId(input?.remoteId);
    const client = await this.#client(ctx);
    const response = await client.rpc<{ link?: string; metadata?: DropboxEntry }>('files/get_temporary_link', {
      path: remoteId,
    });
    const metadata = response.data.metadata;
    if (metadata?.['.tag'] === 'folder') {
      throw new ProviderError('ERR_INVALID_INPUT', `remoteId '${remoteId}' is a folder`);
    }
    const temporaryUrl = typeof response.data.link === 'string' ? response.data.link.trim() : '';
    if (!temporaryUrl) {
      throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'Dropbox returned no temporary link');
    }
    const total = metadata?.size !== undefined ? toBigInt(metadata.size) : null;
    if (input.range && total !== null) {
      if (total === 0n || BigInt(input.range.start) >= total) {
        throw new ProviderError('ERR_INVALID_INPUT', 'range start is outside the object');
      }
    }

    const headers: Record<string, string> = {};
    if (input.range) {
      headers.Range =
        input.range.end !== undefined ? `bytes=${input.range.start}-${input.range.end}` : `bytes=${input.range.start}-`;
    }
    const download = await gatedRequest(temporaryUrl, {
      headers,
      signal: ctx.signal,
      timeoutMs: TRANSFER_TIMEOUT_MS,
    });

    if (download.statusCode >= 300) {
      if (download.statusCode >= 400) {
        const text = await readBodyText(download.body).catch(() => '');
        throw mapDropboxHttpError(download.statusCode, parseJson(text), text);
      }
      await download.body.dump({ limit: 64 * 1024 }).catch(() => undefined);
      throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'Dropbox download redirect had no location');
    }

    const mimeType = headerString(download.headers['content-type']);
    const contentLength = headerString(download.headers['content-length']);
    const contentRange = parseContentRange(headerString(download.headers['content-range']));

    if (!input.range) {
      return { stream: download.body, sizeBytes: total, mimeType };
    }
    if (download.statusCode === 206 && contentRange) {
      const rangeTotal = contentRange.total ?? (total === null ? null : Number(total));
      return {
        stream: download.body,
        sizeBytes: BigInt(contentRange.end - contentRange.start + 1),
        mimeType,
        range: { start: contentRange.start, end: contentRange.end, total: rangeTotal },
      };
    }
    // The link ignored the Range header and served the whole object from byte 0.
    const rangeTotal = total === null ? (contentLength !== null ? Number(contentLength) : null) : Number(total);
    return {
      stream: download.body,
      sizeBytes: total ?? (contentLength !== null ? BigInt(contentLength) : null),
      mimeType,
      range:
        rangeTotal !== null && rangeTotal > 0 ? { start: 0, end: rangeTotal - 1, total: rangeTotal } : undefined,
    };
  }

  async list(ctx: ProviderContext, input: ListInput): Promise<ListResult> {
    this.#require('list');
    const parentId = normalizeParentId(input?.parentId);
    const limit = input?.limit ?? DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new ProviderError('ERR_INVALID_INPUT', 'limit must be a positive integer');
    }
    const take = Math.min(limit, MAX_PAGE_SIZE);
    const client = await this.#client(ctx);
    const path = parentId ?? '';
    let cursor = typeof input?.cursor === 'string' && input.cursor.trim() !== '' ? input.cursor : null;

    const entries: RemoteFileMeta[] = [];
    let nextCursor: string | null = null;
    while (entries.length < take) {
      const pageSize = Math.min(take - entries.length, MAX_PAGE_SIZE);
      const page = cursor
        ? await client.rpc<DropboxListPage>('files/list_folder/continue', { cursor, limit: pageSize })
        : await client.rpc<DropboxListPage>('files/list_folder', { path, limit: pageSize });
      const body = page.data;
      for (const entry of body.entries ?? []) {
        if (entry['.tag'] !== 'file' && entry['.tag'] !== 'folder') continue;
        entries.push(await this.#toMeta(client, entry, parentId));
      }
      if (!body.has_more || typeof body.cursor !== 'string') {
        nextCursor = null;
        break;
      }
      cursor = body.cursor;
      nextCursor = body.cursor;
      if ((body.entries ?? []).length === 0) break; // no progress: hand the cursor back
    }
    return { entries, nextCursor };
  }

  async search(
    ctx: ProviderContext,
    input: { query: string; cursor?: string | null; limit?: number },
  ): Promise<ListResult> {
    this.#require('search');
    const term = typeof input?.query === 'string' ? input.query.trim() : '';
    if (term === '') {
      throw new ProviderError('ERR_INVALID_INPUT', 'query is required');
    }
    const limit = input?.limit ?? DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new ProviderError('ERR_INVALID_INPUT', 'limit must be a positive integer');
    }
    const take = Math.min(limit, MAX_PAGE_SIZE);
    const cursor = typeof input?.cursor === 'string' && input.cursor.trim() !== '' ? input.cursor : null;
    const client = await this.#client(ctx);
    // `search_v2` sizes the page; `search/continue_v2` only continues it.
    const page = cursor
      ? await client.rpc<DropboxSearchPage>('files/search/continue_v2', { cursor })
      : await client.rpc<DropboxSearchPage>('files/search_v2', { query: term, options: { max_results: take } });
    const body = page.data;
    const entries: RemoteFileMeta[] = [];
    for (const match of body.matches ?? []) {
      const entry = unwrapSearchEntry(match);
      if (!entry || (entry['.tag'] !== 'file' && entry['.tag'] !== 'folder')) continue;
      entries.push(await this.#toMeta(client, entry));
    }
    const nextCursor = body.has_more && typeof body.cursor === 'string' && body.cursor !== '' ? body.cursor : null;
    return { entries, nextCursor };
  }

  async getMetadata(ctx: ProviderContext, input: GetMetadataInput): Promise<RemoteFileMeta> {
    this.#require('getMetadata');
    const remoteId = requireRemoteId(input?.remoteId);
    if (remoteId === ROOT_REMOTE_ID) return rootFolderMeta();
    const client = await this.#client(ctx);
    const { meta } = await this.#lookup(client, remoteId);
    return meta;
  }

  async createFolder(ctx: ProviderContext, input: CreateFolderInput): Promise<RemoteFileMeta> {
    this.#require('createFolder');
    const name = requireEntryName(input?.name, 'name');
    const parentId = normalizeParentId(input?.parentId);
    const client = await this.#client(ctx);
    const path = await this.#destinationPath(client, parentId, name);
    try {
      const response = await client.rpc<{ metadata?: DropboxEntry }>('files/create_folder_v2', {
        path,
        autorename: false,
      });
      return await this.#toMeta(client, unwrapMetadata(response.data), parentId);
    } catch (error) {
      if (isDropboxConflictError(error)) {
        const existing = await this.#tryLookupByPath(client, path);
        if (existing) return existing;
      }
      throw error;
    }
  }

  async rename(ctx: ProviderContext, input: RenameInput): Promise<RemoteFileMeta> {
    this.#require('rename');
    const remoteId = requireRemoteId(input?.remoteId);
    const newName = requireEntryName(input?.newName, 'newName');
    const client = await this.#client(ctx);
    const { entry, meta } = await this.#lookup(client, remoteId);
    if (meta.name === newName) return meta;
    const response = await client.rpc<{ metadata?: DropboxEntry }>('files/move_v2', {
      from_path: remoteId,
      to_path: joinPath(this.#parentPath(entry), newName),
      autorename: false,
    });
    return await this.#toMeta(client, unwrapMetadata(response.data), meta.parentId);
  }

  async move(ctx: ProviderContext, input: MoveInput): Promise<RemoteFileMeta> {
    this.#require('move');
    const remoteId = requireRemoteId(input?.remoteId);
    const destination = normalizeParentId(input?.newParentId);
    const client = await this.#client(ctx);
    const { entry, meta } = await this.#lookup(client, remoteId);
    if (destination === null && meta.parentId === null) return meta;
    if (destination !== null && destination === meta.parentId) return meta;
    if (destination === remoteId) {
      throw new ProviderError('ERR_INVALID_INPUT', 'cannot move a folder into itself');
    }
    const destinationPath = await this.#folderPath(client, destination);
    const response = await client.rpc<{ metadata?: DropboxEntry }>('files/move_v2', {
      from_path: remoteId,
      to_path: joinPath(destinationPath, entry.name ?? meta.name),
      autorename: false,
    });
    return await this.#toMeta(client, unwrapMetadata(response.data), destination);
  }

  async copy(ctx: ProviderContext, input: CopyInput): Promise<RemoteFileMeta> {
    this.#require('copy');
    const remoteId = requireRemoteId(input?.remoteId);
    const destination = normalizeParentId(input?.newParentId);
    const client = await this.#client(ctx);
    const { meta } = await this.#lookup(client, remoteId);
    const name =
      input.newName !== undefined && input.newName !== null && input.newName !== ''
        ? requireEntryName(input.newName, 'newName')
        : meta.name;
    const destinationPath = await this.#folderPath(client, destination);
    const response = await client.rpc<{ metadata?: DropboxEntry }>('files/copy_v2', {
      from_path: remoteId,
      to_path: joinPath(destinationPath, name),
      autorename: false,
    });
    return await this.#toMeta(client, unwrapMetadata(response.data), destination);
  }

  async delete(ctx: ProviderContext, input: DeleteInput): Promise<void> {
    this.#require('delete');
    const remoteId = requireRemoteId(input?.remoteId);
    if (remoteId === ROOT_REMOTE_ID) {
      throw new ProviderError('ERR_INVALID_INPUT', 'the root folder cannot be deleted');
    }
    // `permanent` is accepted and ignored: Dropbox offers no purge API, so items
    // land in the recoverable deleted-files trash (contract §11 / provider doc).
    const client = await this.#client(ctx);
    await client.rpc('files/delete_v2', { path: remoteId });
  }

  async createShare(ctx: ProviderContext, input: CreateShareInput): Promise<ShareResult> {
    this.#require('createShare');
    if (input?.visibility !== 'public_read') {
      throw new ProviderError(
        'ERR_INVALID_INPUT',
        `provider '${this.id}' only supports the 'public_read' share visibility`,
      );
    }
    const remoteId = requireRemoteId(input.remoteId);
    const expiresAt = normalizeExpiry(input.expiresAt);
    const client = await this.#client(ctx);
    const { entry } = await this.#lookup(client, remoteId);
    const path = entry.path_display ?? entry.path_lower ?? '';
    try {
      const response = await client.rpc<DropboxSharedLink>(
        'sharing/create_shared_link_with_settings',
        expiresAt ? { path, settings: { expires: expiresAt } } : { path },
      );
      return shareFromLink(response.data, expiresAt);
    } catch (error) {
      if (isDropboxSharedLinkExists(error)) {
        const links = await client.rpc<{ links?: DropboxSharedLink[] }>('sharing/list_shared_links', {
          path,
          direct_only: false,
        });
        const existing = (links.data.links ?? []).find((link) => typeof link.url === 'string' && link.url !== '');
        if (existing) return shareFromLink(existing, expiresAt);
      }
      throw error;
    }
  }

  async revokeShare(ctx: ProviderContext, input: RevokeShareInput): Promise<void> {
    this.#require('revokeShare');
    const remoteId = requireRemoteId(input?.remoteId);
    const client = await this.#client(ctx);
    const { entry } = await this.#lookup(client, remoteId);
    const path = entry.path_display ?? entry.path_lower ?? '';
    const links = await client.rpc<{ links?: DropboxSharedLink[] }>('sharing/list_shared_links', {
      path,
      direct_only: false,
    });
    const existing = (links.data.links ?? []).find((link) => typeof link.url === 'string' && link.url !== '');
    if (!existing) return; // already link-free: revoke is idempotent (fake parity)
    await client.rpc('sharing/revoke_shared_link', { url: existing.url });
  }

  async healthCheck(ctx: ProviderContext): Promise<HealthResult> {
    this.#require('healthCheck');
    const startedAt = Date.now();
    const client = await this.#client(ctx);
    try {
      await client.rpc('users/get_current_account', {});
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

  async #sessionUpload(
    client: DropboxClient,
    input: UploadInput,
    destPath: string,
    resume: DropboxResumeState | null,
  ): Promise<UploadResult> {
    const declared = Number(input.sizeBytes);
    const commit = { path: destPath, mode: 'overwrite', autorename: false, mute: true, strict_conflict: false };
    const source = skippedChunks(
      streamChunks(input.stream as AsyncIterable<Buffer | string>, this.#uploadChunkBytes),
      resume?.offset ?? 0,
    );
    const iterator = source[Symbol.asyncIterator]();
    let sessionId = resume?.sessionId ?? null;
    let offset = resume?.offset ?? 0;

    let current = await iterator.next();
    while (!current.done) {
      const chunk = current.value;
      if (offset + chunk.byteLength > declared) {
        throw new ProviderError('ERR_INVALID_INPUT', `stream is longer than the declared ${declared} bytes`);
      }
      const next = await iterator.next();
      const isLast = next.done === true;

      if (sessionId === null) {
        const started = await client.content<DropboxSessionStartResult>(
          'upload_session/start',
          { close: false },
          { body: chunk, timeoutMs: TRANSFER_TIMEOUT_MS },
        );
        sessionId = typeof started.data.session_id === 'string' ? started.data.session_id : '';
        if (!sessionId) {
          throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'Dropbox returned no upload session id');
        }
        offset += chunk.byteLength;
        if (isLast) break;
        current = next;
        continue;
      }

      if (isLast) {
        if (offset + chunk.byteLength !== declared) {
          throw new ProviderError(
            'ERR_INVALID_INPUT',
            `stream ended after ${offset + chunk.byteLength} bytes, expected ${declared}`,
          );
        }
        const finished = await client.content<DropboxEntry>(
          'upload_session/finish',
          { cursor: { session_id: sessionId, offset }, commit },
          { body: chunk, timeoutMs: TRANSFER_TIMEOUT_MS },
        );
        offset += chunk.byteLength;
        return this.#uploadResult(finished.data, input.sizeBytes);
      }

      await client.content<Record<string, never>>(
        'upload_session/append_v2',
        { cursor: { session_id: sessionId, offset }, close: false },
        { body: chunk, timeoutMs: TRANSFER_TIMEOUT_MS },
      );
      offset += chunk.byteLength;
      current = next;
    }

    if (offset !== declared) {
      throw new ProviderError('ERR_INVALID_INPUT', `stream ended after ${offset} bytes, expected ${declared}`);
    }
    if (sessionId === null) {
      // Declared size 0 with a resume token: commit an empty session.
      const started = await client.content<DropboxSessionStartResult>(
        'upload_session/start',
        { close: false },
        { timeoutMs: TRANSFER_TIMEOUT_MS },
      );
      sessionId = typeof started.data.session_id === 'string' ? started.data.session_id : '';
      if (!sessionId) {
        throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'Dropbox returned no upload session id');
      }
    }
    const finished = await client.content<DropboxEntry>(
      'upload_session/finish',
      { cursor: { session_id: sessionId, offset }, commit },
      { timeoutMs: TRANSFER_TIMEOUT_MS },
    );
    return this.#uploadResult(finished.data, input.sizeBytes);
  }

  #uploadResult(entry: DropboxEntry, declared: bigint): UploadResult {
    const remoteId = typeof entry?.id === 'string' ? entry.id.trim() : '';
    if (!remoteId) {
      throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'Dropbox returned no id for the uploaded file');
    }
    return { remoteId, sizeBytes: entry.size !== undefined ? toBigInt(entry.size) : declared, resumeToken: null };
  }

  async #toMeta(client: DropboxClient, entry: DropboxEntry, knownParentId?: string | null): Promise<RemoteFileMeta> {
    const tag = entry['.tag'];
    if (tag === 'deleted') {
      throw new ProviderError('ERR_NOT_FOUND', `remoteId '${entry.id ?? ''}' was deleted`);
    }
    const isFolder = tag === 'folder';
    const remoteId = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (!remoteId) {
      throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'Dropbox returned metadata without an id');
    }
    const parentId = knownParentId !== undefined ? knownParentId : await this.#resolveParentId(client, entry);
    return {
      remoteId,
      name: entry.name ?? '',
      mimeType: isFolder ? FOLDER_MIME_TYPE : FILE_MIME_TYPE,
      sizeBytes: isFolder ? 0n : toBigInt(entry.size ?? 0),
      parentId,
      isFolder,
      createdAt: entry.client_modified ?? null,
      modifiedAt: entry.server_modified ?? entry.client_modified ?? null,
      checksum: entry.content_hash ?? null,
      webUrl: null,
    };
  }

  /** Dropbox metadata carries no parent id: derive it from the item's path. */
  async #resolveParentId(client: DropboxClient, entry: DropboxEntry): Promise<string | null> {
    const path = entry.path_display ?? entry.path_lower;
    if (!path || path === '/') return null;
    const separator = path.lastIndexOf('/');
    if (separator <= 0) return null; // direct child of the root folder
    const parent = await client.rpc<DropboxEntry>('files/get_metadata', { path: path.slice(0, separator) });
    const parentId = typeof parent.data.id === 'string' ? parent.data.id : '';
    return parentId !== '' ? parentId : null;
  }

  async #lookup(client: DropboxClient, remoteId: string): Promise<{ entry: DropboxEntry; meta: RemoteFileMeta }> {
    const response = await client.rpc<DropboxEntry>('files/get_metadata', { path: remoteId });
    const entry = response.data;
    if (entry?.['.tag'] === 'deleted') {
      throw new ProviderError('ERR_NOT_FOUND', `remoteId '${remoteId}' was deleted`);
    }
    return { entry, meta: await this.#toMeta(client, entry) };
  }

  async #tryLookupByPath(client: DropboxClient, path: string): Promise<RemoteFileMeta | null> {
    try {
      const response = await client.rpc<DropboxEntry>('files/get_metadata', { path });
      return await this.#toMeta(client, response.data);
    } catch (error) {
      if (ProviderError.is(error) && error.code === 'ERR_NOT_FOUND') return null;
      throw error;
    }
  }

  #parentPath(entry: DropboxEntry): string {
    const path = entry.path_display ?? entry.path_lower ?? '';
    const separator = path.lastIndexOf('/');
    return separator <= 0 ? '' : path.slice(0, separator);
  }

  /** Absolute path of a folder id (null / 'root' → root path ''). */
  async #folderPath(client: DropboxClient, parentId: string | null): Promise<string> {
    if (parentId === null) return '';
    const response = await client.rpc<DropboxEntry>('files/get_metadata', { path: parentId });
    const entry = response.data;
    if (entry['.tag'] === 'file') {
      throw new ProviderError('ERR_INVALID_INPUT', `parentId '${parentId}' is not a folder`);
    }
    return entry.path_display ?? entry.path_lower ?? '';
  }

  async #destinationPath(client: DropboxClient, parentId: string | null, name: string): Promise<string> {
    return joinPath(await this.#folderPath(client, parentId), name);
  }
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

export const dropboxProvider = new DropboxProvider();

export function createDropboxProvider(options: DropboxProviderOptions = {}): DropboxProvider {
  return new DropboxProvider(options);
}

export function registerDropboxProvider(): DropboxProvider {
  registerDropboxOAuth2Client();
  registry.register(dropboxProvider);
  return dropboxProvider;
}
