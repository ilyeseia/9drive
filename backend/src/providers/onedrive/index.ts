/**
 * OneDrive (Microsoft Graph) storage adapter — provider-contract §4
 * (StorageProvider) and §11: files at or below the 4 MB simple-upload limit use
 * `PUT .../content`, anything larger (or any resumed attempt) streams through
 * `createUploadSession` chunks; `download` follows the `.../content` redirect to
 * Graph's pre-authenticated URL; `list` pages with `@odata.nextLink`;
 * `search` uses `search(q=…)`; shares are `createLink` permissions.
 *
 * Importing this module registers the OAuth2 client config (§8);
 * `registerOnedriveProvider()` puts the adapter on the shared registry (§6).
 *
 * Quirks: `remoteId` is a Graph drive item id (`root` addresses the drive root);
 * `parentId` comes from `parentReference.id` (absent for root children → null);
 * `delete(permanent)` is accepted and ignored (Graph has no purge path beyond
 * DELETE); copy is a 202 monitor that is polled before the result resolves.
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
  JSON_TIMEOUT_MS,
  OnedriveClient,
  TRANSFER_TIMEOUT_MS,
  parseJson,
  readBodyText,
  type OnedriveSession,
} from './client.js';
import { isOnedriveConflictError, mapOnedriveHttpError, mapOnedriveTransportError } from './errors.js';
import { registerOnedriveOAuth2Client } from './oauth2.js';
import { graphUrl, onedriveTransport } from './transport.js';

const FILE_MIME_TYPE = 'application/octet-stream';
const FOLDER_MIME_TYPE = 'inode/directory';
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 200;
const ROOT_REMOTE_ID = 'root';

const DRIVE_ITEM_SELECT = [
  'id',
  'name',
  'size',
  'folder',
  'file',
  'createdDateTime',
  'lastModifiedDateTime',
  'parentReference',
  'webUrl',
  'deleted',
  'contentHash',
].join(',');

/** Files at or below this size use the simple content upload (contract §11). */
export const ONEDRIVE_SIMPLE_UPLOAD_THRESHOLD_BYTES = 4n * 1024n * 1024n;
/** Upload-session chunk size: a multiple of Graph's 320 KiB step, under 60 MiB. */
export const ONEDRIVE_UPLOAD_CHUNK_BYTES = 10 * 1024 * 1024;
/** Default polling budget for the 202 copy monitor. */
const COPY_POLL_ATTEMPTS = 30;
const COPY_POLL_DELAY_MS = 200;

interface GraphFileFacet {
  mimeType?: string;
}

interface GraphFolderFacet {
  childCount?: number;
}

interface GraphDeletedFacet {
  state?: string;
}

interface GraphParentReference {
  id?: string;
  driveId?: string;
  path?: string;
}

interface GraphPermissionLink {
  webUrl?: string;
  type?: string;
  scope?: string;
}

interface GraphPermission {
  id?: string;
  roles?: string[];
  link?: GraphPermissionLink;
  expirationDateTime?: string | null;
}

interface GraphDriveItem {
  id?: string;
  name?: string;
  size?: number;
  folder?: GraphFolderFacet;
  file?: GraphFileFacet;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  parentReference?: GraphParentReference;
  webUrl?: string;
  deleted?: GraphDeletedFacet;
  contentHash?: string;
}

interface GraphListPage {
  value?: GraphDriveItem[];
  '@odata.nextLink'?: string;
}

interface GraphQuota {
  total?: number;
  used?: number;
  deleted?: number;
  remaining?: number;
  state?: string;
}

interface GraphProfile {
  id?: string;
  displayName?: string;
  mail?: string;
  userPrincipalName?: string;
}

interface OnedriveResumeState {
  sessionUrl: string;
  offset: number;
}

export interface OnedriveProviderOptions {
  capabilities?: Iterable<Capability>;
  simpleUploadThresholdBytes?: bigint;
  uploadChunkBytes?: number;
  copyPollAttempts?: number;
  copyPollDelayMs?: number;
}

export function encodeOnedriveResumeToken(state: OnedriveResumeState): string {
  return Buffer.from(JSON.stringify({ url: state.sessionUrl, off: state.offset }), 'utf8').toString('base64url');
}

export function decodeOnedriveResumeToken(token: string): OnedriveResumeState | null {
  try {
    const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as { url?: unknown; off?: unknown };
    if (typeof parsed.url !== 'string' || !/^https?:\/\//.test(parsed.url)) return null;
    if (typeof parsed.off !== 'number' || !Number.isSafeInteger(parsed.off) || parsed.off < 0) return null;
    return { sessionUrl: parsed.url, offset: parsed.off };
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
  if (name === '') throw new ProviderError('ERR_INVALID_INPUT', `${field} is required`);
  if (name.includes('/')) throw new ProviderError('ERR_INVALID_INPUT', `${field} must not contain '/'`);
  if (name === '.' || name === '..') throw new ProviderError('ERR_INVALID_INPUT', `${field} is not a valid name`);
  return name;
}

function normalizeParentId(parentId: unknown): string | null {
  if (parentId === undefined || parentId === null || parentId === ROOT_REMOTE_ID) return null;
  if (typeof parentId !== 'string' || parentId.trim() === '') {
    throw new ProviderError('ERR_INVALID_INPUT', 'parentId must be a string or null');
  }
  return parentId;
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

/** Graph's `search(q='…')` literal: single quotes are escaped by doubling. */
function escapeSearchTerm(term: string): string {
  return term.replace(/'/g, "''");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ProviderError('ERR_TIMEOUT', 'OneDrive operation was aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(new ProviderError('ERR_TIMEOUT', 'OneDrive operation was aborted'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
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

/** Drops the first `count` bytes of the chunk stream (upload resume). */
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

export class OnedriveProvider implements StorageProvider {
  readonly id: ProviderId = 'onedrive';
  readonly displayName: string = 'OneDrive';
  readonly authMode: AuthMode = 'oauth2';
  readonly capabilities: ReadonlySet<Capability>;
  readonly #simpleUploadThresholdBytes: bigint;
  readonly #uploadChunkBytes: number;
  readonly #copyPollAttempts: number;
  readonly #copyPollDelayMs: number;

  constructor(options: OnedriveProviderOptions = {}) {
    this.capabilities = new Set(options.capabilities ?? ALL_CAPABILITIES);
    this.#simpleUploadThresholdBytes = options.simpleUploadThresholdBytes ?? ONEDRIVE_SIMPLE_UPLOAD_THRESHOLD_BYTES;
    this.#uploadChunkBytes = options.uploadChunkBytes ?? ONEDRIVE_UPLOAD_CHUNK_BYTES;
    this.#copyPollAttempts = options.copyPollAttempts ?? COPY_POLL_ATTEMPTS;
    this.#copyPollDelayMs = options.copyPollDelayMs ?? COPY_POLL_DELAY_MS;
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

  async #client(ctx: ProviderContext): Promise<OnedriveClient> {
    if (ctx.credentials.kind !== 'oauth2') {
      throw new ProviderError(
        'ERR_INVALID_INPUT',
        `provider '${this.id}' requires oauth2 credentials, received '${ctx.credentials.kind}'`,
      );
    }
    const credentials = ctx.credentials;
    const transport = onedriveTransport();
    const config = ctx.account.config ?? {};
    let accessToken = credentials.accessToken;
    return new OnedriveClient({
      baseUrl: await this.#endpoint(config, ['graphBaseUrl', 'baseUrl'], transport.graphUrl),
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
   * fixed official URL are not user input and stay ungated (security-contract §7).
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
    const response = await client.json<GraphProfile>('GET', graphUrl(client.baseUrl, '/me', {
      $select: 'id,displayName,mail,userPrincipalName',
    }));
    const providerAccountId = typeof response.data.id === 'string' ? response.data.id.trim() : '';
    if (!providerAccountId) {
      throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'OneDrive returned no account id');
    }
    return {
      providerAccountId,
      email: response.data.mail ?? response.data.userPrincipalName ?? null,
      displayName: response.data.displayName ?? null,
      avatarUrl: null,
    };
  }

  async getQuota(ctx: ProviderContext): Promise<QuotaInfo> {
    this.#require('getQuota');
    const client = await this.#client(ctx);
    const response = await client.json<{ quota?: GraphQuota }>('GET', graphUrl(client.baseUrl, '/me/drive', {
      $select: 'quota',
    }));
    const quota = response.data.quota ?? {};
    const totalBytes = quota.total !== undefined && quota.total > 0 ? toBigInt(quota.total) : null;
    const usedBytes = toBigInt(quota.used ?? 0);
    const trashBytes = quota.deleted !== undefined ? toBigInt(quota.deleted) : null;
    const availableBytes =
      quota.remaining !== undefined
        ? toBigInt(quota.remaining)
        : totalBytes === null
          ? null
          : totalBytes > usedBytes
            ? totalBytes - usedBytes
            : 0n;
    return { totalBytes, usedBytes, availableBytes, trashBytes, raw: quota as Record<string, unknown> };
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
    const resumeToken =
      typeof input.resumeToken === 'string' && input.resumeToken.trim() !== '' ? input.resumeToken.trim() : null;
    if (resumeToken !== null) this.#require('uploadResumable');
    const resume = resumeToken ? decodeOnedriveResumeToken(resumeToken) : null;
    if (resumeToken && !resume) {
      throw new ProviderError('ERR_INVALID_INPUT', 'resumeToken is not a valid OneDrive resume token');
    }
    if (resume && input.sizeBytes > 0n && resume.offset >= Number(input.sizeBytes)) {
      throw new ProviderError('ERR_INVALID_INPUT', 'resumeToken offset must be below the declared sizeBytes');
    }

    try {
      if (input.sizeBytes <= this.#simpleUploadThresholdBytes && (resume === null || input.sizeBytes === 0n)) {
        const url = graphUrl(client.baseUrl, `${itemPath(parentId)}/children/${encodeURIComponent(name)}/content`);
        const response = await client.json<GraphDriveItem>('PUT', url, {
          body: input.stream as Readable,
          headers: {
            'Content-Type': input.mimeType || FILE_MIME_TYPE,
            'Content-Length': input.sizeBytes.toString(),
          },
          timeoutMs: TRANSFER_TIMEOUT_MS,
        });
        return this.#uploadResult(response.data, input.sizeBytes);
      }
      this.#require('uploadResumable');
      return await this.#sessionUpload(client, input, parentId, name, resume);
    } catch (error) {
      throw ProviderError.is(error) ? error : mapOnedriveTransportError(error);
    }
  }

  async #sessionUpload(
    client: OnedriveClient,
    input: UploadInput,
    parentId: string | null,
    name: string,
    resume: OnedriveResumeState | null,
  ): Promise<UploadResult> {
    const declared = Number(input.sizeBytes);
    let sessionUrl = resume?.sessionUrl ?? '';
    if (resume === null) {
      const url = graphUrl(client.baseUrl, `${itemPath(parentId)}/children/${encodeURIComponent(name)}/createUploadSession`);
      const session = await client.json<{ uploadUrl?: string }>('POST', url, {
        payload: { item: { '@microsoft.graph.conflictBehavior': 'replace', name } },
        timeoutMs: JSON_TIMEOUT_MS,
      });
      sessionUrl = typeof session.data.uploadUrl === 'string' ? session.data.uploadUrl.trim() : '';
      if (sessionUrl === '') {
        throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'OneDrive returned no upload session url');
      }
    }
    await assertFetchAllowed(sessionUrl);

    const source = skippedChunks(
      streamChunks(input.stream as AsyncIterable<Buffer | string>, this.#uploadChunkBytes),
      resume?.offset ?? 0,
    );
    let offset = resume?.offset ?? 0;

    for await (const chunk of source) {
      if (offset + chunk.byteLength > declared) {
        throw new ProviderError('ERR_INVALID_INPUT', `stream is longer than the declared ${declared} bytes`);
      }
      const end = offset + chunk.byteLength - 1;
      const isFinal = end === declared - 1;
      const result = await client.sessionPut(
        sessionUrl,
        chunk,
        `bytes ${offset}-${end}/${declared}`,
        TRANSFER_TIMEOUT_MS,
      );
      offset += chunk.byteLength;
      if (isFinal) {
        if (result.status !== 201 && result.status !== 200) {
          throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'OneDrive upload session did not complete');
        }
        return this.#uploadResult(result.data as GraphDriveItem, input.sizeBytes);
      }
      if (result.status !== 202) {
        throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'OneDrive upload session rejected an intermediate chunk');
      }
    }

    if (offset !== declared) {
      throw new ProviderError('ERR_INVALID_INPUT', `stream ended after ${offset} bytes, expected ${declared}`);
    }
    throw new ProviderError('ERR_INVALID_INPUT', 'OneDrive upload session produced no result');
  }

  #uploadResult(entry: GraphDriveItem, declared: bigint): UploadResult {
    const remoteId = typeof entry?.id === 'string' ? entry.id.trim() : '';
    if (!remoteId) {
      throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'OneDrive returned no id for the uploaded file');
    }
    if (entry.size !== undefined && entry.size !== null && toBigInt(entry.size) !== declared) {
      throw new ProviderError(
        'ERR_INVALID_INPUT',
        `uploaded ${toBigInt(entry.size)} bytes but declared ${declared}`,
      );
    }
    return { remoteId, sizeBytes: entry.size !== undefined ? toBigInt(entry.size) : declared, resumeToken: null };
  }

  async download(ctx: ProviderContext, input: DownloadInput): Promise<DownloadResult> {
    this.#require('download');
    assertRange(input?.range);
    if (input?.range) this.#require('downloadRange');
    const remoteId = requireRemoteId(input?.remoteId);
    const client = await this.#client(ctx);
    const item = await this.#getItem(client, remoteId);
    if (item.folder) {
      throw new ProviderError('ERR_INVALID_INPUT', `remoteId '${remoteId}' is a folder`);
    }
    const total = toBigInt(item.size ?? 0);
    if (input.range) {
      if (total === 0n || BigInt(input.range.start) >= total) {
        throw new ProviderError('ERR_INVALID_INPUT', 'range start is outside the object');
      }
    }

    const headers: Record<string, string> = {};
    if (input.range) {
      headers.Range =
        input.range.end !== undefined ? `bytes=${input.range.start}-${input.range.end}` : `bytes=${input.range.start}-`;
    }
    const response = await client.gatedGet(graphUrl(client.baseUrl, `${itemPath(remoteId)}/content`), {
      headers,
      signal: ctx.signal,
      timeoutMs: TRANSFER_TIMEOUT_MS,
    });

    if (response.statusCode >= 400) {
      const text = await readBodyText(response.body).catch(() => '');
      throw mapOnedriveHttpError(response.statusCode, parseJson(text), text);
    }
    if (response.statusCode >= 300) {
      await response.body.dump({ limit: 64 * 1024 }).catch(() => undefined);
      throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'OneDrive download redirect had no location');
    }

    const mimeType = headerString(response.headers['content-type']);
    const contentLength = headerString(response.headers['content-length']);
    const contentRange = parseContentRange(headerString(response.headers['content-range']));

    if (!input.range) {
      return { stream: response.body, sizeBytes: total, mimeType };
    }
    if (response.statusCode === 206 && contentRange) {
      const rangeTotal = contentRange.total ?? Number(total);
      return {
        stream: response.body,
        sizeBytes: BigInt(contentRange.end - contentRange.start + 1),
        mimeType,
        range: { start: contentRange.start, end: contentRange.end, total: rangeTotal },
      };
    }
    // The endpoint ignored the Range header and served the whole object from byte 0.
    const rangeTotal = total === 0n ? (contentLength !== null ? Number(contentLength) : null) : Number(total);
    return {
      stream: response.body,
      sizeBytes: total === 0n && contentLength !== null ? BigInt(contentLength) : total,
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
    const cursor = typeof input?.cursor === 'string' && input.cursor.trim() !== '' ? input.cursor.trim() : null;
    const url = cursor
      ? (await assertFetchAllowed(cursor)).toString()
      : graphUrl(client.baseUrl, `${itemPath(parentId)}/children`, { $select: DRIVE_ITEM_SELECT, $top: String(take) });

    const page = await client.json<GraphListPage>('GET', url);
    const entries = (page.data.value ?? [])
      .filter((item) => typeof item.id === 'string' && !item.deleted)
      .slice(0, take)
      .map((item) => this.#toMeta(item));
    const nextCursor = typeof page.data['@odata.nextLink'] === 'string' ? page.data['@odata.nextLink'] : null;
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
    const client = await this.#client(ctx);
    const cursor = typeof input?.cursor === 'string' && input.cursor.trim() !== '' ? input.cursor.trim() : null;
    const url = cursor
      ? (await assertFetchAllowed(cursor)).toString()
      : graphUrl(client.baseUrl, `/me/drive/root/search(q='${escapeSearchTerm(term)}')`, {
          $select: DRIVE_ITEM_SELECT,
          $top: String(take),
        });

    const page = await client.json<GraphListPage>('GET', url);
    const entries = (page.data.value ?? [])
      .filter((item) => typeof item.id === 'string' && !item.deleted)
      .slice(0, take)
      .map((item) => this.#toMeta(item));
    const nextCursor = typeof page.data['@odata.nextLink'] === 'string' ? page.data['@odata.nextLink'] : null;
    return { entries, nextCursor };
  }

  async getMetadata(ctx: ProviderContext, input: GetMetadataInput): Promise<RemoteFileMeta> {
    this.#require('getMetadata');
    const remoteId = requireRemoteId(input?.remoteId);
    const client = await this.#client(ctx);
    const item = await this.#getItem(client, remoteId);
    return this.#toMeta(item);
  }

  async createFolder(ctx: ProviderContext, input: CreateFolderInput): Promise<RemoteFileMeta> {
    this.#require('createFolder');
    const name = requireEntryName(input?.name, 'name');
    const parentId = normalizeParentId(input?.parentId);
    const client = await this.#client(ctx);
    try {
      const response = await client.json<GraphDriveItem>(
        'POST',
        graphUrl(client.baseUrl, `${itemPath(parentId)}/children`),
        { payload: { name, folder: {} } },
      );
      return this.#toMeta(response.data);
    } catch (error) {
      if (isOnedriveConflictError(error)) {
        const existing = await this.#getItemByName(client, parentId, name);
        if (existing) return this.#toMeta(existing);
      }
      throw error;
    }
  }

  async rename(ctx: ProviderContext, input: RenameInput): Promise<RemoteFileMeta> {
    this.#require('rename');
    const remoteId = requireRemoteId(input?.remoteId);
    const newName = requireEntryName(input?.newName, 'newName');
    const client = await this.#client(ctx);
    const item = await this.#getItem(client, remoteId);
    if (item.name === newName) return this.#toMeta(item);
    const response = await client.json<GraphDriveItem>('PATCH', graphUrl(client.baseUrl, itemPath(remoteId)), {
      payload: { name: newName },
    });
    return this.#toMeta(response.data);
  }

  async move(ctx: ProviderContext, input: MoveInput): Promise<RemoteFileMeta> {
    this.#require('move');
    const remoteId = requireRemoteId(input?.remoteId);
    const destination = normalizeParentId(input?.newParentId);
    const client = await this.#client(ctx);
    const item = await this.#getItem(client, remoteId);
    const meta = this.#toMeta(item);
    const currentParent = meta.parentId;
    if (destination === currentParent) return meta;
    if (destination !== null && destination === remoteId) {
      throw new ProviderError('ERR_INVALID_INPUT', 'cannot move a folder into itself');
    }
    const destinationId = destination ?? (await this.#rootId(client));
    const response = await client.json<GraphDriveItem>('PATCH', graphUrl(client.baseUrl, itemPath(remoteId)), {
      payload: { parentReference: { id: destinationId } },
    });
    return this.#toMeta(response.data);
  }

  async copy(ctx: ProviderContext, input: CopyInput): Promise<RemoteFileMeta> {
    this.#require('copy');
    const remoteId = requireRemoteId(input?.remoteId);
    const destination = normalizeParentId(input?.newParentId);
    const client = await this.#client(ctx);
    const item = await this.#getItem(client, remoteId);
    const name =
      input.newName !== undefined && input.newName !== null && input.newName !== ''
        ? requireEntryName(input.newName, 'newName')
        : (item.name ?? '');
    if (name === '') {
      throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'OneDrive returned an item without a name');
    }
    const destinationId = destination ?? (await this.#rootId(client));
    const response = await client.json<unknown>('POST', graphUrl(client.baseUrl, `${itemPath(remoteId)}/copy`), {
      payload: { parentReference: { id: destinationId }, name },
    });
    if (response.status !== 202) {
      // Some emulations answer 200/201 with the created item directly.
      const created = response.data as GraphDriveItem;
      if (created && typeof created.id === 'string') return this.#toMeta(created);
      throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'OneDrive copy did not return a monitor or an item');
    }
    const monitor = headerString(response.headers.location);
    if (monitor === null) {
      throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'OneDrive copy returned no monitor');
    }
    const monitorUrl = (await assertFetchAllowed(monitor)).toString();

    for (let attempt = 0; attempt < this.#copyPollAttempts; attempt++) {
      await sleep(this.#copyPollDelayMs, ctx.signal);
      const poll = await client.json<GraphDriveItem>('GET', monitorUrl);
      if (poll.status === 202) continue;
      const created = poll.data;
      if (created && typeof created.id === 'string' && !created.deleted) {
        return this.#toMeta(created);
      }
      const resolved = await this.#getItemByName(client, destinationId, name);
      if (resolved) return this.#toMeta(resolved);
    }
    throw new ProviderError('ERR_TIMEOUT', 'OneDrive copy did not complete within the polling budget');
  }

  async delete(ctx: ProviderContext, input: DeleteInput): Promise<void> {
    this.#require('delete');
    const remoteId = requireRemoteId(input?.remoteId);
    if (remoteId === ROOT_REMOTE_ID) {
      throw new ProviderError('ERR_INVALID_INPUT', 'the root folder cannot be deleted');
    }
    // `permanent` is accepted and ignored: Graph exposes a single DELETE path.
    const client = await this.#client(ctx);
    await client.json('DELETE', graphUrl(client.baseUrl, itemPath(remoteId)));
  }

  async createShare(ctx: ProviderContext, input: CreateShareInput): Promise<ShareResult> {
    this.#require('createShare');
    if (input?.visibility !== 'public_read' && input?.visibility !== 'private') {
      throw new ProviderError(
        'ERR_INVALID_INPUT',
        `unsupported share visibility '${String(input?.visibility)}'`,
      );
    }
    const remoteId = requireRemoteId(input.remoteId);
    const expiresAt = normalizeExpiry(input.expiresAt);
    const client = await this.#client(ctx);
    const permissions = await this.#listPermissions(client, remoteId);

    if (input.visibility === 'private') {
      await this.#removeLinkPermissions(client, remoteId, permissions);
      return { url: '', visibility: 'private', expiresAt: null };
    }

    const existing = permissions.find(
      (permission) => typeof permission.id === 'string' && permission.link && typeof permission.link.webUrl === 'string',
    );
    if (existing?.link?.webUrl) {
      return {
        url: existing.link.webUrl,
        visibility: 'public_read',
        expiresAt: existing.expirationDateTime ?? null,
      };
    }

    const payload: Record<string, unknown> = { type: 'view', scope: 'anonymous' };
    if (expiresAt !== null) payload.expirationDateTime = expiresAt;
    const created = await client.json<GraphPermission>('POST', graphUrl(client.baseUrl, `${itemPath(remoteId)}/createLink`), {
      payload,
    });
    const webUrl = typeof created.data?.link?.webUrl === 'string' ? created.data.link.webUrl.trim() : '';
    if (webUrl === '') {
      throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'OneDrive returned a shared link without a url');
    }
    return { url: webUrl, visibility: 'public_read', expiresAt: created.data?.expirationDateTime ?? expiresAt };
  }

  async revokeShare(ctx: ProviderContext, input: RevokeShareInput): Promise<void> {
    this.#require('revokeShare');
    const remoteId = requireRemoteId(input?.remoteId);
    const client = await this.#client(ctx);
    const permissions = await this.#listPermissions(client, remoteId);
    await this.#removeLinkPermissions(client, remoteId, permissions);
  }

  async healthCheck(ctx: ProviderContext): Promise<HealthResult> {
    this.#require('healthCheck');
    const startedAt = Date.now();
    const client = await this.#client(ctx);
    try {
      await client.json('GET', graphUrl(client.baseUrl, '/me', { $select: 'id' }));
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

  async #getItem(client: OnedriveClient, remoteId: string): Promise<GraphDriveItem> {
    const response = await client.json<GraphDriveItem>('GET', graphUrl(client.baseUrl, itemPath(remoteId), {
      $select: DRIVE_ITEM_SELECT,
    }));
    const item = response.data;
    if (item.deleted) {
      throw new ProviderError('ERR_NOT_FOUND', `remoteId '${remoteId}' was deleted`);
    }
    return item;
  }

  async #getItemByName(client: OnedriveClient, parentId: string | null, name: string): Promise<GraphDriveItem | null> {
    try {
      const response = await client.json<GraphDriveItem>(
        'GET',
        graphUrl(client.baseUrl, `${itemPath(parentId)}/children/${encodeURIComponent(name)}`, {
          $select: DRIVE_ITEM_SELECT,
        }),
      );
      const item = response.data;
      return item && typeof item.id === 'string' && !item.deleted ? item : null;
    } catch (error) {
      if (ProviderError.is(error) && error.code === 'ERR_NOT_FOUND') return null;
      throw error;
    }
  }

  async #rootId(client: OnedriveClient): Promise<string> {
    const response = await client.json<GraphDriveItem>('GET', graphUrl(client.baseUrl, '/me/drive/root', {
      $select: 'id',
    }));
    const id = typeof response.data.id === 'string' ? response.data.id.trim() : '';
    if (id === '') {
      throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'OneDrive returned no root id');
    }
    return id;
  }

  async #listPermissions(client: OnedriveClient, remoteId: string): Promise<GraphPermission[]> {
    const response = await client.json<{ value?: GraphPermission[] }>(
      'GET',
      graphUrl(client.baseUrl, `${itemPath(remoteId)}/permissions`),
    );
    return (response.data.value ?? []).filter((permission) => typeof permission.id === 'string');
  }

  async #removeLinkPermissions(
    client: OnedriveClient,
    remoteId: string,
    permissions: GraphPermission[],
  ): Promise<void> {
    for (const permission of permissions) {
      if (!permission.link || typeof permission.id !== 'string') continue;
      await client.json('DELETE', graphUrl(client.baseUrl, `${itemPath(remoteId)}/permissions/${encodeURIComponent(permission.id)}`));
    }
  }

  #toMeta(item: GraphDriveItem): RemoteFileMeta {
    const remoteId = typeof item.id === 'string' ? item.id.trim() : '';
    if (remoteId === '') {
      throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'OneDrive returned metadata without an id');
    }
    const isFolder = Boolean(item.folder);
    return {
      remoteId,
      name: item.name ?? '',
      mimeType: isFolder ? FOLDER_MIME_TYPE : (item.file?.mimeType ?? FILE_MIME_TYPE),
      sizeBytes: isFolder ? 0n : toBigInt(item.size ?? 0),
      parentId: item.parentReference?.id ?? null,
      isFolder,
      createdAt: item.createdDateTime ?? null,
      modifiedAt: item.lastModifiedDateTime ?? null,
      checksum: item.contentHash ?? null,
      webUrl: item.webUrl ?? null,
    };
  }
}

/** `/me/drive/root` for the root, `/me/drive/items/{id}` otherwise. */
function itemPath(parentId: string | null): string {
  if (parentId === null || parentId === ROOT_REMOTE_ID) return '/me/drive/root';
  return `/me/drive/items/${encodeURIComponent(parentId)}`;
}

export const onedriveProvider = new OnedriveProvider();

export function createOnedriveProvider(options: OnedriveProviderOptions = {}): OnedriveProvider {
  return new OnedriveProvider(options);
}

export function registerOnedriveProvider(): OnedriveProvider {
  registerOnedriveOAuth2Client();
  registry.register(onedriveProvider);
  return onedriveProvider;
}
