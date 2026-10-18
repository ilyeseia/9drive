import { ApiClient } from '../api/client';
import { SessionManager } from './session';
import { MemoryTokenStore, type StoredSession } from './tokenStore';

const USER = { id: 'u1', name: 'Ada', email: 'ada@example.com' };
const saved = (access = 'A1', refresh = 'R1'): StoredSession => ({ accessToken: access, refreshToken: refresh, user: USER });

type Handler = (req: { path: string; method: string; headers: Record<string, string>; body: any }) => Promise<Response> | Response;

function server(handler: Handler) {
  const log: string[] = [];
  const impl = jest.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const headers = init.headers as Record<string, string>;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    log.push(`${init.method} ${path}`);
    return handler({ path, method: String(init.method), headers, body });
  });
  return { impl: impl as unknown as typeof fetch, log };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const err = (status: number, code: string) => json(status, { code, message: code });

function setup(handler: Handler, stored: StoredSession | null = null, store = new MemoryTokenStore(stored)) {
  const srv = server(handler);
  const client = new ApiClient({
    baseUrl: 'https://api.test',
    fetchImpl: srv.impl,
    sleep: async () => undefined,
    retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1 },
  });
  const cleared = jest.fn();
  const session = new SessionManager(client, store, { onCleared: cleared });
  return { session, client, store, cleared, ...srv };
}

describe('sign in / register', () => {
  it('signs in, stores the tokens and exposes the user', async () => {
    const { session, store } = setup(({ path }) =>
      path === '/auth/login' ? json(200, { accessToken: 'A1', refreshToken: 'R1', user: USER }) : err(404, 'X'),
    );
    await session.signIn('ada@example.com', 'correct horse');
    expect(session.getState()).toEqual({ status: 'signedIn', user: USER });
    expect(store.value).toEqual(saved());
  });

  it('never stores or logs the password', async () => {
    const { session, store } = setup(() => json(200, { accessToken: 'A1', refreshToken: 'R1', user: USER }));
    await session.signIn('ada@example.com', 'p4ssw0rd-secret');
    expect(JSON.stringify(store.value)).not.toContain('p4ssw0rd-secret');
  });

  it('leaves the user signed out when the credentials are wrong', async () => {
    const { session } = setup(() => err(401, 'AUTH_INVALID_CREDENTIALS'));
    await expect(session.signIn('a@b.co', 'x')).rejects.toMatchObject({ kind: 'unauthorized', code: 'AUTH_INVALID_CREDENTIALS' });
    expect(session.getState().status).toBe('loading'); // never promoted to signedIn
  });

  it('registers and signs in', async () => {
    const { session } = setup(({ path, body }) =>
      path === '/auth/register' && body.name === 'Ada' ? json(201, { accessToken: 'A1', refreshToken: 'R1', user: USER }) : err(400, 'X'),
    );
    await session.register(' Ada ', 'ada@example.com', 'longenough');
    expect(session.getState().status).toBe('signedIn');
  });

  it('keeps working from memory if secure storage fails, and retries the save later', async () => {
    const store = new MemoryTokenStore();
    const realSave = store.save.bind(store);
    let failing = true;
    store.save = async (s) => {
      if (failing) throw new Error('keystore unavailable');
      return realSave(s);
    };
    const { session } = setup(() => json(200, { accessToken: 'A1', refreshToken: 'R1', user: USER }), null, store);
    await session.signIn('a@b.co', 'x');
    expect(session.getState().status).toBe('signedIn');
    expect(store.value).toBeNull();
    failing = false;
    await session.getAccessToken();
    expect(store.value).toEqual(saved());
  });
});

describe('restore', () => {
  it('starts signed out when nothing is saved', async () => {
    const { session, log } = setup(() => err(500, 'X'));
    await session.restore();
    expect(session.getState()).toEqual({ status: 'signedOut', reason: null });
    expect(log).toEqual([]);
  });

  it('trusts a saved session immediately (works offline) and validates it in the background', async () => {
    const { session, log } = setup(
      ({ path }) => (path === '/auth/me' ? json(200, { user: { ...USER, name: 'Ada L.', status: 'active' } }) : err(404, 'X')),
      saved(),
    );
    await session.restore();
    expect(session.getState().status).toBe('signedIn');
    await session.validate();
    expect(log).toContain('GET /auth/me');
    expect(session.getState()).toEqual({ status: 'signedIn', user: { ...USER, name: 'Ada L.' } });
  });

  it('stays signed in when the validation request fails for connectivity reasons', async () => {
    const { session } = setup(() => {
      throw new TypeError('Network request failed');
    }, saved());
    await session.restore();
    await session.validate();
    expect(session.getState().status).toBe('signedIn');
  });
});

describe('refresh', () => {
  /** A backend that rotates refresh tokens and rejects the old access token. */
  function rotatingBackend() {
    let valid = { access: 'A2', refresh: 'R2' };
    let refreshCalls = 0;
    const handler: Handler = ({ path, headers, body }) => {
      if (path === '/auth/refresh') {
        refreshCalls += 1;
        if (body.refreshToken !== 'R1') return err(401, 'AUTH_SESSION_COMPROMISED');
        return json(200, { accessToken: valid.access, refreshToken: valid.refresh });
      }
      if (headers.Authorization !== `Bearer ${valid.access}`) return err(401, 'AUTH_SESSION_EXPIRED');
      return json(200, { files: [] });
    };
    return { handler, calls: () => refreshCalls };
  }

  it('refreshes once when many requests hit 401 at the same time (single-flight)', async () => {
    const backend = rotatingBackend();
    const { session, client } = setup(backend.handler, saved());
    await session.restore();
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => client.request({ path: '/files' })));
    expect(results).toHaveLength(5);
    expect(backend.calls()).toBe(1); // a second rotation would have tripped reuse detection
    expect(await session.getAccessToken()).toBe('A2');
  });

  it('persists the rotated refresh token BEFORE the retried request uses the new access token', async () => {
    const backend = rotatingBackend();
    const order: string[] = [];
    const store = new MemoryTokenStore(saved());
    const realSave = store.save.bind(store);
    store.save = async (s) => {
      order.push(`save:${s.refreshToken}`);
      return realSave(s);
    };
    const { session, client } = setup(
      (req) => {
        order.push(`http:${req.path}:${req.headers.Authorization ?? ''}`);
        return backend.handler(req);
      },
      null,
      store,
    );
    await session.restore();
    await client.request({ path: '/files' });
    const saveIndex = order.indexOf('save:R2');
    const retryIndex = order.indexOf('http:/files:Bearer A2');
    expect(saveIndex).toBeGreaterThan(-1);
    expect(retryIndex).toBeGreaterThan(saveIndex);
  });

  it('ends the session as expired when the refresh token is rejected, wiping credentials and caches', async () => {
    const { session, client, store, cleared } = setup(
      ({ path }) => (path === '/auth/refresh' ? err(401, 'AUTH_SESSION_EXPIRED') : err(401, 'AUTH_SESSION_EXPIRED')),
      saved(),
    );
    await session.restore();
    await expect(client.request({ path: '/files' })).rejects.toMatchObject({ kind: 'unauthorized' });
    expect(session.getState()).toEqual({ status: 'signedOut', reason: 'expired' });
    expect(store.value).toBeNull();
    expect(cleared).toHaveBeenCalledTimes(1);
  });

  it('reports a compromised session (refresh-token reuse) distinctly', async () => {
    const { session, client } = setup(
      ({ path }) => (path === '/auth/refresh' ? err(401, 'AUTH_SESSION_COMPROMISED') : err(401, 'AUTH_SESSION_EXPIRED')),
      saved(),
    );
    await session.restore();
    await expect(client.request({ path: '/files' })).rejects.toBeDefined();
    expect(session.getState()).toEqual({ status: 'signedOut', reason: 'compromised' });
  });

  it('keeps the session when the refresh fails only because the network is down', async () => {
    const { session, client, store } = setup(({ path }) => {
      if (path === '/auth/refresh') throw new TypeError('Network request failed');
      return err(401, 'AUTH_SESSION_EXPIRED');
    }, saved());
    await session.restore();
    await expect(client.request({ path: '/files' })).rejects.toMatchObject({ kind: 'offline' });
    expect(session.getState().status).toBe('signedIn');
    expect(store.value).toEqual(saved());
  });

  it('signs out with a distinct reason when the account is disabled', async () => {
    const { session, client } = setup(() => err(403, 'AUTH_ACCOUNT_DISABLED'), saved());
    await session.restore();
    await expect(client.request({ path: '/files' })).rejects.toMatchObject({ kind: 'disabled' });
    expect(session.getState()).toEqual({ status: 'signedOut', reason: 'disabled' });
  });
});

describe('sign out', () => {
  it('revokes on the server, then clears local credentials and caches', async () => {
    const { session, store, cleared, log } = setup(
      ({ path }) => (path === '/auth/logout' ? json(200, { status: 'ok' }) : err(404, 'X')),
      saved(),
    );
    await session.restore();
    await expect(session.signOut()).resolves.toEqual({ serverRevoked: true });
    expect(log).toContain('POST /auth/logout');
    expect(session.getState()).toEqual({ status: 'signedOut', reason: null });
    expect(store.value).toBeNull();
    expect(cleared).toHaveBeenCalled();
  });

  it('still removes everything locally when the server is unreachable, and says it could not revoke', async () => {
    const { session, store } = setup(() => {
      throw new TypeError('Network request failed');
    }, saved());
    await session.restore();
    await expect(session.signOut()).resolves.toEqual({ serverRevoked: false });
    expect(store.value).toBeNull();
    expect(session.getState().status).toBe('signedOut');
  });

  it('does not attempt a server call when there is no session', async () => {
    const { session, log } = setup(() => err(500, 'X'));
    await session.restore();
    await session.signOut();
    expect(log).toEqual([]);
  });
});
