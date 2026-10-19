/**
 * HTTP client for the 9Drive API.
 *
 * Responsibilities (and only these): URL building, auth header, timeout/cancellation, error mapping,
 * bounded retry of safe requests, one transparent token refresh, and runtime validation of every response
 * against a Zod schema. Business logic lives in `endpoints/*`; session logic lives in `auth/*`.
 *
 * Network data is untrusted: a response that does not match its schema becomes an `invalid_response` error
 * instead of flowing into the UI as `any`.
 */

import type { ZodType } from 'zod';
import { z } from 'zod';
import { log } from '../core/logger';
import { ApiError, kindForStatus, parseRetryAfter } from './errors';
import { DEFAULT_RETRY, backoffDelay, shouldRetry, type RetryPolicy } from './retry';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type Query = Record<string, string | number | boolean | null | undefined>;

export interface AuthHooks {
  getAccessToken(): Promise<string | null>;
  /**
   * Called once after a 401. Must be single-flight (see `SessionManager`): the server revokes the whole
   * session when a rotated refresh token is presented twice. Returns the new access token, or null when the session can no longer be renewed.
   * May throw an ApiError for a transient failure (offline): the session is then kept.
   */
  refreshAccessToken(rejectedToken: string | null): Promise<string | null>;
  onSessionLost(reason: 'expired' | 'disabled'): void;
}

export interface RequestSpec<T> {
  method?: HttpMethod;
  path: string;
  query?: Query;
  body?: unknown;
  /** Binary payload (e.g. an upload chunk). Sent as-is; mutually exclusive with ody. */
  rawBody?: BodyInit;
  /** Per-request transport, used for streaming bodies the default fetch cannot send. */
  fetchImpl?: typeof fetch;
  schema?: ZodType<T>;
  /** Default true. Login/refresh/register pass false. */
  auth?: boolean;
  signal?: AbortSignal;
  /** Marks a non-GET request as safe to repeat (e.g. it carries an idempotency key). */
  idempotent?: boolean;
  timeoutMs?: number;
  headers?: Record<string, string>;
  retry?: Partial<RetryPolicy>;
}

export interface ApiClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retry?: RetryPolicy;
  auth?: AuthHooks;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  clientName?: string;
}

const errorBodySchema = z.object({ code: z.string().optional(), message: z.string().optional() }).passthrough();

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ApiError('cancelled', null, null, 'Request cancelled.'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new ApiError('cancelled', null, null, 'Request cancelled.'));
      },
      { once: true },
    );
  });

export class ApiClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retryPolicy: RetryPolicy;
  private readonly sleep: NonNullable<ApiClientOptions['sleep']>;
  private readonly random: () => number;
  private readonly clientName: string;
  private auth?: AuthHooks;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.retryPolicy = options.retry ?? DEFAULT_RETRY;
    this.auth = options.auth;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.clientName = options.clientName ?? '9drive-mobile';
  }

  /** The session layer is created after the client (it needs the client for /auth/refresh), so hooks attach late. */
  setAuthHooks(hooks: AuthHooks): void {
    this.auth = hooks;
  }

  buildUrl(path: string, query?: Query): string {
    const url = new URL(`${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  /** Authorization header for transports that bypass `request` (streamed uploads/downloads). Never log it. */
  async authorizationHeader(): Promise<Record<string, string>> {
    const token = await this.auth?.getAccessToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  async request<T>(spec: RequestSpec<T>): Promise<T> {
    const method = spec.method ?? 'GET';
    const useAuth = spec.auth !== false && this.auth !== undefined;
    const policy: RetryPolicy = { ...this.retryPolicy, ...spec.retry };
    let token = useAuth ? await this.auth!.getAccessToken() : null;
    let refreshed = false;
    let attempt = 0;

    for (;;) {
      try {
        return await this.once(spec, method, token);
      } catch (error) {
        if (!ApiError.is(error)) throw error;

        if (useAuth && error.kind === 'unauthorized' && !refreshed) {
          // A 401 is produced before any handler runs, so repeating the request after a refresh is safe
          // for every method.
          refreshed = true;
          let next: string | null;
          try {
            next = await this.auth!.refreshAccessToken(token);
          } catch (refreshError) {
            // A transient failure while renewing (offline, timeout) is not proof the session is dead: report it as
            // such and keep the session so the user can simply retry.
            throw ApiError.is(refreshError) ? refreshError : error;
          }
          if (next) {
            token = next;
            continue;
          }
          this.auth!.onSessionLost('expired');
          throw error;
        }
        if (useAuth && error.kind === 'disabled') this.auth!.onSessionLost('disabled');
        if (useAuth && error.kind === 'unauthorized') this.auth!.onSessionLost('expired');

        if (shouldRetry(error, method, spec.idempotent, attempt, policy)) {
          await this.sleep(backoffDelay(attempt, policy, error.retryAfterMs, this.random), spec.signal);
          attempt += 1;
          continue;
        }
        throw error;
      }
    }
  }

  /** For endpoints whose success body is empty or irrelevant. */
  async requestVoid(spec: Omit<RequestSpec<unknown>, 'schema'>): Promise<void> {
    await this.request({ ...spec, schema: z.unknown() });
  }

  private async once<T>(spec: RequestSpec<T>, method: HttpMethod, token: string | null): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json', 'X-Client': this.clientName, ...spec.headers };
    if (token) headers.Authorization = `Bearer ${token}`;
    let body: BodyInit | undefined;
    if (spec.rawBody !== undefined) {
      body = spec.rawBody;
    } else if (spec.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(spec.body);
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, spec.timeoutMs ?? this.timeoutMs);
    const onCallerAbort = () => controller.abort();
    if (spec.signal?.aborted) controller.abort();
    spec.signal?.addEventListener('abort', onCallerAbort, { once: true });

    let response: Response;
    try {
      response = await (spec.fetchImpl ?? this.fetchImpl)(this.buildUrl(spec.path, spec.query), {
        method,
        headers,
        body,
        signal: controller.signal,
      });
    } catch {
      if (spec.signal?.aborted) throw new ApiError('cancelled', null, null, 'Request cancelled.');
      if (timedOut) throw new ApiError('timeout', null, null, 'The request timed out.');
      throw new ApiError('offline', null, null, 'The server could not be reached.');
    } finally {
      clearTimeout(timer);
      spec.signal?.removeEventListener('abort', onCallerAbort);
    }

    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new ApiError('offline', response.status, null, 'The connection was interrupted.');
    }
    // A web page (for example the site's front end or a proxy error page) instead of the API: the configured address
    // is wrong. Say so plainly instead of the generic "something went wrong".
    // Gateway errors (502/503/504) keep their own, retryable classification.
    if (response.status < 500 && /^\s*<(!doctype html|html)/i.test(text)) {
      throw new ApiError('not_api', response.status, null, 'The server address does not point to the 9Drive API.');
    }
    let json: unknown = undefined;
    if (text !== '') {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }

    if (!response.ok) {
      const parsed = errorBodySchema.safeParse(json);
      const code = parsed.success ? (parsed.data.code ?? null) : null;
      const message = parsed.success && parsed.data.message ? parsed.data.message : `HTTP ${response.status}`;
      throw new ApiError(
        kindForStatus(response.status, code),
        response.status,
        code,
        message,
        parseRetryAfter(response.headers.get('retry-after')),
      );
    }

    if (!spec.schema) return json as T;
    const result = spec.schema.safeParse(json);
    if (!result.success) {
      // Log where it failed, never the data.
      log.warn('Response did not match the contract', {
        path: spec.path,
        issues: result.error.issues.slice(0, 3).map((i) => i.path.join('.')),
      });
      throw new ApiError('invalid_response', response.status, null, 'Unexpected server response.');
    }
    return result.data;
  }
}
