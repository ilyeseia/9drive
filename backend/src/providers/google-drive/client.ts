/**
 * Google Drive v3 REST client for the adapter: bearer auth, a single refresh
 * attempt on 401, JSON envelopes and §5 error mapping. Upload and download
 * bodies stay on undici streams so nothing is buffered whole (contract §4.1).
 */

import type { IncomingHttpHeaders } from 'node:http';
import type { Readable } from 'node:stream';
import { request, type Dispatcher } from 'undici';
import { ProviderError } from '../errors.js';
import { mapGoogleHttpError, mapGoogleTransportError } from './errors.js';
import { googleDriveTransport, googleDriveUrl } from './transport.js';

const JSON_TIMEOUT_MS = 30_000;
const TRANSFER_TIMEOUT_MS = 15 * 60_000;
const MAX_JSON_BODY_BYTES = 4 * 1024 * 1024;

export { JSON_TIMEOUT_MS, TRANSFER_TIMEOUT_MS };

export interface DriveSession {
  /** Current bearer token (may be replaced by `renew`). */
  accessToken(): string;
  /** Refresh the token once; false when no refresh material is available. */
  renew(): Promise<boolean>;
}

export interface DriveRequestInit {
  query?: Record<string, string | undefined>;
  headers?: Record<string, string>;
  /** JSON request body. Mutually exclusive with `body`. */
  payload?: unknown;
  /** Raw request body; content headers belong in `headers`. */
  body?: Buffer | Readable;
  timeoutMs?: number;
}

export interface DriveJsonResult<T> {
  status: number;
  data: T;
  headers: IncomingHttpHeaders;
}

export interface DriveStreamResult {
  status: number;
  headers: IncomingHttpHeaders;
  body: Dispatcher.ResponseData['body'];
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const target = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === target);
}

async function readBodyText(body: Dispatcher.ResponseData['body']): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buffer.byteLength;
    if (total > MAX_JSON_BODY_BYTES) {
      body.destroy();
      throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'Google Drive response body exceeded the JSON limit');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseJson(text: string): unknown {
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export class DriveApiClient {
  readonly #session: DriveSession;
  readonly #signal: AbortSignal | undefined;
  readonly #logger: ((msg: string, meta?: Record<string, unknown>) => void) | undefined;

  constructor(options: {
    session: DriveSession;
    signal?: AbortSignal;
    logger?: (msg: string, meta?: Record<string, unknown>) => void;
  }) {
    this.#session = options.session;
    this.#signal = options.signal;
    this.#logger = options.logger;
  }

  /** Reads a JSON response body and maps non-2xx onto the provider taxonomy. */
  async json<T>(method: string, path: string, init: DriveRequestInit = {}): Promise<DriveJsonResult<T>> {
    const response = await this.#send(method, path, init);
    const text = await readBodyText(response.body);
    const payload = parseJson(text);
    if (response.statusCode >= 400) {
      throw mapGoogleHttpError(response.statusCode, payload, text);
    }
    return { status: response.statusCode, data: payload as T, headers: response.headers };
  }

  /** Same as `json` but hands the response body back as an unconsumed stream. */
  async stream(method: string, path: string, init: DriveRequestInit = {}): Promise<DriveStreamResult> {
    const response = await this.#send(method, path, init);
    if (response.statusCode >= 400) {
      const text = await readBodyText(response.body);
      throw mapGoogleHttpError(response.statusCode, parseJson(text), text);
    }
    return { status: response.statusCode, headers: response.headers, body: response.body };
  }

  log(message: string, meta?: Record<string, unknown>): void {
    this.#logger?.(message, meta);
  }

  async #send(method: string, path: string, init: DriveRequestInit): Promise<Dispatcher.ResponseData> {
    if (init.payload !== undefined && init.body !== undefined) {
      throw new ProviderError('ERR_INTERNAL', 'Google Drive request cannot carry both a payload and a raw body');
    }
    const url = googleDriveUrl(path, init.query);
    const timeoutMs = init.timeoutMs ?? JSON_TIMEOUT_MS;
    const replayable = init.body === undefined || Buffer.isBuffer(init.body);
    const attempts = replayable ? 2 : 1;

    for (let attempt = 0; attempt < attempts; attempt++) {
      const headers: Record<string, string> = { ...init.headers };
      const payload =
        init.payload !== undefined
          ? JSON.stringify(init.payload)
          : (init.body as string | Buffer | Readable | undefined);
      if (init.payload !== undefined && !hasHeader(headers, 'content-type')) {
        headers['Content-Type'] = 'application/json';
      }
      headers.Authorization = `Bearer ${this.#session.accessToken()}`;

      let response: Dispatcher.ResponseData;
      try {
        response = await request(url, {
          method: method as Dispatcher.HttpMethod,
          headers,
          body: payload,
          signal: this.#signal ?? null,
          headersTimeout: timeoutMs,
          bodyTimeout: timeoutMs,
        });
      } catch (error) {
        throw mapGoogleTransportError(error);
      }

      if (response.statusCode === 401 && attempt + 1 < attempts) {
        const renewed = await this.#session.renew();
        if (renewed) {
          await response.body.dump({ limit: 64 * 1024 }).catch(() => undefined);
          continue;
        }
      }
      return response;
    }
    throw new ProviderError('ERR_INTERNAL', 'Google Drive request retry loop exhausted');
  }
}
