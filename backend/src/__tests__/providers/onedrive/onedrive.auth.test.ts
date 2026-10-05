import { describe, expect, it } from 'vitest';
import { getCatalogEntry } from '../../../providers/catalog.js';
import {
  OnedriveProvider,
  createOnedriveProvider,
  registerOnedriveProvider,
} from '../../../providers/onedrive/index.js';
import {
  ONEDRIVE_AUTHORIZATION_URL,
  ONEDRIVE_SCOPES,
  ONEDRIVE_TOKEN_URL,
} from '../../../providers/onedrive/oauth2.js';
import { setOnedriveTransport } from '../../../providers/onedrive/transport.js';
import { buildAuthorizationUrl, getOAuth2Client, hasOAuth2Client } from '../../../providers/oauth2.js';
import { registry } from '../../../providers/registry.js';
import { ALL_CAPABILITIES } from '../../../providers/types.js';
import { expectProviderCode, makeContext, withFakeOnedrive } from './server.js';

describe('onedrive OAuth2 client registration', () => {
  it('registers the config used by the shared connect flow', () => {
    expect(hasOAuth2Client('onedrive')).toBe(true);
    const config = getOAuth2Client('onedrive');
    expect(config.id).toBe('onedrive');
    expect(config.authorizationUrl).toBe(ONEDRIVE_AUTHORIZATION_URL);
    expect(config.authorizationUrl).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
    expect(config.tokenUrl).toBe(ONEDRIVE_TOKEN_URL);
    expect(config.tokenUrl).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/token');
    expect(config.scopes).toEqual(['offline_access', 'User.Read', 'Files.ReadWrite', 'Files.ReadWrite.All']);
    expect(config.scopes).toEqual(ONEDRIVE_SCOPES);
    expect(config.authorizationParams ?? {}).toEqual({});
  });

  it('builds authorization URLs for the shared connect flow', () => {
    const url = new URL(
      buildAuthorizationUrl({
        provider: 'onedrive',
        clientId: 'app-id-1',
        redirectUri: 'https://9drive.example/connected-accounts/onedrive/callback',
        state: 'state-123',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('app-id-1');
    expect(url.searchParams.get('redirect_uri')).toBe('https://9drive.example/connected-accounts/onedrive/callback');
    expect(url.searchParams.get('state')).toBe('state-123');
    expect(url.searchParams.get('scope')).toBe(ONEDRIVE_SCOPES.join(' '));
    expect(url.searchParams.get('token_access_type')).toBeNull();
  });

  it('registers the adapter on the shared provider registry', () => {
    const provider = registerOnedriveProvider();
    try {
      expect(registry.get('onedrive')).toBe(provider);
      expect(provider.id).toBe('onedrive');
      expect(provider.displayName).toBe('OneDrive');
      expect(provider.authMode).toBe('oauth2');
      const entry = getCatalogEntry('onedrive');
      expect(entry).not.toBeNull();
      expect(new Set(entry!.capabilities)).toEqual(new Set(provider.capabilities));
      for (const capability of ALL_CAPABILITIES) {
        expect(provider.capabilities.has(capability)).toBe(true);
      }
    } finally {
      registry.unregister('onedrive');
    }
  });

  it('builds capability-limited adapters through the factory', () => {
    const provider = createOnedriveProvider({ capabilities: ['list'] });
    expect(provider).toBeInstanceOf(OnedriveProvider);
    expect(provider.getCapabilities().has('list')).toBe(true);
    expect(provider.getCapabilities().has('upload')).toBe(false);
  });
});

describe('onedrive account information', () => {
  it('reads the profile endpoint', async () => {
    await withFakeOnedrive({}, async (server) => {
      const provider = createOnedriveProvider();
      const info = await provider.getAccountInfo(makeContext());
      expect(info).toEqual({
        providerAccountId: 'user-0001',
        email: 'fake@outlook.example',
        displayName: 'Fake OneDrive User',
        avatarUrl: null,
      });
      expect(server.requests).toContain('/v1.0/me');
    });
  });

  it('rejects credentials that are not oauth2', async () => {
    await withFakeOnedrive({}, async () => {
      const provider = createOnedriveProvider();
      const ctx = { ...makeContext(), credentials: { kind: 'api_key' as const, apiKey: 'k' } };
      await expectProviderCode(provider.getAccountInfo(ctx), 'ERR_INVALID_INPUT');
    });
  });

  it('honours the getAccountInfo capability gate', async () => {
    await withFakeOnedrive({}, async () => {
      const provider = createOnedriveProvider({ capabilities: ['list'] });
      await expectProviderCode(provider.getAccountInfo(makeContext()), 'ERR_CAPABILITY_UNSUPPORTED');
    });
  });

  it('reports the drive quota', async () => {
    await withFakeOnedrive({}, async () => {
      const provider = createOnedriveProvider();
      const quota = await provider.getQuota(makeContext());
      expect(quota.totalBytes).toBe(5_368_709_120n);
      expect(quota.usedBytes).toBe(1_073_741_824n);
      expect(quota.availableBytes).toBe(4_294_966_272n);
      expect(quota.trashBytes).toBe(1_024n);
      expect(quota.raw).toMatchObject({ state: 'normal' });
    });
  });

  it('reports an unlimited quota when Graph omits the totals', async () => {
    await withFakeOnedrive({ quota: { total: null, remaining: null, deleted: null, used: 12 } }, async () => {
      const provider = createOnedriveProvider();
      const quota = await provider.getQuota(makeContext());
      expect(quota.totalBytes).toBeNull();
      expect(quota.availableBytes).toBeNull();
      expect(quota.trashBytes).toBeNull();
      expect(quota.usedBytes).toBe(12n);
    });
  });

  it('honours the getQuota capability gate', async () => {
    await withFakeOnedrive({}, async () => {
      const provider = createOnedriveProvider({ capabilities: ['list'] });
      await expectProviderCode(provider.getQuota(makeContext()), 'ERR_CAPABILITY_UNSUPPORTED');
    });
  });
});

describe('onedrive health check', () => {
  it('reports a healthy account with latency and timestamp', async () => {
    await withFakeOnedrive({}, async () => {
      const provider = createOnedriveProvider();
      const health = await provider.healthCheck(makeContext());
      expect(health.state).toBe('healthy');
      expect(health.message).toBeNull();
      expect(health.latencyMs).toBeGreaterThanOrEqual(0);
      expect(Number.isNaN(Date.parse(health.checkedAt))).toBe(false);
    });
  });

  it('maps a rejected token to unauthorized', async () => {
    await withFakeOnedrive({}, async (server) => {
      const provider = createOnedriveProvider();
      const ctx = makeContext({ credentials: { kind: 'oauth2', accessToken: 'stale-token' } });
      const health = await provider.healthCheck(ctx);
      expect(health.state).toBe('unauthorized');
      expect(health.message).toContain('401');
      expect(server.tokenRequests).toHaveLength(0);
    });
  });

  it('maps an unreachable upstream to unreachable', async () => {
    await withFakeOnedrive({}, async (server) => {
      setOnedriveTransport({ graphUrl: 'http://127.0.0.1:9', tokenUrl: server.tokenUrl });
      const provider = createOnedriveProvider();
      const health = await provider.healthCheck(makeContext());
      expect(health.state).toBe('unreachable');
    });
  });

  it('refuses to run without the healthCheck capability', async () => {
    await withFakeOnedrive({}, async () => {
      const provider = createOnedriveProvider({ capabilities: ['list'] });
      await expectProviderCode(provider.healthCheck(makeContext()), 'ERR_CAPABILITY_UNSUPPORTED');
    });
  });
});

describe('onedrive error mapping', () => {
  it('maps429 responses to ERR_RATE_LIMITED', async () => {
    await withFakeOnedrive({}, async (server) => {
      server.failNext('/v1.0/me/drive', { status: 429, code: 'activityLimitReached', message: 'throttled' });
      const provider = createOnedriveProvider();
      await expectProviderCode(provider.getQuota(makeContext()), 'ERR_RATE_LIMITED');
    });
  });

  it('maps rate-limit codes on non-429 responses to ERR_RATE_LIMITED', async () => {
    await withFakeOnedrive({}, async (server) => {
      server.failNext('/v1.0/me/drive', { status: 409, code: 'activityLimitReached', message: 'busy' });
      const provider = createOnedriveProvider();
      await expectProviderCode(provider.getQuota(makeContext()), 'ERR_RATE_LIMITED');
    });
  });

  it('maps itemNotFound responses to ERR_NOT_FOUND', async () => {
    await withFakeOnedrive({}, async (server) => {
      server.failNext('/v1.0/me/drive', { status: 404, code: 'itemNotFound', message: 'gone' });
      const provider = createOnedriveProvider();
      await expectProviderCode(provider.getQuota(makeContext()), 'ERR_NOT_FOUND');
    });
  });

  it('maps quota codes to ERR_QUOTA_EXCEEDED', async () => {
    await withFakeOnedrive({}, async (server) => {
      server.failNext('/v1.0/me/drive', { status: 409, code: 'insufficientStorage', message: 'full' });
      const provider = createOnedriveProvider();
      await expectProviderCode(provider.getQuota(makeContext()), 'ERR_QUOTA_EXCEEDED');
    });
  });

  it('maps413 responses to ERR_QUOTA_EXCEEDED', async () => {
    await withFakeOnedrive({}, async (server) => {
      server.failNext('/v1.0/me/drive', { status: 413, code: 'payloadTooLarge', message: 'too big' });
      const provider = createOnedriveProvider();
      await expectProviderCode(provider.getQuota(makeContext()), 'ERR_QUOTA_EXCEEDED');
    });
  });

  it('maps plain403 responses to ERR_AUTH_REVOKED', async () => {
    await withFakeOnedrive({}, async (server) => {
      server.failNext('/v1.0/me/drive', { status: 403, code: 'accessDenied', message: 'denied' });
      const provider = createOnedriveProvider();
      await expectProviderCode(provider.getQuota(makeContext()), 'ERR_AUTH_REVOKED');
    });
  });

  it('maps500 responses to ERR_UPSTREAM_UNAVAILABLE', async () => {
    await withFakeOnedrive({}, async (server) => {
      server.failNext('/v1.0/me/drive', { status: 500, code: 'generalException', message: 'boom' });
      const provider = createOnedriveProvider();
      await expectProviderCode(provider.getQuota(makeContext()), 'ERR_UPSTREAM_UNAVAILABLE');
    });
  });

  it('maps a missing remote id to ERR_NOT_FOUND', async () => {
    await withFakeOnedrive({}, async () => {
      const provider = createOnedriveProvider();
      await expectProviderCode(provider.getMetadata(makeContext(), { remoteId: 'item-missing' }), 'ERR_NOT_FOUND');
    });
  });

  it('maps401 responses without refresh material to ERR_AUTH_EXPIRED', async () => {
    await withFakeOnedrive({}, async (server) => {
      const provider = createOnedriveProvider();
      const ctx = makeContext({ credentials: { kind: 'oauth2', accessToken: 'stale-token' } });
      await expectProviderCode(provider.getQuota(ctx), 'ERR_AUTH_EXPIRED');
      expect(server.tokenRequests).toHaveLength(0);
    });
  });

  it('maps an aborted request to ERR_TIMEOUT', async () => {
    await withFakeOnedrive({}, async (server) => {
      server.failNext('/v1.0/me/drive', { status: 200, code: 'hang', hang: true });
      const controller = new AbortController();
      const provider = createOnedriveProvider();
      const pending = provider.getQuota(makeContext({ signal: controller.signal }));
      setTimeout(() => controller.abort(), 30);
      await expectProviderCode(pending, 'ERR_TIMEOUT');
    });
  });
});

describe('onedrive token refresh', () => {
  it('refreshes on401 and retries the original request once', async () => {
    await withFakeOnedrive({}, async (server) => {
      const provider = createOnedriveProvider();
      const ctx = makeContext({ accessToken: 'stale-token' });
      const quota = await provider.getQuota(ctx);

      expect(quota.usedBytes).toBe(1_073_741_824n);
      expect(server.tokenRequests).toHaveLength(1);
      expect(server.tokenRequests[0]).toMatchObject({
        grant_type: 'refresh_token',
        refresh_token: 'refresh-token-1',
        client_id: 'client-id-1',
        client_secret: 'client-secret-1',
      });
      expect(server.auths.slice(0, 2)).toEqual(['Bearer stale-token', 'Bearer test-token-2']);
    });
  });

  it('does not attempt a refresh when no refresh token is available', async () => {
    await withFakeOnedrive({}, async (server) => {
      const provider = createOnedriveProvider();
      const ctx = makeContext({ credentials: { kind: 'oauth2', accessToken: 'stale-token' } });
      await expectProviderCode(provider.list(ctx, { parentId: null }), 'ERR_AUTH_EXPIRED');
      expect(server.tokenRequests).toHaveLength(0);
    });
  });
});

describe('onedrive endpoint overrides', () => {
  it('routes account-configured endpoints through the SSRF gate', async () => {
    await withFakeOnedrive({}, async () => {
      const provider = createOnedriveProvider();
      const ctx = makeContext({ config: { graphBaseUrl: 'http://169.254.169.254/v1.0' } });
      await expectProviderCode(provider.getAccountInfo(ctx), 'ERR_SSRF_BLOCKED');
    });
  });

  it('accepts an allow-listed endpoint from the account config', async () => {
    await withFakeOnedrive({}, async (server) => {
      const provider = createOnedriveProvider();
      const ctx = makeContext({ config: { graphBaseUrl: `${server.origin}/v1.0` } });
      const info = await provider.getAccountInfo(ctx);
      expect(info.providerAccountId).toBe('user-0001');
      expect(server.requests).toContain('/v1.0/me');
    });
  });
});
