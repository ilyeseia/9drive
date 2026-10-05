/**
 * S3 settings resolution, client construction and the per-request SSRF gate —
 * security-contract.md §7: a custom `endpoint` passes `assertUrlAllowed` at
 * client build and the full `assertFetchAllowed` (URL + DNS) before every request.
 */

import { S3Client } from '@aws-sdk/client-s3';
import type { Command } from '@smithy/core/client';
import { ProviderError } from '../errors.js';
import type { ProviderContext, ProviderCredentials } from '../types.js';
import { assertFetchAllowed, assertUrlAllowed } from '../../utils/ssrf.js';
import { mapS3Error } from './errors.js';
import { namespaceRoot } from './keys.js';
import { resolveS3Target, type S3Target } from './presets.js';

/** access_key credentials as produced by context.ts (contract fields + S3 targeting). */
type S3AccessKeyCredentials = Extract<ProviderCredentials, { kind: 'access_key' }> & {
  bucket?: string;
  prefix?: string;
};

export const DEFAULT_PREFIX = '9drive';
export const DEFAULT_MULTIPART_THRESHOLD_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MULTIPART_PART_BYTES = 5 * 1024 * 1024;
export const MAX_MULTIPART_PARTS = 10_000;
export const MAX_QUOTA_PAGES = 10_000;
export const MAX_OBJECT_BYTES = Number.MAX_SAFE_INTEGER;

export interface S3Settings {
  bucket: string;
  prefix: string;
  region: string;
  endpoint: string | null;
  forcePathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  quotaBytes: bigint | null;
  multipartThresholdBytes: number;
  multipartPartBytes: number;
  target: S3Target;
}

export interface S3Session {
  settings: S3Settings;
  client: S3Client;
  /** `prefix/userId` — every key this session touches lives underneath. */
  root: string;
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function byteCount(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value >= 0n ? value : null;
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? BigInt(Math.floor(value)) : null;
  if (typeof value === 'string' && /^\d{1,19}$/.test(value.trim())) return BigInt(value.trim());
  return null;
}

function positiveInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/** Resolve the full settings object for one context (credentials + config + catalog preset). */
export function resolveSettings(ctx: ProviderContext): S3Settings {
  const credentials = ctx.credentials;
  if (credentials.kind !== 'access_key') {
    throw new ProviderError('ERR_INVALID_INPUT', 'S3 requires access-key credentials');
  }
  const key = credentials as S3AccessKeyCredentials;
  const config = ctx.account.config ?? {};

  const bucket = text(config.bucket) ?? text(key.bucket);
  if (!bucket) throw new ProviderError('ERR_INVALID_INPUT', 'S3 account configuration is missing a bucket');
  if (/[/\\\s]/.test(bucket) || bucket === '.' || bucket === '..') {
    throw new ProviderError('ERR_INVALID_INPUT', 'S3 bucket name is invalid');
  }
  const accessKeyId = text(key.accessKeyId);
  const secretAccessKey = text(key.secretAccessKey);
  if (!accessKeyId || !secretAccessKey) {
    throw new ProviderError('ERR_INVALID_INPUT', 'S3 access key id and secret access key are required');
  }

  const prefix = text(config.prefix) ?? text(key.prefix) ?? DEFAULT_PREFIX;
  const target = resolveS3Target({
    preset: text(config.preset) ?? text(config.s3Preset),
    endpoint: text(config.endpoint) ?? text(key.endpoint),
    region: text(config.region) ?? text(key.region),
    forcePathStyle:
      typeof config.forcePathStyle === 'boolean'
        ? config.forcePathStyle
        : typeof key.forcePathStyle === 'boolean'
          ? key.forcePathStyle
          : null,
  });
  const endpoint = target.endpoint === null ? null : target.endpoint.replace(/\/+$/, '');

  return {
    bucket,
    prefix,
    region: target.region,
    endpoint,
    forcePathStyle: target.forcePathStyle,
    accessKeyId,
    secretAccessKey,
    quotaBytes: byteCount(config.quotaBytes),
    multipartThresholdBytes: positiveInt(
      config.multipartThresholdBytes,
      DEFAULT_MULTIPART_THRESHOLD_BYTES,
      1,
      5 * 1024 * 1024 * 1024,
    ),
    multipartPartBytes: positiveInt(
      config.multipartPartBytes,
      DEFAULT_MULTIPART_PART_BYTES,
      1024,
      5 * 1024 * 1024 * 1024,
    ),
    target,
  };
}

/** Build a client for one resolved settings object. Throws ERR_SSRF_BLOCKED on a bad endpoint. */
export function buildClient(settings: S3Settings): S3Client {
  if (settings.endpoint) assertUrlAllowed(settings.endpoint);
  return new S3Client({
    region: settings.region,
    endpoint: settings.endpoint ?? undefined,
    forcePathStyle: settings.forcePathStyle,
    credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
    // Plain PUT/GET bodies keep the adapter compatible with every S3-compatible
    // endpoint; aws-chunked trailer checksums are not universally supported.
    requestChecksumCalculation: 'WHEN_REQUIRED',
  });
}

/** Open a session: resolve settings, derive the user namespace, build the client. */
export function openSession(ctx: ProviderContext): S3Session {
  const settings = resolveSettings(ctx);
  const root = namespaceRoot(settings.prefix, ctx.account.userId);
  return { settings, client: buildClient(settings), root };
}

/**
 * Any SDK command instance. `Parameters<S3Client['send']>[0]` freezes the
 * client's type parameters at their constraints, which makes every concrete
 * command (narrower middleware stack) fail assignability; `Command<any,…>`
 * keeps the same structural shape without that variance trap.
 */
export type AnyS3Command = Command<any, any, any, any, any>;

/**
 * Send one command: full SSRF gate first (custom endpoints only), then the SDK.
 * Every failure is mapped onto the §5 taxonomy; raw SDK errors never escape.
 * `opts.signal` is combined with `ctx.signal` so a caller (upload guard) can
 * abort a request whose stream diverged from the declared size.
 */
export async function sendCommand<T>(
  ctx: ProviderContext,
  session: S3Session,
  command: AnyS3Command,
  operation: string,
  opts: { signal?: AbortSignal } = {},
): Promise<T> {
  if (session.settings.endpoint) {
    try {
      await assertFetchAllowed(session.settings.endpoint);
    } catch (err) {
      throw ProviderError.is(err) ? err : mapS3Error(err, operation);
    }
  }
  const abortSignal =
    opts.signal && ctx.signal && opts.signal !== ctx.signal
      ? AbortSignal.any([ctx.signal, opts.signal])
      : (opts.signal ?? ctx.signal);
  try {
    return (await session.client.send(command, { abortSignal })) as T;
  } catch (err) {
    throw mapS3Error(err, operation);
  }
}
