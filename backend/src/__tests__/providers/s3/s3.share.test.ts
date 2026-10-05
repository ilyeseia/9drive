/**
 * S3 shares are presigned GET URLs (provider-contract.md §4): signature verified
 * independently, lifetime clamped to SigV4's 7 days, no credential material in
 * the URL.
 */
import { describe, expect, it } from 'vitest';
import { resolveSettings } from '../../../providers/s3/client.js';
import { createS3Provider } from '../../../providers/s3/index.js';
import { DEFAULT_PRESIGN_SECONDS, MAX_PRESIGN_SECONDS, objectTarget, resolveShareExpiresIn } from '../../../providers/s3/presign.js';
import type { ProviderContext, ProviderCredentials } from '../../../providers/types.js';
import {
  TEST_ACCESS_KEY_ID,
  TEST_REGION,
  TEST_SECRET_ACCESS_KEY,
  expectProviderCode,
  makeS3Context,
  verifyPresignedUrl,
  withFakeS3,
} from './helpers.js';

const provider = createS3Provider();
const FILE_KEY = '9drive/user-1/fA/report.pdf';

function rawContext(config: Record<string, unknown> = {}): ProviderContext {
  const credentials: ProviderCredentials = Object.assign(
    { kind: 'access_key' as const, accessKeyId: TEST_ACCESS_KEY_ID, secretAccessKey: TEST_SECRET_ACCESS_KEY },
    {},
  );
  return {
    credentials,
    account: { id: 'acc-1', userId: 'user-1', provider: 's3', providerAccountId: 'test-bucket:us-east-1', config: { bucket: 'test-bucket', ...config } },
    logger: () => {},
  };
}

function signature(): { accessKeyId: string; secretAccessKey: string; region: string } {
  return { accessKeyId: TEST_ACCESS_KEY_ID, secretAccessKey: TEST_SECRET_ACCESS_KEY, region: TEST_REGION };
}

describe('s3 presigned share URLs', () => {
  it('creates a verifiable public GET URL for one hour', async () => {
    await withFakeS3({}, async (server) => {
      server.seed(FILE_KEY, 'PDFDATA', 'application/pdf');
      const ctx = makeS3Context(server);
      const share = await provider.createShare(ctx, { remoteId: FILE_KEY, visibility: 'public_read' });

      expect(share.visibility).toBe('public_read');
      expect(share.expiresAt).toBeTruthy();

      const url = new URL(share.url);
      expect(url.protocol).toBe('http:');
      expect(url.hostname).toBe('127.0.0.1');
      expect(url.pathname).toBe(`/test-bucket/${FILE_KEY}`);
      expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
      expect(url.searchParams.get('X-Amz-Expires')).toBe(String(DEFAULT_PRESIGN_SECONDS));
      expect(url.searchParams.get('X-Amz-Credential')).toContain(`/${TEST_REGION}/s3/aws4_request`);
      expect(share.url).not.toContain(TEST_SECRET_ACCESS_KEY);

      expect(verifyPresignedUrl(share.url, signature())).toEqual({ valid: true });
    });
  });

  it('signs object keys that need URI escaping', async () => {
    await withFakeS3({}, async (server) => {
      const key = '9drive/user-1/fB/my report (final).txt';
      server.seed(key, 'spacey', 'text/plain');
      const ctx = makeS3Context(server);
      const share = await provider.createShare(ctx, { remoteId: key, visibility: 'public_read' });

      expect(new URL(share.url).pathname).toBe('/test-bucket/9drive/user-1/fB/my%20report%20%28final%29.txt');
      expect(verifyPresignedUrl(share.url, signature())).toEqual({ valid: true });
    });
  });

  it('honours and clamps the requested expiry', async () => {
    await withFakeS3({}, async (server) => {
      server.seed(FILE_KEY, 'PDFDATA', 'application/pdf');
      const ctx = makeS3Context(server);

      const soon = await provider.createShare(ctx, {
        remoteId: FILE_KEY,
        visibility: 'public_read',
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      });
      expect(new URL(soon.url).searchParams.get('X-Amz-Expires')).toBe('1800');

      const far = await provider.createShare(ctx, {
        remoteId: FILE_KEY,
        visibility: 'public_read',
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      });
      expect(new URL(far.url).searchParams.get('X-Amz-Expires')).toBe(String(MAX_PRESIGN_SECONDS));
      expect(verifyPresignedUrl(far.url, signature())).toEqual({ valid: true });
    });
  });

  it('rejects unusable share requests', async () => {
    await withFakeS3({}, async (server) => {
      server.seed(FILE_KEY, 'PDFDATA', 'application/pdf');
      const ctx = makeS3Context(server);

      await expectProviderCode(provider.createShare(ctx, { remoteId: FILE_KEY, visibility: 'private' }), 'ERR_INVALID_INPUT');
      await expectProviderCode(
        provider.createShare(ctx, { remoteId: FILE_KEY, visibility: 'public_read', expiresAt: 'never' }),
        'ERR_INVALID_INPUT',
      );
      await expectProviderCode(
        provider.createShare(ctx, { remoteId: FILE_KEY, visibility: 'public_read', expiresAt: '2020-01-01T00:00:00.000Z' }),
        'ERR_INVALID_INPUT',
      );
      await expectProviderCode(
        provider.createShare(ctx, { remoteId: '9drive/user-1/d1/docs/', visibility: 'public_read' }),
        'ERR_INVALID_INPUT',
      );
      await expectProviderCode(provider.createShare(ctx, { remoteId: '9drive/user-1/fZ/gone.pdf', visibility: 'public_read' }), 'ERR_NOT_FOUND');
      await expectProviderCode(
        provider.createShare(ctx, { remoteId: '9drive/user-2/fX/other.txt', visibility: 'public_read' }),
        'ERR_NOT_FOUND',
      );
      expect(server.count('HeadObject')).toBe(3);
    });
  });
});

describe('s3 presign addressing and lifetimes', () => {
  it('matches the client addressing style for AWS, virtual-host and path-style endpoints', () => {
    const aws = objectTarget(resolveSettings(rawContext()), FILE_KEY);
    expect(aws).toEqual({
      protocol: 'https:',
      hostname: 'test-bucket.s3.us-east-1.amazonaws.com',
      port: null,
      path: '/9drive/user-1/fA/report.pdf',
    });

    const virtualHost = objectTarget(
      resolveSettings(rawContext({ endpoint: 'https://s3.example.com', forcePathStyle: false })),
      FILE_KEY,
    );
    expect(virtualHost.hostname).toBe('test-bucket.s3.example.com');
    expect(virtualHost.path).toBe('/9drive/user-1/fA/report.pdf');

    const pathStyle = objectTarget(resolveSettings(rawContext({ endpoint: 'https://s3.example.com' })), FILE_KEY);
    expect(pathStyle.hostname).toBe('s3.example.com');
    expect(pathStyle.path).toBe('/test-bucket/9drive/user-1/fA/report.pdf');
  });

  it('escapes every key segment exactly once', () => {
    const target = objectTarget(resolveSettings(rawContext()), '9drive/user-1/fA/a b+c.txt');
    expect(target.path).toBe('/9drive/user-1/fA/a%20b%2Bc.txt');
  });

  it('defaults, clamps and validates share lifetimes', () => {
    const now = 1_700_000_000_000;
    expect(resolveShareExpiresIn(null, now)).toBe(DEFAULT_PRESIGN_SECONDS);
    expect(resolveShareExpiresIn('', now)).toBe(DEFAULT_PRESIGN_SECONDS);
    expect(resolveShareExpiresIn(new Date(now + 60_000).toISOString(), now)).toBe(60);
    expect(resolveShareExpiresIn(new Date(now + 100 * 24 * 60 * 60 * 1000).toISOString(), now)).toBe(MAX_PRESIGN_SECONDS);
    expect(() => resolveShareExpiresIn('tomorrow', now)).toThrowError(/not a valid timestamp/);
    expect(() => resolveShareExpiresIn(new Date(now - 1000).toISOString(), now)).toThrowError(/future/);
  });
});
