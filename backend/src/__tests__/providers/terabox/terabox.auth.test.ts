import { describe, expect, it } from 'vitest';
import { getCatalogEntry } from '../../../providers/catalog.js';
import { ProviderError } from '../../../providers/errors.js';
import { normalizeTeraBoxCookie, TeraBoxClient } from '../../../providers/terabox/client.js';
import {
  TERABOX_CAPABILITIES,
  TeraBoxProvider,
  createTeraBoxProvider,
  registerTeraBoxProvider,
} from '../../../providers/terabox/index.js';
import { setTeraBoxTransport } from '../../../providers/terabox/transport.js';
import { registry } from '../../../providers/registry.js';
import { ALL_CAPABILITIES } from '../../../providers/types.js';
import { expectProviderCode, makeContext, textStream, withFakeTeraBox } from './server.js';

const SHARED_CAPABILITIES = new Set(
  ALL_CAPABILITIES.filter(
    (capability) => capability !== 'uploadResumable' && capability !== 'createShare' && capability !== 'revokeShare',
  ),
);

describe('TeraBox provider registration', () => {
  it('registers the adapter on the shared registry with the cookie-session surface', () => {
    const provider = registerTeraBoxProvider();
    try {
      expect(registry.get('terabox')).toBe(provider);
      expect(provider.id).toBe('terabox');
      expect(provider.displayName).toBe('TeraBox');
      expect(provider.authMode).toBe('api_key');
      expect(SHARED_CAPABILITIES.size).toBe(15);
      expect(new Set(provider.capabilities)).toEqual(SHARED_CAPABILITIES);
      expect(new Set(TERABOX_CAPABILITIES)).toEqual(SHARED_CAPABILITIES);
      // The cookie API exposes neither resumable uploads nor sharing.
      expect(provider.capabilities.has('uploadResumable')).toBe(false);
      expect(provider.capabilities.has('createShare')).toBe(false);
      expect(provider.capabilities.has('revokeShare')).toBe(false);
      expect(provider.capabilities.has('downloadRange')).toBe(true);
    } finally {
      registry.unregister('terabox');
    }
  });

  it('matches the catalog entry served by GET /providers/catalog', () => {
    const entry = getCatalogEntry('terabox');
    expect(entry).not.toBeNull();
    expect(entry!.id).toBe('terabox');
    expect(entry!.status).toBe('SUPPORTED');
    expect(entry!.authMode).toBe('api_key');
    expect(new Set(entry!.capabilities)).toEqual(SHARED_CAPABILITIES);
  });

  it('builds capability-limited adapters through the factory', () => {
    const provider = createTeraBoxProvider({ capabilities: ['list'] });
    expect(provider).toBeInstanceOf(TeraBoxProvider);
    expect(provider.getCapabilities().has('list')).toBe(true);
    expect(provider.getCapabilities().has('upload')).toBe(false);
  });
});

describe('TeraBox session cookie', () => {
  it('turns a pasted ndus value into a real cookie header', () => {
    expect(normalizeTeraBoxCookie('abc123ndus')).toBe('ndus=abc123ndus; lang=en');
    expect(normalizeTeraBoxCookie('"abc123ndus"')).toBe('ndus=abc123ndus; lang=en');
    expect(normalizeTeraBoxCookie('ndus=abc; STOKEN=xyz')).toBe('ndus=abc; STOKEN=xyz');
    expect(normalizeTeraBoxCookie('  ndus=abc  ')).toBe('ndus=abc');
    expect(normalizeTeraBoxCookie('')).toBe('');
    expect(normalizeTeraBoxCookie(undefined)).toBe('');
  });

  it('refuses to build a client without a cookie', () => {
    expect(() => new TeraBoxClient({ cookie: '' })).toThrow(ProviderError);
    try {
      new TeraBoxClient({ cookie: '   ' });
    } catch (error) {
      expect(ProviderError.is(error)).toBe(true);
      expect((error as ProviderError).code).toBe('ERR_AUTH_EXPIRED');
    }
  });

  it('authenticates a bare ndus value end to end', async () => {
    await withFakeTeraBox({ cookie: 'bare-ndus-value', apiKey: 'bare-ndus-value' }, async (server, ctx) => {
      const info = await createTeraBoxProvider().getAccountInfo(ctx);
      expect(info.providerAccountId).toBe('987654321');
      expect(server.requests).toContain('GET /api/check/login');
    });
  });
});

describe('TeraBox account information', () => {
  it('reads the login uk and the user profile', async () => {
    await withFakeTeraBox({}, async (server) => {
      const info = await createTeraBoxProvider().getAccountInfo(makeContext());
      expect(info).toEqual({
        providerAccountId: '987654321',
        email: null,
        displayName: 'TeraBox Tester',
        avatarUrl: null,
      });
      expect(server.requests).toContain('GET /api/check/login');
      expect(server.requests).toContain('GET /api/user/getinfo');
    });
  });

  it('fails when login answers no account id', async () => {
    await withFakeTeraBox({ omitUk: true }, async () => {
      await expectProviderCode(createTeraBoxProvider().getAccountInfo(makeContext()), 'ERR_UPSTREAM_UNAVAILABLE');
    });
  });

  it('keeps the account readable when only the profile call fails', async () => {
    await withFakeTeraBox({}, async (server) => {
      server.failNext('/api/user/getinfo', 15);
      const messages: string[] = [];
      const info = await createTeraBoxProvider().getAccountInfo(
        makeContext({ logger: (message) => messages.push(message) }),
      );
      expect(info.providerAccountId).toBe('987654321');
      expect(info.displayName).toBeNull();
      expect(messages.some((message) => message.includes('user info unavailable'))).toBe(true);
    });
  });

  it('propagates a session failure from the profile call', async () => {
    await withFakeTeraBox({}, async (server) => {
      server.failNext('/api/user/getinfo', 104);
      await expectProviderCode(createTeraBoxProvider().getAccountInfo(makeContext()), 'ERR_AUTH_EXPIRED');
    });
  });

  it('rejects credentials that are not api_key', async () => {
    await withFakeTeraBox({}, async () => {
      const ctx = {
        ...makeContext(),
        credentials: { kind: 'oauth2' as const, accessToken: 'token' },
      };
      await expectProviderCode(createTeraBoxProvider().getAccountInfo(ctx), 'ERR_INVALID_INPUT');
    });
  });
});

describe('TeraBox quota', () => {
  it('reports total, used and available bytes from /api/quota', async () => {
    await withFakeTeraBox({}, async (server) => {
      const quota = await createTeraBoxProvider().getQuota(makeContext());
      expect(quota.totalBytes).toBe(1_073_741_824n);
      expect(quota.usedBytes).toBe(10_485_760n);
      expect(quota.availableBytes).toBe(1_063_256_064n);
      // TeraBox reports no separate trash total: one shared pool.
      expect(quota.trashBytes).toBeNull();
      expect(quota.raw).toMatchObject({ total: 1_073_741_824, used: 10_485_760 });
      expect(server.requests).toContain('GET /api/quota');
    });
  });

  it('honours a configured quota', async () => {
    await withFakeTeraBox({ total: 500, used: 120 }, async () => {
      const quota = await createTeraBoxProvider().getQuota(makeContext());
      expect(quota.totalBytes).toBe(500n);
      expect(quota.usedBytes).toBe(120n);
      expect(quota.availableBytes).toBe(380n);
    });
  });
});

describe('TeraBox health check', () => {
  it('reports a healthy account with latency and timestamp', async () => {
    await withFakeTeraBox({}, async () => {
      const health = await createTeraBoxProvider().healthCheck(makeContext());
      expect(health.state).toBe('healthy');
      expect(health.message).toBeNull();
      expect(health.latencyMs).toBeGreaterThanOrEqual(0);
      expect(Number.isNaN(Date.parse(health.checkedAt))).toBe(false);
    });
  });

  it('maps a rejected cookie (errno 104) to unauthorized', async () => {
    await withFakeTeraBox({ cookie: 'stale-cookie' }, async () => {
      const health = await createTeraBoxProvider().healthCheck(makeContext());
      expect(health.state).toBe('unauthorized');
      expect(health.message).toContain('104');
    });
  });

  it('maps an unreachable upstream to unreachable', async () => {
    await withFakeTeraBox({}, async () => {
      setTeraBoxTransport({ baseUrl: 'http://127.0.0.1:9', uploadHost: 'http://127.0.0.1:9' });
      const health = await createTeraBoxProvider().healthCheck(makeContext());
      expect(health.state).toBe('unreachable');
    });
  });

  it('refuses to run without the healthCheck capability', async () => {
    await withFakeTeraBox({}, async () => {
      const limited = createTeraBoxProvider({ capabilities: ['list'] });
      await expectProviderCode(limited.healthCheck(makeContext()), 'ERR_CAPABILITY_UNSUPPORTED');
    });
  });
});

describe('TeraBox error mapping', () => {
  it('maps the documented errno table onto the contract taxonomy', async () => {
    await withFakeTeraBox({}, async (server) => {
      const provider = createTeraBoxProvider();
      const cases: Array<[number, string]> = [
        [111, 'ERR_RATE_LIMITED'],
        [-10, 'ERR_QUOTA_EXCEEDED'],
        [-9, 'ERR_NOT_FOUND'],
        [104, 'ERR_AUTH_EXPIRED'],
        [2, 'ERR_INTERNAL'],
        [-8, 'ERR_INVALID_INPUT'],
        [-11, 'ERR_INVALID_INPUT'],
        [4242, 'ERR_UPSTREAM_UNAVAILABLE'],
      ];
      for (const [errno, code] of cases) {
        server.failNext('/api/quota', errno);
        await expectProviderCode(provider.getQuota(makeContext()), code);
      }
    });
  });

  it('maps HTTP statuses the way gateways answer', async () => {
    await withFakeTeraBox({}, async (server) => {
      const provider = createTeraBoxProvider();
      server.failNext('/api/quota', { status: 429 });
      await expectProviderCode(provider.getQuota(makeContext()), 'ERR_RATE_LIMITED');
      server.failNext('/api/quota', { status: 500 });
      await expectProviderCode(provider.getQuota(makeContext()), 'ERR_UPSTREAM_UNAVAILABLE');
      server.failNext('/api/quota', { status: 401 });
      await expectProviderCode(provider.getQuota(makeContext()), 'ERR_AUTH_EXPIRED');
    });
  });

  it('marks rate limits and upstream failures retryable', async () => {
    await withFakeTeraBox({}, async (server) => {
      const provider = createTeraBoxProvider();
      server.failNext('/api/quota', 111);
      const limited: unknown = await provider.getQuota(makeContext()).catch((error: unknown) => error);
      expect((limited as ProviderError).retryable).toBe(true);
      server.failNext('/api/quota', 4242);
      const upstream: unknown = await provider.getQuota(makeContext()).catch((error: unknown) => error);
      expect((upstream as ProviderError).retryable).toBe(true);
      server.failNext('/api/quota', 104);
      const auth: unknown = await provider.getQuota(makeContext()).catch((error: unknown) => error);
      expect((auth as ProviderError).retryable).toBe(false);
    });
  });

  it('refreshes jsToken once on a stale-token errno', async () => {
    await withFakeTeraBox({}, async (server) => {
      server.failNext('/api/quota', 4000023);
      const quota = await createTeraBoxProvider().getQuota(makeContext());
      expect(quota.totalBytes).toBe(1_073_741_824n);
      // The retried request carried the freshly scraped token.
      expect(server.tokenRequests.some((entry) => entry.includes('/api/quota'))).toBe(true);
    });
  });

  it('gives up after the single jsToken retry', async () => {
    await withFakeTeraBox({}, async (server) => {
      server.failNext('/api/quota', 4000023);
      server.failNext('/api/quota', 4000023);
      await expectProviderCode(createTeraBoxProvider().getQuota(makeContext()), 'ERR_UPSTREAM_UNAVAILABLE');
    });
  });
});

describe('TeraBox capability gates', () => {
  it('rejects every gated operation when the capability is missing', async () => {
    await withFakeTeraBox({}, async () => {
      const ctx = makeContext();
      const limited = createTeraBoxProvider({ capabilities: ['list'] });
      const uploadInput = {
        stream: textStream('payload'),
        fileName: 'file.txt',
        mimeType: 'text/plain',
        sizeBytes: 7n,
        parentId: null,
      };
      await expectProviderCode(limited.getAccountInfo(ctx), 'ERR_CAPABILITY_UNSUPPORTED');
      await expectProviderCode(limited.getQuota(ctx), 'ERR_CAPABILITY_UNSUPPORTED');
      await expectProviderCode(limited.healthCheck(ctx), 'ERR_CAPABILITY_UNSUPPORTED');
      await expectProviderCode(limited.upload(ctx, uploadInput), 'ERR_CAPABILITY_UNSUPPORTED');
      await expectProviderCode(limited.download(ctx, { remoteId: '/file.txt' }), 'ERR_CAPABILITY_UNSUPPORTED');
      await expectProviderCode(limited.createFolder(ctx, { name: 'x', parentId: null }), 'ERR_CAPABILITY_UNSUPPORTED');
      await expectProviderCode(limited.rename(ctx, { remoteId: '/a', newName: 'b' }), 'ERR_CAPABILITY_UNSUPPORTED');
      await expectProviderCode(limited.move(ctx, { remoteId: '/a', newParentId: null }), 'ERR_CAPABILITY_UNSUPPORTED');
      await expectProviderCode(limited.copy(ctx, { remoteId: '/a', newParentId: null }), 'ERR_CAPABILITY_UNSUPPORTED');
      await expectProviderCode(limited.delete(ctx, { remoteId: '/a' }), 'ERR_CAPABILITY_UNSUPPORTED');
      await expectProviderCode(limited.search(ctx, { query: 'a' }), 'ERR_CAPABILITY_UNSUPPORTED');
      await expectProviderCode(
        limited.createShare(ctx, { remoteId: '/file.txt', visibility: 'public_read' }),
        'ERR_CAPABILITY_UNSUPPORTED',
      );
    });
  });

  it('never exposes sharing over the cookie session, even with the capability declared', async () => {
    await withFakeTeraBox({}, async () => {
      const provider = createTeraBoxProvider({ capabilities: [...TERABOX_CAPABILITIES, 'createShare'] });
      await expectProviderCode(
        provider.createShare(makeContext(), { remoteId: '/file.txt', visibility: 'public_read' }),
        'ERR_CAPABILITY_UNSUPPORTED',
      );
    });
  });
});

describe('TeraBox jsToken scraping', () => {
  it('takes the token from /main when / redirects to login (production shape)', async () => {
    await withFakeTeraBox({ shellRedirects: ['/'] }, async () => {
      const client = new TeraBoxClient({ cookie: 'valid-cookie' });
      expect(await client.ensureJsToken()).toBe(true);
      expect(client.jsToken).toBe('TEST-JS-TOKEN');
    });
  });

  it('falls back to / when /main redirects', async () => {
    await withFakeTeraBox({ shellRedirects: ['/main'] }, async () => {
      const client = new TeraBoxClient({ cookie: 'valid-cookie' });
      expect(await client.ensureJsToken()).toBe(true);
      expect(client.jsToken).toBe('TEST-JS-TOKEN');
    });
  });

  it('resolves false instead of throwing when every shell entry redirects', async () => {
    await withFakeTeraBox({ shellRedirects: ['/', '/main'] }, async () => {
      const client = new TeraBoxClient({ cookie: 'valid-cookie' });
      expect(await client.ensureJsToken()).toBe(false);
      expect(client.jsToken).toBe('');
    });
  });
});
