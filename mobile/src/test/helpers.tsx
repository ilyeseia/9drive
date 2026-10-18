import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ApiClient } from '../api/client';
import { ServicesProvider, type Services } from '../app/services';
import { LockController } from '../auth/lock';
import { SessionManager } from '../auth/session';
import { MemoryTokenStore, type StoredSession } from '../auth/tokenStore';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/messages';
import { ThemeProvider } from '../theme/theme';
import { TransferManager } from '../transfers/manager';
import { UploadRunner, type UploadApi } from '../transfers/upload';

export type Handler = (req: {
  path: string;
  method: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: unknown;
}) => Response | Promise<Response>;

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

export const TEST_USER = { id: 'u1', name: 'Ada', email: 'ada@example.com' };

const inertUploadApi: UploadApi = {
  init: async () => {
    throw new Error('not used');
  },
  status: async () => {
    throw new Error('not used');
  },
  putChunk: async () => {
    throw new Error('not used');
  },
};

/** Real client + session + transfer manager wired to a fake in-memory server (no network, no native modules). */
export function makeHarness(handler: Handler, opts: { signedIn?: boolean; locale?: Locale } = {}) {
  const calls: { method: string; path: string; query: string; body: unknown }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    calls.push({ method: String(init.method), path: u.pathname, query: u.search, body });
    return handler({
      path: u.pathname,
      method: String(init.method),
      query: u.searchParams,
      headers: init.headers as Record<string, string>,
      body,
    });
  }) as unknown as typeof fetch;
  const client = new ApiClient({
    baseUrl: 'https://api.test',
    fetchImpl,
    retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1 },
    sleep: async () => undefined,
  });
  const stored: StoredSession | null = opts.signedIn ? { accessToken: 'A', refreshToken: 'R', user: TEST_USER } : null;
  const store = new MemoryTokenStore(stored);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false, networkMode: 'always' } },
  });
  const session = new SessionManager(client, store, { onCleared: () => queryClient.clear() });
  const lock = new LockController({
    authenticator: { availability: async () => 'ok', authenticate: async () => true },
    load: async () => ({ enabled: false, timeoutSec: 0 }),
    save: async () => undefined,
  });
  let n = 0;
  const transfers = new TransferManager({
    runner: new UploadRunner(inertUploadApi),
    makeSource: (m) => ({ name: m.name, mimeType: m.mimeType, size: m.size, read: async () => new Uint8Array() as unknown as BodyInit }),
    download: async () => 'file:///cache/x',
    newId: () => `t${++n}`,
  });
  const services: Services = { client, session, lock, transfers, queryClient };
  const wrap = (ui: ReactNode) => (
    <ThemeProvider initialMode="light">
      <I18nProvider initialLocale={opts.locale ?? 'en'}>
        <QueryClientProvider client={queryClient}>
          <ServicesProvider services={services}>{ui}</ServicesProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>
  );
  return { services, calls, store, wrap, queryClient };
}
