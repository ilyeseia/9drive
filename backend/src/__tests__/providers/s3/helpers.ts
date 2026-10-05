import { createHash, createHmac } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { ProviderError } from '../../../providers/errors.js';
import type { ProviderContext } from '../../../providers/types.js';

export type S3Operation =
  | 'HeadBucket'
  | 'HeadObject'
  | 'ListObjectsV2'
  | 'GetObject'
  | 'PutObject'
  | 'CopyObject'
  | 'DeleteObject'
  | 'DeleteObjects'
  | 'CreateMultipartUpload'
  | 'UploadPart'
  | 'CompleteMultipartUpload'
  | 'ListParts'
  | 'AbortMultipartUpload'
  | 'unknown';

export interface RecordedRequest {
  operation: S3Operation;
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export interface ScriptedFailure {
  operation?: S3Operation;
  status: number;
  code?: string;
  message?: string;
  /** Raw XML body override (used to return a 200 with `<Error>` entries, e.g. DeleteObjects). */
  bodyXml?: string;
  times?: number;
}

export interface StoredObject {
  body: Buffer;
  contentType: string;
  lastModified: Date;
  etag: string;
}

interface MultipartUpload {
  key: string;
  contentType: string;
  parts: Map<number, Buffer>;
}

export interface FakeS3 {
  baseUrl: string;
  bucket: string;
  objects: Map<string, StoredObject>;
  uploads: Map<string, MultipartUpload>;
  requests: RecordedRequest[];
  /** Keys returned per ListObjectsV2 page (default 1000, like real S3). */
  pageKeys: number;
  seed(key: string, body: Buffer | string, contentType?: string): StoredObject;
  objectFor(key: string): StoredObject | undefined;
  count(operation: S3Operation): number;
  ops(): S3Operation[];
  failNext(failure: ScriptedFailure): void;
  clear(): void;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    };
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', settle);
    req.on('error', settle);
    req.on('close', settle);
  });
}

function send(
  res: ServerResponse,
  status: number,
  payload: Buffer | string,
  headers: Record<string, string> = {},
  headOnly = false,
): void {
  const buffer = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (res.writableEnded || res.destroyed) return;
  try {
    const base = status === 204 || status === 304 ? {} : { 'content-length': String(buffer.byteLength) };
    res.writeHead(status, { ...base, ...headers });
    res.end(headOnly ? undefined : buffer);
  } catch {
    res.destroy();
  }
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function xmlUnescape(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function md5(buffer: Buffer): string {
  return createHash('md5').update(buffer).digest('hex');
}

function etagOf(buffer: Buffer): string {
  return `"${md5(buffer)}"`;
}

function isoOf(date: Date): string {
  return date.toISOString();
}

function lastModifiedHeader(date: Date): string {
  return date.toUTCString();
}

function errorXml(code: string, message: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${xmlEscape(code)}</Code><Message>${xmlEscape(message)}</Message><RequestId>fake-request</RequestId></Error>`;
}

function parseDeleteKeys(body: Buffer): string[] {
  const keys: string[] = [];
  const pattern = /<Key>([\s\S]*?)<\/Key>/g;
  const text = body.toString('utf8');
  for (const match of text.matchAll(pattern)) keys.push(xmlUnescape(match[1] ?? ''));
  return keys;
}

function parseCompleteParts(body: Buffer): number[] {
  const parts: number[] = [];
  const text = body.toString('utf8');
  for (const match of text.matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)) parts.push(Number(match[1]));
  return parts;
}

type Route = { operation: S3Operation; bucket: string; key: string | null };

function routeOf(method: string, url: URL, headers: IncomingHttpHeaders): Route {
  const pathname = url.pathname;
  const segments = pathname.split('/').filter((segment) => segment !== '');
  if (segments.length === 0) return { operation: 'unknown', bucket: '', key: null };
  const bucket = decodeURIComponent(segments[0] ?? '');
  let key = segments.length > 1 ? segments.slice(1).map(decodeURIComponent).join('/') : null;
  // Object keys are allowed to end with `/` (folder markers); the segment split above drops it.
  if (key !== null && !key.endsWith('/') && pathname.endsWith('/')) key += '/';
  const query = url.searchParams;
  if (key === null) {
    if (method === 'HEAD') return { operation: 'HeadBucket', bucket, key };
    if (method === 'GET' && (query.get('list-type') === '2' || query.has('prefix'))) {
      return { operation: 'ListObjectsV2', bucket, key };
    }
    if (method === 'POST' && query.has('delete')) return { operation: 'DeleteObjects', bucket, key };
    return { operation: 'unknown', bucket, key };
  }
  if (method === 'HEAD') return { operation: 'HeadObject', bucket, key };
  if (method === 'GET') return { operation: query.has('uploadId') ? 'ListParts' : 'GetObject', bucket, key };
  if (method === 'PUT') {
    if (query.has('uploadId')) return { operation: 'UploadPart', bucket, key };
    if (headers['x-amz-copy-source']) return { operation: 'CopyObject', bucket, key };
    return { operation: 'PutObject', bucket, key };
  }
  if (method === 'POST') {
    if (query.has('uploads')) return { operation: 'CreateMultipartUpload', bucket, key };
    if (query.has('uploadId')) return { operation: 'CompleteMultipartUpload', bucket, key };
    return { operation: 'unknown', bucket, key };
  }
  if (method === 'DELETE') {
    return { operation: query.has('uploadId') ? 'AbortMultipartUpload' : 'DeleteObject', bucket, key };
  }
  return { operation: 'unknown', bucket, key };
}

function copySourceKey(raw: string): { bucket: string; key: string } {
  const stripped = raw.startsWith('/') ? raw.slice(1) : raw;
  const slash = stripped.indexOf('/');
  const bucket = decodeURIComponent(stripped.slice(0, slash));
  const key = stripped
    .slice(slash + 1)
    .split('/')
    .map((segment) => decodeURIComponent(segment))
    .join('/');
  return { bucket, key };
}

function parseRange(header: string, total: number): { start: number; end: number } | null {
  const match = /^bytes=(\d+)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const start = Number(match[1]);
  const end = match[2] === '' ? total - 1 : Math.min(Number(match[2]), total - 1);
  if (!Number.isInteger(start) || start > end || start >= total) return null;
  return { start, end };
}

export async function startFakeS3(options: { bucket?: string; pageKeys?: number } = {}): Promise<FakeS3> {
  const bucket = options.bucket ?? 'test-bucket';
  const objects = new Map<string, StoredObject>();
  const uploads = new Map<string, MultipartUpload>();
  const requests: RecordedRequest[] = [];
  const scripted: ScriptedFailure[] = [];
  let uploadSeq = 0;
  let httpServer: Server | null = null;

  const server: FakeS3 = {
    baseUrl: '',
    bucket,
    objects,
    uploads,
    requests,
    pageKeys: options.pageKeys ?? 1000,
    seed: (key, body, contentType = 'application/octet-stream') => {
      const buffer = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
      const stored: StoredObject = {
        body: buffer,
        contentType,
        lastModified: new Date('2026-01-04T10:00:00.000Z'),
        etag: etagOf(buffer),
      };
      objects.set(key, stored);
      return stored;
    },
    objectFor: (key) => objects.get(key),
    count: (operation) => requests.filter((entry) => entry.operation === operation).length,
    ops: () => requests.map((entry) => entry.operation),
    failNext: (failure) => scripted.push({ times: 1, ...failure }),
    clear: () => {
      requests.length = 0;
      scripted.length = 0;
    },
    close: () =>
      new Promise<void>((resolve) => {
        if (!httpServer) {
          resolve();
          return;
        }
        httpServer.closeAllConnections?.();
        httpServer.close(() => resolve());
      }),
  };

  const takeScripted = (operation: S3Operation): ScriptedFailure | undefined => {
    const index = scripted.findIndex((entry) => entry.times !== 0 && (entry.operation === undefined || entry.operation === operation));
    if (index === -1) return undefined;
    const entry = scripted[index];
    if (entry.times !== undefined) entry.times -= 1;
    if (entry.times === 0) scripted.splice(index, 1);
    return entry;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = (req.method ?? 'GET').toUpperCase();
    const body = await readBody(req);
    const route = routeOf(method, url, req.headers);
    requests.push({
      operation: route.operation,
      method,
      path: url.pathname,
      query: url.searchParams,
      headers: req.headers,
      body,
    });

    const headOnly = method === 'HEAD';
    const failure = takeScripted(route.operation);
    if (failure) {
      const payload = failure.bodyXml ?? errorXml(failure.code ?? 'InternalError', failure.message ?? 'scripted failure');
      send(res, failure.status, payload, { 'content-type': 'application/xml' }, headOnly);
      return;
    }

    const query = url.searchParams;
    const isHeadBucket = route.operation === 'HeadBucket';
    if (isHeadBucket) {
      if (route.bucket === bucket) {
        send(res, 200, '', { 'content-type': 'application/xml', 'x-amz-bucket-region': 'us-east-1' }, true);
        return;
      }
      send(res, 404, errorXml('NoSuchBucket', 'bucket not found'), { 'content-type': 'application/xml' }, true);
      return;
    }

    if (route.operation === 'ListObjectsV2') {
      const prefix = query.get('prefix') ?? '';
      const token = query.get('continuation-token') ?? '';
      const start = token.startsWith('token-') ? Number(token.slice('token-'.length)) : 0;
      const allKeys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
      const page = allKeys.slice(start, start + server.pageKeys);
      const truncated = start + server.pageKeys < allKeys.length;
      const contents = page
        .map((key) => {
          const object = objects.get(key)!;
          return `<Contents><Key>${xmlEscape(key)}</Key><LastModified>${isoOf(object.lastModified)}</LastModified><ETag>${xmlEscape(object.etag)}</ETag><Size>${object.body.byteLength}</Size><StorageClass>STANDARD</StorageClass></Contents>`;
        })
        .join('');
      const next = truncated ? `<NextContinuationToken>token-${start + server.pageKeys}</NextContinuationToken>` : '';
      const xml = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${xmlEscape(bucket)}</Name><Prefix>${xmlEscape(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>${truncated}</IsTruncated>${next}${contents}</ListBucketResult>`;
      send(res, 200, xml, { 'content-type': 'application/xml' });
      return;
    }

    if (route.operation === 'DeleteObjects') {
      for (const key of parseDeleteKeys(body)) objects.delete(key);
      send(res, 200, `<?xml version="1.0" encoding="UTF-8"?><DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"></DeleteResult>`, {
        'content-type': 'application/xml',
      });
      return;
    }

    const key = route.key ?? '';
    const existing = objects.get(key);

    if (route.operation === 'HeadObject') {
      if (!existing) {
        send(res, 404, '', {}, true);
        return;
      }
      send(
        res,
        200,
        '',
        {
          'content-type': existing.contentType,
          'content-length': String(existing.body.byteLength),
          etag: existing.etag,
          'last-modified': lastModifiedHeader(existing.lastModified),
          'accept-ranges': 'bytes',
        },
        true,
      );
      return;
    }

    if (route.operation === 'GetObject') {
      if (!existing) {
        send(res, 404, errorXml('NoSuchKey', 'key not found'), { 'content-type': 'application/xml' });
        return;
      }
      const total = existing.body.byteLength;
      const rangeHeader = req.headers.range;
      if (typeof rangeHeader === 'string' && rangeHeader !== '') {
        const range = parseRange(rangeHeader, total);
        if (!range) {
          send(res, 416, errorXml('InvalidRange', 'requested range is not satisfiable'), {
            'content-type': 'application/xml',
            'content-range': `bytes */${total}`,
          });
          return;
        }
        const slice = existing.body.subarray(range.start, range.end + 1);
        send(
          res,
          206,
          slice,
          {
            'content-type': existing.contentType,
            etag: existing.etag,
            'last-modified': lastModifiedHeader(existing.lastModified),
            'content-range': `bytes ${range.start}-${range.end}/${total}`,
          },
        );
        return;
      }
      send(
        res,
        200,
        existing.body,
        {
          'content-type': existing.contentType,
          etag: existing.etag,
          'last-modified': lastModifiedHeader(existing.lastModified),
          'accept-ranges': 'bytes',
        },
      );
      return;
    }

    if (route.operation === 'PutObject') {
      const contentType = String(req.headers['content-type'] ?? 'application/octet-stream');
      server.seed(key, body, contentType);
      send(res, 200, '', { etag: etagOf(body) });
      return;
    }

    if (route.operation === 'CopyObject') {
      const raw = String(req.headers['x-amz-copy-source'] ?? '');
      const source = copySourceKey(raw);
      const stored = objects.get(source.key);
      if (source.bucket !== bucket || !stored) {
        send(res, 404, errorXml('NoSuchKey', 'copy source not found'), { 'content-type': 'application/xml' });
        return;
      }
      const copy: StoredObject = { ...stored, lastModified: new Date() };
      objects.set(key, copy);
      const xml = `<?xml version="1.0" encoding="UTF-8"?><CopyObjectResult><ETag>${xmlEscape(copy.etag)}</ETag><LastModified>${isoOf(copy.lastModified)}</LastModified></CopyObjectResult>`;
      send(res, 200, xml, { 'content-type': 'application/xml' });
      return;
    }

    if (route.operation === 'DeleteObject') {
      objects.delete(key);
      send(res, 204, '');
      return;
    }

    if (route.operation === 'CreateMultipartUpload') {
      uploadSeq += 1;
      const uploadId = `upload-${uploadSeq}`;
      const contentType = String(req.headers['content-type'] ?? 'application/octet-stream');
      uploads.set(uploadId, { key, contentType, parts: new Map() });
      const xml = `<?xml version="1.0" encoding="UTF-8"?><InitiateMultipartUploadResult><Bucket>${xmlEscape(bucket)}</Bucket><Key>${xmlEscape(key)}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`;
      send(res, 200, xml, { 'content-type': 'application/xml' });
      return;
    }

    if (route.operation === 'UploadPart') {
      const uploadId = query.get('uploadId') ?? '';
      const partNumber = Number(query.get('partNumber') ?? '0');
      const upload = uploads.get(uploadId);
      if (!upload) {
        send(res, 404, errorXml('NoSuchUpload', 'upload not found'), { 'content-type': 'application/xml' });
        return;
      }
      upload.parts.set(partNumber, Buffer.from(body));
      send(res, 200, '', { etag: etagOf(body) });
      return;
    }

    if (route.operation === 'CompleteMultipartUpload') {
      const uploadId = query.get('uploadId') ?? '';
      const upload = uploads.get(uploadId);
      if (!upload) {
        send(res, 404, errorXml('NoSuchUpload', 'upload not found'), { 'content-type': 'application/xml' });
        return;
      }
      const order = parseCompleteParts(body);
      const missing = order.find((partNumber) => !upload.parts.has(partNumber));
      if (order.length === 0 || missing !== undefined) {
        send(res, 400, errorXml('InvalidPart', `part ${missing ?? '?'} is missing`), { 'content-type': 'application/xml' });
        return;
      }
      const assembled = Buffer.concat(order.map((partNumber) => upload.parts.get(partNumber)!));
      server.seed(upload.key, assembled, upload.contentType);
      uploads.delete(uploadId);
      const xml = `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUploadResult><Location>${xmlEscape(`${server.baseUrl}/${bucket}/${upload.key}`)}</Location><Bucket>${xmlEscape(bucket)}</Bucket><Key>${xmlEscape(upload.key)}</Key><ETag>${etagOf(assembled)}</ETag></CompleteMultipartUploadResult>`;
      send(res, 200, xml, { 'content-type': 'application/xml' });
      return;
    }

    if (route.operation === 'ListParts') {
      const uploadId = query.get('uploadId') ?? '';
      const upload = uploads.get(uploadId);
      if (!upload) {
        send(res, 404, errorXml('NoSuchUpload', 'upload not found'), { 'content-type': 'application/xml' });
        return;
      }
      const marker = Number(query.get('part-number-marker') ?? '0');
      const ordered = [...upload.parts.entries()].sort((a, b) => a[0] - b[0]);
      const visible = ordered.filter(([partNumber]) => partNumber > marker);
      const parts = visible
        .map(([partNumber, buffer]) => {
          const iso = isoOf(new Date('2026-01-04T10:00:00.000Z'));
          return `<Part><PartNumber>${partNumber}</PartNumber><LastModified>${iso}</LastModified><ETag>${etagOf(buffer)}</ETag><Size>${buffer.byteLength}</Size></Part>`;
        })
        .join('');
      const xml = `<?xml version="1.0" encoding="UTF-8"?><ListPartsResult><Bucket>${xmlEscape(bucket)}</Bucket><Key>${xmlEscape(upload.key)}</Key><UploadId>${uploadId}</UploadId><PartNumberMarker>${marker}</PartNumberMarker><MaxParts>1000</MaxParts><IsTruncated>false</IsTruncated>${parts}</ListPartsResult>`;
      send(res, 200, xml, { 'content-type': 'application/xml' });
      return;
    }

    if (route.operation === 'AbortMultipartUpload') {
      uploads.delete(query.get('uploadId') ?? '');
      send(res, 204, '');
      return;
    }

    send(res, 500, errorXml('NotImplemented', `no fake route for ${method} ${url.pathname}`), {
      'content-type': 'application/xml',
    });
  };

  httpServer = createServer((req, res) => {
    void handle(req, res).catch(() => {
      try {
        if (!res.writableEnded && !res.destroyed) {
          send(res, 500, errorXml('InternalError', 'fake server failure'), { 'content-type': 'application/xml' });
        }
      } catch {
        res.destroy();
      }
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address() as AddressInfo;
  server.baseUrl = `http://127.0.0.1:${address.port}`;
  return server;
}

/** Free port that nothing listens on (connection-refused scenarios). */
export async function unusedPort(): Promise<number> {
  const httpServer = createServer(() => undefined);
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const port = (httpServer.address() as AddressInfo).port;
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  return port;
}

const SAVED_ENV: Record<string, string | undefined> = {};

/** The SSRF gate needs an explicit opt-in for loopback http endpoints. */
export function enableLocalEndpoint(): void {
  for (const name of ['ALLOW_INSECURE_ENDPOINTS', 'SSRF_ALLOWLIST']) SAVED_ENV[name] = process.env[name];
  process.env.ALLOW_INSECURE_ENDPOINTS = 'true';
  process.env.SSRF_ALLOWLIST = '127.0.0.1';
}

export function restoreEndpointEnv(): void {
  for (const [name, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

/**
 * Start a fake S3 endpoint with the SSRF opt-in for loopback http in place,
 * mirroring `withFakeDrive` from the Google Drive tests.
 */
export async function withFakeS3(
  options: { bucket?: string; pageKeys?: number },
  run: (server: FakeS3) => Promise<void>,
): Promise<void> {
  enableLocalEndpoint();
  const server = await startFakeS3(options);
  try {
    await run(server);
  } finally {
    await server.close();
    restoreEndpointEnv();
  }
}

export const TEST_ACCESS_KEY_ID = 'test-access-key-id';
export const TEST_SECRET_ACCESS_KEY = 'test-secret-access-key';
export const TEST_REGION = 'us-east-1';

let contextSeq = 0;

export interface S3ContextOverrides {
  userId?: string;
  config?: Record<string, unknown>;
  endpoint?: string;
  signal?: AbortSignal;
  credentials?: Record<string, unknown>;
}

export function makeS3Context(server: FakeS3 | { baseUrl: string; bucket?: string }, overrides: S3ContextOverrides = {}): ProviderContext {
  contextSeq += 1;
  const endpoint = overrides.endpoint ?? server.baseUrl;
  const bucket = server.bucket ?? 'test-bucket';
  const credentials = {
    kind: 'access_key' as const,
    accessKeyId: TEST_ACCESS_KEY_ID,
    secretAccessKey: TEST_SECRET_ACCESS_KEY,
    endpoint,
    region: TEST_REGION,
    forcePathStyle: true,
    bucket,
    prefix: '9drive',
    ...(overrides.credentials ?? {}),
  } as ProviderContext['credentials'];
  return {
    credentials,
    account: {
      id: `account-${contextSeq}`,
      userId: overrides.userId ?? 'user-1',
      provider: 's3',
      providerAccountId: 's3-account-001',
      displayName: 'S3 Tester',
      config: {
        bucket,
        prefix: '9drive',
        endpoint,
        region: TEST_REGION,
        forcePathStyle: true,
        ...overrides.config,
      },
    },
    signal: overrides.signal,
    logger: () => undefined,
  };
}

export function textStream(content: string): NodeJS.ReadableStream {
  return Readable.from([Buffer.from(content, 'utf8')]);
}

export function bufferStream(content: Buffer): NodeJS.ReadableStream {
  return Readable.from([content]);
}

export async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
  }
  return Buffer.concat(chunks);
}

export async function expectProviderCode(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.then(
    () => {
      throw new Error(`expected the operation to reject with ${code}, but it resolved`);
    },
    (err: unknown) => err,
  );
  if (!ProviderError.is(error)) {
    throw new Error(`expected a ProviderError, received: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (error.code !== code) {
    throw new Error(`expected provider code ${code}, received ${error.code}: ${error.message}`);
  }
}

function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Payload hash @smithy/signature-v4 signs for a body-less presigned request. */
const EMPTY_PAYLOAD_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

/** SigV4 URI encoding: `encodeURIComponent` plus the `!'()*` set (AWS spec). */
function encodeAws(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

export interface PresignCheck {
  valid: boolean;
  reason?: string;
}

/**
 * Independent AWS SigV4 verification of a presigned URL: rebuild the canonical
 * request from the URL alone, derive the signing key, compare the signature.
 */
export function verifyPresignedUrl(
  rawUrl: string,
  credentials: { accessKeyId: string; secretAccessKey: string; region: string },
): PresignCheck {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { valid: false, reason: 'url is not parseable' };
  }
  const query = url.searchParams;
  const algorithm = query.get('X-Amz-Algorithm');
  if (algorithm !== 'AWS4-HMAC-SHA256') return { valid: false, reason: `unexpected algorithm ${algorithm}` };
  const credential = query.get('X-Amz-Credential');
  const amzDate = query.get('X-Amz-Date');
  const expires = query.get('X-Amz-Expires');
  const signedHeaders = query.get('X-Amz-SignedHeaders');
  const signature = query.get('X-Amz-Signature');
  if (!credential || !amzDate || !expires || !signedHeaders || !signature) {
    return { valid: false, reason: 'missing presign query parameter' };
  }
  const scopeParts = credential.split('/');
  if (scopeParts.length !== 5 || scopeParts[0] !== credentials.accessKeyId) {
    return { valid: false, reason: 'credential scope does not match the access key' };
  }
  const [, dateStamp, region, service, terminator] = scopeParts;
  if (region !== credentials.region || service !== 's3' || terminator !== 'aws4_request') {
    return { valid: false, reason: 'credential scope must end in <region>/s3/aws4_request' };
  }
  if (!amzDate.startsWith(`${dateStamp}T`)) return { valid: false, reason: 'amz date does not match credential date' };

  const names = signedHeaders.split(';').filter(Boolean);
  const canonicalQuery = [...query.entries()]
    .filter(([name]) => name !== 'X-Amz-Signature')
    .map(([name, value]) => `${encodeAws(name)}=${encodeAws(value)}`)
    .sort()
    .join('&');
  const canonicalHeaders = names
    .map((name) => {
      const lower = name.toLowerCase();
      let value: string;
      if (lower === 'host') value = url.port === '' ? url.hostname : `${url.hostname}:${url.port}`;
      else value = query.get(name) ?? '';
      return `${lower}:${value.trim()}\n`;
    })
    .join('');

  const scope = `${dateStamp}/${region}/${service}/${terminator}`;
  const canonicalRequest = [
    'GET',
    url.pathname,
    canonicalQuery,
    canonicalHeaders,
    names.map((name) => name.toLowerCase()).join(';'),
    EMPTY_PAYLOAD_SHA256,
  ].join('\n');

  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const dateKey = hmac(`AWS4${credentials.secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, service);
  const signingKey = hmac(serviceKey, terminator);
  const expected = hmac(signingKey, stringToSign).toString('hex');
  if (expected !== signature) return { valid: false, reason: 'signature mismatch' };
  return { valid: true };
}
