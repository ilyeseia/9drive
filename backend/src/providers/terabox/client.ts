/**
 * TeraBox REST client for the adapter — cookie auth, regional base switching,
 * jsToken acquisition and §5 error mapping.
 *
 * Request shapes mirror the reverse-engineered web API documented in
 * docs/architecture/providers/terabox.md §4 (verified against the community
 * client and the rclone backend, both of which are live-tested against the
 * real service). The unofficial API answers `{ errno }` on HTTP 200, so every
 * payload is checked for a non-zero code and stale-token errnos
 * (4000023/450016/4000020/400810) trigger exactly one jsToken refresh + retry.
 *
 * `gatedDownload()` is the SSRF-checked path for upstream-supplied dlinks:
 * every hop re-enters `assertFetchAllowed()` before connecting, and the session
 * cookie is dropped as soon as a redirect leaves the host it was issued to
 * (security-contract §7).
 */

import type { IncomingHttpHeaders } from 'node:http';
import type { Readable } from 'node:stream';
import { request, type Dispatcher } from 'undici';
import { assertFetchAllowed } from '../../utils/ssrf.js';
import { ProviderError } from '../errors.js';
import {
  TOKEN_REFRESH_ERRNOS,
  mapTeraBoxErrno,
  mapTeraBoxHttpStatus,
  mapTeraBoxTransportError,
  teraboxErrno,
} from './errors.js';
import { extractJsToken } from './sign.js';
import { TERABOX_APP_QUERY, TERABOX_USER_AGENT, isTeraboxHostname, regionBaseUrl, teraboxTransport, uploadHostUrl } from './transport.js';

export const JSON_TIMEOUT_MS = 30_000;
export const TRANSFER_TIMEOUT_MS = 15 * 60_000;

const MAX_JSON_BODY_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_TOKEN_RETRIES = 1;
const MAX_REGION_SWITCHES = 1;

/** Which response field carries the failure code (defaults to `errno`). */
export type TeraBoxErrnoField = 'errno' | 'error_code' | 'none';

export interface TeraBoxSendOptions {
  /** Form fields (application/x-www-form-urlencoded body). */
  form?: Record<string, string | number | undefined>;
  /** Raw body; mutually exclusive with `form`. */
  body?: Buffer | Readable;
  contentType?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  errnoField?: TeraBoxErrnoField;
  /** Extra query pairs merged over the app query (`jsToken` included). */
  query?: Record<string, string | number | undefined>;
  /** Append app_id/channel/clienttype/jsToken (default true). */
  appQuery?: boolean;
  /**
   * `filemetas` answers `{"errno":12,"info":[{"errno":-9}]}` — the per-item
   * code outranks the envelope, so it is checked before the top-level one.
   */
  preferInfoErrno?: boolean;
}

export interface TeraBoxJsonResult<T> {
  status: number;
  data: T;
  headers: IncomingHttpHeaders;
}

export interface TeraBoxClientOptions {
  /** Browser cookie string, a bare `ndus` value, or `ndus=…`. */
  cookie: string;
  /** Override the API base (tests inject a local fake). */
  baseUrl?: string;
  signal?: AbortSignal;
  logger?: (msg: string, meta?: Record<string, unknown>) => void;
}

/**
 * A pasted `ndus` value carries no `=`, so it is turned into a real cookie
 * header (the same normalisation the rclone backend performs).
 */
export function normalizeTeraBoxCookie(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value === '') return '';
  const quoted = value.replace(/^"(.*)"$/, '$1').trim();
  if (!quoted.includes('=')) return `ndus=${quoted}; lang=en`;
  return quoted;
}

function headerValue(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const target = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === target);
}

function isHtml(text: string): boolean {
  return /^\s*<(!doctype|html|head|body)/i.test(text);
}

/** True when the cookie must not leave the host it was sent to. */
function isSameHost(a: URL, b: URL): boolean {
  return a.hostname === b.hostname;
}

export async function readBodyText(
  body: Dispatcher.ResponseData['body'],
  limit = MAX_JSON_BODY_BYTES,
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buffer.byteLength;
    if (total > limit) {
      body.destroy();
      throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'TeraBox response body exceeded the JSON limit');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function parseJson(text: string): unknown {
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * GET an upstream-supplied URL (a dlink) through the SSRF gate, following at
 * most `MAX_REDIRECTS` hops with the gate re-applied before every connection.
 * undici never follows redirects on its own, which is what makes the per-hop
 * gate complete. The session cookie travels with the first hop (the URL comes
 * from TeraBox's own API and gated downloads are how the web client works) and
 * is dropped the moment a redirect leaves that host.
 */
export async function gatedDownload(
  url: string,
  init: {
    headers?: Record<string, string>;
    body?: Buffer | Readable;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<Dispatcher.ResponseData> {
  const timeoutMs = init.timeoutMs ?? TRANSFER_TIMEOUT_MS;
  let current = url;
  let headers: Record<string, string> = { ...init.headers };
  let originHost: string | null = null;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const allowed = await assertFetchAllowed(current);
    if (originHost !== null && !isSameHost(allowed, new URL(`${allowed.protocol}//${originHost}`))) {
      delete headers.Cookie;
    }
    if (originHost === null) originHost = allowed.host;

    let response: Dispatcher.ResponseData;
    try {
      response = await request(allowed.toString(), {
        method: 'GET',
        headers,
        body: init.body,
        signal: init.signal ?? null,
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
      });
    } catch (error) {
      throw mapTeraBoxTransportError(error);
    }

    const location = headerValue(response.headers.location);
    if (!REDIRECT_STATUSES.has(response.statusCode) || location === null) return response;
    await response.body.dump({ limit: 64 * 1024 }).catch(() => undefined);

    let next: URL;
    try {
      next = new URL(location, allowed);
    } catch {
      throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'TeraBox returned a malformed redirect');
    }
    if (!isSameHost(next, allowed)) delete headers.Cookie;
    current = next.toString();
    if (hop === MAX_REDIRECTS) {
      throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'TeraBox download followed too many redirects');
    }
  }
  throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'TeraBox download followed too many redirects');
}

export class TeraBoxClient {
  readonly #cookie: string;
  readonly #signal: AbortSignal | undefined;
  readonly #logger: ((msg: string, meta?: Record<string, unknown>) => void) | undefined;
  readonly #transport = teraboxTransport();
  #baseUrl: string;
  #jsToken = '';
  #uploadHost: string | null = null;
  #regionSwitches = 0;
  #tokenRetries = 0;

  constructor(options: TeraBoxClientOptions) {
    const cookie = normalizeTeraBoxCookie(options.cookie);
    if (cookie === '') {
      throw new ProviderError('ERR_AUTH_EXPIRED', 'TeraBox session cookie is empty');
    }
    this.#cookie = cookie;
    this.#baseUrl = (options.baseUrl ?? this.#transport.baseUrl).replace(/\/+$/, '');
    this.#signal = options.signal;
    this.#logger = options.logger;
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  get jsToken(): string {
    return this.#jsToken;
  }

  #headers(extra?: Record<string, string>): Record<string, string> {
    return {
      Accept: 'application/json, text/plain, */*',
      'User-Agent': TERABOX_USER_AGENT,
      Cookie: this.#cookie,
      Referer: `${this.#baseUrl}/`,
      'X-Requested-With': 'XMLHttpRequest',
      ...extra,
    };
  }

  #appQuery(): Record<string, string | number | undefined> {
    return {
      app_id: TERABOX_APP_QUERY.app_id,
      channel: TERABOX_APP_QUERY.channel,
      clienttype: TERABOX_APP_QUERY.clienttype,
      ...(this.#jsToken ? { jsToken: this.#jsToken } : {}),
    };
  }

  #url(endpoint: string, options: TeraBoxSendOptions, base: string): string {
    const url = new URL(endpoint.startsWith('http') ? endpoint : `${base}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`);
    const extra = options.appQuery === false ? {} : { ...this.#appQuery(), ...options.query };
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  /** Regional base switch driven by the upstream prefix header (once, ever). */
  #maybeSwitchRegion(headers: IncomingHttpHeaders): string | null {
    if (this.#regionSwitches >= MAX_REGION_SWITCHES) return null;
    const prefix =
      headerValue(headers['region-domain-prefix'] as string | string[] | undefined) ??
      headerValue(headers['url-domain-prefix'] as string | string[] | undefined);
    const next = regionBaseUrl(prefix ?? undefined);
    if (!next || next === this.#baseUrl) return null;
    const previous = this.#baseUrl;
    this.#baseUrl = next;
    this.#regionSwitches += 1;
    this.#logger?.('TeraBox regional base switched', { from: previous, to: next });
    return previous;
  }

  async #call<T>(method: string, endpoint: string, options: TeraBoxSendOptions = {}, depth = 0): Promise<TeraBoxJsonResult<T>> {
    const timeoutMs = options.timeoutMs ?? JSON_TIMEOUT_MS;
    const usedBase = this.#baseUrl;
    const url = this.#url(endpoint, options, usedBase);
    const headers: Record<string, string> = this.#headers(options.headers);

    let body: Buffer | Readable | undefined = options.body;
    if (options.form) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(options.form)) {
        if (value === undefined || value === null) continue;
        params.set(key, String(value));
      }
      body = Buffer.from(params.toString(), 'utf8');
      if (!hasHeader(headers, 'Content-Type')) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else if (options.contentType !== undefined && body !== undefined && !hasHeader(headers, 'Content-Type')) {
      headers['Content-Type'] = options.contentType;
    }

    let response: Dispatcher.ResponseData;
    try {
      response = await request(url, {
        method: method as Dispatcher.HttpMethod,
        headers,
        body,
        signal: this.#signal ?? null,
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
      });
    } catch (error) {
      throw mapTeraBoxTransportError(error);
    }

    const previousBase = this.#maybeSwitchRegion(response.headers);
    if (previousBase !== null && url.startsWith(previousBase)) {
      await response.body.dump({ limit: 64 * 1024 }).catch(() => undefined);
      return this.#call<T>(method, `${this.#baseUrl}${url.slice(previousBase.length)}`, options, depth + 1);
    }

    if (REDIRECT_STATUSES.has(response.statusCode)) {
      const location = headerValue(response.headers.location);
      await response.body.dump({ limit: 64 * 1024 }).catch(() => undefined);
      if (location && /(^|\/)login(\?|$)/.test(location)) {
        throw new ProviderError(
          'ERR_AUTH_EXPIRED',
          'TeraBox redirected to the login page: the session cookie is no longer valid',
        );
      }
      if (method === 'GET' && location && depth < MAX_REDIRECTS) {
        const next = new URL(location, url);
        if (isTeraboxHostname(next.hostname)) {
          this.#baseUrl = next.origin;
          return this.#call<T>(method, next.toString(), options, depth + 1);
        }
      }
      throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'TeraBox returned an unexpected redirect', {
        upstreamStatus: response.statusCode,
      });
    }

    const text = await readBodyText(response.body).catch((error: unknown) => {
      throw mapTeraBoxTransportError(error);
    });
    const payload = parseJson(text);

    if (payload === undefined) {
      if (isHtml(text) && /(^|["'(=\/])\/login/.test(text)) {
        throw new ProviderError(
          'ERR_AUTH_EXPIRED',
          'TeraBox returned a login page: the session cookie is no longer valid',
        );
      }
      if (response.statusCode >= 400) throw mapTeraBoxHttpStatus(response.statusCode, undefined, text);
      throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'TeraBox returned a non-JSON response', {
        upstreamStatus: response.statusCode,
      });
    }

    if (response.statusCode >= 400) {
      throw mapTeraBoxHttpStatus(response.statusCode, payload, text);
    }

    const errno = options.errnoField === 'none' ? null : teraboxErrno(payload, options.errnoField ?? 'errno');
    if (errno !== null && errno !== 0 && TOKEN_REFRESH_ERRNOS.has(errno) && this.#tokenRetries < MAX_TOKEN_RETRIES && depth < MAX_REDIRECTS) {
      this.#tokenRetries += 1;
      await this.ensureJsToken(true);
      return this.#call<T>(method, endpoint, options, depth + 1);
    }

    // `filemetas` answers `{"errno":12,"info":[{"errno":-9}]}`: the per-item code
    // outranks the envelope, and a resolved item is success even when the
    // envelope carries a stale conflict code.
    if (options.preferInfoErrno) {
      const info = (payload as { info?: unknown }).info;
      if (Array.isArray(info) && info.length > 0) {
        const item = info[0] as { errno?: unknown };
        const itemErrno = typeof item?.errno === 'number' ? item.errno : 0;
        if (itemErrno !== 0) throw mapTeraBoxErrno(itemErrno, text || 'request failed', payload);
        return { status: response.statusCode, data: payload as T, headers: response.headers };
      }
    }

    if (errno !== null && errno !== 0) {
      throw mapTeraBoxErrno(errno, text || 'request failed', payload);
    }

    return { status: response.statusCode, data: payload as T, headers: response.headers };
  }

  /** GET an endpoint; returns the parsed payload. */
  get<T>(endpoint: string, query?: Record<string, string | number | undefined>, options: TeraBoxSendOptions = {}): Promise<T> {
    return this.#call<T>('GET', endpoint, { ...options, query: options.query ?? query }).then((r) => r.data);
  }

  /** POST `application/x-www-form-urlencoded` fields to an endpoint. */
  postForm<T>(endpoint: string, options: TeraBoxSendOptions = {}): Promise<T> {
    return this.#call<T>('POST', endpoint, options).then((r) => r.data);
  }

  /** POST a raw body (multipart chunk upload) to an absolute or relative URL. */
  post<T>(endpoint: string, options: TeraBoxSendOptions = {}): Promise<T> {
    return this.#call<T>('POST', endpoint, options).then((r) => r.data);
  }

  /**
   * Fetch the app shell and scrape `jsToken`. Read endpoints work without it;
   * `precreate`, `create` and `filemanager` are the ones that demand it, so
   * those call this first (a missing token is not fatal: the errno-driven retry
   * below covers a rejected write).
   *
   * Production serves the shell at `/main`; the bare `/` bounces through the
   * login/ai flow for every session, valid or not, so a shell redirect is never
   * an auth signal — API errnos are, and this method never throws one.
   */
  async ensureJsToken(force = false): Promise<boolean> {
    if (this.#jsToken !== '' && !force) return true;
    for (const entry of ['/main', '/']) {
      try {
        const response = await request(`${this.#baseUrl}${entry}`, {
          method: 'GET',
          headers: this.#headers(),
          signal: this.#signal ?? null,
          headersTimeout: JSON_TIMEOUT_MS,
          bodyTimeout: JSON_TIMEOUT_MS,
        });
        if (REDIRECT_STATUSES.has(response.statusCode)) {
          await response.body.dump({ limit: 64 * 1024 }).catch(() => undefined);
          continue;
        }
        const token = extractJsToken(await readBodyText(response.body));
        if (token) {
          this.#jsToken = token;
          return true;
        }
      } catch {
        // Best-effort: shell trouble must not masquerade as an auth failure.
      }
    }
    return false;
  }

  /** `GET /rest/2.0/pcs/file?method=locateupload` → absolute upload base. */
  async locateUploadHost(): Promise<string> {
    if (this.#uploadHost !== null) return this.#uploadHost;
    let host: string | undefined;
    try {
      const data = await this.get<{ host?: string }>(
        '/rest/2.0/pcs/file',
        { method: 'locateupload' },
        { appQuery: false },
      );
      host = data?.host;
    } catch (error) {
      if (ProviderError.is(error) && (error.code === 'ERR_AUTH_EXPIRED' || error.code === 'ERR_TIMEOUT')) throw error;
      host = undefined;
    }
    this.#uploadHost = uploadHostUrl(host) ?? this.#transport.uploadHost;
    return this.#uploadHost;
  }

  /** Absolute URL for the multipart chunk endpoint on the upload host. */
  async chunkUploadUrl(query: Record<string, string | number | undefined>): Promise<string> {
    const root = (await this.locateUploadHost()).replace(/\/+$/, '');
    const url = new URL(`${root}/rest/2.0/pcs/superfile2`);
    url.searchParams.set('method', 'upload');
    for (const [key, value] of Object.entries({ ...this.#appQuery(), ...query })) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  log(message: string, meta?: Record<string, unknown>): void {
    this.#logger?.(message, meta);
  }

  /**
   * Headers for a gated dlink hop: the signed link is issued to this session,
   * so the web player's cookie and fingerprint travel with the first request
   * (`gatedDownload()` drops them the moment a redirect changes host).
   */
  downloadHeaders(): Record<string, string> {
    return {
      Cookie: this.#cookie,
      'User-Agent': TERABOX_USER_AGENT,
      Accept: '*/*',
      Referer: `${this.#baseUrl}/`,
    };
  }
}

/** Build a `multipart/form-data` body for the chunk upload (field + file part). */
export function buildMultipartBody(
  boundary: string,
  fields: Record<string, string>,
  file: { name: string; buffer: Buffer },
): { body: Buffer; contentType: string } {
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8'),
    );
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\n` +
        'Content-Type: application/octet-stream\r\n\r\n',
      'utf8',
    ),
  );
  chunks.push(file.buffer);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}
