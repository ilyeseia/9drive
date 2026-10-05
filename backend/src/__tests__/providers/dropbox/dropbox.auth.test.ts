import { describe, expect, it } from 'vitest';
import { getCatalogEntry } from '../../../providers/catalog.js';
import {
  DropboxProvider,
  createDropboxProvider,
  registerDropboxProvider,
} from '../../../providers/dropbox/index.js';
import {
  DROPBOX_AUTHORIZATION_URL,
  DROPBOX_SCOPES,
  DROPBOX_TOKEN_URL,
} from '../../../providers/dropbox/oauth2.js';
import { setDropboxTransport } from '../../../providers/dropbox/transport.js';
import { buildAuthorizationUrl, getOAuth2Client, hasOAuth2Client } from '../../../providers/oauth2.js';
import { registry } from '../../../providers/registry.js';
import { ALL_CAPABILITIES } from '../../../providers/types.js';
import { expectProviderCode, makeContext, withFakeDropbox } from './server.js';

describe('dropbox OAuth2 client registration', () => {
  it('registers the config used by the shared connect flow', () => {
    expect(hasOAuth2Client('dropbox')).toBe(true);
    const config = getOAuth2Client('dropbox');
    expect(config.id).toBe('dropbox');
    expect(config.authorizationUrl).toBe(DROPBOX_AUTHORIZATION_URL);
    expect(config.authorizationUrl).toBe('https://www.dropbox.com/oauth2/authorize');
    expect(config.tokenUrl).toBe(DROPBOX_TOKEN_URL);
    expect(config.tokenUrl).toBe('https://api.dropboxapi.com/oauth2/token');
    expect(config.scopes).toEqual([
      'account_info.read',
      'files.metadata.read',
      'files.metadata.write',
      'files.content.read',
      'files.content.write',
      'sharing.read',
      'sharing.write',
    ]);
    expect(config.scopes).toEqual(DROPBOX_SCOPES);
    expect(config.authorizationParams).toEqual({ token_access_type: 'offline' });
  });

  it('builds authorization URLs that request an offline refresh token', () => {
    const url = new URL(
      buildAuthorizationUrl({
        provider: 'dropbox',
        clientId: 'app-key-1',
        redirectUri: 'https://9drive.example/auth/dropbox/callback',
        state: 'state-123',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://www.dropbox.com/oauth2/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('app-key-1');
    expect(url.searchParams.get('redirect_uri')).toBe('https://9drive.example/auth/dropbox/callback');
    expect(url.searchParams.get('state')).toBe('state-123');
    expect(url.searchParams.get('scope')).toBe(DROPBOX_SCOPES.join(' '));
    expect(url.searchParams.get('token_access_type')).toBe('offline');
  });

  it('registers the adapter on the shared provider registry', () => {
    const provider = registerDropboxProvider();
    try {
      expect(registry.get('dropbox')).toBe(provider);
      expect(provider.id).toBe('dropbox');
      expect(provider.displayName).toBe('Dropbox');
      expect(provider.authMode).toBe('oauth2');
      const entry = getCatalogEntry('dropbox');
      expect(entry).not.toBeNull();
      expect(new Set(entry!.capabilities)).toEqual(new Set(provider.capabilities));
      for (const capability of ALL_CAPABILITIES) {
        expect(provider.capabilities.has(capability)).toBe(true);
      }
    } finally {
      registry.unregister('dropbox');
    }
  });

  it('builds capability-limited adapters through the factory', () => {
    const provider = createDropboxProvider({ capabilities: ['list'] });
    expect(provider).toBeInstanceOf(DropboxProvider);
    expect(provider.getCapabilities().has('list')).toBe(true);
    expect(provider.getCapabilities().has('upload')).toBe(false);
  });
});

describe('dropbox account information', () => {
  it('reads the current account endpoint', async () => {
    await withFakeDropbox({}, async (server) => {
      const provider = createDropboxProvider();
      const info = await provider.getAccountInfo(makeContext());
      expect(info).toEqual({
        providerAccountId: 'dbid:FAKEACCOUNT',
        email: 'fake@dropbox.example',
        displayName: 'Fake Dropbox User',
        avatarUrl: 'https://dl-web.dropbox.com/account_photo/fake',
      });
      expect(server.requests).toContain('/2/users/get_current_account');
    });
  });

  it('rejects credentials that are not oauth2', async () => {
    await withFakeDropbox({}, async () => {
      const provider = createDropboxProvider();
      const ctx = { ...makeContext(), credentials: { kind: 'api_key' as const, apiKey: 'k' } };
      await expectProviderCode(provider.getAccountInfo(ctx), 'ERR_INVALID_INPUT');
    });
  });

  it('honours the getAccountInfo capability gate', async () => {
    await withFakeDropbox({}, async () => {
      const provider = createDropboxProvider({ capabilities: ['list'] });
      await expectProviderCode(provider.getAccountInfo(makeContext()), 'ERR_CAPABILITY_UNSUPPORTED');
    });
  });

  it('reports quota with bigint arithmetic beyond Number.MAX_SAFE_INTEGER', async () => {
    await withFakeDropbox(
      { spaceUsage: { used: '9007199254740993', allocated: '18446744073709551615' } },
      async () => {
        const provider = createDropboxProvider();
        const quota = await provider.getQuota(makeContext());
        expect(quota.totalBytes).toBe(18446744073709551615n);
        expect(quota.usedBytes).toBe(9007199254740993n);
        expect(quota.availableBytes).toBe(18446744073709551615n - 9007199254740993n);
        expect(quota.trashBytes).toBeNull();
        expect(quota.raw).toMatchObject({ used: '9007199254740993' });
      },
    );
  });

  it('reports an unlimited quota when Dropbox omits the allocation', async () => {
    await withFakeDropbox({ spaceUsage: { used: 12, allocated: null } }, async () => {
      const provider = createDropboxProvider();
      const quota = await provider.getQuota(makeContext());
      expect(quota.totalBytes).toBeNull();
      expect(quota.availableBytes).toBeNull();
      expect(quota.usedBytes).toBe(12n);
    });
  });

  it('honours the getQuota capability gate', async () => {
    await withFakeDropbox({}, async () => {
      const provider = createDropboxProvider({ capabilities: ['list'] });
      await expectProviderCode(provider.getQuota(makeContext()), 'ERR_CAPABILITY_UNSUPPORTED');
    });
  });
});

describe('dropbox health check', () => {
  it('reports a healthy account with latency and timestamp', async () => {
    await withFakeDropbox({}, async () => {
      const provider = createDropboxProvider();
      const health = await provider.healthCheck(makeContext());
      expect(health.state).toBe('healthy');
      expect(health.message).toBeNull();
      expect(health.latencyMs).toBeGreaterThanOrEqual(0);
      expect(Number.isNaN(Date.parse(health.checkedAt))).toBe(false);
    });
  });

  it('maps a rejected token to unauthorized', async () => {
    await withFakeDropbox({}, async (server) => {
      const provider = createDropboxProvider();
      const ctx = makeContext({
        credentials: { kind: 'oauth2', accessToken: 'stale-token' },
      });
      const health = await provider.healthCheck(ctx);
      expect(health.state).toBe('unauthorized');
      expect(health.message).toContain('401');
      expect(server.tokenRequests).toHaveLength(0);
    });
  });

  it('maps an unreachable upstream to unreachable', async () => {
    await withFakeDropbox({}, async (server) => {
      setDropboxTransport({ apiUrl: 'http://127.0.0.1:9', contentUrl: 'http://127.0.0.1:9', tokenUrl: server.tokenUrl });
      const provider = createDropboxProvider();
      const health = await provider.healthCheck(makeContext());
      expect(health.state).toBe('unreachable');
    });
  });

  it('refuses to run without the healthCheck capability', async () => {
    await withFakeDropbox({}, async () => {
      const provider = createDropboxProvider({ capabilities: ['list'] });
      await expectProviderCode(provider.healthCheck(makeContext()), 'ERR_CAPABILITY_UNSUPPORTED');
    });
  });
});

describe('dropbox error mapping', () => {
  it('maps rate limit reasons on409 responses to ERR_RATE_LIMITED', async () => {
    await withFakeDropbox({}, async (server) => {
      server.failNext('/2/users/get_space_usage', { status: 409, summary: 'too_many_write_operations/.' });
      const provider = createDropboxProvider();
      await expectProviderCode(provider.getQuota(makeContext()), 'ERR_RATE_LIMITED');
    });
  });

  it('maps429 responses to ERR_RATE_LIMITED', async () => {
    await withFakeDropbox({}, async (server) => {
      server.failNext('/2/users/get_space_usage', { status: 429, summary: 'slow_down/.' });
      const provider = createDropboxProvider();
      await expectProviderCode(provider.getQuota(makeContext()), 'ERR_RATE_LIMITED');
    });
  });

  it('maps path/not_found summaries to ERR_NOT_FOUND', async () => {
    await withFakeDropbox({}, async (server) => {
      server.failNext('/2/users/get_space_usage', { status: 409, summary: 'path/not_found/.' });
      const provider = createDropboxProvider();
      await expectProviderCode(provider.getQuota(makeContext()), 'ERR_NOT_FOUND');
    });
  });

  it('maps insufficient_space summaries to ERR_QUOTA_EXCEEDED', async () => {
    await withFakeDropbox({}, async (server) => {
      server.failNext('/2/users/get_space_usage', { status: 409, summary: 'insufficient_space/.' });
      const provider = createDropboxProvider();
      await expectProviderCode(provider.getQuota(makeContext()), 'ERR_QUOTA_EXCEEDED');
    });
  });

  it('maps plain403 responses to ERR_AUTH_REVOKED', async () => {
    await withFakeDropbox({}, async (server) => {
      server.failNext('/2/users/get_space_usage', { status: 403, summary: 'forbidden/.' });
      const provider = createDropboxProvider();
      await expectProviderCode(provider.getQuota(makeContext()), 'ERR_AUTH_REVOKED');
    });
  });

  it('maps500 responses to ERR_UPSTREAM_UNAVAILABLE', async () => {
    await withFakeDropbox({}, async (server) => {
      server.failNext('/2/users/get_space_usage', { status: 500, summary: 'internal/.' });
      const provider = createDropboxProvider();
      await expectProviderCode(provider.getQuota(makeContext()), 'ERR_UPSTREAM_UNAVAILABLE');
    });
  });

  it('maps a missing remote id to ERR_NOT_FOUND', async () => {
    await withFakeDropbox({}, async () => {
      const provider = createDropboxProvider();
      await expectProviderCode(provider.getMetadata(makeContext(), { remoteId: 'id:missing' }), 'ERR_NOT_FOUND');
    });
  });

  it('maps401 responses without refresh material to ERR_AUTH_EXPIRED', async () => {
    await withFakeDropbox({}, async (server) => {
      const provider = createDropboxProvider();
      const ctx = makeContext({ credentials: { kind: 'oauth2', accessToken: 'stale-token' } });
      await expectProviderCode(provider.getQuota(ctx), 'ERR_AUTH_EXPIRED');
      expect(server.tokenRequests).toHaveLength(0);
    });
  });

  it('maps an aborted request to ERR_TIMEOUT', async () => {
    await withFakeDropbox({}, async (server) => {
      server.failNext('/2/users/get_space_usage', { status: 200, summary: '', hang: true });
      const controller = new AbortController();
      const provider = createDropboxProvider();
      const pending = provider.getQuota(makeContext({ signal: controller.signal }));
      setTimeout(() => controller.abort(), 30);
      await expectProviderCode(pending, 'ERR_TIMEOUT');
    });
  });
});

describe('dropbox token refresh', () => {
  it('refreshes on401 and retries the original request once', async () => {
    await withFakeDropbox({}, async (server) => {
      const provider = createDropboxProvider();
      const ctx = makeContext({ accessToken: 'stale-token' });
      const quota = await provider.getQuota(ctx);

      expect(quota.usedBytes).toBe(1_099_511_627_776n);
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
    await withFakeDropbox({}, async (server) => {
      const provider = createDropboxProvider();
      const ctx = makeContext({ credentials: { kind: 'oauth2', accessToken: 'stale-token' } });
      await expectProviderCode(provider.list(ctx, { parentId: null }), 'ERR_AUTH_EXPIRED');
      expect(server.tokenRequests).toHaveLength(0);
    });
  });
});

describe('dropbox endpoint overrides', () => {
  it('routes account-configured endpoints through the SSRF gate', async () => {
    await withFakeDropbox({}, async () => {
      const provider = createDropboxProvider();
      const ctx = makeContext({ config: { apiBaseUrl: 'http://169.254.169.254/2' } });
      await expectProviderCode(provider.getAccountInfo(ctx), 'ERR_SSRF_BLOCKED');
    });
  });

  it('accepts an allow-listed endpoint from the account config', async () => {
    await withFakeDropbox({}, async (server) => {
      const provider = createDropboxProvider();
      const ctx = makeContext({ config: { apiBaseUrl: `${server.origin}/2` } });
      const info = await provider.getAccountInfo(ctx);
      expect(info.providerAccountId).toBe('dbid:FAKEACCOUNT');
      expect(server.requests).toContain('/2/users/get_current_account');
    });
  });
});
