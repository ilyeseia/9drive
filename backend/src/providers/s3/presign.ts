/**
 * Presigned S3 GET URLs for `createShare` — provider-contract.md §4.
 *
 * `@aws-sdk/s3-request-presigner` is not a dependency, so the URL is produced by
 * the standalone `@smithy/signature-v4` signer with a node:crypto SHA-256
 * implementation (HMAC mode when the signer derives its signing key).
 * Lifetimes are clamped to 7 days: SigV4 rejects anything longer.
 */

import { createHash, createHmac } from 'node:crypto';
import { SignatureV4 } from '@smithy/signature-v4';
import { ProviderError } from '../errors.js';
import { assertUrlAllowed } from '../../utils/ssrf.js';
import type { S3Settings } from './client.js';

/** AWS rejects presigned lifetimes longer than 7 days. */
export const MAX_PRESIGN_SECONDS = 604_800;
/** Share URLs live one hour unless the caller picks an expiry. */
export const DEFAULT_PRESIGN_SECONDS = 3_600;

type HashSource = string | ArrayBuffer | ArrayBufferView;

function toBinary(data: HashSource): Buffer | string {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  const view = data as ArrayBufferView;
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
}

/** node:crypto hash/HMAC behind the `HashConstructor` shape the signer expects. */
class NodeSha256 {
  readonly #hash: ReturnType<typeof createHash> | ReturnType<typeof createHmac>;

  constructor(secret?: HashSource) {
    this.#hash = secret === undefined ? createHash('sha256') : createHmac('sha256', toBinary(secret));
  }

  update(data: HashSource): void {
    this.#hash.update(toBinary(data));
  }

  digest(): Promise<Uint8Array> {
    return Promise.resolve(new Uint8Array(this.#hash.digest()));
  }
}

const EXTRAS = /[!'()*]/g;

/** AWS single URI encoding: `encodeURIComponent` plus the SigV4 extra set. */
export function escapeUri(value: string): string {
  return encodeURIComponent(value).replace(EXTRAS, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

interface ObjectTarget {
  protocol: string;
  hostname: string;
  port: number | null;
  path: string;
}

function defaultPort(protocol: string): number {
  return protocol === 'https:' ? 443 : 80;
}

function hostHeaderFor(target: ObjectTarget): string {
  if (target.port !== null && target.port !== defaultPort(target.protocol)) return `${target.hostname}:${target.port}`;
  return target.hostname;
}

/** Addressing the presigned GET must use, mirroring the client's path/virtual-host style. */
export function objectTarget(settings: S3Settings, key: string): ObjectTarget {
  const encodedKey = key.split('/').map(escapeUri).join('/');
  if (settings.endpoint) {
    const url = assertUrlAllowed(settings.endpoint);
    const port = url.port === '' ? null : Number(url.port);
    const protocol = url.protocol;
    if (settings.forcePathStyle) {
      return { protocol, hostname: url.hostname, port, path: `/${escapeUri(settings.bucket)}/${encodedKey}` };
    }
    return { protocol, hostname: `${settings.bucket}.${url.hostname}`, port, path: `/${encodedKey}` };
  }
  const protocol = 'https:';
  const base = `s3.${settings.region}.amazonaws.com`;
  if (settings.forcePathStyle) {
    return { protocol, hostname: base, port: null, path: `/${escapeUri(settings.bucket)}/${encodedKey}` };
  }
  return { protocol, hostname: `${settings.bucket}.${base}`, port: null, path: `/${encodedKey}` };
}

function clampExpires(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_PRESIGN_SECONDS;
  const seconds = Math.floor(value);
  if (seconds < 1) return 1;
  return Math.min(seconds, MAX_PRESIGN_SECONDS);
}

function composeUrl(target: ObjectTarget, query: Record<string, string | string[] | null>): string {
  const pairs = Object.keys(query)
    .sort()
    .flatMap((name) => {
      const value = query[name];
      if (value === null || value === undefined) return [escapeUri(name)];
      if (Array.isArray(value)) return value.map((item) => `${escapeUri(name)}=${escapeUri(item)}`);
      return [`${escapeUri(name)}=${escapeUri(value)}`];
    });
  const authority = hostHeaderFor(target);
  const search = pairs.length > 0 ? `?${pairs.join('&')}` : '';
  return `${target.protocol}//${authority}${target.path}${search}`;
}

/** Build a presigned GET URL for one object key inside the account namespace. */
export async function createPresignedGetUrl(
  settings: S3Settings,
  key: string,
  expiresInSeconds: number,
  signingDate: Date = new Date(),
): Promise<string> {
  const expiresIn = clampExpires(expiresInSeconds);
  const target = objectTarget(settings, key);
  const signer = new SignatureV4({
    service: 's3',
    region: settings.region,
    credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
    sha256: NodeSha256,
    uriEscapePath: false,
    applyChecksum: false,
  });
  const signed = await signer.presign(
    {
      method: 'GET',
      protocol: target.protocol,
      hostname: target.hostname,
      ...(target.port !== null ? { port: target.port } : {}),
      path: target.path,
      query: {},
      headers: { host: hostHeaderFor(target) },
    },
    { expiresIn, signingDate },
  );
  return composeUrl(target, signed.query ?? {});
}

/** Resolve a caller-supplied share expiry into a clamped SigV4 lifetime. */
export function resolveShareExpiresIn(expiresAt: string | null | undefined, now: number = Date.now()): number {
  if (typeof expiresAt !== 'string' || expiresAt.trim() === '') return DEFAULT_PRESIGN_SECONDS;
  const parsed = Date.parse(expiresAt.trim());
  if (Number.isNaN(parsed)) {
    throw new ProviderError('ERR_INVALID_INPUT', 'expiresAt is not a valid timestamp');
  }
  if (parsed <= now) {
    throw new ProviderError('ERR_INVALID_INPUT', 'expiresAt must be in the future');
  }
  return Math.min(Math.ceil((parsed - now) / 1000), MAX_PRESIGN_SECONDS);
}
