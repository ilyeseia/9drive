/**
 * Bounded-retry JSON POST used by every model adapter.
 *
 * Retries only transient failures (429, 5xx except 501, timeouts, connection errors), at most
 * `maxRetries` times, honouring Retry-After (capped). Cancellation is never retried. Error
 * messages contain a short, scrubbed excerpt of the provider message — never the request,
 * headers or API key.
 */

import { request } from 'undici';
import { ModelError } from './types.js';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_RETRY_AFTER_MS = 10_000;
const BASE_BACKOFF_MS = 500;

export interface PostJsonOptions {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs: number;
  maxRetries: number;
  signal?: AbortSignal;
  /** Test seam. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ModelError('MODEL_CANCELLED', 'The request was cancelled.'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ModelError('MODEL_CANCELLED', 'The request was cancelled.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function scrub(text: string): string {
  return text
    .replace(/(sk|key|token|bearer)[-_ ]?[A-Za-z0-9._-]{12,}/gi, '[redacted]')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .slice(0, 200);
}

function providerMessage(payload: unknown): string {
  if (payload && typeof payload === 'object') {
    const error = (payload as { error?: unknown }).error;
    if (typeof error === 'string') return scrub(error);
    if (error && typeof error === 'object') {
      const message = (error as { message?: unknown }).message;
      if (typeof message === 'string') return scrub(message);
    }
  }
  return '';
}

function retryAfterMs(header: string | string[] | undefined): number | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  return null;
}

function classify(status: number, payload: unknown, retryHeader: string | string[] | undefined): ModelError {
  const detail = providerMessage(payload);
  const suffix = detail ? `: ${detail}` : '';
  if (status === 429) {
    return new ModelError('MODEL_RATE_LIMITED', `The model provider rate-limited the request${suffix}`, {
      retryable: true,
      retryAfterMs: retryAfterMs(retryHeader),
    });
  }
  if (status === 401 || status === 403) {
    return new ModelError('MODEL_AUTH', 'The model provider rejected the configured credentials.');
  }
  if (status === 404) return new ModelError('MODEL_NOT_FOUND', `The configured model or endpoint was not found${suffix}`);
  if (status === 408) return new ModelError('MODEL_TIMEOUT', 'The model provider timed out.', { retryable: true });
  if (status >= 500 && status !== 501) {
    return new ModelError('MODEL_UNAVAILABLE', `The model provider is unavailable (HTTP ${status})${suffix}`, {
      retryable: true,
      retryAfterMs: retryAfterMs(retryHeader),
    });
  }
  return new ModelError('MODEL_BAD_REQUEST', `The model provider rejected the request (HTTP ${status})${suffix}`);
}

async function readBody(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_RESPONSE_BYTES) throw new ModelError('MODEL_BAD_RESPONSE', 'The model response was too large.');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function postJson(options: PostJsonOptions): Promise<unknown> {
  const sleep = options.sleep ?? defaultSleep;
  let attempt = 0;
  for (;;) {
    if (options.signal?.aborted) throw new ModelError('MODEL_CANCELLED', 'The request was cancelled.');
    let failure: ModelError;
    try {
      const response = await request(options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...options.headers },
        body: JSON.stringify(options.body),
        signal: options.signal ?? null,
        headersTimeout: options.timeoutMs,
        bodyTimeout: options.timeoutMs,
      });
      const text = await readBody(response.body);
      let payload: unknown = null;
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
      if (response.statusCode >= 200 && response.statusCode < 300) {
        if (payload === null || typeof payload !== 'object') {
          throw new ModelError('MODEL_BAD_RESPONSE', 'The model provider returned a non-JSON response.');
        }
        return payload;
      }
      failure = classify(response.statusCode, payload, response.headers['retry-after']);
    } catch (error) {
      if (ModelError.is(error)) {
        failure = error;
      } else if (options.signal?.aborted) {
        throw new ModelError('MODEL_CANCELLED', 'The request was cancelled.');
      } else {
        const name = (error as { name?: string; code?: string } | null)?.name;
        const code = (error as { code?: string } | null)?.code;
        const timeout = name === 'TimeoutError' || (typeof code === 'string' && code.startsWith('UND_ERR_') && code.includes('TIMEOUT'));
        failure = timeout
          ? new ModelError('MODEL_TIMEOUT', 'The model provider timed out.', { retryable: true })
          : new ModelError('MODEL_UNAVAILABLE', 'The model provider could not be reached.', { retryable: true });
      }
    }
    if (!failure.retryable || attempt >= options.maxRetries) throw failure;
    const delay = failure.retryAfterMs ?? BASE_BACKOFF_MS * 2 ** attempt;
    attempt += 1;
    await sleep(delay, options.signal);
  }
}
