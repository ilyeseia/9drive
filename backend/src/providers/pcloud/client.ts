/**
 * pCloud REST client for the adapter: `access_token` query auth, one refresh
 * attempt on 401, `{ result }` envelope checking and §5 error mapping. Upload
 * bodies stay on undici streams so nothing is buffered whole (contract §4.1).
 *
 * `gatedRequest()` is the SSRF-checked path used for upstream-supplied URLs
 * (CDN links from `getfilelink`): every redirect hop re-enters
 * `assertFetchAllowed()`, and because the token travels only as a query
 * parameter on the API origin it can never cross an origin boundary
 * (security-contract §7).
 */

import type { Readable } from 'node:stream';
import { request, type Dispatcher } from 'undici';
import { assertFetchAllowed } from '../../utils/ssrf.js';
import { ProviderError } from '../errors.js';
import { mapPcloudHttpError, mapPcloudResultError, mapPcloudTransportError } from './errors.js';
import { pcloudUrl } from './transport.js';

export const JSON_TIMEOUT_MS = 30_000;
export const TRANSFER_TIMEOUT_MS = 15 * 60_000;

const MAX_JSON_BODY_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface PcloudSession {
  /** Current access token (may be replaced by `renew`). */
  accessToken(): string;
  /** Refresh the token once; false when no refresh material is available. */
  renew(): Promise<boolean>;
}

export interface PcloudRequestInit {
  /** Raw request body for PUT uploads; content headers belong in `headers`. */
  body?: Buffer | Readable;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface GatedRequestInit {
  method?: Dispatcher.HttpMethod;
  headers?: Record<string, string>;
  body?: Buffer | Readable;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const target = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === target);
}

function headerValue(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

export async function readBodyText(body: Dispatcher.ResponseData['body']): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buffer.byteLength;
    if (total > MAX_JSON_BODY_BYTES) {
      body.destroy();
      throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'pCloud response body exceeded the JSON limit');
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
 * GET an upstream-supplied CDN URL through the SSRF gate, following at most
 * `MAX_REDIRECTS` hops with the gate re-applied to every hop. No credentials
 * are attached — the link itself is the capability. undici v7 never follows
 * redirects on its own, which is what makes the per-hop gate complete.
 */
export async function gatedRequest(url: string, init: GatedRequestInit = {}): Promise<Dispatcher.ResponseData> {
  const timeoutMs = init.timeoutMs ?? TRANSFER_TIMEOUT_MS;
  let current = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const allowed = await assertFetchAllowed(current);
    let response: Dispatcher.ResponseData;
    try {
      response = await request(allowed.toString(), {
        method: init.method ?? 'GET',
        headers: { ...init.headers },
        body: init.body,
        signal: init.signal ?? null,
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
      });
    } catch (error) {
      throw mapPcloudTransportError(error);
    }

    const location = headerValue(response.headers.location);
    if (!REDIRECT_STATUSES.has(response.statusCode) || location === null) return response;
    await response.body.dump({ limit: 64 * 1024 }).catch(() => undefined);

    let next: URL;
    try {
      next = new URL(location, allowed);
    } catch {
      throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'pCloud returned a malformed redirect');
    }
    current = next.toString();
    if (hop === MAX_REDIRECTS) {
      throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'pCloud download followed too many redirects');
    }
  }
  throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'pCloud download followed too many redirects');
}

export class PcloudClient {
  readonly apiUrl: string;
  readonly #session: PcloudSession;
  readonly #signal: AbortSignal | undefined;
  readonly #logger: ((msg: string, meta?: Record<string, unknown>) => void) | undefined;

  constructor(options: {
    session: PcloudSession;
    apiUrl: string;
    signal?: AbortSignal;
    logger?: (msg: string, meta?: Record<string, unknown>) => void;
  }) {
    this.#session = options.session;
    this.apiUrl = options.apiUrl;
    this.#signal = options.signal;
    this.#logger = options.logger;
  }

  /**
   * JSON method call: GET `<apiUrl>/<method>` with the token in the query
   * string (pCloud's documented auth transport). Validates `result` even on
   * HTTP 200 — that is where pCloud reports nearly every failure.
   */
  async call<T>(
    method: string,
    params: Record<string, string | number | undefined> = {},
    init: PcloudRequestInit = {},
  ): Promise<T> {
    const timeoutMs = init.timeoutMs ?? JSON_TIMEOUT_MS;
    const replayable = init.body === undefined || Buffer.isBuffer(init.body);
    const attempts = replayable ? 2 : 1;

    for (let attempt = 0; attempt < attempts; attempt++) {
      const headers: Record<string, string> = { ...init.headers };
      const url = pcloudUrl(this.apiUrl, method, {
        ...params,
        access_token: this.#session.accessToken(),
      });

      let response: Dispatcher.ResponseData;
      try {
        response = await request(url, {
          method: init.body === undefined ? 'GET' : 'PUT',
          headers,
          body: init.body,
          signal: this.#signal ?? null,
          headersTimeout: timeoutMs,
          bodyTimeout: timeoutMs,
        });
      } catch (error) {
        throw mapPcloudTransportError(error);
      }

      if (response.statusCode === 401 && attempt + 1 < attempts) {
        const renewed = await this.#session.renew();
        if (renewed) {
          await response.body.dump({ limit: 64 * 1024 }).catch(() => undefined);
          continue;
        }
      }

      const text = await readBodyText(response.body).catch((error: unknown) => {
        throw mapPcloudTransportError(error);
      });
      const payload = parseJson(text);
      if (response.statusCode >= 400) {
        throw mapPcloudHttpError(response.statusCode, payload, text);
      }
      if (payload !== null && typeof payload === 'object') {
        const result = (payload as { result?: unknown }).result;
        if (typeof result === 'number' && result !== 0) {
          throw mapPcloudResultError(result, payload);
        }
      }
      return payload as T;
    }
    throw new ProviderError('ERR_INTERNAL', 'pCloud request retry loop exhausted');
  }

  /**
   * PUT `uploadfile` with parameters in the query string and the file bytes
   * as the raw body (protocol: Uploading Files). Streams are not replayed, so
   * a stream body is attempted exactly once.
   */
  async upload<T>(
    params: Record<string, string | number | undefined>,
    body: Buffer | Readable,
    init: PcloudRequestInit = {},
  ): Promise<T> {
    const headers: Record<string, string> = { ...init.headers };
    if (!hasHeader(headers, 'Content-Type')) headers['Content-Type'] = 'application/octet-stream';
    return this.call<T>('uploadfile', params, { ...init, body, headers });
  }

  log(message: string, meta?: Record<string, unknown>): void {
    this.#logger?.(message, meta);
  }
}
