import { z } from 'zod';
import { ApiClient, type AuthHooks } from './client';
import { ApiError } from './errors';
import { setLogSink, type LogEvent } from '../core/logger';

type Step = { status?: number; body?: unknown; headers?: Record<string, string>; throws?: 'network' | 'hang' };

function fakeFetch(steps: Step[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = jest.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)]!;
    if (step.throws === 'network') throw new TypeError('Network request failed');
    if (step.throws === 'hang') {
      return new Promise<Response>((_resolve, reject) =>
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
      );
    }
    const status = step.status ?? 200;
    return new Response(step.body === undefined ? '' : JSON.stringify(step.body), { status, headers: step.headers });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const noSleep = async () => undefined;
const make = (steps: Step[], extra: Partial<ConstructorParameters<typeof ApiClient>[0]> = {}) => {
  const f = fakeFetch(steps);
  return {
    client: new ApiClient({ baseUrl: 'https://api.test/', fetchImpl: f.impl, sleep: noSleep, random: () => 0.5, ...extra }),
    calls: f.calls,
  };
};

const schema = z.object({ id: z.string(), n: z.number() });

describe('ApiClient basics', () => {
  it('builds URLs with query parameters, skipping undefined/null', async () => {
    const { client, calls } = make([{ body: { id: 'a', n: 1 } }]);
    await client.request({ path: '/files', query: { q: 'a b', limit: 5, x: undefined, y: null, ok: true }, schema });
    expect(calls[0]?.url).toBe('https://api.test/files?q=a+b&limit=5&ok=true');
  });

  it('validates the response and rejects a body that violates the contract', async () => {
    const events: LogEvent[] = [];
    setLogSink((e) => events.push(e));
    const { client } = make([{ body: { id: 1, n: 'nope', secret: 'TOPSECRET' } }]);
    await expect(client.request({ path: '/x', schema })).rejects.toMatchObject({ kind: 'invalid_response' });
    expect(JSON.stringify(events)).not.toContain('TOPSECRET');
    setLogSink(null);
  });

  it('strips unknown fields from valid responses', async () => {
    const { client } = make([{ body: { id: 'a', n: 1, extra: true } }]);
    await expect(client.request({ path: '/x', schema })).resolves.toEqual({ id: 'a', n: 1 });
  });

  it('maps error bodies to typed errors without exposing server text as the user message', async () => {
    const { client } = make([{ status: 404, body: { code: 'NOT_FOUND', message: 'Resource not found.' } }]);
    await expect(client.request({ path: '/x', schema })).rejects.toMatchObject({ kind: 'not_found', status: 404, code: 'NOT_FOUND' });
  });

  it('survives a non-JSON error page (e.g. a proxy 502 in HTML)', async () => {
    const f = { impl: jest.fn(async () => new Response('<html>Bad gateway</html>', { status: 502 })) as unknown as typeof fetch };
    const client = new ApiClient({
      baseUrl: 'https://api.test',
      fetchImpl: f.impl,
      sleep: noSleep,
      retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1 },
    });
    await expect(client.request({ path: '/x', schema })).rejects.toMatchObject({ kind: 'unavailable', status: 502 });
  });

  it('sends JSON bodies with a content type and never sends auth when auth:false', async () => {
    const { client, calls } = make([{ body: { id: 'a', n: 1 } }], {
      auth: { getAccessToken: async () => 'TOK', refreshAccessToken: async () => null, onSessionLost: () => undefined },
    });
    await client.request({ method: 'POST', path: '/auth/login', body: { email: 'a' }, auth: false, schema });
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Authorization).toBeUndefined();
    expect(calls[0]?.init.body).toBe('{"email":"a"}');
  });
});

describe('ApiClient transport failures', () => {
  it('maps a network failure to offline and retries a GET with bounded attempts', async () => {
    const { client, calls } = make([{ throws: 'network' }]);
    await expect(client.request({ path: '/x', schema })).rejects.toMatchObject({ kind: 'offline' });
    expect(calls).toHaveLength(3); // 1 try + 2 retries
  });

  it('does NOT retry an unsafe request after a network failure', async () => {
    const { client, calls } = make([{ throws: 'network' }]);
    await expect(client.request({ method: 'POST', path: '/x', body: {}, schema })).rejects.toMatchObject({ kind: 'offline' });
    expect(calls).toHaveLength(1);
  });

  it('retries an idempotent POST', async () => {
    const { client, calls } = make([{ throws: 'network' }, { body: { id: 'a', n: 1 } }]);
    await expect(client.request({ method: 'POST', path: '/x', body: {}, idempotent: true, schema })).resolves.toEqual({ id: 'a', n: 1 });
    expect(calls).toHaveLength(2);
  });

  it('retries 503 then succeeds, honouring Retry-After through the sleep hook', async () => {
    const sleeps: number[] = [];
    const { client, calls } = make([{ status: 503, headers: { 'retry-after': '2' } }, { body: { id: 'a', n: 1 } }], {
      sleep: async (ms) => void sleeps.push(ms),
    });
    await expect(client.request({ path: '/x', schema })).resolves.toEqual({ id: 'a', n: 1 });
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([2000]);
  });

  it('does not retry 4xx or 500', async () => {
    for (const status of [400, 403, 500]) {
      const { client, calls } = make([{ status, body: { code: 'X', message: 'm' } }]);
      await expect(client.request({ path: '/x', schema })).rejects.toBeInstanceOf(ApiError);
      expect(calls).toHaveLength(1);
    }
  });

  it('times out a hanging request', async () => {
    const { client } = make([{ throws: 'hang' }], { timeoutMs: 20, retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1 } });
    await expect(client.request({ path: '/x', schema })).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('honours caller cancellation and does not retry it', async () => {
    const { client, calls } = make([{ throws: 'hang' }], { timeoutMs: 5_000 });
    const controller = new AbortController();
    const pending = client.request({ path: '/x', schema, signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
    expect(calls).toHaveLength(1);
  });
});

describe('ApiClient authentication', () => {
  function hooks(overrides: Partial<AuthHooks> = {}): AuthHooks & { lost: string[]; refreshes: (string | null)[] } {
    let token: string | null = 'OLD';
    const lost: string[] = [];
    const refreshes: (string | null)[] = [];
    return {
      lost,
      refreshes,
      getAccessToken: async () => token,
      refreshAccessToken: async (rejected) => {
        refreshes.push(rejected);
        token = 'NEW';
        return 'NEW';
      },
      onSessionLost: (reason) => void lost.push(reason),
      ...overrides,
    };
  }
  const authed = (h: AuthHooks, steps: Step[]) => make(steps, { auth: h });
  const headerOf = (call: { init: RequestInit } | undefined) => (call?.init.headers as Record<string, string>).Authorization;

  it('attaches the bearer token', async () => {
    const { client, calls } = authed(hooks(), [{ body: { id: 'a', n: 1 } }]);
    await client.request({ path: '/files', schema });
    expect(headerOf(calls[0])).toBe('Bearer OLD');
  });

  it('refreshes once after a 401 and repeats the request with the new token (even for POST)', async () => {
    const h = hooks();
    const { client, calls } = authed(h, [
      { status: 401, body: { code: 'AUTH_SESSION_EXPIRED', message: 'x' } },
      { body: { id: 'a', n: 1 } },
    ]);
    await expect(client.request({ method: 'POST', path: '/files', body: {}, schema })).resolves.toEqual({ id: 'a', n: 1 });
    expect(calls).toHaveLength(2);
    expect(headerOf(calls[1])).toBe('Bearer NEW');
    expect(h.refreshes).toEqual(['OLD']);
    expect(h.lost).toEqual([]);
  });

  it('gives up and reports the session lost when the refresh fails', async () => {
    const h = hooks({ refreshAccessToken: async () => null });
    const { client, calls } = authed(h, [{ status: 401, body: { code: 'AUTH_SESSION_EXPIRED', message: 'x' } }]);
    await expect(client.request({ path: '/files', schema })).rejects.toMatchObject({ kind: 'unauthorized' });
    expect(calls).toHaveLength(1);
    expect(h.lost).toEqual(['expired']);
  });

  it('refreshes at most once per request (a second 401 ends the session)', async () => {
    const h = hooks();
    const { client, calls } = authed(h, [{ status: 401, body: { code: 'AUTH_INVALID_TOKEN', message: 'x' } }]);
    await expect(client.request({ path: '/files', schema })).rejects.toMatchObject({ kind: 'unauthorized' });
    expect(calls).toHaveLength(2);
    expect(h.refreshes).toHaveLength(1);
    expect(h.lost).toEqual(['expired']);
  });

  it('reports a disabled account without trying to refresh', async () => {
    const h = hooks();
    const { client } = authed(h, [{ status: 403, body: { code: 'AUTH_ACCOUNT_DISABLED', message: 'x' } }]);
    await expect(client.request({ path: '/files', schema })).rejects.toMatchObject({ kind: 'disabled' });
    expect(h.refreshes).toEqual([]);
    expect(h.lost).toEqual(['disabled']);
  });

  it('does not touch the session for unauthenticated calls such as login', async () => {
    const h = hooks();
    const { client } = authed(h, [{ status: 401, body: { code: 'AUTH_INVALID_CREDENTIALS', message: 'x' } }]);
    await expect(client.request({ method: 'POST', path: '/auth/login', body: {}, auth: false, schema })).rejects.toMatchObject({
      kind: 'unauthorized',
    });
    expect(h.refreshes).toEqual([]);
    expect(h.lost).toEqual([]);
  });

  it('exposes the authorization header for streamed transports without logging it', async () => {
    const { client } = authed(hooks(), []);
    await expect(client.authorizationHeader()).resolves.toEqual({ Authorization: 'Bearer OLD' });
  });
});
