import { describe, expect, it } from 'vitest';
import { getCatalogEntry } from '../../../providers/catalog.js';
import {
  GoogleDriveProvider,
  createGoogleDriveProvider,
  registerGoogleDriveProvider,
} from '../../../providers/google-drive/index.js';
import { setGoogleDriveTransport } from '../../../providers/google-drive/transport.js';
import { hasOAuth2Client, getOAuth2Client } from '../../../providers/oauth2.js';
import { registry } from '../../../providers/registry.js';
import { ALL_CAPABILITIES } from '../../../providers/types.js';
import { expectProviderCode, makeContext, withFakeDrive } from './helpers.js';

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

describe('google_drive OAuth2 client registration', () => {
  it('registers the config used by the shared connect flow', () => {
    expect(hasOAuth2Client('google_drive')).toBe(true);
    const config = getOAuth2Client('google_drive');
    expect(config.id).toBe('google_drive');
    expect(config.authorizationUrl).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(config.tokenUrl).toBe('https://oauth2.googleapis.com/token');
    expect(config.scopes).toEqual(GOOGLE_SCOPES);
    expect(config.authorizationParams).toEqual({
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
    });
  });

  it('registers the adapter on the shared provider registry', () => {
    const provider = registerGoogleDriveProvider();
    try {
      expect(registry.get('google_drive')).toBe(provider);
      expect(provider.id).toBe('google_drive');
      expect(provider.displayName).toBe('Google Drive');
      expect(provider.authMode).toBe('oauth2');
      const entry = getCatalogEntry('google_drive');
      expect(entry).not.toBeNull();
      expect(new Set(entry!.capabilities)).toEqual(new Set(provider.capabilities));
      for (const capability of ALL_CAPABILITIES) {
        expect(provider.capabilities.has(capability)).toBe(true);
      }
    } finally {
      registry.unregister('google_drive');
    }
  });

  it('builds capability-limited adapters through the factory', () => {
    const provider = createGoogleDriveProvider({ capabilities: ['list'] });
    expect(provider).toBeInstanceOf(GoogleDriveProvider);
    expect(provider.getCapabilities().has('list')).toBe(true);
    expect(provider.getCapabilities().has('upload')).toBe(false);
  });
});

describe('google_drive account information', () => {
  it('reads the Google profile endpoint', async () => {
    await withFakeDrive({}, async (drive) => {
      const provider = createGoogleDriveProvider();
      const info = await provider.getAccountInfo(makeContext(drive));
      expect(info).toEqual({
        providerAccountId: 'profile-sub-001',
        email: 'drive@example.test',
        displayName: 'Drive Tester',
        avatarUrl: 'https://example.test/avatar.png',
      });
      expect(drive.requests.some((request) => request.path === '/oauth2/v2/userinfo')).toBe(true);
    });
  });

  it('falls back to the Drive about endpoint when the profile endpoint fails', async () => {
    await withFakeDrive({ profile: null }, async (drive) => {
      const provider = createGoogleDriveProvider();
      const info = await provider.getAccountInfo(makeContext(drive));
      expect(info.providerAccountId).toBe('profile-sub-001');
      expect(info.email).toBe('drive@example.test');
      expect(drive.requests.some((request) => request.path === '/drive/v3/about')).toBe(true);
    });
  });

  it('reports quota with bigint arithmetic beyond Number.MAX_SAFE_INTEGER', async () => {
    await withFakeDrive(
      {
        storageQuota: {
          limit: '10000000000000000000',
          usage: '4000000000000000000',
          usageInDriveTrash: '1000000000000000000',
        },
      },
      async (drive) => {
        const provider = createGoogleDriveProvider();
        const quota = await provider.getQuota(makeContext(drive));
        expect(quota.totalBytes).toBe(10000000000000000000n);
        expect(quota.usedBytes).toBe(4000000000000000000n);
        expect(quota.availableBytes).toBe(6000000000000000000n);
        expect(quota.trashBytes).toBe(1000000000000000000n);
      },
    );
  });

  it('reports an unlimited quota when Google omits the limit', async () => {
    await withFakeDrive({ storageQuota: { usage: '12' } }, async (drive) => {
      const provider = createGoogleDriveProvider();
      const quota = await provider.getQuota(makeContext(drive));
      expect(quota.totalBytes).toBeNull();
      expect(quota.availableBytes).toBeNull();
      expect(quota.usedBytes).toBe(12n);
    });
  });
});

describe('google_drive health check', () => {
  it('reports a healthy account with latency and timestamp', async () => {
    await withFakeDrive({}, async (drive) => {
      const provider = createGoogleDriveProvider();
      const health = await provider.healthCheck(makeContext(drive));
      expect(health.state).toBe('healthy');
      expect(health.message).toBeNull();
      expect(health.latencyMs).toBeGreaterThanOrEqual(0);
      expect(Number.isNaN(Date.parse(health.checkedAt))).toBe(false);
    });
  });

  it('maps a rejected token to unauthorized', async () => {
    await withFakeDrive({}, async (drive) => {
      const provider = createGoogleDriveProvider();
      const health = await provider.healthCheck(makeContext(drive, { accessToken: 'stale-token', refreshToken: '' }));
      expect(health.state).toBe('unauthorized');
      expect(health.message).toContain('Google Drive API 401');
    });
  });

  it('maps an unreachable upstream to unreachable', async () => {
    await withFakeDrive({}, async (drive) => {
      setGoogleDriveTransport({ baseUrl: 'http://127.0.0.1:9', tokenUrl: drive.tokenUrl });
      const provider = createGoogleDriveProvider();
      const health = await provider.healthCheck(makeContext(drive));
      expect(health.state).toBe('unreachable');
    });
  });

  it('refuses to run without the healthCheck capability', async () => {
    const provider = createGoogleDriveProvider({ capabilities: ['list'] });
    await expectProviderCode(provider.healthCheck(makeContext()), 'ERR_CAPABILITY_UNSUPPORTED');
  });
});

describe('google_drive error mapping', () => {
  it('maps rate limit reasons to ERR_RATE_LIMITED', async () => {
    await withFakeDrive({}, async (drive) => {
      drive.failNext({
        path: '/drive/v3/about',
        method: 'GET',
        status: 403,
        body: {
          error: {
            code: 403,
            message: 'A user rate limit has been exceeded',
            errors: [{ domain: 'global', reason: 'userRateLimitExceeded', message: 'rate limited' }],
          },
        },
      });
      const provider = createGoogleDriveProvider();
      await expectProviderCode(provider.getQuota(makeContext(drive)), 'ERR_RATE_LIMITED');
    });
  });

  it('maps RPC reason strings on403 responses', async () => {
    await withFakeDrive({}, async (drive) => {
      drive.failNext({
        path: '/drive/v3/about',
        method: 'GET',
        status: 403,
        body: {
          error: {
            code: 403,
            message: 'quota exceeded',
            status: 'RESOURCE_EXHAUSTED',
            details: [{ reason: 'RATE_LIMIT_EXCEEDED' }],
          },
        },
      });
      const provider = createGoogleDriveProvider();
      await expectProviderCode(provider.getQuota(makeContext(drive)), 'ERR_RATE_LIMITED');
    });
  });

  it('maps plain 403 responses to ERR_AUTH_REVOKED', async () => {
    await withFakeDrive({}, async (drive) => {
      drive.failNext({
        path: '/drive/v3/about',
        method: 'GET',
        status: 403,
        body: { error: { code: 403, message: 'The user does not have permission', errors: [{ reason: 'forbidden' }] } },
      });
      const provider = createGoogleDriveProvider();
      await expectProviderCode(provider.getQuota(makeContext(drive)), 'ERR_AUTH_REVOKED');
    });
  });

  it('maps storageQuotaExceeded to ERR_QUOTA_EXCEEDED', async () => {
    await withFakeDrive({}, async (drive) => {
      drive.failNext({
        path: '/drive/v3/about',
        method: 'GET',
        status: 403,
        body: {
          error: {
            code: 403,
            message: 'The user\'s Drive storage quota has been exceeded',
            errors: [{ reason: 'storageQuotaExceeded' }],
          },
        },
      });
      const provider = createGoogleDriveProvider();
      await expectProviderCode(provider.getQuota(makeContext(drive)), 'ERR_QUOTA_EXCEEDED');
    });
  });

  it('maps 429 responses to ERR_RATE_LIMITED', async () => {
    await withFakeDrive({}, async (drive) => {
      drive.failNext({
        path: '/drive/v3/about',
        method: 'GET',
        status: 429,
        body: { error: { code: 429, message: 'Too many requests', errors: [{ reason: 'rateLimitExceeded' }] } },
      });
      const provider = createGoogleDriveProvider();
      await expectProviderCode(provider.getQuota(makeContext(drive)), 'ERR_RATE_LIMITED');
    });
  });

  it('maps 500 backendError responses to ERR_UPSTREAM_UNAVAILABLE', async () => {
    await withFakeDrive({}, async (drive) => {
      drive.failNext({
        path: '/drive/v3/about',
        method: 'GET',
        status: 500,
        body: { error: { code: 500, message: 'Backend Error', errors: [{ reason: 'backendError' }] } },
      });
      const provider = createGoogleDriveProvider();
      await expectProviderCode(provider.getQuota(makeContext(drive)), 'ERR_UPSTREAM_UNAVAILABLE');
    });
  });

  it('maps a missing file to ERR_NOT_FOUND', async () => {
    await withFakeDrive({}, async (drive) => {
      const provider = createGoogleDriveProvider();
      await expectProviderCode(
        provider.getMetadata(makeContext(drive), { remoteId: 'does-not-exist' }),
        'ERR_NOT_FOUND',
      );
    });
  });

  it('maps 401 responses without refresh material to ERR_AUTH_EXPIRED', async () => {
    await withFakeDrive({}, async (drive) => {
      const provider = createGoogleDriveProvider();
      const ctx = makeContext(drive, { accessToken: 'stale-token', refreshToken: '' });
      await expectProviderCode(provider.getQuota(ctx), 'ERR_AUTH_EXPIRED');
    });
  });

  it('maps an aborted request to ERR_TIMEOUT', async () => {
    await withFakeDrive({}, async (drive) => {
      drive.failNext({ path: '/drive/v3/about', method: 'GET', status: 200, hang: true });
      const controller = new AbortController();
      const ctx = makeContext(drive, { signal: controller.signal });
      const provider = createGoogleDriveProvider();
      const pending = provider.getQuota(ctx);
      setTimeout(() => controller.abort(), 30);
      await expectProviderCode(pending, 'ERR_TIMEOUT');
    });
  });
});

describe('google_drive token refresh', () => {
  it('refreshes on401 and retries the original request once', async () => {
    await withFakeDrive({}, async (drive) => {
      drive.seedFile({ id: 'root-9drive', name: '9drive', mimeType: 'application/vnd.google-apps.folder', parents: ['root'] });
      drive.seedFile({ id: 'child-1', name: 'note.txt', parents: [drive.rootId()] });
      const provider = createGoogleDriveProvider();
      const ctx = makeContext(drive, { accessToken: 'stale-token' });
      const result = await provider.list(ctx, { parentId: null });

      expect(result.entries.map((entry) => entry.remoteId)).toEqual(['child-1']);
      expect(drive.tokenRequests).toHaveLength(1);
      expect(drive.tokenRequests[0]).toMatchObject({
        grant_type: 'refresh_token',
        refresh_token: 'refresh-token-1',
        client_id: 'client-id-1',
        client_secret: 'client-secret-1',
      });
      const lists = drive.requests.filter((request) => request.path === '/drive/v3/files' && request.method === 'GET');
      expect(lists).toHaveLength(3);
      expect(lists[0].headers.authorization).toBe('Bearer stale-token');
      expect(lists[1].headers.authorization).toBe('Bearer refreshed-token-2');
      expect(lists[2].headers.authorization).toBe('Bearer refreshed-token-2');
    });
  });

  it('does not attempt a refresh when no refresh token is available', async () => {
    await withFakeDrive({}, async (drive) => {
      const provider = createGoogleDriveProvider();
      const ctx = makeContext(drive, { accessToken: 'stale-token', refreshToken: '' });
      await expectProviderCode(provider.getQuota(ctx), 'ERR_AUTH_EXPIRED');
      expect(drive.tokenRequests).toHaveLength(0);
    });
  });
});
