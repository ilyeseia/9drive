import { describe, expect, it } from 'vitest';
import { getCatalogEntry } from '../../../providers/catalog.js';
import {
  PCLOUD_CAPABILITIES,
  PcloudProvider,
  createPcloudProvider,
  registerPcloudProvider,
} from '../../../providers/pcloud/index.js';
import {
  PCLOUD_AUTHORIZATION_URL,
  PCLOUD_SCOPES,
  PCLOUD_TOKEN_URL,
} from '../../../providers/pcloud/oauth2.js';
import { setPcloudTransport } from '../../../providers/pcloud/transport.js';
import { buildAuthorizationUrl, exchangeCode, getOAuth2Client, hasOAuth2Client } from '../../../providers/oauth2.js';
import { registry } from '../../../providers/registry.js';
import { ALL_CAPABILITIES } from '../../../providers/types.js';
import { expectProviderCode, makeContext, withFakePcloud } from './server.js';

describe('pCloud OAuth2 client registration', () => {
  it('registers the config used by the shared connect flow', () => {
    expect(hasOAuth2Client('pcloud')).toBe(true);
    const config = getOAuth2Client('pcloud');
    expect(config.id).toBe('pcloud');
    expect(config.authorizationUrl).toBe(PCLOUD_AUTHORIZATION_URL);
    expect(config.authorizationUrl).toBe('https://my.pcloud.com/oauth2/authorize');
    expect(config.tokenUrl).toBe(PCLOUD_TOKEN_URL);
    expect(config.tokenUrl).toBe('https://api.pcloud.com/oauth2_token');
    // pCloud's authorize page takes no scope parameter and grants full access.
    expect(config.scopes).toEqual([]);
    expect(config.scopes).toEqual(PCLOUD_SCOPES);
    expect(config.authorizationParams).toBeUndefined();
  });

  it('builds authorization URLs without a scope parameter', () => {
    const url = new URL(
      buildAuthorizationUrl({
        provider: 'pcloud',
        clientId: 'app-key-1',
        redirectUri: 'https://9drive.example/auth/pcloud/callback',
        state: 'state-123',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://my.pcloud.com/oauth2/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('app-key-1');
    expect(url.searchParams.get('redirect_uri')).toBe('https://9drive.example/auth/pcloud/callback');
    expect(url.searchParams.get('state')).toBe('state-123');
    expect(url.searchParams.get('scope')).toBeNull();
  });

  it('registers the adapter on the shared provider registry with every capability but uploadResumable', () => {
    const provider = registerPcloudProvider();
    try {
      expect(registry.get('pcloud')).toBe(provider);
      expect(provider.id).toBe('pcloud');
      expect(provider.displayName).toBe('pCloud');
      expect(provider.authMode).toBe('oauth2');
      const expected = new Set(ALL_CAPABILITIES.filter((capability) => capability !== 'uploadResumable'));
      expect(expected.size).toBe(17);
      expect(new Set(provider.capabilities)).toEqual(expected);
      expect(new Set(PCLOUD_CAPABILITIES)).toEqual(expected);
      expect(provider.capabilities.has('uploadResumable')).toBe(false);
      // The catalog still advertises `ALL`; that divergence is reported to the
      // coordinator — this test pins the adapter's real surface.
      const entry = getCatalogEntry('pcloud');
      expect(entry).not.toBeNull();
      expect(entry!.status).toBe('SUPPORTED');
      expect(entry!.docsUrl).toBe('https://docs.pcloud.com/');
    } finally {
      registry.unregister('pcloud');
    }
  });

  it('builds capability-limited adapters through the factory', () => {
    const provider = createPcloudProvider({ capabilities: ['list'] });
    expect(provider).toBeInstanceOf(PcloudProvider);
    expect(provider.getCapabilities().has('list')).toBe(true);
    expect(provider.getCapabilities().has('upload')).toBe(false);
  });
});

describe('pCloud token exchange', () => {
  it('exchanges a code for a permanent token with no expiry', async () => {
    await withFakePcloud({}, async (server) => {
      const result = await exchangeCode({
        provider: 'pcloud',
        clientId: 'client-id-1',
        clientSecret: 'client-secret-1',
        redirectUri: 'https://9drive.example/auth/pcloud/callback',
        code: 'auth-code-1',
        tokenUrl: server.tokenUrl,
      });
      expect(result.accessToken).toBe('test-token-2');
      expect(result.expiresAt).toBeNull();
      expect(result.refreshToken).toBeUndefined();
      expect(server.tokenRequests).toHaveLength(1);
      expect(server.tokenRequests[0]).toMatchObject({
        client_id: 'client-id-1',
        client_secret: 'client-secret-1',
        code: 'auth-code-1',
        grant_type: 'authorization_code',
      });
    });
  });
});

describe('pCloud account information', () => {
  it('reads the userinfo endpoint', async () => {
    await withFakePcloud({}, async (server) => {
      const provider = createPcloudProvider();
      const info = await provider.getAccountInfo(makeContext());
      expect(info).toEqual({
        providerAccountId: '4242',
        email: 'fake@pcloud.example',
        displayName: null,
        avatarUrl: null,
      });
      expect(server.requests).toContain('/userinfo');
      expect(server.auths[0]).toBe('test-token');
    });
  });

  it('rejects credentials that are not oauth2', async () => {
    await withFakePcloud({}, async () => {
      const provider = createPcloudProvider();
      const ctx = { ...makeContext(), credentials: { kind: 'api_key' as const, apiKey: 'k' } };
      await expectProviderCode(provider.getAccountInfo(ctx), 'ERR_INVALID_INPUT');
    });
  });

  it('honours the getAccountInfo capability gate', async () => {
    await withFakePcloud({}, async () => {
      const provider = createPcloudProvider({ capabilities: ['list'] });
      await expectProviderCode(provider.getAccountInfo(makeContext()), 'ERR_CAPABILITY_UNSUPPORTED');
    });
  });

  it('reports quota with bigint arithmetic beyond Number.MAX_SAFE_INTEGER', async () => {
    await withFakePcloud(
      { quota: '18446744073709551615', usedquota: '9007199254740993' },
      async () => {
        const provider = createPcloudProvider();
        const quota = await provider.getQuota(makeContext());
        expect(quota.totalBytes).toBe(18446744073709551615n);
        expect(quota.usedBytes).toBe(9007199254740993n);
        expect(quota.availableBytes).toBe(18446744073709551615n - 9007199254740993n);
        expect(quota.trashBytes).toBeNull();
        expect(quota.raw).toMatchObject({ usedquota: '9007199254740993' });
      },
    );
  });

  it('reports an unlimited quota when userinfo omits the quota field', async () => {
    await withFakePcloud({ quota: null, usedquota: 12 }, async () => {
      const provider = createPcloudProvider();
      const quota = await provider.getQuota(makeContext());
      expect(quota.totalBytes).toBeNull();
      expect(quota.availableBytes).toBeNull();
      expect(quota.usedBytes).toBe(12n);
    });
  });

  it('honours the getQuota capability gate', async () => {
    await withFakePcloud({}, async () => {
      const provider = createPcloudProvider({ capabilities: ['list'] });
      await expectProviderCode(provider.getQuota(makeContext()), 'ERR_CAPABILITY_UNSUPPORTED');
    });
  });
});

describe('pCloud health check', () => {
  it('reports a healthy account with latency and timestamp', async () => {
    await withFakePcloud({}, async () => {
      const provider = createPcloudProvider();
      const health = await provider.healthCheck(makeContext());
      expect(health.state).toBe('healthy');
      expect(health.message).toBeNull();
      expect(health.latencyMs).toBeGreaterThanOrEqual(0);
      expect(Number.isNaN(Date.parse(health.checkedAt))).toBe(false);
    });
  });

  it('maps a rejected token (result 1000) to unauthorized', async () => {
    await withFakePcloud({}, async (server) => {
      const provider = createPcloudProvider();
      const ctx = makeContext({ accessToken: 'stale-token' });
      const health = await provider.healthCheck(ctx);
      expect(health.state).toBe('unauthorized');
      expect(health.message).toContain('1000');
      expect(server.tokenRequests).toHaveLength(0);
    });
  });

  it('maps an unreachable upstream to unreachable', async () => {
    await withFakePcloud({}, async (server) => {
      setPcloudTransport({ apiUrl: 'http://127.0.0.1:9', tokenUrl: server.tokenUrl, cdnScheme: 'http' });
      const provider = createPcloudProvider();
      const health = await provider.healthCheck(makeContext());
      expect(health.state).toBe('unreachable');
    });
  });

  it('refuses to run without the healthCheck capability', async () => {
    await withFakePcloud({}, async () => {
      const provider = createPcloudProvider({ capabilities: ['list'] });
      await expectProviderCode(provider.healthCheck(makeContext()), 'ERR_CAPABILITY_UNSUPPORTED');
    });
  });
});

describe('pCloud error mapping', () => {
  it('maps the 4xxx rate-limit category to ERR_RATE_LIMITED', async () => {
    await withFakePcloud({}, async (server) => {
      server.failNext('userinfo', { result: 4000 });
      const provider = createPcloudProvider();
      await expectProviderCode(provider.getQuota(makeContext()), 'ERR_RATE_LIMITED');
    });
  });

  it('maps the 5xxx internal category to ERR_UPSTREAM_UNAVAILABLE', async () => {
    await withFakePcloud({}, async (server) => {
      server.failNext('userinfo', { result: 5000 });
      const provider = createPcloudProvider();
      await expectProviderCode(provider.getQuota(makeContext()), 'ERR_UPSTREAM_UNAVAILABLE');
    });
  });

  it('marks 4xxx results retryable', async () => {
    await withFakePcloud({}, async (server) => {
      server.failNext('userinfo', { result: 4001 });
      const provider = createPcloudProvider();
      const error: unknown = await provider.getQuota(makeContext()).catch((err: unknown) => err);
      expect((error as { code?: string }).code).toBe('ERR_RATE_LIMITED');
      expect((error as { retryable?: boolean }).retryable).toBe(true);
    });
  });

  it('maps access denied (result 2003) to ERR_INVALID_INPUT', async () => {
    await withFakePcloud({}, async (server) => {
      server.failNext('userinfo', { result: 2003 });
      const provider = createPcloudProvider();
      await expectProviderCode(provider.getQuota(makeContext()), 'ERR_INVALID_INPUT');
    });
  });

  it('maps plain HTTP 500 responses to ERR_UPSTREAM_UNAVAILABLE', async () => {
    await withFakePcloud({}, async (server) => {
      server.failNext('userinfo', { status: 500 });
      const provider = createPcloudProvider();
      await expectProviderCode(provider.getQuota(makeContext()), 'ERR_UPSTREAM_UNAVAILABLE');
    });
  });

  it('maps plain HTTP 429 responses to ERR_RATE_LIMITED', async () => {
    await withFakePcloud({}, async (server) => {
      server.failNext('userinfo', { status: 429 });
      const provider = createPcloudProvider();
      await expectProviderCode(provider.getQuota(makeContext()), 'ERR_RATE_LIMITED');
    });
  });

  it('maps HTTP 401 without refresh material to ERR_AUTH_EXPIRED', async () => {
    await withFakePcloud({}, async (server) => {
      server.failNext('userinfo', { status: 401 });
      const provider = createPcloudProvider();
      await expectProviderCode(provider.getQuota(makeContext()), 'ERR_AUTH_EXPIRED');
      expect(server.tokenRequests).toHaveLength(0);
    });
  });

  it('maps a missing file to ERR_NOT_FOUND (stat result 2009)', async () => {
    await withFakePcloud({}, async () => {
      const provider = createPcloudProvider();
      await expectProviderCode(provider.getMetadata(makeContext(), { remoteId: 'f9999999' }), 'ERR_NOT_FOUND');
    });
  });

  it('maps a malformed remoteId to ERR_INVALID_INPUT', async () => {
    await withFakePcloud({}, async () => {
      const provider = createPcloudProvider();
      await expectProviderCode(provider.getMetadata(makeContext(), { remoteId: 'not-a-pcloud-id' }), 'ERR_INVALID_INPUT');
    });
  });

  it('maps an aborted request to ERR_TIMEOUT', async () => {
    await withFakePcloud({}, async (server) => {
      server.failNext('userinfo', { hang: true });
      const controller = new AbortController();
      const provider = createPcloudProvider();
      const pending = provider.getQuota(makeContext({ signal: controller.signal }));
      setTimeout(() => controller.abort(), 30);
      await expectProviderCode(pending, 'ERR_TIMEOUT');
    });
  });
});

describe('pCloud endpoint overrides', () => {
  it('routes account-configured endpoints through the SSRF gate', async () => {
    await withFakePcloud({}, async () => {
      const provider = createPcloudProvider();
      const ctx = makeContext({ config: { apiBaseUrl: 'http://169.254.169.254' } });
      await expectProviderCode(provider.getAccountInfo(ctx), 'ERR_SSRF_BLOCKED');
    });
  });

  it('accepts an allow-listed endpoint from the account config', async () => {
    await withFakePcloud({}, async (server) => {
      const provider = createPcloudProvider();
      const ctx = makeContext({ config: { apiBaseUrl: server.origin } });
      const info = await provider.getAccountInfo(ctx);
      expect(info.providerAccountId).toBe('4242');
      expect(server.requests).toContain('/userinfo');
    });
  });
});
