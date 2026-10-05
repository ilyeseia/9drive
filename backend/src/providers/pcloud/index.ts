/**
 * pCloud storage adapter — provider-contract §4 (StorageProvider) and §11.
 *
 * Method mapping (docs.pcloud.com/methods): `upload` → PUT `uploadfile`
 * (streaming body), `download` → `stat` + `getfilelink` + gated CDN fetch,
 * `list` → `listfolder` paged with client-side offset cursors (pCloud has no
 * server-side paging), `search` → recursive `listfolder` filtered in-process
 * (pCloud has no search API — declared as a documented O(tree) caveat),
 * rename/move → `renamefile`/`renamefolder` (they do both), copy →
 * `copyfile`/`copyfolder` with `noover` so conflicts fail instead of
 * overwriting, delete → `deletefile`/`deletefolder` (trash) with
 * `deletefolderrecursive` fallback for non-empty folders, shares → the
 * `*publink` family.
 *
 * Importing this module registers the OAuth2 client config (§8);
 * `registerPcloudProvider()` puts the adapter on the shared registry (§6).
 *
 * Quirks: `remoteId` is pCloud's own metadata id (`f<fileid>` / `d<folderid>`,
 * root `d0`); `parentId: null` is root `folderid=0`; metadata `hash` is never
 * exposed (it exceeds 2^53 and JSON.parse would corrupt it); timestamps are
 * upstream RFC 2822 strings normalised to ISO 8601; `delete(permanent)` only
 * chooses between `deletefolder` (trash) and `deletefolderrecursive`.
 */

import type { Readable } from 'node:stream';
import { assertFetchAllowed } from '../../utils/ssrf.js';
import { ProviderError } from '../errors.js';
import { mapErrorToHealthState } from '../health.js';
import { refreshAccessToken } from '../oauth2.js';
import { registry } from '../registry.js';
import {
  ALL_CAPABILITIES,
  decodeOffsetCursor,
  encodeOffsetCursor,
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
  PcloudClient,
  gatedRequest,
  parseJson,
  readBodyText,
  type PcloudSession,
} from './client.js';
import {
  isPcloudConflictError,
  isPcloudNotEmptyError,
  mapPcloudHttpError,
  pcloudResultOf,
} from './errors.js';
import { registerPcloudOAuth2Client } from './oauth2.js';
import { pcloudCdnUrl, pcloudTransport } from './transport.js';

const FILE_MIME_TYPE = 'application/octet-stream';
const FOLDER_MIME_TYPE = 'inode/directory';
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1000;
const ROOT_REMOTE_ID = 'd0';
const ROOT_FOLDER_ID = 0;

interface PcloudMetadata {
  id?: string;
  fileid?: number;
  folderid?: number;
  parentfolderid?: number;
  isfolder?: boolean;
  isdeleted?: boolean;
  ismine?: boolean;
  isshared?: boolean;
  name?: string;
  path?: string;
  size?: number;
  contenttype?: string;
  created?: string;
  modified?: string;
  contents?: PcloudMetadata[];
}

interface PcloudMetadataPayload {
  metadata?: PcloudMetadata;
}

interface PcloudUserinfoPayload {
  userid?: number;
  email?: string;
  quota?: number;
  usedquota?: number;
}

interface PcloudLinkPayload {
  path?: string;
  expires?: string;
  hosts?: string[];
  linkid?: number;
  link?: string;
  code?: string;
}

interface PcloudPubLink {
  linkid?: number;
  link?: string;
  code?: string;
  expires?: string;
  metadata?: PcloudMetadata;
}

interface PcloudPubLinksPayload {
  publinks?: PcloudPubLink[];
}

interface PcloudUploadPayload {
  fileids?: number[];
  metadata?: PcloudMetadata[];
}

export interface PcloudProviderOptions {
  capabilities?: Iterable<Capability>;
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

/** Quota fields are 64-bit ints; tolerate digit strings (2^53-safe JSON). */
function optionalBigInt(value: unknown): bigint | null {
  if (typeof value === 'number' && Number.isFinite(value)) return toBigInt(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  return null;
}

/** `f123` / `d456` (or the `root` / `d0` aliases) → kind plus numeric id. */
function parseRemoteId(remoteId: string): { isFolder: boolean; id: number } {
  if (remoteId === 'root' || remoteId === ROOT_REMOTE_ID) return { isFolder: true, id: ROOT_FOLDER_ID };
  const file = /^f(\d+)$/.exec(remoteId);
  if (file) return { isFolder: false, id: Number(file[1]) };
  const folder = /^d(\d+)$/.exec(remoteId);
  if (folder) return { isFolder: true, id: Number(folder[1]) };
  throw new ProviderError('ERR_INVALID_INPUT', `'${remoteId}' is not a pCloud remoteId`);
}

function remoteIdOf(meta: PcloudMetadata): string {
  if (typeof meta.id === 'string' && meta.id.trim() !== '') return meta.id.trim();
  if (typeof meta.fileid === 'number') return `f${meta.fileid}`;
  if (meta.isfolder === true && typeof meta.folderid === 'number') return `d${meta.folderid}`;
  throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'pCloud returned metadata without an id');
}

function folderIdRemote(id: number): string | null {
  return id === ROOT_FOLDER_ID ? null : `d${id}`;
}

/** Input `parentId`: null / 'root' / 'd0' → root; otherwise a folder remoteId. */
function normalizeParentId(parentId: unknown): string | null {
  if (parentId === undefined || parentId === null || parentId === '' || parentId === 'root' || parentId === ROOT_REMOTE_ID) {
    return null;
  }
  if (typeof parentId !== 'string') {
    throw new ProviderError('ERR_INVALID_INPUT', 'parentId must be a string or null');
  }
  return parentId.trim();
}

function parentFolderId(parentId: string | null): number {
  if (parentId === null) return ROOT_FOLDER_ID;
  const parsed = parseRemoteId(parentId);
  if (!parsed.isFolder) {
    throw new ProviderError('ERR_INVALID_INPUT', `parentId '${parentId}' is not a folder`);
  }
  return parsed.id;
}

function toIsoString(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Upstream datetimes are RFC 2822 (`Wed, 02 Oct 2013 14:29:11 +0000`). */
function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : toIsoString(parsed);
}

function requireFutureDate(value: string | null | undefined, field: string): Date | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ProviderError('ERR_INVALID_INPUT', `${field} must be an ISO 8601 timestamp`);
  }
  if (parsed.getTime() <= Date.now()) {
    throw new ProviderError('ERR_INVALID_INPUT', `${field} must be in the future`);
  }
  return parsed;
}

/** pCloud parses share expirations as RFC 2822 with a numeric offset. */
function toRfc2822(date: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${days[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${months[date.getUTCMonth()]} ` +
    `${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:` +
    `${pad(date.getUTCSeconds())} +0000`
  );
}

function toMeta(meta: PcloudMetadata | undefined, knownParentId?: string | null): RemoteFileMeta {
  if (!meta || typeof meta !== 'object') {
    throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'pCloud returned no metadata');
  }
  if (meta.isdeleted) {
    throw new ProviderError('ERR_NOT_FOUND', `remoteId '${meta.id ?? ''}' was deleted`);
  }
  const remoteId = remoteIdOf(meta);
  const isFolder = meta.isfolder === true;
  const parentId =
    knownParentId !== undefined
      ? knownParentId
      : typeof meta.parentfolderid === 'number'
        ? folderIdRemote(meta.parentfolderid)
        : null;
  return {
    remoteId,
    name: isFolder && remoteId === ROOT_REMOTE_ID ? '' : (meta.name ?? ''),
    mimeType: isFolder ? FOLDER_MIME_TYPE : (meta.contenttype ?? FILE_MIME_TYPE),
    sizeBytes: isFolder ? 0n : toBigInt(meta.size ?? 0),
    parentId,
    isFolder,
    createdAt: normalizeTimestamp(meta.created),
    modifiedAt: normalizeTimestamp(meta.modified) ?? normalizeTimestamp(meta.created),
    // `hash` exceeds 2^53; JSON.parse would silently corrupt it, so never expose it.
    checksum: null,
    webUrl: null,
  };
}

/** Pre-order walk of a `listfolder` response with `recursive=1`. */
function flattenTree(root: PcloudMetadata | undefined): PcloudMetadata[] {
  const out: PcloudMetadata[] = [];
  const walk = (node: PcloudMetadata): void => {
    for (const child of node.contents ?? []) {
      if (child.isdeleted) continue;
      out.push(child);
      if (child.isfolder === true) walk(child);
    }
  };
  if (root) walk(root);
  return out;
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

export class PcloudProvider implements StorageProvider {
  readonly id: ProviderId = 'pcloud';
  readonly displayName = 'pCloud';
  readonly authMode: AuthMode = 'oauth2';
  readonly capabilities: ReadonlySet<Capability>;

  constructor(options: PcloudProviderOptions = {}) {
    this.capabilities = new Set(options.capabilities ?? PCLOUD_CAPABILITIES);
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

  async #client(ctx: ProviderContext): Promise<PcloudClient> {
    if (ctx.credentials.kind !== 'oauth2') {
      throw new ProviderError(
        'ERR_INVALID_INPUT',
        `provider '${this.id}' requires oauth2 credentials, received '${ctx.credentials.kind}'`,
      );
    }
    const credentials = ctx.credentials;
    const transport = pcloudTransport();
    const config = ctx.account.config ?? {};
    let accessToken = credentials.accessToken;
    return new PcloudClient({
      apiUrl: await this.#endpoint(config, ['apiBaseUrl', 'apiUrl'], transport.apiUrl),
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
            tokenUrl: await this.#endpoint(config, ['tokenUrl'], transport.tokenUrl),
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
   * EU accounts set `apiBaseUrl` to https://eapi.pcloud.com (see the provider doc).
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
    const payload = await client.call<PcloudUserinfoPayload>('userinfo');
    const accountId = payload.userid !== undefined ? String(payload.userid) : '';
    if (!accountId) {
      throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'pCloud returned no user id');
    }
    return {
      providerAccountId: accountId,
      email: payload.email ?? null,
      // pCloud exposes no profile name or avatar.
      displayName: null,
      avatarUrl: null,
    };
  }

  async getQuota(ctx: ProviderContext): Promise<QuotaInfo> {
    this.#require('getQuota');
    const client = await this.#client(ctx);
    const payload = await client.call<PcloudUserinfoPayload>('userinfo');
    const totalBytes = optionalBigInt(payload.quota);
    const usedBytes = optionalBigInt(payload.usedquota) ?? 0n;
    return {
      totalBytes,
      usedBytes,
      availableBytes: totalBytes === null ? null : totalBytes > usedBytes ? totalBytes - usedBytes : 0n,
      // pCloud reports no separate trash total in userinfo.
      trashBytes: null,
      raw: payload as unknown as Record<string, unknown>,
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
    const resumeToken =
      typeof input.resumeToken === 'string' && input.resumeToken.trim() !== '' ? input.resumeToken.trim() : null;
    if (resumeToken !== null) this.#require('uploadResumable'); // not in PCLOUD_CAPABILITIES: throws
    const client = await this.#client(ctx);
    const folderid = parentFolderId(normalizeParentId(input.parentId));

    const payload = await client.upload<PcloudUploadPayload>(
      { folderid, filename: name, nopartial: 1 },
      input.stream as Readable,
      { headers: { 'Content-Type': input.mimeType || FILE_MIME_TYPE }, timeoutMs: TRANSFER_TIMEOUT_MS },
    );
    const metadata = payload.metadata?.[0];
    if (metadata) return this.#uploadResult(metadata, input.sizeBytes);
    const fileid = payload.fileids?.[0];
    if (typeof fileid === 'number') {
      return { remoteId: `f${fileid}`, sizeBytes: input.sizeBytes, resumeToken: null };
    }
    throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'pCloud returned no id for the uploaded file');
  }

  #uploadResult(metadata: PcloudMetadata, declared: bigint): UploadResult {
    return {
      remoteId: remoteIdOf(metadata),
      sizeBytes: metadata.size !== undefined ? toBigInt(metadata.size) : declared,
      resumeToken: null,
    };
  }

  async download(ctx: ProviderContext, input: DownloadInput): Promise<DownloadResult> {
    this.#require('download');
    assertRange(input?.range);
    if (input?.range) this.#require('downloadRange');
    const remoteId = requireRemoteId(input?.remoteId);
    const parsed = parseRemoteId(remoteId);
    if (parsed.isFolder) {
      throw new ProviderError('ERR_INVALID_INPUT', `remoteId '${remoteId}' is a folder`);
    }
    const client = await this.#client(ctx);

    const stat = await client.call<PcloudMetadataPayload>('stat', { fileid: parsed.id });
    const metadata = stat.metadata;
    if (!metadata) {
      throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'pCloud returned no metadata');
    }
    const total = toBigInt(metadata.size ?? 0);
    if (input.range && (total === 0n || BigInt(input.range.start) >= total)) {
      throw new ProviderError('ERR_INVALID_INPUT', 'range start is outside the object');
    }

    const link = await client.call<PcloudLinkPayload>('getfilelink', { fileid: parsed.id, forcedownload: 1 });
    const host = typeof link.hosts?.[0] === 'string' ? link.hosts[0].trim() : '';
    const path = typeof link.path === 'string' ? link.path.trim() : '';
    if (!host || !path) {
      throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'pCloud returned no download host');
    }
    const url = pcloudCdnUrl(pcloudTransport().cdnScheme, host, path);

    const headers: Record<string, string> = {};
    if (input.range) {
      headers.Range =
        input.range.end !== undefined ? `bytes=${input.range.start}-${input.range.end}` : `bytes=${input.range.start}-`;
    }
    const download = await gatedRequest(url, {
      headers,
      signal: ctx.signal,
      timeoutMs: TRANSFER_TIMEOUT_MS,
    });

    if (download.statusCode >= 300) {
      if (download.statusCode >= 400) {
        const text = await readBodyText(download.body).catch(() => '');
        throw mapPcloudHttpError(download.statusCode, parseJson(text), text);
      }
      await download.body.dump({ limit: 64 * 1024 }).catch(() => undefined);
      throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'pCloud download redirect had no location');
    }

    const mimeType = headerString(download.headers['content-type']) ?? metadata.contenttype ?? null;
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
    // The CDN ignored the Range header and served the whole object from byte 0.
    const rangeTotal = Number(total) || (contentLength !== null ? Number(contentLength) : 0);
    return {
      stream: download.body,
      sizeBytes: total || (contentLength !== null ? BigInt(contentLength) : null),
      mimeType,
      range: rangeTotal > 0 ? { start: 0, end: rangeTotal - 1, total: rangeTotal } : undefined,
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
    const folderid = parentFolderId(parentId);
    const offset = typeof input?.cursor === 'string' && input.cursor.trim() !== '' ? decodeOffsetCursor(input.cursor) : 0;
    const client = await this.#client(ctx);

    // pCloud offers no server-side paging: each cursor re-fetches the folder
    // and slices it (documented in the provider doc).
    const page = await client.call<PcloudMetadataPayload>('listfolder', { folderid });
    const contents = Array.isArray(page.metadata?.contents) ? (page.metadata?.contents ?? []) : [];
    const slice = contents.slice(offset, offset + take);
    const entries = slice.map((meta) => toMeta(meta, parentId));
    const nextCursor = offset + slice.length < contents.length ? encodeOffsetCursor(offset + slice.length) : null;
    return { entries, nextCursor };
  }

  /**
   * pCloud has no search API: walk `listfolder?recursive=1` and filter names
   * case-insensitively. Each cursor re-walks the tree (O(tree) per page).
   */
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
    const offset = typeof input?.cursor === 'string' && input.cursor.trim() !== '' ? decodeOffsetCursor(input.cursor) : 0;
    const client = await this.#client(ctx);

    const page = await client.call<PcloudMetadataPayload>('listfolder', { folderid: ROOT_FOLDER_ID, recursive: 1 });
    const needle = term.toLowerCase();
    const matches = flattenTree(page.metadata).filter(
      (meta) => typeof meta.name === 'string' && meta.name.toLowerCase().includes(needle),
    );
    const slice = matches.slice(offset, offset + take);
    const entries = slice.map((meta) => toMeta(meta));
    const nextCursor = offset + slice.length < matches.length ? encodeOffsetCursor(offset + slice.length) : null;
    return { entries, nextCursor };
  }

  async getMetadata(ctx: ProviderContext, input: GetMetadataInput): Promise<RemoteFileMeta> {
    this.#require('getMetadata');
    const remoteId = requireRemoteId(input?.remoteId);
    const parsed = parseRemoteId(remoteId);
    const client = await this.#client(ctx);
    return this.#lookup(client, parsed);
  }

  async createFolder(ctx: ProviderContext, input: CreateFolderInput): Promise<RemoteFileMeta> {
    this.#require('createFolder');
    const name = requireEntryName(input?.name, 'name');
    const parentId = normalizeParentId(input?.parentId);
    const folderid = parentFolderId(parentId);
    const client = await this.#client(ctx);
    try {
      const response = await client.call<PcloudMetadataPayload>('createfolder', { folderid, name });
      return toMeta(response.metadata, parentId);
    } catch (error) {
      if (isPcloudConflictError(error)) {
        const existing = await this.#findChild(client, folderid, name, parentId);
        if (existing) return existing;
      }
      throw error;
    }
  }

  async rename(ctx: ProviderContext, input: RenameInput): Promise<RemoteFileMeta> {
    this.#require('rename');
    const remoteId = requireRemoteId(input?.remoteId);
    const newName = requireEntryName(input?.newName, 'newName');
    const parsed = parseRemoteId(remoteId);
    const client = await this.#client(ctx);
    const current = await this.#lookup(client, parsed);
    if (current.name === newName) return current;
    const method = parsed.isFolder ? 'renamefolder' : 'renamefile';
    const idParam = parsed.isFolder ? { folderid: parsed.id } : { fileid: parsed.id };
    const response = await client.call<PcloudMetadataPayload>(method, { ...idParam, toname: newName });
    if (response.metadata) return toMeta(response.metadata, current.parentId);
    return this.#lookup(client, parsed);
  }

  async move(ctx: ProviderContext, input: MoveInput): Promise<RemoteFileMeta> {
    this.#require('move');
    const remoteId = requireRemoteId(input?.remoteId);
    const destination = normalizeParentId(input?.newParentId);
    const destinationId = parentFolderId(destination);
    const parsed = parseRemoteId(remoteId);
    const client = await this.#client(ctx);
    const current = await this.#lookup(client, parsed);
    const currentParentId = current.parentId === null ? ROOT_FOLDER_ID : parentFolderId(current.parentId);
    if (destinationId === currentParentId) return current;
    if (parsed.isFolder && destinationId === parsed.id) {
      throw new ProviderError('ERR_INVALID_INPUT', 'cannot move a folder into itself');
    }
    const method = parsed.isFolder ? 'renamefolder' : 'renamefile';
    const idParam = parsed.isFolder ? { folderid: parsed.id } : { fileid: parsed.id };
    const response = await client.call<PcloudMetadataPayload>(method, { ...idParam, tofolderid: destinationId });
    const destinationRemote = folderIdRemote(destinationId);
    if (response.metadata) return toMeta(response.metadata, destinationRemote);
    return this.#lookup(client, parsed);
  }

  async copy(ctx: ProviderContext, input: CopyInput): Promise<RemoteFileMeta> {
    this.#require('copy');
    const remoteId = requireRemoteId(input?.remoteId);
    const destination = normalizeParentId(input?.newParentId);
    const destinationId = parentFolderId(destination);
    const parsed = parseRemoteId(remoteId);
    const client = await this.#client(ctx);
    const current = await this.#lookup(client, parsed);
    const name =
      input.newName !== undefined && input.newName !== null && input.newName !== ''
        ? requireEntryName(input.newName, 'newName')
        : current.name;
    if (parsed.isFolder && destinationId === parsed.id) {
      throw new ProviderError('ERR_INVALID_INPUT', 'cannot copy a folder into itself');
    }
    const method = parsed.isFolder ? 'copyfolder' : 'copyfile';
    const idParam = parsed.isFolder ? { folderid: parsed.id } : { fileid: parsed.id };
    // `noover=1`: fail with 2004 (→ ERR_INVALID_INPUT) instead of silently
    // replacing an existing destination, matching copy semantics elsewhere.
    const response = await client.call<PcloudMetadataPayload>(method, {
      ...idParam,
      tofolderid: destinationId,
      toname: name,
      noover: 1,
    });
    const destinationRemote = folderIdRemote(destinationId);
    if (response.metadata) return toMeta(response.metadata, destinationRemote);
    const existing = await this.#findChild(client, destinationId, name, destinationRemote);
    if (existing) return existing;
    throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'pCloud returned no metadata for the copy');
  }

  async delete(ctx: ProviderContext, input: DeleteInput): Promise<void> {
    this.#require('delete');
    const remoteId = requireRemoteId(input?.remoteId);
    const parsed = parseRemoteId(remoteId);
    if (parsed.isFolder && parsed.id === ROOT_FOLDER_ID) {
      throw new ProviderError('ERR_INVALID_INPUT', 'the root folder cannot be deleted');
    }
    const client = await this.#client(ctx);
    if (!parsed.isFolder) {
      await client.call('deletefile', { fileid: parsed.id });
      return;
    }
    if (input?.permanent === true) {
      await client.call('deletefolderrecursive', { folderid: parsed.id });
      return;
    }
    try {
      // Empty folders go to the recoverable trash (contract §11).
      await client.call('deletefolder', { folderid: parsed.id });
    } catch (error) {
      if (!isPcloudNotEmptyError(error)) throw error;
      // pCloud offers no recursive trash: non-empty folders are purged
      // outright. `permanent` only decides whether we skip the trash attempt.
      await client.call('deletefolderrecursive', { folderid: parsed.id });
    }
  }

  async createShare(ctx: ProviderContext, input: CreateShareInput): Promise<ShareResult> {
    this.#require('createShare');
    const remoteId = requireRemoteId(input?.remoteId);
    const client = await this.#client(ctx);

    if (input?.visibility === 'private') {
      const links = await this.#pubLinksFor(client, remoteId);
      for (const link of links) {
        if (typeof link.linkid === 'number') await this.#deletePubLink(client, link.linkid);
      }
      return { url: '', visibility: 'private', expiresAt: null };
    }
    if (input?.visibility !== 'public_read') {
      throw new ProviderError(
        'ERR_INVALID_INPUT',
        `provider '${this.id}' only supports the 'public_read' and 'private' share visibilities`,
      );
    }

    const expiry = requireFutureDate(input.expiresAt, 'expiresAt');
    const parsed = parseRemoteId(remoteId);
    const method = parsed.isFolder ? 'getfolderpublink' : 'getfilepublink';
    const idParam = parsed.isFolder ? { folderid: parsed.id } : { fileid: parsed.id };
    const params: Record<string, string | number | undefined> = { ...idParam };
    if (expiry) params.expire = toRfc2822(expiry);
    const response = await client.call<PcloudLinkPayload>(method, params);
    const url = typeof response.link === 'string' ? response.link.trim() : '';
    if (!url) {
      throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'pCloud returned no public link');
    }
    const upstreamExpiry = normalizeTimestamp(response.expires);
    return {
      url,
      visibility: 'public_read',
      expiresAt: upstreamExpiry ?? (expiry ? toIsoString(expiry) : null),
    };
  }

  async revokeShare(ctx: ProviderContext, input: RevokeShareInput): Promise<void> {
    this.#require('revokeShare');
    const remoteId = requireRemoteId(input?.remoteId);
    const client = await this.#client(ctx);
    const links = await this.#pubLinksFor(client, remoteId);
    if (links.length === 0) return; // already link-free: revoke is idempotent
    for (const link of links) {
      if (typeof link.linkid === 'number') await this.#deletePubLink(client, link.linkid);
    }
  }

  async healthCheck(ctx: ProviderContext): Promise<HealthResult> {
    this.#require('healthCheck');
    const startedAt = Date.now();
    const client = await this.#client(ctx);
    try {
      await client.call('userinfo');
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

  /** Files use `stat`; folders (and the root) use `listfolder` — `stat` is files-only. */
  async #lookup(client: PcloudClient, parsed: { isFolder: boolean; id: number }): Promise<RemoteFileMeta> {
    if (parsed.isFolder) {
      const page = await client.call<PcloudMetadataPayload>('listfolder', { folderid: parsed.id });
      return toMeta(page.metadata);
    }
    const stat = await client.call<PcloudMetadataPayload>('stat', { fileid: parsed.id });
    return toMeta(stat.metadata);
  }

  async #findChild(
    client: PcloudClient,
    folderid: number,
    name: string,
    knownParentId: string | null,
  ): Promise<RemoteFileMeta | null> {
    try {
      const page = await client.call<PcloudMetadataPayload>('listfolder', { folderid });
      const child = (page.metadata?.contents ?? []).find((entry) => entry.isdeleted !== true && entry.name === name);
      return child ? toMeta(child, knownParentId) : null;
    } catch (error) {
      if (ProviderError.is(error) && error.code === 'ERR_NOT_FOUND') return null;
      throw error;
    }
  }

  async #pubLinksFor(client: PcloudClient, remoteId: string): Promise<PcloudPubLink[]> {
    const response = await client.call<PcloudPubLinksPayload>('listpublinks');
    return (response.publinks ?? []).filter((link) => {
      if (!link.metadata) return false;
      try {
        return remoteIdOf(link.metadata) === remoteId;
      } catch {
        return false;
      }
    });
  }

  async #deletePubLink(client: PcloudClient, linkid: number): Promise<void> {
    try {
      await client.call('deletepublink', { linkid });
    } catch (error) {
      // 2027 — invalid or already deleted: treat as success (idempotent revoke).
      if (pcloudResultOf(error) === 2027) return;
      throw error;
    }
  }
}

/** pCloud honours every contract capability except resumable upload. */
export const PCLOUD_CAPABILITIES: readonly Capability[] = ALL_CAPABILITIES.filter(
  (capability) => capability !== 'uploadResumable',
);

export const pcloudProvider = new PcloudProvider();

export function createPcloudProvider(options: PcloudProviderOptions = {}): PcloudProvider {
  return new PcloudProvider(options);
}

export function registerPcloudProvider(): PcloudProvider {
  registerPcloudOAuth2Client();
  registry.register(pcloudProvider);
  return pcloudProvider;
}
