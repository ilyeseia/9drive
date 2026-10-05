/** S3 account probe, authentication and healthCheck states. */
import { describe, expect, it } from 'vitest';
import { createS3Provider } from '../../../providers/s3/index.js';
import { expectProviderCode, makeS3Context, unusedPort, withFakeS3 } from './helpers.js';

const provider = createS3Provider();

describe('s3 account probe', () => {
  it('authenticates against the bucket and returns the stored descriptor', async () => {
    await withFakeS3({}, async (server) => {
      const ctx = makeS3Context(server);
      expect(await provider.authenticate(ctx)).toEqual({ ok: true });

      const info = await provider.getAccountInfo(ctx);
      expect(info).toEqual({
        providerAccountId: 's3-account-001',
        email: null,
        displayName: 'S3 Tester',
        avatarUrl: null,
      });
      expect(server.count('HeadBucket')).toBe(2);
    });
  });

  it('fails authentication when the bucket does not exist', async () => {
    await withFakeS3({}, async (server) => {
      const ctx = makeS3Context(server, { config: { bucket: 'missing-bucket' } });
      await expectProviderCode(provider.authenticate(ctx), 'ERR_NOT_FOUND');
    });
  });
});

describe('s3 healthCheck', () => {
  it('reports healthy on a reachable bucket', async () => {
    await withFakeS3({}, async (server) => {
      const health = await provider.healthCheck(makeS3Context(server));
      expect(health.state).toBe('healthy');
      expect(health.message).toBeNull();
      expect(health.latencyMs).toBeGreaterThanOrEqual(0);
      expect(Number.isNaN(Date.parse(health.checkedAt))).toBe(false);
    });
  });

  it('reports degraded on a missing bucket', async () => {
    await withFakeS3({}, async (server) => {
      server.failNext({ operation: 'HeadBucket', status: 404, code: 'NoSuchBucket' });
      const health = await provider.healthCheck(makeS3Context(server));
      expect(health.state).toBe('degraded');
      expect(health.message).toContain('was not found');
    });
  });

  it('reports unauthorized on a denied bucket', async () => {
    await withFakeS3({}, async (server) => {
      server.failNext({ operation: 'HeadBucket', status: 403, code: 'AccessDenied' });
      const health = await provider.healthCheck(makeS3Context(server));
      expect(health.state).toBe('unauthorized');
      expect(health.message).toContain('denied');
    });
  });

  it('reports unreachable when the endpoint refuses connections', async () => {
    await withFakeS3({}, async () => {
      const port = await unusedPort();
      const health = await provider.healthCheck(makeS3Context({ baseUrl: `http://127.0.0.1:${port}` }));
      expect(health.state).toBe('unreachable');
      expect(health.message).toBeTruthy();
    });
  });

  it('reports degraded when the endpoint is blocked by the SSRF gate', async () => {
    await withFakeS3({}, async (server) => {
      const ctx = makeS3Context(server, { config: { endpoint: 'https://localhost:443' } });
      const health = await provider.healthCheck(ctx);
      expect(health.state).toBe('degraded');
      expect(health.message).toContain('not allowed');
    });
  });
});
