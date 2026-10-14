/**
 * TeraBox Open Platform REST client (official `/openapi/*` + `superfile2`).
 *
 * The access token travels as the `access_tokens` query parameter, exactly as the
 * official document specifies. Consequently request URLs are secrets: this module
 * never logs them and never puts them into error messages or `detail`.
 * Service hosts come from `/oauth/tokeninfo`, are validated by `transport.ts`, and
 * every request (and every download redirect hop) re-enters `assertFetchAllowed()`.
 */

import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Blob } from 'node:buffer';
import { FormData, request, type Dispatcher } from 'undici';
import { assertFetchAllowed } from '../../utils/ssrf.js';
import { ProviderError } from '../errors.js';
import { fetchTokenInfo, type TeraBoxTokenInfo } from './auth.js';
import { mapTeraBoxErrno, mapTeraBoxHttpStatus, mapTeraBoxTransportError } from './errors.js';
import { assertTeraBoxDownloadUrl, buildUrl, TERABOX_OPEN_APP_ID } from './transport.js';

export const JSON_TIMEOUT_MS = 30_000;
export const TRANSFER_TIMEOUT_MS = 15 * 60_000;
const MAX_JSON_BODY_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Doc §1.4.2.2: cache the per-token domain info for no longer than one hour. */
const TOKEN_INFO_TTL_MS = 30 * 60_000;
const TOKEN_INFO_MAX_ENTRIES = 500;
const tokenInfoCache = new Map<string, { info: TeraBoxTokenInfo; expiresAt: number }>();

export function clearTokenInfoCache(): void {
  tokenInfoCache.clear();
}

function cacheKey(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface ApiCallOptions {
  method?: 'GET' | 'POST';
  query?: Record<string, string | number | undefined>;
  form?: Record<string, string | number>;
  timeoutMs?: number;
}

export interface TeraBoxOpenClientOptions {
  accessToken: string;
  signal?: AbortSignal;
}

export class TeraBoxOpenClient {
  private constructor(
    private readonly accessToken: string,
    readonly info: TeraBoxTokenInfo,
    private readonly signal: AbortSignal | undefined,
  ) {}

  static async create(options: TeraBoxOpenClientOptions): Promise<TeraBoxOpenClient> {
    const key = cacheKey(options.accessToken);
    const hit = tokenInfoCache.get(key);
    if (hit && hit.expiresAt > Date.now()) {
      return new TeraBoxOpenClient(options.accessToken, hit.info, options.signal);
    }
    const info = await fetchTokenInfo(options.accessToken, options.signal);
    if (tokenInfoCache.size >= TOKEN_INFO_MAX_ENTRIES) {
      const oldest = tokenInfoCache.keys().next().value;
      if (oldest !== undefined) tokenInfoCache.delete(oldest);
    }
    tokenInfoCache.set(key, { info, expiresAt: Date.now() + TOKEN_INFO_TTL_MS });
    return new TeraBoxOpenClient(options.accessToken, info, options.signal);
  }

  get uploadBase(): string {
    if (!this.info.uploadBase) {
      throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'TeraBox did not return an upload_domain for this account');
    }
    return this.info.uploadBase;
  }

  /** JSON call on `api_domain`. Throws on HTTP failure or non-zero top-level errno. */
  async api(endpoint: string, options: ApiCallOptions = {}): Promise<Record<string, unknown>> {
    const method = options.method ?? (options.form ? 'POST' : 'GET');
    const url = buildUrl(this.info.apiBase, endpoint, { ...options.query, access_tokens: this.accessToken });
    return this.json(url, {
      method,
      body: options.form
        ? new URLSearchParams(Object.entries(options.form).map(([k, v]) => [k, String(v)])).toString()
        : undefined,
      headers: options.form ? { 'content-type': 'application/x-www-form-urlencoded' } : undefined,
      timeoutMs: options.timeoutMs ?? JSON_TIMEOUT_MS,
    });
  }

  private async json(
    url: string,
    init: { method: 'GET' | 'POST'; body?: string | FormData; headers?: Record<string, string>; timeoutMs: number },
  ): Promise<Record<string, unknown>> {
    try {
      await assertFetchAllowed(url);
      const response = await request(url, {
        method: init.method,
        body: init.body,
        headers: { accept: 'application/json, text/plain, */*', ...init.headers },
        signal: this.signal ?? null,
        headersTimeout: init.timeoutMs,
        bodyTimeout: init.timeoutMs,
      });
      const text = await readCapped(response.body, MAX_JSON_BODY_BYTES);
      let payload: unknown = null;
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        if (response.statusCode >= 400) throw mapTeraBoxHttpStatus(response.statusCode);
        throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'TeraBox returned a non-JSON response', {
          upstreamStatus: response.statusCode,
        });
      }
      const body = payload as Record<string, unknown>;
      const code = firstNumber(body.errno) ?? firstNumber(body.error_code) ?? 0;
      if (code !== 0) throw mapTeraBoxErrno(code, body);
      if (response.statusCode >= 400) throw mapTeraBoxHttpStatus(response.statusCode);
      return body;
    } catch (error) {
      throw mapTeraBoxTransportError(error);
    }
  }

  /**
   * One shard of `POST {upload_domain}/rest/2.0/pcs/superfile2`.
   * Returns the server-echoed shard md5 (used for integrity verification).
   */
  async uploadShard(input: { path: string; uploadId: string; partSeq: number; data: Buffer }): Promise<string> {
    const url = buildUrl(this.uploadBase, '/rest/2.0/pcs/superfile2', {
      method: 'upload',
      app_id: TERABOX_OPEN_APP_ID,
      path: input.path,
      uploadid: input.uploadId,
      partseq: input.partSeq,
      access_tokens: this.accessToken,
    });
    const form = new FormData();
    form.set('file', new Blob([input.data as unknown as Uint8Array<ArrayBuffer>]) as never, 'blob');
    const body = await this.json(url, { method: 'POST', body: form, timeoutMs: TRANSFER_TIMEOUT_MS });
    const md5 = typeof body.md5 === 'string' ? body.md5.toLowerCase() : '';
    if (!/^[0-9a-f]{32}$/.test(md5)) {
      throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'TeraBox did not echo a shard md5');
    }
    return md5;
  }

  /**
   * Fetch a dlink returned by `/openapi/api/download`. The documented link needs
   * `access_tokens` appended. Every hop is host-validated and SSRF-gated; the token
   * is only ever attached to the first hop (redirect targets are CDN-signed).
   */
  async openDownload(dlink: string, range?: { start: number; end?: number }): Promise<Dispatcher.ResponseData> {
    let target = assertTeraBoxDownloadUrl(dlink);
    target.searchParams.set('access_tokens', this.accessToken);
    let current = target.toString();
    const headers: Record<string, string> = {};
    if (range) headers.range = `bytes=${range.start}-${range.end ?? ''}`;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let response: Dispatcher.ResponseData;
      try {
        await assertFetchAllowed(current);
        response = await request(current, {
          method: 'GET',
          headers,
          signal: this.signal ?? null,
          headersTimeout: TRANSFER_TIMEOUT_MS,
          bodyTimeout: TRANSFER_TIMEOUT_MS,
        });
      } catch (error) {
        throw mapTeraBoxTransportError(error);
      }
      const location = typeof response.headers.location === 'string' ? response.headers.location : null;
      if (!REDIRECT_STATUSES.has(response.statusCode) || location === null) {
        if (response.statusCode >= 400) {
          await response.body.dump({ limit: 64 * 1024 }).catch(() => undefined);
          throw mapTeraBoxHttpStatus(response.statusCode);
        }
        return response;
      }
      await response.body.dump({ limit: 64 * 1024 }).catch(() => undefined);
      if (hop === MAX_REDIRECTS) throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'TeraBox download redirected too many times');
      target = assertTeraBoxDownloadUrl(new URL(location, current).toString());
      target.searchParams.delete('access_tokens');
      current = target.toString();
    }
    throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'TeraBox download redirected too many times');
  }
}

function firstNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

async function readCapped(stream: Readable | AsyncIterable<Uint8Array>, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream as AsyncIterable<Uint8Array>) {
    const buf = Buffer.from(chunk);
    total += buf.length;
    if (total > limit) throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'TeraBox response body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}
