import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { getCatalogEntry } from '../../../providers/catalog.js';
import { ProviderError } from '../../../providers/errors.js';
import { getOAuth2Client, hasOAuth2Client, refreshAccessToken } from '../../../providers/oauth2.js';
import { registry } from '../../../providers/registry.js';
import { ALL_CAPABILITIES } from '../../../providers/types.js';
import {
  pollDeviceToken,
  refreshTeraBoxTokens,
  signTeraBoxRequest,
  startDeviceAuthorization,
} from '../../../providers/terabox-open/auth.js';
import {
  TERABOX_OPEN_CAPABILITIES,
  TeraBoxOpenProvider,
  createTeraBoxOpenProvider,
  registerTeraBoxOpenProvider,
} from '../../../providers/terabox-open/index.js';
import {
  assertTeraBoxDownloadUrl,
  isTeraBoxHostname,
  resetTeraBoxOpenTransport,
  serviceBaseFromDomain,
} from '../../../providers/terabox-open/transport.js';
import { TEST_APP, expectProviderCode, makeContext, withFakeTeraBox } from './server.js';

describe('terabox_open registration', () => {
  it('is registered and catalogued as official OAuth with device-code connect', () => {
    registerTeraBoxOpenProvider();
    const provider = registry.get('terabox_open');
    expect(provider).toBeInstanceOf(TeraBoxOpenProvider);
    const entry = getCatalogEntry('terabox_open');
    expect(entry?.status).toBe('SUPPORTED');
    expect(entry?.authMode).toBe('oauth2');
    expect(entry?.connectMode).toBe('device_code');
    expect(entry?.quotaPolicy).toBe('required');
    expect(entry?.experimental).toBeUndefined();
  });

  it('keeps catalog and adapter capabilities identical and never declares undocumented operations', () => {
    const entry = getCatalogEntry('terabox_open')!;
    expect([...entry.capabilities].sort()).toEqual([...TERABOX_OPEN_CAPABILITIES].sort());
    for (const unsupported of ['createFolder', 'createShare', 'revokeShare', 'uploadResumable', 'downloadRange'] as const) {
      expect(createTeraBoxOpenProvider().capabilities.has(unsupported)).toBe(false);
    }
    expect(TERABOX_OPEN_CAPABILITIES.every((cap) => ALL_CAPABILITIES.includes(cap))).toBe(true);
  });

  it('marks the cookie adapter experimental and excluded from the official provider id', () => {
    const cookie = getCatalogEntry('terabox')!;
    expect(cookie.experimental).toBe(true);
    expect(cookie.authMode).toBe('api_key');
    expect(cookie.id).not.toBe('terabox_open');
  });

  it('registers an OAuth client with a custom refresh hook', () => {
    expect(hasOAuth2Client('terabox_open')).toBe(true);
    expect(typeof getOAuth2Client('terabox_open').refresh).toBe('function');
  });
});

describe('request signing', () => {
  it('signs md5(client_id_timestamp_client_secret_private_secret)', () => {
    const sign = signTeraBoxRequest({ clientId: 'a', clientSecret: 'b', privateSecret: 'c' }, 1705570481);
    expect(sign).toBe(createHash('md5').update('a_1705570481_b_c').digest('hex'));
  });
});

describe('device-code authorization', () => {
  afterEach(() => resetTeraBoxOpenTransport());

  it('starts, reports pending (errno 400001), then returns tokens once authorized', async () => {
    await withFakeTeraBox({}, async (server) => {
      const started = await startDeviceAuthorization(TEST_APP.clientId);
      expect(started.deviceCode).toBe('device-code-1');
      expect(started.qrCodeDataUrl.startsWith('data:image/png;base64,')).toBe(true);
      expect(started.intervalSeconds).toBe(2);

      const pending = await pollDeviceToken(TEST_APP, started.deviceCode);
      expect(pending).toEqual({ status: 'pending' });

      server.authorizeDevice();
      const done = await pollDeviceToken(TEST_APP, started.deviceCode);
      expect(done.status).toBe('authorized');
      if (done.status !== 'authorized') throw new Error('unreachable');
      expect(done.tokens.accessToken).toBe(server.tokens.access);
      expect(done.tokens.refreshToken).toBe(server.tokens.refresh);
      // 2-day lifetime from the official doc (172800 s).
      expect(done.tokens.expiresAt! - Date.now()).toBeGreaterThan(172_000_000);
    });
  });

  it('rejects a bad client id and a wrong signature with stable codes', async () => {
    await withFakeTeraBox({}, async () => {
      await expectProviderCode(startDeviceAuthorization('wrong'), 'ERR_INTERNAL');
      await expectProviderCode(pollDeviceToken({ ...TEST_APP, privateSecret: 'nope' }, 'device-code-1'), 'ERR_INTERNAL');
    });
  });

  it('refuses a QR payload that is not an inline PNG', async () => {
    await withFakeTeraBox({}, async (server) => {
      server.failNext('/oauth/devicecode', {
        body: { errno: 0, data: { device_code: 'x', expires_in: 300, interval: 2, qrcode_url: 'https://evil.example/qr.png' } },
      });
      await expectProviderCode(startDeviceAuthorization(TEST_APP.clientId), 'ERR_UPSTREAM_UNAVAILABLE');
    });
  });
});

describe('token refresh (single-use refresh tokens)', () => {
  it('rotates both tokens and signs the request', async () => {
    await withFakeTeraBox({}, async (server) => {
      const before = { ...server.tokens };
      const refreshed = await refreshTeraBoxTokens({
        clientId: TEST_APP.clientId,
        clientSecret: TEST_APP.clientSecret,
        refreshToken: before.refresh,
      });
      expect(refreshed.accessToken).not.toBe(before.access);
      expect(refreshed.refreshToken).not.toBe(before.refresh);
      expect(server.counts.refresh).toBe(1);
    });
  });

  it('shares one upstream call between concurrent refreshes of the same token', async () => {
    await withFakeTeraBox({}, async (server) => {
      const options = { clientId: TEST_APP.clientId, clientSecret: TEST_APP.clientSecret, refreshToken: server.tokens.refresh };
      const results = await Promise.all([refreshTeraBoxTokens(options), refreshTeraBoxTokens(options), refreshTeraBoxTokens(options)]);
      expect(server.counts.refresh).toBe(1);
      expect(new Set(results.map((r) => r.refreshToken)).size).toBe(1);
    });
  });

  it('maps a reused or expired refresh token to ERR_AUTH_REVOKED', async () => {
    await withFakeTeraBox({}, async (server) => {
      const stale = server.tokens.refresh;
      await refreshTeraBoxTokens({ clientId: TEST_APP.clientId, clientSecret: TEST_APP.clientSecret, refreshToken: stale });
      await expectProviderCode(
        refreshTeraBoxTokens({ clientId: TEST_APP.clientId, clientSecret: TEST_APP.clientSecret, refreshToken: stale }),
        'ERR_AUTH_REVOKED',
      );
    });
  });

  it('fails closed when TERABOX_PRIVATE_SECRET is missing', async () => {
    await withFakeTeraBox({}, async (server) => {
      delete process.env.TERABOX_PRIVATE_SECRET;
      await expectProviderCode(
        refreshTeraBoxTokens({ clientId: TEST_APP.clientId, clientSecret: TEST_APP.clientSecret, refreshToken: server.tokens.refresh }),
        'ERR_INTERNAL',
      );
      expect(server.counts.refresh).toBe(0);
    });
  });

  it('is reached through the shared refreshAccessToken() hook', async () => {
    await withFakeTeraBox({}, async (server) => {
      const result = await refreshAccessToken({
        provider: 'terabox_open',
        clientId: TEST_APP.clientId,
        clientSecret: TEST_APP.clientSecret,
        refreshToken: server.tokens.refresh,
      });
      expect(result.accessToken).toBe(server.tokens.access);
      expect(result.expiresAt).toBeGreaterThan(Date.now());
    });
  });
});

describe('upstream-supplied hosts are untrusted', () => {
  it('accepts only terabox.com hostnames for api_domain / upload_domain', () => {
    resetTeraBoxOpenTransport();
    expect(serviceBaseFromDomain('www.terabox.com', 'api_domain')).toBe('https://www.terabox.com');
    expect(serviceBaseFromDomain('c-jp.terabox.com', 'upload_domain')).toBe('https://c-jp.terabox.com');
    for (const bad of [
      'evil.com',
      'terabox.com.evil.com',
      'eviltabox.com',
      '127.0.0.1',
      'www.terabox.com:8080',
      'https://www.terabox.com',
      'www.terabox.com/path',
      'user@www.terabox.com',
      '',
    ]) {
      expect(() => serviceBaseFromDomain(bad, 'api_domain'), bad).toThrow(ProviderError);
    }
    expect(() => serviceBaseFromDomain(undefined, 'api_domain')).toThrow(ProviderError);
  });

  it('validates download links (https, terabox.com, no credentials)', () => {
    resetTeraBoxOpenTransport();
    expect(assertTeraBoxDownloadUrl('https://d.terabox.com/file/abc?x=1').hostname).toBe('d.terabox.com');
    for (const bad of [
      'http://d.terabox.com/file/abc',
      'https://evil.example.com/file/abc',
      'https://terabox.com.evil.com/file/abc',
      'https://user:pw@d.terabox.com/file/abc',
      'https://169.254.169.254/latest/meta-data',
      'not a url',
    ]) {
      expect(() => assertTeraBoxDownloadUrl(bad), bad).toThrow(ProviderError);
    }
    expect(isTeraBoxHostname('a.b.terabox.com')).toBe(true);
    expect(isTeraBoxHostname('xterabox.com')).toBe(false);
  });

  it('rejects a tokeninfo that points outside terabox.com', async () => {
    await withFakeTeraBox({ apiDomain: 'evil.example.com' }, async (server) => {
      // withFakeTeraBox runs with the permissive test transport; re-enable the production policy.
      const { setTeraBoxOpenTransport } = await import('../../../providers/terabox-open/transport.js');
      setTeraBoxOpenTransport({ authBase: server.origin, hostPolicy: 'terabox', scheme: 'https' });
      const provider = createTeraBoxOpenProvider();
      await expectProviderCode(provider.getQuota(makeContext(server)), 'ERR_SSRF_BLOCKED');
      expect(server.requests.some((r) => r.path === '/openapi/api/quota')).toBe(false);
    });
  });
});

describe('account, quota, health', () => {
  const provider = createTeraBoxOpenProvider();

  it('identifies the account by tokeninfo.user_id and reads the profile', async () => {
    await withFakeTeraBox({ userId: 424242 }, async (server) => {
      const info = await provider.getAccountInfo(makeContext(server));
      expect(info.providerAccountId).toBe('424242');
      expect(info.displayName).toBe('tester@example.com');
      expect(info.email).toBeNull();
    });
  });

  it('reports quota from total/used and never negative availability', async () => {
    await withFakeTeraBox({}, async (server) => {
      server.setQuota(1000, 250);
      const quota = await provider.getQuota(makeContext(server));
      expect(quota).toMatchObject({ totalBytes: 1000n, usedBytes: 250n, availableBytes: 750n, trashBytes: null });
      server.setQuota(1000, 2000);
      expect((await provider.getQuota(makeContext(server))).availableBytes).toBe(0n);
    });
  });

  it('treats an incomplete quota response as an error, not as unlimited', async () => {
    await withFakeTeraBox({}, async (server) => {
      server.failNext('/openapi/api/quota', { body: { errno: 0 } });
      await expectProviderCode(provider.getQuota(makeContext(server)), 'ERR_UPSTREAM_UNAVAILABLE');
    });
  });

  it('maps expired access tokens to ERR_AUTH_EXPIRED and health to unauthorized', async () => {
    await withFakeTeraBox({}, async (server) => {
      const ctx = makeContext(server);
      expect((await provider.healthCheck(ctx)).state).toBe('healthy');
      server.expireAccessToken();
      await expectProviderCode(provider.getQuota(ctx), 'ERR_AUTH_EXPIRED');
      expect((await provider.healthCheck(ctx)).state).toBe('unauthorized');
    });
  });

  it('requires OAuth credentials', async () => {
    await withFakeTeraBox({}, async (server) => {
      const ctx = { ...makeContext(server), credentials: { kind: 'api_key' as const, apiKey: 'cookie' } };
      await expectProviderCode(provider.getQuota(ctx), 'ERR_AUTH_EXPIRED');
    });
  });

  it('maps undocumented errnos to a retryable upstream error and keeps secrets out of detail', async () => {
    await withFakeTeraBox({}, async (server) => {
      server.failNext('/openapi/api/quota', { body: { errno: 31999, access_token: 'SECRET-TOKEN', dlink: 'https://x/y' } });
      const error = await expectProviderCode(provider.getQuota(makeContext(server)), 'ERR_UPSTREAM_UNAVAILABLE');
      expect(error.retryable).toBe(true);
      const serialized = JSON.stringify({ message: error.message, detail: error.detail });
      expect(serialized).not.toContain('SECRET-TOKEN');
      expect(serialized).not.toContain('https://x/y');
    });
  });

  it('never leaks the access token in error messages', async () => {
    await withFakeTeraBox({}, async (server) => {
      const token = server.tokens.access;
      server.failNext('/openapi/api/quota', { status: 502, body: {} });
      const error = await expectProviderCode(provider.getQuota(makeContext(server)), 'ERR_UPSTREAM_UNAVAILABLE');
      expect(JSON.stringify({ m: error.message, d: error.detail })).not.toContain(token);
    });
  });
});
