/**
 * Google Drive storage adapter — provider-contract §4 (StorageProvider) and §11
 * (per-account "9drive" root folder, export conversion, resumable upload,
 * reader-only public sharing).
 *
 * Importing this module registers the OAuth2 client config (§8);
 * `registerGoogleDriveProvider()` puts the adapter on the shared registry (§6).
 */

import { Readable } from 'node:stream';
import { ProviderError } from '../errors.js';
import { mapErrorToHealthState } from '../health.js';
import { refreshAccessToken } from '../oauth2.js';
import { registry } from '../registry.js';
import {
  ALL_CAPABILITIES,
  type AccountInfo,
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
import { DriveApiClient, TRANSFER_TIMEOUT_MS, type DriveRequestInit } from './client.js';
import { isMissingParentError, mapGoogleHttpError } from './errors.js';
import {
  DEFAULT_UPLOAD_MIME_TYPE,
  GOOGLE_FOLDER_MIME_TYPE,
  escapeDriveQueryValue,
  exportTargetFor,
  isGoogleWorkspaceType,
} from './mime.js';
import { registerGoogleDriveOAuth2Client } from './oauth2.js';
import { assertSessionUriAllowed, googleDriveTransport } from './transport.js';

const FILE_FIELDS =
  'id,name,mimeType,size,parents,createdTime,modifiedTime,md5Checksum,webViewLink,trashed';
const PAGE_FIELDS = `nextPageToken,files(${FILE_FIELDS})`;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1000;
const MULTIPART_BOUNDARY = '9drive-google-drive-boundary';

export const GOOGLE_DRIVE_ROOT_FOLDER_NAME = '9drive';
export const GOOGLE_DRIVE_RESUMABLE_THRESHOLD_BYTES = 5n * 1024n * 1024n;
export const GOOGLE_DRIVE_CHUNK_BYTES = 8 * 1024 * 1024;

interface DriveFile {
  id?: string;
  name?: string;
  mimeType?: string;
  size?: string;
  parents?: string[];
  createdTime?: string;
  modifiedTime?: string;
  md5Checksum?: string;
  webViewLink?: string;
  trashed?: boolean;
}

interface DriveListResponse {
  files?: DriveFile[];
  nextPageToken?: string;
}

function toBigInt(value: string | undefined): bigint {
  if (!value) return 0n;
  try {
    const parsed = BigInt(value);
    return parsed < 0n ? 0n : parsed;
  } catch {
    return 0n;
  }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseCommittedOffset(range: string | undefined): bigint | null {
  if (!range) return null;
  const match = /bytes=(\d+)-(\d+)/.exec(range);
  if (!match) return null;
  try {
    return BigInt(match[2]) + 1n;
  } catch {
    return null;
  }
}

function parseContentRange(value: string): { start: number; end: number; total: number | null } | null {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/.exec(value.trim());
  if (!match) return null;
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    total: match[3] === '*' ? null : Number(match[3]),
  };
}

function isRootRequest(parentId: string | null | undefined): boolean {
  return parentId === null || parentId === undefined || parentId.trim() === '';
}

function webViewUrl(file: DriveFile, remoteId: string): string {
  if (typeof file.webViewLink === 'string' && file.webViewLink.length > 0) return file.webViewLink;
  return file.mimeType === GOOGLE_FOLDER_MIME_TYPE
    ? `https://drive.google.com/drive/folders/${remoteId}`
    : `https://drive.google.com/file/d/${remoteId}/view`;
}

function toMeta(file: DriveFile, rootId: string): RemoteFileMeta {
  const remoteId = file.id ?? '';
  const parents = Array.isArray(file.parents) ? file.parents : [];
  const rawParent = parents[0] ?? null;
  const parentId = rawParent !== null && rawParent !== rootId ? rawParent : null;
  return {
    remoteId,
    name: file.name ?? '',
    mimeType: file.mimeType ?? DEFAULT_UPLOAD_MIME_TYPE,
    sizeBytes: toBigInt(file.size),
    parentId,
    isFolder: file.mimeType === GOOGLE_FOLDER_MIME_TYPE,
    createdAt: file.createdTime ?? null,
    modifiedAt: file.modifiedTime ?? null,
    checksum: file.md5Checksum ?? null,
    webUrl: webViewUrl(file, remoteId),
  };
}

function compareMeta(a: RemoteFileMeta, b: RemoteFileMeta): number {
  if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.remoteId < b.remoteId ? -1 : a.remoteId > b.remoteId ? 1 : 0;
}

function requireRemoteId(remoteId: string): string {
  if (typeof remoteId !== 'string' || remoteId.trim() === '') {
    throw new ProviderError('ERR_INVALID_INPUT', 'remoteId is required');
  }
  return remoteId.trim();
}

function assertRange(range: { start: number; end?: number } | undefined): void {
  if (!range) return;
  if (!Number.isInteger(range.start) || range.start < 0) {
    throw new ProviderError('ERR_INVALID_INPUT', 'range.start must be a non-negative integer');
  }
  if (range.end !== undefined && (!Number.isInteger(range.end) || range.end < range.start)) {
    throw new ProviderError('ERR_INVALID_INPUT', 'range.end must be an integer greater than or equal to range.start');
  }
}

async function* chunkReadable(
  stream: NodeJS.ReadableStream,
  chunkBytes: number,
  skipBytes: bigint,
): AsyncGenerator<Buffer> {
  const source = stream as AsyncIterable<Buffer | string>;
  const pending: Buffer[] = [];
  let pendingBytes = 0;
  let remaining = skipBytes;

  const take = (size: number): Buffer => {
    if (pending.length === 1 && pending[0].byteLength === size) {
      pendingBytes -= size;
      return pending.shift() as Buffer;
    }
    const out = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const head = pending[0];
      const needed = size - offset;
      if (head.byteLength <= needed) {
        head.copy(out, offset);
        offset += head.byteLength;
        pending.shift();
      } else {
        head.copy(out, offset, 0, needed);
        pending[0] = head.subarray(needed);
        offset = size;
      }
    }
    pendingBytes -= size;
    return out;
  };

  for await (const chunk of source) {
    let buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    if (remaining > 0n) {
      const drop = remaining < BigInt(buffer.byteLength) ? remaining : BigInt(buffer.byteLength);
      buffer = buffer.subarray(Number(drop));
      remaining -= drop;
      if (buffer.byteLength === 0) continue;
    }
    pending.push(buffer);
    pendingBytes += buffer.byteLength;
    while (pendingBytes >= chunkBytes) yield take(chunkBytes);
  }
  if (remaining > 0n) {
    throw new ProviderError('ERR_INVALID_INPUT', `stream ended ${remaining} bytes before the resume offset`);
  }
  while (pendingBytes > 0) yield take(Math.min(pendingBytes, chunkBytes));
}

async function* multipartBody(
  prefix: Buffer,
  suffix: Buffer,
  stream: NodeJS.ReadableStream,
  declared: bigint,
  onError: (error: ProviderError) => void,
): AsyncGenerator<Buffer> {
  yield prefix;
  let sent = 0n;
  const source = stream as AsyncIterable<Buffer | string>;
  for await (const chunk of source) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    sent += BigInt(buffer.byteLength);
    if (sent > declared) {
      const error = new ProviderError('ERR_INVALID_INPUT', `stream delivered more bytes than sizeBytes (${declared})`);
      onError(error);
      throw error;
    }
    yield buffer;
  }
  if (sent !== declared) {
    const error = new ProviderError('ERR_INVALID_INPUT', `stream delivered ${sent} bytes, expected ${declared}`);
    onError(error);
    throw error;
  }
  yield suffix;
}

export interface GoogleDriveProviderOptions {
  capabilities?: Iterable<Capability>;
}

export class GoogleDriveProvider implements StorageProvider {
  readonly id: ProviderId = 'google_drive';
  readonly displayName = 'Google Drive';
  readonly authMode = 'oauth2' as const;
  readonly capabilities: ReadonlySet<Capability>;

  readonly #rootFolders = new Map<string, string>();

  constructor(options: GoogleDriveProviderOptions = {}) {
    this.capabilities = new Set(options.capabilities ?? ALL_CAPABILITIES);
  }

  getCapabilities(): ReadonlySet<Capability> {
    return this.capabilities;
  }

  clearRootFolderCache(accountId?: string): void {
    if (accountId === undefined) this.#rootFolders.clear();
    else this.#rootFolders.delete(accountId);
  }

  async getAccountInfo(ctx: ProviderContext): Promise<AccountInfo> {
    this.#require('getAccountInfo');
    const client = this.#client(ctx);
    try {
      const profile = await client.json<{ id?: string; email?: string; name?: string; picture?: string }>(
        'GET',
        '/oauth2/v2/userinfo',
      );
      const id = typeof profile.data.id === 'string' ? profile.data.id.trim() : '';
      if (id) {
        return {
          providerAccountId: id,
          email: profile.data.email ?? null,
          displayName: profile.data.name ?? null,
          avatarUrl: profile.data.picture ?? null,
        };
      }
    } catch (error) {
      if (!ProviderError.is(error)) throw error;
    }
    const about = await client.json<{ user?: { permissionId?: string; emailAddress?: string; displayName?: string; photoLink?: string } }>(
      'GET',
      '/drive/v3/about',
      { query: { fields: 'user' } },
    );
    const user = about.data.user;
    return {
      providerAccountId: user?.permissionId?.trim() || ctx.account.providerAccountId,
      email: user?.emailAddress ?? null,
      displayName: user?.displayName ?? ctx.account.displayName ?? null,
      avatarUrl: user?.photoLink ?? null,
    };
  }

  async getQuota(ctx: ProviderContext): Promise<QuotaInfo> {
    this.#require('getQuota');
    const client = this.#client(ctx);
    const about = await client.json<{
      storageQuota?: { limit?: string; usage?: string; usageInDriveTrash?: string };
    }>('GET', '/drive/v3/about', { query: { fields: 'storageQuota' } });
    const quota = about.data.storageQuota ?? {};
    const totalBytes = quota.limit ? toBigInt(quota.limit) : null;
    const usedBytes = quota.usage ? toBigInt(quota.usage) : 0n;
    return {
      totalBytes,
      usedBytes,
      availableBytes: totalBytes === null ? null : totalBytes > usedBytes ? totalBytes - usedBytes : 0n,
      trashBytes: quota.usageInDriveTrash !== undefined ? toBigInt(quota.usageInDriveTrash) : null,
      raw: { ...quota },
    };
  }

  async upload(ctx: ProviderContext, input: UploadInput): Promise<UploadResult> {
    this.#require('upload');
    if (!input || typeof input.fileName !== 'string' || input.fileName.trim() === '') {
      throw new ProviderError('ERR_INVALID_INPUT', 'fileName is required');
    }
    if (!input.stream || typeof input.stream.pipe !== 'function') {
      throw new ProviderError('ERR_INVALID_INPUT', 'stream is required');
    }
    if (typeof input.sizeBytes !== 'bigint' || input.sizeBytes < 0n) {
      throw new ProviderError('ERR_INVALID_INPUT', 'sizeBytes must be a non-negative bigint');
    }
    const resumeToken =
      typeof input.resumeToken === 'string' && input.resumeToken.trim() !== '' ? input.resumeToken.trim() : null;
    if (resumeToken !== null) this.#require('uploadResumable');
    const mimeType =
      typeof input.mimeType === 'string' && input.mimeType.trim() !== ''
        ? input.mimeType.trim()
        : DEFAULT_UPLOAD_MIME_TYPE;
    const client = this.#client(ctx);

    return this.#withRootFallback(ctx, input.parentId, async () => {
      const parentId = await this.#resolveParentId(ctx, client, input.parentId);
      const target = { fileName: input.fileName, mimeType, parentId };
      if (resumeToken !== null || input.sizeBytes >= GOOGLE_DRIVE_RESUMABLE_THRESHOLD_BYTES) {
        this.#require('uploadResumable');
        return this.#resumableUpload(client, input, target, resumeToken);
      }
      return this.#multipartUpload(client, input, target);
    });
  }

  async download(ctx: ProviderContext, input: DownloadInput): Promise<DownloadResult> {
    this.#require('download');
    assertRange(input?.range);
    if (input?.range) this.#require('downloadRange');
    const remoteId = requireRemoteId(input.remoteId);
    const client = this.#client(ctx);
    const file = await this.#getFile(client, remoteId, FILE_FIELDS);
    const mimeType = file.mimeType ?? DEFAULT_UPLOAD_MIME_TYPE;
    if (mimeType === GOOGLE_FOLDER_MIME_TYPE) {
      throw new ProviderError('ERR_INVALID_INPUT', `remoteId '${remoteId}' is a folder`);
    }

    if (isGoogleWorkspaceType(mimeType)) {
      if (input.range) {
        throw new ProviderError('ERR_INVALID_INPUT', 'byte ranges are not supported for Google Workspace exports');
      }
      const target = exportTargetFor(mimeType);
      if (!target) {
        throw new ProviderError('ERR_INVALID_INPUT', `Google Drive type '${mimeType}' cannot be exported`);
      }
      const response = await client.stream('GET', `/drive/v3/files/${encodeURIComponent(remoteId)}/export`, {
        query: { mimeType: target.mimeType },
        timeoutMs: TRANSFER_TIMEOUT_MS,
      });
      const length = firstHeader(response.headers['content-length']);
      return {
        stream: response.body,
        sizeBytes: length ? toBigInt(length) : null,
        mimeType: target.mimeType,
      };
    }

    const response = await client.stream('GET', `/drive/v3/files/${encodeURIComponent(remoteId)}`, {
      query: { alt: 'media' },
      headers: input.range
        ? { Range: `bytes=${input.range.start}-${input.range.end === undefined ? '' : input.range.end}` }
        : {},
      timeoutMs: TRANSFER_TIMEOUT_MS,
    });
    const contentLength = firstHeader(response.headers['content-length']);
    const contentRange = firstHeader(response.headers['content-range']);
    const parsed = contentRange ? parseContentRange(contentRange) : null;
    if (parsed) {
      return {
        stream: response.body,
        sizeBytes: contentLength ? toBigInt(contentLength) : BigInt(parsed.end - parsed.start + 1),
        mimeType,
        range: { start: parsed.start, end: parsed.end, total: parsed.total },
      };
    }
    return {
      stream: response.body,
      sizeBytes: contentLength ? toBigInt(contentLength) : toBigInt(file.size),
      mimeType,
    };
  }

  async list(ctx: ProviderContext, input: ListInput): Promise<ListResult> {
    this.#require('list');
    const limit = this.#pageLimit(input?.limit);
    const cursor = typeof input?.cursor === 'string' && input.cursor.trim() !== '' ? input.cursor : null;
    const client = this.#client(ctx);
    const rootId = await this.#rootFolderId(ctx, client);
    const parent = isRootRequest(input?.parentId) ? rootId : (input.parentId as string);
    const response = await client.json<DriveListResponse>('GET', '/drive/v3/files', {
      query: {
        q: `'${parent}' in parents and trashed = false`,
        spaces: 'drive',
        pageSize: String(limit),
        fields: PAGE_FIELDS,
        ...(cursor ? { pageToken: cursor } : {}),
      },
    });
    return this.#mapPage(response.data, rootId);
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
    const limit = this.#pageLimit(input?.limit);
    const cursor = typeof input?.cursor === 'string' && input.cursor.trim() !== '' ? input.cursor : null;
    const client = this.#client(ctx);
    const rootId = await this.#rootFolderId(ctx, client);
    const response = await client.json<DriveListResponse>('GET', '/drive/v3/files', {
      query: {
        q: `name contains '${escapeDriveQueryValue(term)}' and trashed = false`,
        spaces: 'drive',
        corpora: 'user',
        pageSize: String(limit),
        fields: PAGE_FIELDS,
        ...(cursor ? { pageToken: cursor } : {}),
      },
    });
    return this.#mapPage(response.data, rootId);
  }

  async getMetadata(ctx: ProviderContext, input: GetMetadataInput): Promise<RemoteFileMeta> {
    this.#require('getMetadata');
    const remoteId = requireRemoteId(input?.remoteId);
    const client = this.#client(ctx);
    const rootId = await this.#rootFolderId(ctx, client);
    const file = await this.#getFile(client, remoteId, FILE_FIELDS);
    return toMeta(file, rootId);
  }

  async createFolder(ctx: ProviderContext, input: CreateFolderInput): Promise<RemoteFileMeta> {
    this.#require('createFolder');
    const name = typeof input?.name === 'string' ? input.name.trim() : '';
    if (name === '') {
      throw new ProviderError('ERR_INVALID_INPUT', 'name is required');
    }
    const client = this.#client(ctx);
    return this.#withRootFallback(ctx, input.parentId, async () => {
      const parentId = await this.#resolveParentId(ctx, client, input.parentId);
      const rootId = await this.#rootFolderId(ctx, client);
      const response = await client.json<DriveFile>('POST', '/drive/v3/files', {
        payload: { name, mimeType: GOOGLE_FOLDER_MIME_TYPE, parents: [parentId] },
        query: { fields: FILE_FIELDS },
      });
      return toMeta(response.data, rootId);
    });
  }

  async rename(ctx: ProviderContext, input: RenameInput): Promise<RemoteFileMeta> {
    this.#require('rename');
    const remoteId = requireRemoteId(input?.remoteId);
    const newName = typeof input.newName === 'string' ? input.newName.trim() : '';
    if (newName === '') {
      throw new ProviderError('ERR_INVALID_INPUT', 'newName is required');
    }
    const client = this.#client(ctx);
    const rootId = await this.#rootFolderId(ctx, client);
    const response = await client.json<DriveFile>('PATCH', `/drive/v3/files/${encodeURIComponent(remoteId)}`, {
      payload: { name: newName },
      query: { fields: FILE_FIELDS },
    });
    return toMeta(response.data, rootId);
  }

  async move(ctx: ProviderContext, input: MoveInput): Promise<RemoteFileMeta> {
    this.#require('move');
    const remoteId = requireRemoteId(input?.remoteId);
    const client = this.#client(ctx);
    return this.#withRootFallback(ctx, input.newParentId, async () => {
      const target = await this.#resolveParentId(ctx, client, input.newParentId);
      const current = await this.#getFile(client, remoteId, FILE_FIELDS);
      const parents = Array.isArray(current.parents) ? current.parents : [];
      if (parents.includes(target)) {
        const rootId = await this.#rootFolderId(ctx, client);
        return toMeta(current, rootId);
      }
      const removeParents = parents.filter((parent) => parent !== target).join(',');
      const response = await client.json<DriveFile>('PATCH', `/drive/v3/files/${encodeURIComponent(remoteId)}`, {
        query: {
          addParents: target,
          ...(removeParents ? { removeParents } : {}),
          fields: FILE_FIELDS,
        },
        payload: {},
      });
      const rootId = await this.#rootFolderId(ctx, client);
      return toMeta(response.data, rootId);
    });
  }

  async copy(ctx: ProviderContext, input: CopyInput): Promise<RemoteFileMeta> {
    this.#require('copy');
    const remoteId = requireRemoteId(input?.remoteId);
    const client = this.#client(ctx);
    return this.#withRootFallback(ctx, input.newParentId, async () => {
      const parentId = await this.#resolveParentId(ctx, client, input.newParentId);
      const rootId = await this.#rootFolderId(ctx, client);
      const newName = typeof input.newName === 'string' ? input.newName.trim() : '';
      const response = await client.json<DriveFile>('POST', `/drive/v3/files/${encodeURIComponent(remoteId)}/copy`, {
        payload: { ...(newName ? { name: newName } : {}), parents: [parentId] },
        query: { fields: FILE_FIELDS },
      });
      return toMeta(response.data, rootId);
    });
  }

  async delete(ctx: ProviderContext, input: DeleteInput): Promise<void> {
    this.#require('delete');
    const remoteId = requireRemoteId(input?.remoteId);
    const client = this.#client(ctx);
    if (input.permanent) {
      await client.json('DELETE', `/drive/v3/files/${encodeURIComponent(remoteId)}`);
      return;
    }
    await client.json('PATCH', `/drive/v3/files/${encodeURIComponent(remoteId)}`, {
      payload: { trashed: true },
      query: { fields: 'id,trashed' },
    });
  }

  async createShare(ctx: ProviderContext, input: CreateShareInput): Promise<ShareResult> {
    this.#require('createShare');
    const remoteId = requireRemoteId(input?.remoteId);
    if (input.visibility !== 'public_read' && input.visibility !== 'private') {
      throw new ProviderError('ERR_INVALID_INPUT', `unsupported share visibility '${String(input.visibility)}'`);
    }
    const client = this.#client(ctx);
    const expiresAt = typeof input.expiresAt === 'string' && input.expiresAt.trim() !== '' ? input.expiresAt.trim() : null;

    if (input.visibility === 'private') {
      await this.#removeAnyonePermissions(client, remoteId);
      return { url: '', visibility: 'private', expiresAt: null };
    }

    const permissions = await this.#listPermissions(client, remoteId);
    const anyone = permissions.find((permission) => permission.type === 'anyone' && permission.id);
    if (anyone?.id) {
      const downgrade = anyone.role !== 'reader' || expiresAt !== null;
      if (downgrade) {
        await client.json('PATCH', `/drive/v3/files/${encodeURIComponent(remoteId)}/permissions/${anyone.id}`, {
          payload: { role: 'reader', ...(expiresAt ? { expirationTime: expiresAt } : {}) },
          query: { fields: 'id,type,role,expirationTime' },
        });
      }
    } else {
      await client.json('POST', `/drive/v3/files/${encodeURIComponent(remoteId)}/permissions`, {
        payload: {
          type: 'anyone',
          role: 'reader',
          allowFileDiscovery: false,
          ...(expiresAt ? { expirationTime: expiresAt } : {}),
        },
        query: { fields: 'id,type,role,expirationTime' },
      });
    }
    const file = await this.#getFile(client, remoteId, 'id,webViewLink');
    return { url: webViewUrl(file, remoteId), visibility: 'public_read', expiresAt };
  }

  async revokeShare(ctx: ProviderContext, input: RevokeShareInput): Promise<void> {
    this.#require('revokeShare');
    const remoteId = requireRemoteId(input?.remoteId);
    const client = this.#client(ctx);
    await this.#removeAnyonePermissions(client, remoteId);
  }

  async healthCheck(ctx: ProviderContext): Promise<HealthResult> {
    this.#require('healthCheck');
    const startedAt = Date.now();
    const client = this.#client(ctx);
    try {
      await client.json('GET', '/drive/v3/about', { query: { fields: 'user' } });
      return {
        state: 'healthy',
        latencyMs: Date.now() - startedAt,
        message: null,
        checkedAt: new Date().toISOString(),
      };
    } catch (error) {
      return {
        state: mapErrorToHealthState(error),
        latencyMs: Date.now() - startedAt,
        message: ProviderError.is(error) ? error.message : 'Google Drive health check failed',
        checkedAt: new Date().toISOString(),
      };
    }
  }

  #require(capability: Capability): void {
    if (!this.capabilities.has(capability)) {
      throw new ProviderError(
        'ERR_CAPABILITY_UNSUPPORTED',
        `provider '${this.id}' does not declare capability '${capability}'`,
      );
    }
  }

  #client(ctx: ProviderContext): DriveApiClient {
    if (ctx.credentials.kind !== 'oauth2') {
      throw new ProviderError(
        'ERR_INVALID_INPUT',
        `provider '${this.id}' requires oauth2 credentials, received '${ctx.credentials.kind}'`,
      );
    }
    const credentials = ctx.credentials;
    let accessToken = credentials.accessToken;
    return new DriveApiClient({
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
            tokenUrl: googleDriveTransport().tokenUrl,
            signal: ctx.signal,
          });
          accessToken = refreshed.accessToken;
          return true;
        },
      },
    });
  }

  #pageLimit(limit: number | undefined): number {
    if (limit === undefined || limit === null) return DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new ProviderError('ERR_INVALID_INPUT', 'limit must be a positive integer');
    }
    return Math.min(limit, MAX_PAGE_SIZE);
  }

  #mapPage(data: DriveListResponse, rootId: string): ListResult {
    const files = Array.isArray(data.files) ? data.files : [];
    const entries = files
      .filter((file) => typeof file.id === 'string' && file.id.length > 0)
      .map((file) => toMeta(file, rootId));
    entries.sort(compareMeta);
    const nextCursor = typeof data.nextPageToken === 'string' && data.nextPageToken !== '' ? data.nextPageToken : null;
    return { entries, nextCursor };
  }

  async #withRootFallback<T>(ctx: ProviderContext, parentId: string | null, run: () => Promise<T>): Promise<T> {
    if (!isRootRequest(parentId)) return run();
    try {
      return await run();
    } catch (error) {
      if (isMissingParentError(error)) this.#rootFolders.delete(ctx.account.id);
      throw error;
    }
  }

  async #resolveParentId(ctx: ProviderContext, client: DriveApiClient, parentId: string | null): Promise<string> {
    if (parentId !== null && parentId.trim() !== '') return parentId.trim();
    return this.#rootFolderId(ctx, client);
  }

  async #rootFolderId(ctx: ProviderContext, client: DriveApiClient): Promise<string> {
    const cached = this.#rootFolders.get(ctx.account.id);
    if (cached) return cached;
    const existing = await client.json<DriveListResponse>('GET', '/drive/v3/files', {
      query: {
        q: `'root' in parents and name = '${GOOGLE_DRIVE_ROOT_FOLDER_NAME}' and mimeType = '${GOOGLE_FOLDER_MIME_TYPE}' and trashed = false`,
        spaces: 'drive',
        pageSize: '10',
        fields: 'files(id,name,mimeType)',
      },
    });
    const found = (existing.data.files ?? []).find((file) => typeof file.id === 'string' && file.id.length > 0);
    if (found?.id) {
      this.#rootFolders.set(ctx.account.id, found.id);
      return found.id;
    }
    const created = await client.json<DriveFile>('POST', '/drive/v3/files', {
      payload: { name: GOOGLE_DRIVE_ROOT_FOLDER_NAME, mimeType: GOOGLE_FOLDER_MIME_TYPE },
      query: { fields: 'id,name,mimeType' },
    });
    const id = typeof created.data.id === 'string' ? created.data.id.trim() : '';
    if (!id) {
      throw new ProviderError('ERR_INTERNAL', 'Google Drive did not return an id for the 9drive root folder');
    }
    this.#rootFolders.set(ctx.account.id, id);
    return id;
  }

  async #getFile(client: DriveApiClient, remoteId: string, fields: string): Promise<DriveFile> {
    const response = await client.json<DriveFile>('GET', `/drive/v3/files/${encodeURIComponent(remoteId)}`, {
      query: { fields },
    });
    if (typeof response.data?.id !== 'string' || response.data.id === '') {
      throw new ProviderError('ERR_INTERNAL', 'Google Drive returned no id for the file');
    }
    return response.data;
  }

  async #listPermissions(
    client: DriveApiClient,
    remoteId: string,
  ): Promise<{ id?: string; type?: string; role?: string }[]> {
    const response = await client.json<{ permissions?: { id?: string; type?: string; role?: string }[] }>(
      'GET',
      `/drive/v3/files/${encodeURIComponent(remoteId)}/permissions`,
      { query: { fields: 'permissions(id,type,role)', pageSize: '100' } },
    );
    return Array.isArray(response.data.permissions) ? response.data.permissions : [];
  }

  async #removeAnyonePermissions(client: DriveApiClient, remoteId: string): Promise<number> {
    const permissions = await this.#listPermissions(client, remoteId);
    let removed = 0;
    for (const permission of permissions) {
      if (permission.type !== 'anyone' || !permission.id) continue;
      try {
        await client.json('DELETE', `/drive/v3/files/${encodeURIComponent(remoteId)}/permissions/${permission.id}`);
        removed += 1;
      } catch (error) {
        if (ProviderError.is(error) && error.code === 'ERR_NOT_FOUND') continue;
        throw error;
      }
    }
    return removed;
  }

  async #multipartUpload(
    client: DriveApiClient,
    input: UploadInput,
    target: { fileName: string; mimeType: string; parentId: string },
  ): Promise<UploadResult> {
    const metadata = { name: target.fileName, mimeType: target.mimeType, parents: [target.parentId] };
    const prefix = Buffer.from(
      `--${MULTIPART_BOUNDARY}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(
        metadata,
      )}\r\n--${MULTIPART_BOUNDARY}\r\nContent-Type: ${target.mimeType}\r\n\r\n`,
      'utf8',
    );
    const suffix = Buffer.from(`\r\n--${MULTIPART_BOUNDARY}--`, 'utf8');
    const contentLength = prefix.byteLength + Number(input.sizeBytes) + suffix.byteLength;
    let streamError: ProviderError | null = null;
    const body = Readable.from(
      multipartBody(prefix, suffix, input.stream, input.sizeBytes, (error) => {
        streamError = error;
      }),
    );
    const init: DriveRequestInit = {
      query: { uploadType: 'multipart', fields: FILE_FIELDS },
      headers: {
        'Content-Type': `multipart/related; boundary=${MULTIPART_BOUNDARY}`,
        'Content-Length': String(contentLength),
      },
      body,
      timeoutMs: TRANSFER_TIMEOUT_MS,
    };
    let response;
    try {
      response = await client.json<DriveFile>('POST', '/upload/drive/v3/files', init);
    } catch (error) {
      throw streamError ?? error;
    }
    const remoteId = typeof response.data.id === 'string' ? response.data.id.trim() : '';
    if (!remoteId) throw new ProviderError('ERR_INTERNAL', 'Google Drive returned no id for the uploaded file');
    return { remoteId, sizeBytes: response.data.size ? toBigInt(response.data.size) : input.sizeBytes };
  }

  async #resumableUpload(
    client: DriveApiClient,
    input: UploadInput,
    target: { fileName: string; mimeType: string; parentId: string },
    resumeToken: string | null,
  ): Promise<UploadResult> {
    const totalKnown = input.sizeBytes > 0n;
    let sessionUri = resumeToken;
    let committed = 0n;

    if (sessionUri !== null) {
      if (!assertSessionUriAllowed(sessionUri)) {
        throw new ProviderError('ERR_SSRF_BLOCKED', 'the resume token is not an allowed upload session URL');
      }
      const status = await this.#resumableStatus(client, sessionUri, input.sizeBytes);
      if (status.file) return this.#uploadResult(status.file, input.sizeBytes, sessionUri);
      committed = status.offset;
    } else {
      const init = await client.json('POST', '/upload/drive/v3/files', {
        query: { uploadType: 'resumable' },
        headers: {
          'Content-Type': 'application/json',
          'X-Upload-Content-Type': target.mimeType,
          ...(totalKnown ? { 'X-Upload-Content-Length': input.sizeBytes.toString() } : {}),
        },
        payload: { name: target.fileName, mimeType: target.mimeType, parents: [target.parentId] },
        timeoutMs: TRANSFER_TIMEOUT_MS,
      });
      const location = firstHeader(init.headers.location);
      if (!location) {
        throw new ProviderError('ERR_INTERNAL', 'Google Drive did not return a resumable upload session URL');
      }
      if (!assertSessionUriAllowed(location)) {
        throw new ProviderError('ERR_SSRF_BLOCKED', 'Google Drive returned an upload session URL on an unexpected host');
      }
      sessionUri = location;
    }

    const uri = sessionUri;
    let completed: DriveFile | null = null;
    let stalls = 0;

    for await (const chunk of chunkReadable(input.stream, GOOGLE_DRIVE_CHUNK_BYTES, committed)) {
      let offset = 0;
      while (offset < chunk.byteLength) {
        const slice = chunk.subarray(offset);
        const start = committed;
        const end = start + BigInt(slice.byteLength) - 1n;
        if (totalKnown && end >= input.sizeBytes) {
          throw new ProviderError('ERR_INVALID_INPUT', `stream delivered more bytes than sizeBytes (${input.sizeBytes})`);
        }
        const response = await client.json<DriveFile>('PUT', uri, {
          headers: {
            'Content-Type': target.mimeType,
            'Content-Range': totalKnown
              ? `bytes ${start}-${end}/${input.sizeBytes}`
              : `bytes ${start}-${end}/*`,
          },
          body: Buffer.from(slice),
          timeoutMs: TRANSFER_TIMEOUT_MS,
        });
        if (response.status >= 200 && response.status < 300) {
          completed = response.data;
          offset = chunk.byteLength;
          break;
        }
        if (response.status !== 308) {
          throw mapGoogleHttpError(response.status, response.data, 'resumable chunk upload failed');
        }
        const serverOffset = parseCommittedOffset(firstHeader(response.headers.range));
        if (serverOffset !== null && serverOffset > committed) {
          committed = serverOffset;
          stalls = 0;
        } else {
          stalls += 1;
          if (stalls >= 3) {
            throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'Google Drive resumable upload session made no progress');
          }
        }
        offset = Number(committed - start);
        if (offset < 0) offset = 0;
        if (offset > chunk.byteLength) offset = chunk.byteLength;
      }
      if (completed) break;
    }

    if (!completed && totalKnown) {
      const status = await this.#resumableStatus(client, uri, input.sizeBytes);
      if (status.file) completed = status.file;
      else {
        throw new ProviderError(
          'ERR_INVALID_INPUT',
          `stream ended after ${status.offset} bytes, expected ${input.sizeBytes}`,
        );
      }
    }
    if (!completed && !totalKnown) {
      const finalize = await client.json<DriveFile>('PUT', uri, {
        headers: { 'Content-Range': `bytes */${committed}` },
        timeoutMs: TRANSFER_TIMEOUT_MS,
      });
      if (finalize.status >= 200 && finalize.status < 300) completed = finalize.data;
      else throw mapGoogleHttpError(finalize.status, finalize.data, 'resumable upload finalisation failed');
    }
    if (!completed) {
      throw new ProviderError('ERR_INTERNAL', 'Google Drive resumable upload did not return a file');
    }
    return this.#uploadResult(completed, input.sizeBytes, uri);
  }

  async #resumableStatus(
    client: DriveApiClient,
    sessionUri: string,
    sizeBytes: bigint,
  ): Promise<{ file: DriveFile | null; offset: bigint }> {
    const total = sizeBytes > 0n ? sizeBytes.toString() : '*';
    const response = await client.json<DriveFile>('PUT', sessionUri, {
      headers: { 'Content-Range': `bytes */${total}` },
      timeoutMs: TRANSFER_TIMEOUT_MS,
    });
    if (response.status >= 200 && response.status < 300) {
      return { file: response.data, offset: sizeBytes };
    }
    if (response.status === 308) {
      return { file: null, offset: parseCommittedOffset(firstHeader(response.headers.range)) ?? 0n };
    }
    throw mapGoogleHttpError(response.status, response.data, 'resumable upload status query failed');
  }

  #uploadResult(file: DriveFile, declared: bigint, resumeToken: string): UploadResult {
    const remoteId = typeof file.id === 'string' ? file.id.trim() : '';
    if (!remoteId) throw new ProviderError('ERR_INTERNAL', 'Google Drive returned no id for the uploaded file');
    return { remoteId, sizeBytes: file.size ? toBigInt(file.size) : declared, resumeToken };
  }
}

export const googleDriveProvider = new GoogleDriveProvider();

export function createGoogleDriveProvider(options: GoogleDriveProviderOptions = {}): GoogleDriveProvider {
  return new GoogleDriveProvider(options);
}

export function registerGoogleDriveProvider(): GoogleDriveProvider {
  registerGoogleDriveOAuth2Client();
  registry.register(googleDriveProvider);
  return googleDriveProvider;
}

export function clearGoogleDriveRootFolderCache(accountId?: string): void {
  googleDriveProvider.clearRootFolderCache(accountId);
}
