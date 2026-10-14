/**
 * TeraBox Open Platform authorization service client.
 *
 * Endpoints (official doc §1.4, §2): `GET /oauth/devicecode`,
 * `POST /oauth/gettoken`, `POST /oauth/refreshtoken`, `POST /oauth/tokeninfo`.
 * Responses are `{ data: {...}, errno }`. Signed calls carry
 * `timestamp` + `sign = md5(client_id_timestamp_client_secret_private_secret)`.
 *
 * The `private_secret` is read from the environment only (`TERABOX_PRIVATE_SECRET`);
 * it is never stored in the database and never logged.
 *
 * Refresh tokens are SINGLE-USE and the previous access token dies 15 s after a
 * successful refresh, so concurrent refreshes of one account would lock the
 * account out. `refreshTeraBoxTokens()` therefore shares one in-flight request
 * per refresh token within this process.
 */

import { createHash } from 'node:crypto';
import { FormData, request } from 'undici';
import { z } from 'zod';
import { assertFetchAllowed } from '../../utils/ssrf.js';
import { ProviderError } from '../errors.js';
import type { OAuth2TokenResult } from '../oauth2.js';
import { mapTeraBoxErrno, mapTeraBoxHttpStatus, mapTeraBoxTransportError, TERABOX_ERRNO } from './errors.js';
import { buildUrl, serviceBaseFromDomain, teraboxOpenTransport } from './transport.js';

export const AUTH_TIMEOUT_MS = 30_000;
const MAX_AUTH_BODY_BYTES = 1024 * 1024;
const QR_PREFIX = 'data:image/png;base64,';
const MAX_QR_CHARS = 512 * 1024;

export interface TeraBoxAppCredentials {
  clientId: string;
  clientSecret: string;
  privateSecret: string;
}

export function readPrivateSecret(): string {
  const value = process.env.TERABOX_PRIVATE_SECRET?.trim();
  if (!value) {
    throw new ProviderError(
      'ERR_INTERNAL',
      'TeraBox private_secret is not configured (set TERABOX_PRIVATE_SECRET)',
      { retryable: false },
    );
  }
  return value;
}

/** `md5(client_id_timestamp_client_secret_private_secret)` — lowercase hex (case unverified upstream). */
export function signTeraBoxRequest(creds: TeraBoxAppCredentials, timestamp: number): string {
  return createHash('md5')
    .update(`${creds.clientId}_${timestamp}_${creds.clientSecret}_${creds.privateSecret}`)
    .digest('hex');
}

interface AuthCallOptions {
  method: 'GET' | 'POST';
  endpoint: string;
  query?: Record<string, string | number | undefined>;
  form?: Record<string, string | number>;
  signal?: AbortSignal;
}

async function authCall(options: AuthCallOptions): Promise<Record<string, unknown>> {
  const url = buildUrl(teraboxOpenTransport().authBase, options.endpoint, options.query);
  let body: FormData | undefined;
  if (options.form) {
    body = new FormData();
    for (const [key, value] of Object.entries(options.form)) body.set(key, String(value));
  }
  try {
    await assertFetchAllowed(url);
    const response = await request(url, {
      method: options.method,
      body,
      signal: options.signal ?? null,
      headersTimeout: AUTH_TIMEOUT_MS,
      bodyTimeout: AUTH_TIMEOUT_MS,
    });
    const text = await readCapped(response.body, MAX_AUTH_BODY_BYTES);
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      if (response.statusCode >= 400) throw mapTeraBoxHttpStatus(response.statusCode);
      throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'TeraBox authorization service returned a non-JSON response', {
        upstreamStatus: response.statusCode,
      });
    }
    return payload as Record<string, unknown>;
  } catch (error) {
    throw mapTeraBoxTransportError(error);
  }
}

async function readCapped(stream: AsyncIterable<Buffer | Uint8Array>, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.from(chunk);
    total += buf.length;
    if (total > limit) throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'TeraBox response body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function errnoOf(payload: Record<string, unknown>): number {
  const raw = payload.errno;
  if (raw === undefined || raw === null) return 0;
  const value = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(value) ? value : -1;
}

const tokenDataSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.coerce.number().int().positive(),
});

function toTokenResult(payload: Record<string, unknown>): OAuth2TokenResult {
  const parsed = tokenDataSchema.safeParse(payload.data);
  if (!parsed.success) {
    throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'TeraBox token response was malformed');
  }
  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token,
    expiresAt: Date.now() + parsed.data.expires_in * 1000,
  };
}

export interface DeviceAuthorization {
  deviceCode: string;
  /** `data:image/png;base64,…` produced by TeraBox. */
  qrCodeDataUrl: string;
  expiresInSeconds: number;
  intervalSeconds: number;
}

const deviceDataSchema = z.object({
  device_code: z.string().min(1).max(256),
  qrcode_url: z.string().min(1),
  expires_in: z.coerce.number().int().positive().max(3600),
  interval: z.coerce.number().int().min(1).max(60),
});

/** Step 1 of device-code mode. */
export async function startDeviceAuthorization(clientId: string, signal?: AbortSignal): Promise<DeviceAuthorization> {
  const payload = await authCall({ method: 'GET', endpoint: '/oauth/devicecode', query: { client_id: clientId }, signal });
  const errno = errnoOf(payload);
  if (errno !== 0) throw mapTeraBoxErrno(errno, payload);
  const parsed = deviceDataSchema.safeParse(payload.data);
  if (!parsed.success) {
    throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'TeraBox device-code response was malformed');
  }
  const qr = parsed.data.qrcode_url;
  // Only an inline PNG is ever forwarded to the browser; no remote image URL is trusted.
  if (!qr.startsWith(QR_PREFIX) || qr.length > MAX_QR_CHARS || !/^[A-Za-z0-9+/=]+$/.test(qr.slice(QR_PREFIX.length))) {
    throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'TeraBox returned an unexpected QR code format');
  }
  return {
    deviceCode: parsed.data.device_code,
    qrCodeDataUrl: qr,
    expiresInSeconds: parsed.data.expires_in,
    intervalSeconds: parsed.data.interval,
  };
}

export type DevicePollResult = { status: 'pending' } | { status: 'authorized'; tokens: OAuth2TokenResult };

/** Step 2 of device-code mode: errno 400001 means the user has not scanned yet. */
export async function pollDeviceToken(
  creds: TeraBoxAppCredentials,
  deviceCode: string,
  signal?: AbortSignal,
): Promise<DevicePollResult> {
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = await authCall({
    method: 'POST',
    endpoint: '/oauth/gettoken',
    form: {
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      grant_type: 'device_code',
      code: deviceCode,
      timestamp,
      sign: signTeraBoxRequest(creds, timestamp),
    },
    signal,
  });
  const errno = errnoOf(payload);
  if (errno === TERABOX_ERRNO.DEVICE_AUTH_PENDING) return { status: 'pending' };
  if (errno !== 0) throw mapTeraBoxErrno(errno, payload);
  return { status: 'authorized', tokens: toTokenResult(payload) };
}

const inflightRefresh = new Map<string, Promise<OAuth2TokenResult>>();

export interface RefreshOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  signal?: AbortSignal;
}

/**
 * `POST /oauth/refreshtoken`. Single-use refresh tokens: callers racing with the
 * same refresh token share one request (and one result).
 */
export function refreshTeraBoxTokens(options: RefreshOptions): Promise<OAuth2TokenResult> {
  const key = createHash('sha256').update(options.refreshToken).digest('hex');
  const existing = inflightRefresh.get(key);
  if (existing) return existing;
  const run = doRefresh(options).finally(() => {
    inflightRefresh.delete(key);
  });
  inflightRefresh.set(key, run);
  return run;
}

async function doRefresh(options: RefreshOptions): Promise<OAuth2TokenResult> {
  const creds: TeraBoxAppCredentials = {
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    privateSecret: readPrivateSecret(),
  };
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = await authCall({
    method: 'POST',
    endpoint: '/oauth/refreshtoken',
    form: {
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: options.refreshToken,
      timestamp,
      sign: signTeraBoxRequest(creds, timestamp),
    },
    signal: options.signal,
  });
  const errno = errnoOf(payload);
  if (errno !== 0) throw mapTeraBoxErrno(errno, payload);
  return toTokenResult(payload);
}

export interface TeraBoxTokenInfo {
  userId: string;
  apiBase: string;
  uploadBase: string;
  expiresInSeconds: number | null;
}

const tokenInfoSchema = z.object({
  user_id: z.union([z.number(), z.string()]),
  api_domain: z.string().min(1),
  upload_domain: z.string().min(1).optional(),
  expires_in: z.coerce.number().optional(),
});

/** `POST /oauth/tokeninfo` → per-user service domains (cache ≤ 1 h per the doc). */
export async function fetchTokenInfo(accessToken: string, signal?: AbortSignal): Promise<TeraBoxTokenInfo> {
  const payload = await authCall({
    method: 'POST',
    endpoint: '/oauth/tokeninfo',
    form: { access_token: accessToken },
    signal,
  });
  const errno = errnoOf(payload);
  if (errno !== 0) throw mapTeraBoxErrno(errno, payload);
  const parsed = tokenInfoSchema.safeParse(payload.data);
  if (!parsed.success) throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'TeraBox token info was malformed');
  return {
    userId: String(parsed.data.user_id),
    apiBase: serviceBaseFromDomain(parsed.data.api_domain, 'api_domain'),
    // Fails closed: the doc says uploads must use upload_domain; no fallback is invented.
    uploadBase: parsed.data.upload_domain
      ? serviceBaseFromDomain(parsed.data.upload_domain, 'upload_domain')
      : '',
    expiresInSeconds: parsed.data.expires_in ?? null,
  };
}
