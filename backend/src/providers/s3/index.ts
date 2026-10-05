/**
 * S3-compatible storage adapter — provider-contract.md §4 (StorageProvider),
 * §5 (error taxonomy) and §11 (key layout `prefix/userId/fileId/fileName`,
 * quota via ListObjectsV2, SSRF-gated custom endpoints).
 *
 * `registerS3Provider()` puts the adapter on the shared registry (§6).
 */

import { Readable } from 'node:stream';
import {
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  UploadPartCommand,
  type DeleteObjectsCommandOutput,
  type GetObjectCommandOutput,
  type HeadObjectCommandOutput,
  type ListObjectsV2CommandOutput,
  type ListPartsCommandOutput,
} from '@aws-sdk/client-s3';
import { catalog } from '../catalog.js';
import { ProviderError, isRetryableProviderError } from '../errors.js';
import { mapErrorToHealthState } from '../health.js';
import { registry } from '../registry.js';
import {
  decodeOffsetCursor,
  encodeOffsetCursor,
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
  type HealthState,
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
import { mapS3Error } from './errors.js';
import {
  MAX_MULTIPART_PARTS,
  MAX_OBJECT_BYTES,
  MAX_QUOTA_PAGES,
  openSession,
  sendCommand,
  type S3Session,
} from './client.js';
import {
  FOLDER_MARKER_CONTENT_TYPE,
  assertOwnKey,
  fileKey,
  folderKey,
  listDir,
  newKeySegment,
  parseChild,
  parseKey,
  parentDirOf,
  rebaseKey,
  sanitizeFileName,
  sanitizeFolderName,
  type ParsedChild,
} from './keys.js';
import { DEFAULT_MIME_TYPE, FOLDER_MIME_TYPE, mimeTypeForName } from './mime.js';
import { DEFAULT_PRESIGN_SECONDS, MAX_PRESIGN_SECONDS, createPresignedGetUrl, escapeUri, resolveShareExpiresIn } from './presign.js';

const FALLBACK_CAPABILITIES: readonly Capability[] = [
  'authenticate',
  'getAccountInfo',
  'getQuota',
  'upload',
  'uploadResumable',
  'download',
  'downloadRange',
  'list',
  'getMetadata',
  'createFolder',
  'rename',
  'move',
  'copy',
  'delete',
  'createShare',
  'healthCheck',
];

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1000;
const DELETE_BATCH_SIZE = 1000;
const RESUME_TOKEN_VERSION = 1;

function declaredCapabilities(): readonly Capability[] {
  return catalog.get('s3')?.capabilities ?? FALLBACK_CAPABILITIES;
}

function requireRemoteId(remoteId: unknown): string {
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

function pageLimit(limit: number | undefined): number {
  if (limit === undefined || limit === null) return DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new ProviderError('ERR_INVALID_INPUT', 'limit must be a positive integer');
  }
  return Math.min(limit, MAX_PAGE_SIZE);
}

function stripQuotes(value: string): string {
  return value.startsWith('"') && value.endsWith('"') && value.length >= 2 ? value.slice(1, -1) : value;
}

interface ScanEntry {
  key: string;
  size: bigint;
  lastModified: string | null;
  etag: string | null;
}

interface ChildEntry {
  child: ParsedChild;
  entry: ScanEntry;
}

async function scanPrefix(
  ctx: ProviderContext,
  session: S3Session,
  prefix: string,
  operation: string,
): Promise<ScanEntry[]> {
  const out: ScanEntry[] = [];
  let continuationToken: string | undefined;
  do {
    const page: ListObjectsV2CommandOutput = await sendCommand<ListObjectsV2CommandOutput>(
      ctx,
      session,
      new ListObjectsV2Command({
        Bucket: session.settings.bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
      operation,
    );
    for (const object of page.Contents ?? []) {
      if (typeof object.Key !== 'string') continue;
      out.push({
        key: object.Key,
        size: typeof object.Size === 'number' && object.Size >= 0 ? BigInt(Math.floor(object.Size)) : 0n,
        lastModified: object.LastModified instanceof Date ? object.LastModified.toISOString() : null,
        etag: typeof object.ETag === 'string' ? stripQuotes(object.ETag) : null,
      });
    }
    const truncated = page.IsTruncated === true;
    continuationToken =
      truncated && typeof page.NextContinuationToken === 'string' ? page.NextContinuationToken : undefined;
    if (truncated && continuationToken === undefined) break;
  } while (continuationToken !== undefined);
  return out;
}

function directChildren(dir: string, entries: ScanEntry[]): ChildEntry[] {
  const out: ChildEntry[] = [];
  for (const entry of entries) {
    const child = parseChild(dir, entry.key);
    if (child) out.push({ child, entry });
  }
  out.sort((a, b) => {
    if (a.child.name !== b.child.name) return a.child.name < b.child.name ? -1 : 1;
    if (a.entry.key === b.entry.key) return 0;
    return a.entry.key < b.entry.key ? -1 : 1;
  });
  return out;
}

function metaFromChild(root: string, dir: string, child: ParsedChild, entry: ScanEntry): RemoteFileMeta {
  return {
    remoteId: entry.key,
    name: child.name,
    mimeType: child.isFolder ? FOLDER_MIME_TYPE : mimeTypeForName(child.name),
    sizeBytes: child.isFolder ? 0n : entry.size,
    parentId: dir === `${root}/` ? null : dir,
    isFolder: child.isFolder,
    createdAt: null,
    modifiedAt: entry.lastModified,
    checksum: entry.etag,
    webUrl: null,
  };
}

async function headObject(
  ctx: ProviderContext,
  session: S3Session,
  key: string,
  operation: string,
): Promise<HeadObjectCommandOutput> {
  return await sendCommand<HeadObjectCommandOutput>(
    ctx,
    session,
    new HeadObjectCommand({ Bucket: session.settings.bucket, Key: key }),
    operation,
  );
}

function metaFromHead(root: string, key: string, head: HeadObjectCommandOutput): RemoteFileMeta {
  const parsed = parseKey(root, key);
  return {
    remoteId: key,
    name: parsed.name,
    mimeType: head.ContentType ?? (parsed.isFolder ? FOLDER_MIME_TYPE : mimeTypeForName(parsed.name)),
    sizeBytes: parsed.isFolder ? 0n : BigInt(head.ContentLength ?? 0),
    parentId: parsed.parentId,
    isFolder: parsed.isFolder,
    createdAt: null,
    modifiedAt: head.LastModified instanceof Date ? head.LastModified.toISOString() : null,
    checksum: typeof head.ETag === 'string' ? stripQuotes(head.ETag) : null,
    webUrl: null,
  };
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

async function copyObject(
  ctx: ProviderContext,
  session: S3Session,
  sourceKey: string,
  targetKey: string,
  operation: string,
): Promise<void> {
  const bucket = session.settings.bucket;
  const copySource = `${bucket}/${sourceKey.split('/').map(escapeUri).join('/')}`;
  await sendCommand(
    ctx,
    session,
    new CopyObjectCommand({ Bucket: bucket, CopySource: copySource, Key: targetKey }),
    operation,
  );
}

async function deleteKeys(
  ctx: ProviderContext,
  session: S3Session,
  keys: string[],
  operation: string,
): Promise<void> {
  for (let index = 0; index < keys.length; index += DELETE_BATCH_SIZE) {
    const batch = keys.slice(index, index + DELETE_BATCH_SIZE);
    const response: DeleteObjectsCommandOutput = await sendCommand<DeleteObjectsCommandOutput>(
      ctx,
      session,
      new DeleteObjectsCommand({
        Bucket: session.settings.bucket,
        Delete: { Objects: batch.map((key) => ({ Key: key })), Quiet: true },
      }),
      operation,
    );
    const failure = response.Errors?.[0];
    if (failure) {
      throw mapS3Error({ name: failure.Code ?? 'UnknownError', Code: failure.Code }, operation);
    }
  }
}

async function copySubtree(
  ctx: ProviderContext,
  session: S3Session,
  oldDir: string,
  newDir: string,
  operation: string,
): Promise<void> {
  if (newDir.startsWith(oldDir)) {
    throw new ProviderError('ERR_INVALID_INPUT', 'cannot move/copy a folder into itself');
  }
  const entries = await scanPrefix(ctx, session, oldDir, operation);
  for (const entry of entries) {
    await copyObject(ctx, session, entry.key, rebaseKey(oldDir, newDir, entry.key), operation);
  }
}

async function deletePrefix(
  ctx: ProviderContext,
  session: S3Session,
  prefix: string,
  operation: string,
): Promise<void> {
  const entries = await scanPrefix(ctx, session, prefix, operation);
  await deleteKeys(ctx, session, entries.map((entry) => entry.key), operation);
}

class StreamCursor {
  #iterator: AsyncIterator<Buffer | string>;
  #buffer: Buffer = Buffer.alloc(0);
  #ended = false;

  constructor(stream: NodeJS.ReadableStream) {
    this.#iterator = (stream as AsyncIterable<Buffer | string>)[Symbol.asyncIterator]();
  }

  async read(maxBytes: number): Promise<Buffer | null> {
    while (!this.#ended && this.#buffer.byteLength < maxBytes) {
      let next: IteratorResult<Buffer | string>;
      try {
        next = await this.#iterator.next();
      } catch (cause) {
        throw ProviderError.is(cause)
          ? cause
          : new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'upload stream failed', { cause });
      }
      if (next.done === true || next.value === undefined) {
        this.#ended = true;
        break;
      }
      const chunk = typeof next.value === 'string' ? Buffer.from(next.value, 'utf8') : next.value;
      this.#buffer = this.#buffer.byteLength === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    }
    if (this.#buffer.byteLength === 0) return null;
    const take = Math.min(maxBytes, this.#buffer.byteLength);
    const out = this.#buffer.subarray(0, take);
    this.#buffer = this.#buffer.subarray(take);
    return out;
  }

  async hasMore(): Promise<boolean> {
    return (await this.read(1)) !== null;
  }
}

/**
 * Pull-based upload body: chunks are fetched only when the SDK asks for them,
 * so a size mismatch is always detected while the request is in flight and the
 * caller can abort it (a short body with a fixed Content-Length would otherwise
 * deadlock against the endpoint). Source failures become ProviderErrors, and
 * no `error` event is ever emitted for the SDK to leak.
 */
function guardedBody(
  source: NodeJS.ReadableStream,
  declared: bigint,
  onMismatch: (error: ProviderError) => void,
): Readable {
  const iterator = (source as AsyncIterable<Buffer | string>)[Symbol.asyncIterator]();
  let sent = 0n;
  let pulling = false;
  let finished = false;
  let body: Readable;

  const finish = (error?: ProviderError): void => {
    if (finished) return;
    finished = true;
    if (error) onMismatch(error);
    body.push(null);
  };

  body = new Readable({
    read() {
      if (pulling || finished) return;
      pulling = true;
      void (async () => {
        try {
          const next = await iterator.next();
          if (finished) return;
          if (next.done === true || next.value === undefined) {
            finish(
              sent === declared
                ? undefined
                : new ProviderError('ERR_INVALID_INPUT', `stream delivered ${sent} bytes, expected ${declared}`),
            );
            return;
          }
          const chunk = typeof next.value === 'string' ? Buffer.from(next.value, 'utf8') : next.value;
          sent += BigInt(chunk.byteLength);
          if (sent > declared) {
            finish(
              new ProviderError('ERR_INVALID_INPUT', `stream delivered more bytes than sizeBytes (${declared})`),
            );
            return;
          }
          body.push(chunk);
        } catch (cause) {
          finish(
            ProviderError.is(cause)
              ? cause
              : new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'upload stream failed', { cause }),
          );
        } finally {
          pulling = false;
        }
      })();
    },
  });
  return body;
}

function resolvePartSize(size: bigint, configured: number): number {
  const minimum = Number((size + BigInt(MAX_MULTIPART_PARTS) - 1n) / BigInt(MAX_MULTIPART_PARTS));
  return Math.max(configured, minimum);
}

interface ResumeState {
  key: string;
  uploadId: string;
  partSize: number;
  size: bigint;
}

function parseResumeToken(raw: string): ResumeState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new ProviderError('ERR_INVALID_INPUT', 'resume token is not valid JSON', { cause });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ProviderError('ERR_INVALID_INPUT', 'resume token is malformed');
  }
  const token = parsed as { v?: unknown; key?: unknown; uploadId?: unknown; partSize?: unknown; size?: unknown };
  if (
    token.v !== RESUME_TOKEN_VERSION ||
    typeof token.key !== 'string' ||
    token.key === '' ||
    typeof token.uploadId !== 'string' ||
    token.uploadId === '' ||
    typeof token.partSize !== 'number' ||
    !Number.isInteger(token.partSize) ||
    token.partSize < 1 ||
    typeof token.size !== 'string' ||
    !/^\d{1,19}$/.test(token.size)
  ) {
    throw new ProviderError('ERR_INVALID_INPUT', 'resume token is malformed');
  }
  return { key: token.key, uploadId: token.uploadId, partSize: token.partSize, size: BigInt(token.size) };
}

function resumeTokenOf(state: ResumeState): string {
  return JSON.stringify({
    v: RESUME_TOKEN_VERSION,
    key: state.key,
    uploadId: state.uploadId,
    partSize: state.partSize,
    size: state.size.toString(),
  });
}

function withResumeToken(error: unknown, state: ResumeState): unknown {
  const mapped = ProviderError.is(error) ? error : mapS3Error(error, 'upload');
  if (!isRetryableProviderError(mapped)) return mapped;
  const detail =
    mapped.detail && typeof mapped.detail === 'object' && !Array.isArray(mapped.detail)
      ? { ...(mapped.detail as Record<string, unknown>), resumeToken: resumeTokenOf(state) }
      : { resumeToken: resumeTokenOf(state) };
  return new ProviderError(mapped.code, mapped.message, {
    detail,
    cause: mapped,
    upstreamStatus: mapped.upstreamStatus,
    retryable: mapped.retryable,
  });
}

export interface S3ProviderOptions {
  capabilities?: Iterable<Capability>;
}

export class S3Provider implements StorageProvider {
  readonly id: ProviderId = 's3';
  readonly displayName = 'S3-compatible';
  readonly authMode = 'access_key' as const;
  readonly capabilities: ReadonlySet<Capability>;

  constructor(options: S3ProviderOptions = {}) {
    this.capabilities = new Set(options.capabilities ?? declaredCapabilities());
  }

  getCapabilities(): ReadonlySet<Capability> {
    return this.capabilities;
  }

  async authenticate(ctx: ProviderContext): Promise<{ ok: true }> {
    this.#require('authenticate');
    const session = openSession(ctx);
    await sendCommand(ctx, session, new HeadBucketCommand({ Bucket: session.settings.bucket }), 'authenticate');
    return { ok: true };
  }

  async getAccountInfo(ctx: ProviderContext): Promise<AccountInfo> {
    this.#require('getAccountInfo');
    const session = openSession(ctx);
    await sendCommand(ctx, session, new HeadBucketCommand({ Bucket: session.settings.bucket }), 'getAccountInfo');
    return {
      providerAccountId: ctx.account.providerAccountId,
      email: null,
      displayName: ctx.account.displayName ?? null,
      avatarUrl: null,
    };
  }

  async getQuota(ctx: ProviderContext): Promise<QuotaInfo> {
    this.#require('getQuota');
    const session = openSession(ctx);
    const prefix = `${session.root}/`;
    let usedBytes = 0n;
    let objectCount = 0;
    let pages = 0;
    let truncated = false;
    let continuationToken: string | undefined;
    do {
      if (pages >= MAX_QUOTA_PAGES) {
        truncated = true;
        break;
      }
      const page: ListObjectsV2CommandOutput = await sendCommand<ListObjectsV2CommandOutput>(
        ctx,
        session,
        new ListObjectsV2Command({
          Bucket: session.settings.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
        'getQuota',
      );
      pages += 1;
      for (const object of page.Contents ?? []) {
        const size = typeof object.Size === 'number' && object.Size >= 0 ? object.Size : 0;
        usedBytes += BigInt(Math.floor(size));
        objectCount += 1;
      }
      const truncatedPage = page.IsTruncated === true;
      continuationToken =
        truncatedPage && typeof page.NextContinuationToken === 'string' ? page.NextContinuationToken : undefined;
      if (truncatedPage && continuationToken === undefined) break;
    } while (continuationToken !== undefined);

    const totalBytes = session.settings.quotaBytes;
    return {
      totalBytes,
      usedBytes,
      availableBytes: totalBytes === null ? null : totalBytes > usedBytes ? totalBytes - usedBytes : 0n,
      trashBytes: null,
      raw: {
        source: 'ListObjectsV2',
        approximate: true,
        prefix,
        objectCount,
        pages,
        truncated,
      },
    };
  }

  async upload(ctx: ProviderContext, input: UploadInput): Promise<UploadResult> {
    this.#require('upload');
    const resumeRaw =
      typeof input?.resumeToken === 'string' && input.resumeToken.trim() !== '' ? input.resumeToken.trim() : null;
    if (resumeRaw !== null) this.#require('uploadResumable');
    if (!input || typeof input.fileName !== 'string' || input.fileName.trim() === '') {
      throw new ProviderError('ERR_INVALID_INPUT', 'fileName is required');
    }
    if (!input.stream || typeof input.stream.pipe !== 'function') {
      throw new ProviderError('ERR_INVALID_INPUT', 'stream is required');
    }
    if (typeof input.sizeBytes !== 'bigint' || input.sizeBytes < 0n) {
      throw new ProviderError('ERR_INVALID_INPUT', 'sizeBytes must be a non-negative bigint');
    }
    if (input.sizeBytes > BigInt(MAX_OBJECT_BYTES)) {
      throw new ProviderError('ERR_INVALID_INPUT', 'sizeBytes exceeds the maximum supported object size');
    }
    const fileName = sanitizeFileName(input.fileName);
    const mimeType =
      typeof input.mimeType === 'string' && input.mimeType.trim() !== ''
        ? input.mimeType.trim()
        : DEFAULT_MIME_TYPE;
    const session = openSession(ctx);
    const dir = listDir(session.root, input.parentId ?? null);
    const sizeBytes = input.sizeBytes;

    if (sizeBytes === 0n) {
      if (resumeRaw !== null) {
        throw new ProviderError('ERR_INVALID_INPUT', 'a resume token cannot be used for an empty upload');
      }
      const cursor = new StreamCursor(input.stream);
      if (await cursor.hasMore()) {
        throw new ProviderError('ERR_INVALID_INPUT', 'stream delivered more bytes than sizeBytes (0)');
      }
      const key = fileKey(dir, newKeySegment('f'), fileName);
      await sendCommand(
        ctx,
        session,
        new PutObjectCommand({
          Bucket: session.settings.bucket,
          Key: key,
          Body: Buffer.alloc(0),
          ContentType: mimeType,
          ContentLength: 0,
        }),
        'upload',
      );
      return { remoteId: key, sizeBytes: 0n, resumeToken: null };
    }

    const partSize = resolvePartSize(sizeBytes, session.settings.multipartPartBytes);
    let resume: ResumeState | null = null;
    if (resumeRaw !== null) {
      resume = parseResumeToken(resumeRaw);
      assertOwnKey(session.root, resume.key);
      if (!resume.key.startsWith(dir)) {
        throw new ProviderError('ERR_INVALID_INPUT', 'resume token belongs to a different folder');
      }
      if (resume.size !== sizeBytes || resume.partSize !== partSize) {
        throw new ProviderError('ERR_INVALID_INPUT', 'resume token does not match this upload');
      }
    }

    if (resume === null && sizeBytes <= BigInt(session.settings.multipartThresholdBytes)) {
      const key = fileKey(dir, newKeySegment('f'), fileName);
      let streamError: ProviderError | null = null;
      const abort = new AbortController();
      const body = guardedBody(input.stream, sizeBytes, (error) => {
        streamError = streamError ?? error;
        abort.abort(error);
      });
      try {
        await sendCommand(
          ctx,
          session,
          new PutObjectCommand({
            Bucket: session.settings.bucket,
            Key: key,
            Body: body,
            ContentType: mimeType,
            ContentLength: Number(sizeBytes),
          }),
          'upload',
          { signal: abort.signal },
        );
        if (streamError) throw streamError;
      } catch (error) {
        throw streamError ?? error;
      }
      return { remoteId: key, sizeBytes, resumeToken: null };
    }

    return await this.#multipartUpload(ctx, session, input, { dir, fileName, mimeType, partSize, resume });
  }

  async download(ctx: ProviderContext, input: DownloadInput): Promise<DownloadResult> {
    this.#require('download');
    assertRange(input?.range);
    if (input.range) this.#require('downloadRange');
    const remoteId = requireRemoteId(input.remoteId);
    const session = openSession(ctx);
    assertOwnKey(session.root, remoteId);
    if (remoteId.endsWith('/')) {
      throw new ProviderError('ERR_INVALID_INPUT', 'remoteId is a folder');
    }
    const parsed = parseKey(session.root, remoteId);
    const range = input.range;
    const response: GetObjectCommandOutput = await sendCommand<GetObjectCommandOutput>(
      ctx,
      session,
      new GetObjectCommand({
        Bucket: session.settings.bucket,
        Key: remoteId,
        ...(range ? { Range: `bytes=${range.start}-${range.end === undefined ? '' : range.end}` } : {}),
      }),
      'download',
    );
    if (!response.Body) {
      throw new ProviderError('ERR_INTERNAL', 'S3 returned an empty response body');
    }
    const contentLength = typeof response.ContentLength === 'number' ? BigInt(response.ContentLength) : null;
    const result: DownloadResult = {
      stream: response.Body as unknown as NodeJS.ReadableStream,
      sizeBytes: contentLength,
      mimeType: response.ContentType ?? mimeTypeForName(parsed.name),
    };
    const served = response.ContentRange ? parseContentRange(response.ContentRange) : null;
    if (served) result.range = served;
    return result;
  }

  async list(ctx: ProviderContext, input: ListInput): Promise<ListResult> {
    this.#require('list');
    const session = openSession(ctx);
    const dir = listDir(session.root, input.parentId);
    const limit = pageLimit(input.limit);
    const offset = input.cursor ? decodeOffsetCursor(input.cursor) : 0;
    const entries = await scanPrefix(ctx, session, dir, 'list');
    const children = directChildren(dir, entries);
    const page = children.slice(offset, offset + limit);
    const nextCursor = offset + limit < children.length ? encodeOffsetCursor(offset + limit) : null;
    return {
      entries: page.map((item) => metaFromChild(session.root, dir, item.child, item.entry)),
      nextCursor,
    };
  }

  async getMetadata(ctx: ProviderContext, input: GetMetadataInput): Promise<RemoteFileMeta> {
    this.#require('getMetadata');
    const remoteId = requireRemoteId(input?.remoteId);
    const session = openSession(ctx);
    assertOwnKey(session.root, remoteId);
    const head = await headObject(ctx, session, remoteId, 'getMetadata');
    return metaFromHead(session.root, remoteId, head);
  }

  async createFolder(ctx: ProviderContext, input: CreateFolderInput): Promise<RemoteFileMeta> {
    this.#require('createFolder');
    const name = sanitizeFolderName(input?.name);
    const session = openSession(ctx);
    const dir = listDir(session.root, input?.parentId ?? null);
    const entries = await scanPrefix(ctx, session, dir, 'createFolder');
    const existing = directChildren(dir, entries).find((item) => item.child.isFolder && item.child.name === name);
    if (existing) return metaFromChild(session.root, dir, existing.child, existing.entry);
    const key = folderKey(dir, newKeySegment('d'), name);
    await sendCommand(
      ctx,
      session,
      new PutObjectCommand({
        Bucket: session.settings.bucket,
        Key: key,
        Body: Buffer.alloc(0),
        ContentType: FOLDER_MARKER_CONTENT_TYPE,
        ContentLength: 0,
      }),
      'createFolder',
    );
    return {
      remoteId: key,
      name,
      mimeType: FOLDER_MIME_TYPE,
      sizeBytes: 0n,
      parentId: dir === `${session.root}/` ? null : dir,
      isFolder: true,
      createdAt: null,
      modifiedAt: new Date().toISOString(),
      checksum: null,
      webUrl: null,
    };
  }

  async rename(ctx: ProviderContext, input: RenameInput): Promise<RemoteFileMeta> {
    this.#require('rename');
    const remoteId = requireRemoteId(input?.remoteId);
    const session = openSession(ctx);
    assertOwnKey(session.root, remoteId);
    const head = await headObject(ctx, session, remoteId, 'rename');
    const parsed = parseKey(session.root, remoteId);
    const newName = parsed.isFolder ? sanitizeFolderName(input?.newName) : sanitizeFileName(input?.newName);
    if (newName === parsed.name) return metaFromHead(session.root, remoteId, head);

    if (!parsed.isFolder) {
      const targetKey = `${remoteId.slice(0, remoteId.lastIndexOf('/') + 1)}${newName}`;
      await copyObject(ctx, session, remoteId, targetKey, 'rename');
      await sendCommand(
        ctx,
        session,
        new DeleteObjectCommand({ Bucket: session.settings.bucket, Key: remoteId }),
        'rename',
      );
      return metaFromHead(session.root, targetKey, await headObject(ctx, session, targetKey, 'rename'));
    }

    const parentDir = parentDirOf(session.root, remoteId) ?? `${session.root}/`;
    const newDir = `${parentDir}${parsed.fileId}/${newName}/`;
    await copySubtree(ctx, session, remoteId, newDir, 'rename');
    await deletePrefix(ctx, session, remoteId, 'rename');
    return metaFromHead(session.root, newDir, await headObject(ctx, session, newDir, 'rename'));
  }

  async move(ctx: ProviderContext, input: MoveInput): Promise<RemoteFileMeta> {
    this.#require('move');
    const remoteId = requireRemoteId(input?.remoteId);
    const session = openSession(ctx);
    assertOwnKey(session.root, remoteId);
    const head = await headObject(ctx, session, remoteId, 'move');
    const parsed = parseKey(session.root, remoteId);
    const newDir = listDir(session.root, input?.newParentId ?? null);
    const oldParentDir = parentDirOf(session.root, remoteId) ?? `${session.root}/`;
    if (newDir === oldParentDir) return metaFromHead(session.root, remoteId, head);
    if (parsed.isFolder && newDir.startsWith(remoteId)) {
      throw new ProviderError('ERR_INVALID_INPUT', 'cannot move/copy a folder into itself');
    }

    if (!parsed.isFolder) {
      const targetKey = `${newDir}${parsed.fileId}/${parsed.name}`;
      await copyObject(ctx, session, remoteId, targetKey, 'move');
      await sendCommand(
        ctx,
        session,
        new DeleteObjectCommand({ Bucket: session.settings.bucket, Key: remoteId }),
        'move',
      );
      return metaFromHead(session.root, targetKey, await headObject(ctx, session, targetKey, 'move'));
    }

    const newDirKey = `${newDir}${parsed.fileId}/${parsed.name}/`;
    await copySubtree(ctx, session, remoteId, newDirKey, 'move');
    await deletePrefix(ctx, session, remoteId, 'move');
    return metaFromHead(session.root, newDirKey, await headObject(ctx, session, newDirKey, 'move'));
  }

  async copy(ctx: ProviderContext, input: CopyInput): Promise<RemoteFileMeta> {
    this.#require('copy');
    const remoteId = requireRemoteId(input?.remoteId);
    const session = openSession(ctx);
    assertOwnKey(session.root, remoteId);
    await headObject(ctx, session, remoteId, 'copy');
    const parsed = parseKey(session.root, remoteId);
    const newDir = listDir(session.root, input?.newParentId ?? null);
    if (parsed.isFolder && newDir.startsWith(remoteId)) {
      throw new ProviderError('ERR_INVALID_INPUT', 'cannot move/copy a folder into itself');
    }
    const rawName = typeof input?.newName === 'string' && input.newName.trim() !== '' ? input.newName : null;
    const newName = rawName === null ? parsed.name : parsed.isFolder ? sanitizeFolderName(rawName) : sanitizeFileName(rawName);

    if (parsed.isFolder) {
      const newDirKey = `${newDir}${newKeySegment('d')}/${newName}/`;
      await copySubtree(ctx, session, remoteId, newDirKey, 'copy');
      return metaFromHead(session.root, newDirKey, await headObject(ctx, session, newDirKey, 'copy'));
    }
    const targetKey = `${newDir}${newKeySegment('f')}/${newName}`;
    await copyObject(ctx, session, remoteId, targetKey, 'copy');
    return metaFromHead(session.root, targetKey, await headObject(ctx, session, targetKey, 'copy'));
  }

  async delete(ctx: ProviderContext, input: DeleteInput): Promise<void> {
    this.#require('delete');
    const remoteId = requireRemoteId(input?.remoteId);
    const session = openSession(ctx);
    assertOwnKey(session.root, remoteId);
    await headObject(ctx, session, remoteId, 'delete');
    if (!remoteId.endsWith('/')) {
      await sendCommand(
        ctx,
        session,
        new DeleteObjectCommand({ Bucket: session.settings.bucket, Key: remoteId }),
        'delete',
      );
      return;
    }
    await deletePrefix(ctx, session, remoteId, 'delete');
  }

  async createShare(ctx: ProviderContext, input: CreateShareInput): Promise<ShareResult> {
    this.#require('createShare');
    if (input?.visibility !== 'public_read') {
      throw new ProviderError(
        'ERR_INVALID_INPUT',
        "S3 shares only support the 'public_read' visibility (presigned GET URLs)",
      );
    }
    const remoteId = requireRemoteId(input.remoteId);
    const session = openSession(ctx);
    assertOwnKey(session.root, remoteId);
    if (remoteId.endsWith('/')) {
      throw new ProviderError('ERR_INVALID_INPUT', 'folders cannot be shared');
    }
    await headObject(ctx, session, remoteId, 'createShare');
    const expiresIn = resolveShareExpiresIn(input.expiresAt);
    const url = await createPresignedGetUrl(session.settings, remoteId, expiresIn);
    return {
      url,
      visibility: 'public_read',
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    };
  }

  async revokeShare(_ctx: ProviderContext, _input: RevokeShareInput): Promise<void> {
    this.#require('revokeShare');
  }

  async healthCheck(ctx: ProviderContext): Promise<HealthResult> {
    this.#require('healthCheck');
    const startedAt = Date.now();
    try {
      const session = openSession(ctx);
      await sendCommand(ctx, session, new HeadBucketCommand({ Bucket: session.settings.bucket }), 'healthCheck');
      return {
        state: 'healthy',
        latencyMs: Date.now() - startedAt,
        message: null,
        checkedAt: new Date().toISOString(),
      };
    } catch (error) {
      const state = mapErrorToHealthState(error);
      return {
        state: state === 'unknown' ? ('degraded' as HealthState) : state,
        latencyMs: Date.now() - startedAt,
        message: ProviderError.is(error) ? error.message : 'S3 health check failed',
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

  async #multipartUpload(
    ctx: ProviderContext,
    session: S3Session,
    input: UploadInput,
    target: {
      dir: string;
      fileName: string;
      mimeType: string;
      partSize: number;
      resume: ResumeState | null;
    },
  ): Promise<UploadResult> {
    const bucket = session.settings.bucket;
    const sizeBytes = input.sizeBytes;
    const partCount = Number((sizeBytes + BigInt(target.partSize) - 1n) / BigInt(target.partSize));
    if (partCount > MAX_MULTIPART_PARTS) {
      throw new ProviderError('ERR_INVALID_INPUT', 'upload would exceed the multipart part limit');
    }

    let key: string;
    let uploadId: string;
    const completed = new Map<number, string>();
    if (target.resume !== null) {
      key = target.resume.key;
      uploadId = target.resume.uploadId;
      for (const part of await this.#listParts(ctx, session, key, uploadId)) {
        if (typeof part.PartNumber === 'number' && typeof part.ETag === 'string') {
          completed.set(part.PartNumber, part.ETag);
        }
      }
    } else {
      key = fileKey(target.dir, newKeySegment('f'), target.fileName);
      const created = await sendCommand<{ UploadId?: string }>(
        ctx,
        session,
        new CreateMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          ContentType: target.mimeType,
        }),
        'upload',
      );
      uploadId = created.UploadId ?? '';
      if (!uploadId) {
        throw new ProviderError('ERR_INTERNAL', 'S3 did not return an upload id');
      }
    }

    const state: ResumeState = { key, uploadId, partSize: target.partSize, size: sizeBytes };
    const cursor = new StreamCursor(input.stream);
    const parts: { ETag: string; PartNumber: number }[] = [];

    try {
      let offset = 0n;
      let partNumber = 1;
      while (offset < sizeBytes) {
        const remaining = sizeBytes - offset;
        const want = remaining < BigInt(target.partSize) ? Number(remaining) : target.partSize;
        const buffer = await cursor.read(want);
        if (buffer === null) {
          throw new ProviderError('ERR_INVALID_INPUT', `stream ended after ${offset} bytes, expected ${sizeBytes}`);
        }
        offset += BigInt(buffer.byteLength);
        const known = completed.get(partNumber);
        if (known !== undefined) {
          parts.push({ ETag: known, PartNumber: partNumber });
        } else {
          const uploaded = await sendCommand<{ ETag?: string }>(
            ctx,
            session,
            new UploadPartCommand({
              Bucket: bucket,
              Key: key,
              UploadId: uploadId,
              PartNumber: partNumber,
              Body: buffer,
              ContentLength: buffer.byteLength,
            }),
            'upload',
          );
          if (typeof uploaded.ETag !== 'string' || uploaded.ETag === '') {
            throw new ProviderError('ERR_INTERNAL', 'S3 did not return an ETag for the uploaded part');
          }
          parts.push({ ETag: uploaded.ETag, PartNumber: partNumber });
        }
        partNumber += 1;
      }
      if (await cursor.hasMore()) {
        throw new ProviderError('ERR_INVALID_INPUT', `stream delivered more bytes than sizeBytes (${sizeBytes})`);
      }
      parts.sort((a, b) => a.PartNumber - b.PartNumber);
      await sendCommand(
        ctx,
        session,
        new CompleteMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: { Parts: parts },
        }),
        'upload',
      );
      return { remoteId: key, sizeBytes, resumeToken: null };
    } catch (error) {
      throw withResumeToken(error, state);
    }
  }

  async #listParts(
    ctx: ProviderContext,
    session: S3Session,
    key: string,
    uploadId: string,
  ): Promise<{ PartNumber?: number; ETag?: string }[]> {
    const parts: { PartNumber?: number; ETag?: string }[] = [];
    let marker: string | undefined;
    do {
      const page: ListPartsCommandOutput = await sendCommand<ListPartsCommandOutput>(
        ctx,
        session,
        new ListPartsCommand({
          Bucket: session.settings.bucket,
          Key: key,
          UploadId: uploadId,
          PartNumberMarker: marker,
        }),
        'upload',
      );
      for (const part of page.Parts ?? []) parts.push(part);
      const truncated = page.IsTruncated === true;
      const next = page.NextPartNumberMarker;
      marker = truncated && typeof next === 'string' && next !== '' && next !== '0' ? next : undefined;
      if (truncated && marker === undefined) break;
    } while (marker !== undefined);
    return parts;
  }
}

export const s3Provider = new S3Provider();

export function createS3Provider(options: S3ProviderOptions = {}): S3Provider {
  return new S3Provider(options);
}

export function registerS3Provider(): S3Provider {
  registry.register(s3Provider);
  return s3Provider;
}
