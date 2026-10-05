/**
 * OneDrive (Microsoft Graph) client for the adapter: bearer auth, one refresh
 * attempt on 401, JSON envelopes and §5 error mapping. Upload/download bodies
 * stay on undici streams so nothing is buffered whole (contract §4.1).
 *
 * `gatedRequest()` is the SSRF-checked path used for upstream-supplied URLs
 * (download redirects, copy monitors): every hop re-enters
 * `assertFetchAllowed()` and the Authorization header never crosses an origin
 * boundary (security-contract §7). Upload-session URLs are gated once and never
 * carry the bearer token (Graph issues them for anonymous PUTs).
 */

import type { IncomingHttpHeaders } from 'node:http';
import type { Readable } from 'node:stream';
import { request, type Dispatcher } from 'undici';
import { assertFetchAllowed } from '../../utils/ssrf.js';
import { ProviderError } from '../errors.js';
import { mapOnedriveHttpError, mapOnedriveTransportError } from './errors.js';

export const JSON_TIMEOUT_MS = 30_000;
export const TRANSFER_TIMEOUT_MS = 15 * 60_000;

const MAX_JSON_BODY_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface OnedriveSession {
  /** Current bearer token (may be replaced by `renew`). */
  accessToken(): string;
  /** Refresh the token once; false when no refresh material is available. */
  renew(): Promise<boolean>;
}

export interface OnedriveRequestInit {
  headers?: Record<string, string>;
  /** JSON request body. Mutually exclusive with `body`. */
  payload?: unknown;
  /** Raw request body; content headers belong in `headers`. */
  body?: Buffer | Readable;
  timeoutMs?: number;
}

export interface OnedriveJsonResult<T> {
  status: number;
  data: T;
  headers: IncomingHttpHeaders;
}

export interface GatedRequestInit {
  method?: Dispatcher.HttpMethod;
  headers?: Record<string, string>;
  body?: Buffer | Readable;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function headerValue(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const target = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === target);
}

export async function readBodyText(body: Dispatcher.ResponseData['body']): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buffer.byteLength;
    if (total > MAX_JSON_BODY_BYTES) {
      body.destroy();
      throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'OneDrive response body exceeded the JSON limit');
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
 * GET an upstream-supplied URL through the SSRF gate, following at most
 * `MAX_REDIRECTS` hops with the gate re-applied to every hop. The bearer token
 * is dropped as soon as a redirect leaves the original origin. undici v7 never
 * follows redirects on its own, which is what makes the per-hop gate complete.
 */
export async function gatedRequest(url: string, init: GatedRequestInit = {}): Promise<Dispatcher.ResponseData> {
  const timeoutMs = init.timeoutMs ?? TRANSFER_TIMEOUT_MS;
  let current = url;
  let headers: Record<string, string> = { ...init.headers };

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const allowed = await assertFetchAllowed(current);
    let response: Dispatcher.ResponseData;
    try {
      response = await request(allowed.toString(), {
        method: init.method ?? 'GET',
        headers,
        body: init.body,
        signal: init.signal ?? null,
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
      });
    } catch (error) {
      throw mapOnedriveTransportError(error);
    }

    const location = headerValue(response.headers.location);
    if (!REDIRECT_STATUSES.has(response.statusCode) || location === null) return response;
    await response.body.dump({ limit: 64 * 1024 }).catch(() => undefined);

    let next: URL;
    try {
      next = new URL(location, allowed);
    } catch {
      throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'OneDrive returned a malformed redirect');
    }
    if (next.origin !== allowed.origin) delete headers.Authorization;
    current = next.toString();
    if (hop === MAX_REDIRECTS) {
      throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'OneDrive download followed too many redirects');
    }
  }
  throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'OneDrive download followed too many redirects');
}

export class OnedriveClient {
  readonly baseUrl: string;
  readonly #session: OnedriveSession;
  readonly #signal: AbortSignal | undefined;
  readonly #logger: ((msg: string, meta?: Record<string, unknown>) => void) | undefined;

  constructor(options: {
    session: OnedriveSession;
    baseUrl: string;
    signal?: AbortSignal;
    logger?: (msg: string, meta?: Record<string, unknown>) => void;
  }) {
    this.#session = options.session;
    this.baseUrl = options.baseUrl;
    this.#signal = options.signal;
    this.#logger = options.logger;
  }

  /** Reads a JSON response body and maps non-2xx onto the provider taxonomy. */
  async json<T>(method: string, url: string, init: OnedriveRequestInit = {}): Promise<OnedriveJsonResult<T>> {
    if (init.payload !== undefined && init.body !== undefined) {
      throw new ProviderError('ERR_INTERNAL', 'OneDrive request cannot carry both a payload and a raw body');
    }
    const timeoutMs = init.timeoutMs ?? JSON_TIMEOUT_MS;
    const replayable = init.body === undefined || Buffer.isBuffer(init.body);
    const attempts = replayable ? 2 : 1;

    for (let attempt = 0; attempt < attempts; attempt++) {
      const headers: Record<string, string> = { ...init.headers };
      const body =
        init.payload !== undefined ? JSON.stringify(init.payload) : (init.body as Buffer | Readable | undefined);
      if (init.payload !== undefined && !hasHeader(headers, 'Content-Type')) {
        headers['Content-Type'] = 'application/json';
      }
      headers.Authorization = `Bearer ${this.#session.accessToken()}`;

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
        throw mapOnedriveTransportError(error);
      }

      if (response.statusCode === 401 && attempt + 1 < attempts) {
        const renewed = await this.#session.renew();
        if (renewed) {
          await response.body.dump({ limit: 64 * 1024 }).catch(() => undefined);
          continue;
        }
      }

      const text = await readBodyText(response.body).catch((error: unknown) => {
        throw mapOnedriveTransportError(error);
      });
      const payload = parseJson(text);
      if (response.statusCode >= 400) {
        throw mapOnedriveHttpError(response.statusCode, payload, text);
      }
      return { status: response.statusCode, data: payload as T, headers: response.headers };
    }
    throw new ProviderError('ERR_INTERNAL', 'OneDrive request retry loop exhausted');
  }

  /**
   * GET an upstream URL through the SSRF gate with bearer auth on the first
   * hop. `gatedRequest` drops the Authorization header as soon as a redirect
   * crosses the origin boundary (security-contract §7).
   */
  async gatedGet(url: string, init: GatedRequestInit = {}): Promise<Dispatcher.ResponseData> {
    return gatedRequest(url, {
      ...init,
      headers: { Authorization: `Bearer ${this.#session.accessToken()}`, ...init.headers },
    });
  }

  /**
   * PUT a chunk at an upstream upload-session URL. No Authorization header:
   * session URLs are pre-authenticated and cross an origin boundary.
   * Returns the HTTP status so the caller can tell 201 (done) from 202 (more).
   */
  async sessionPut(url: string, body: Buffer, contentRange: string, timeoutMs?: number): Promise<OnedriveJsonResult<unknown>> {
    const allowed = await assertFetchAllowed(url);
    let response: Dispatcher.ResponseData;
    try {
      response = await request(allowed.toString(), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Range': contentRange },
        body,
        signal: this.#signal ?? null,
        headersTimeout: timeoutMs ?? TRANSFER_TIMEOUT_MS,
        bodyTimeout: timeoutMs ?? TRANSFER_TIMEOUT_MS,
      });
    } catch (error) {
      throw mapOnedriveTransportError(error);
    }
    const text = await readBodyText(response.body).catch((error: unknown) => {
      throw mapOnedriveTransportError(error);
    });
    const payload = parseJson(text);
    if (response.statusCode >= 400) {
      throw mapOnedriveHttpError(response.statusCode, payload, text);
    }
    return { status: response.statusCode, data: payload, headers: response.headers };
  }

  log(message: string, meta?: Record<string, unknown>): void {
    this.#logger?.(message, meta);
  }
}
