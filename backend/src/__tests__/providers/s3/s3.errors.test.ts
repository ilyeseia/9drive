/**
 * S3 error taxonomy — security-contract.md §5 / provider-contract.md §5.
 * Unit coverage of `mapS3Error` plus live scripted failures against the fake
 * server, including SDK retry behaviour and connection refusal.
 */
import { describe, expect, it } from 'vitest';
import { ProviderError } from '../../../providers/errors.js';
import { mapS3Error } from '../../../providers/s3/errors.js';
import { createS3Provider } from '../../../providers/s3/index.js';
import {
  TEST_SECRET_ACCESS_KEY,
  makeS3Context,
  textStream,
  unusedPort,
  withFakeS3,
} from './helpers.js';

const provider = createS3Provider();
const ROOT = '9drive/user-1';

async function capture(promise: Promise<unknown>): Promise<ProviderError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(ProviderError.is(caught), `expected a ProviderError, received: ${String(caught)}`).toBe(true);
  return caught as ProviderError;
}

describe('mapS3Error', () => {
  it('passes ProviderError instances through untouched', () => {
    const original = new ProviderError('ERR_INVALID_INPUT', 'bad input');
    expect(mapS3Error(original, 'list')).toBe(original);

    const cause = new ProviderError('ERR_SSRF_BLOCKED', 'blocked');
    expect(mapS3Error({ name: 'Error', cause }, 'list')).toBe(cause);
  });

  it('maps SDK-shaped failures onto the contract taxonomy', () => {
    const cases: Array<[unknown, string, boolean | undefined]> = [
      [{ name: 'TimeoutError' }, 'ERR_TIMEOUT', true],
      [{ name: 'SlowDown', $metadata: { httpStatusCode: 429 } }, 'ERR_RATE_LIMITED', true],
      [{ name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } }, 'ERR_NOT_FOUND', false],
      [{ name: 'NoSuchBucket', $metadata: { httpStatusCode: 404 } }, 'ERR_NOT_FOUND', false],
      [{ name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }, 'ERR_AUTH_REVOKED', false],
      [{ name: 'InvalidRange', $metadata: { httpStatusCode: 416 } }, 'ERR_INVALID_INPUT', false],
      [{ $metadata: { httpStatusCode: 401 } }, 'ERR_AUTH_EXPIRED', false],
      [{ $metadata: { httpStatusCode: 507 } }, 'ERR_QUOTA_EXCEEDED', false],
      [{ $metadata: { httpStatusCode: 500 } }, 'ERR_UPSTREAM_UNAVAILABLE', true],
      [{ code: 'ECONNREFUSED' }, 'ERR_UPSTREAM_UNAVAILABLE', true],
      [{ code: 'ENOTFOUND' }, 'ERR_UPSTREAM_UNAVAILABLE', true],
      [new TypeError('fetch failed'), 'ERR_UPSTREAM_UNAVAILABLE', true],
      [new Error('boom'), 'ERR_INTERNAL', false],
    ];

    for (const [source, code, retryable] of cases) {
      const mapped = mapS3Error(source, 'list');
      expect(mapped.code, `${JSON.stringify(source)} -> ${code}`).toBe(code);
      expect(mapped.message.startsWith('list ')).toBe(true);
      expect(mapped.message).not.toMatch(/https?:/);
      if (retryable !== undefined) expect(mapped.retryable).toBe(retryable);
    }
  });

  it('keeps raw upstream detail bounded to codes and status', () => {
    const mapped = mapS3Error({ name: 'SlowDown', $metadata: { httpStatusCode: 429 } }, 'upload');
    expect(mapped.detail).toEqual({ codes: ['SlowDown'], status: 429 });
    expect(mapped.upstreamStatus).toBe(429);
  });
});

describe('s3 scripted failures (live)', () => {
  it('maps throttling and outage responses after the SDK retry budget', async () => {
    await withFakeS3({}, async (server) => {
      const ctx = makeS3Context(server);

      server.failNext({ operation: 'ListObjectsV2', status: 429, code: 'SlowDown', times: 3 });
      const throttled = await capture(provider.list(ctx, { parentId: null }));
      expect(throttled.code).toBe('ERR_RATE_LIMITED');
      expect(throttled.retryable).toBe(true);
      expect(throttled.upstreamStatus).toBe(429);
      expect(server.count('ListObjectsV2')).toBe(3);
      server.clear();

      server.failNext({ operation: 'ListObjectsV2', status: 500, code: 'InternalError', times: 3 });
      const outage = await capture(provider.list(ctx, { parentId: null }));
      expect(outage.code).toBe('ERR_UPSTREAM_UNAVAILABLE');
      expect(outage.retryable).toBe(true);
      expect(server.count('ListObjectsV2')).toBe(3);
      server.clear();
    });
  });

  it('maps quota, auth and range failures without retrying', async () => {
    await withFakeS3({}, async (server) => {
      const ctx = makeS3Context(server);

      server.failNext({ operation: 'PutObject', status: 507, code: 'QuotaExceeded', times: 3 });
      const quota = await capture(
        provider.upload(ctx, {
          stream: textStream('payload'),
          fileName: 'big.bin',
          mimeType: 'application/octet-stream',
          sizeBytes: 7n,
          parentId: null,
        }),
      );
      expect(quota.code).toBe('ERR_QUOTA_EXCEEDED');
      expect(quota.retryable).toBe(false);
      server.clear();

      server.seed(`${ROOT}/fA/report.pdf`, 'PDFDATA', 'application/pdf');
      server.failNext({ operation: 'GetObject', status: 401, code: 'ExpiredToken' });
      const expired = await capture(provider.download(ctx, { remoteId: `${ROOT}/fA/report.pdf` }));
      expect(expired.code).toBe('ERR_AUTH_EXPIRED');
      expect(expired.retryable).toBe(false);
      expect(expired.upstreamStatus).toBe(401);
      expect(expired.message).not.toContain(TEST_SECRET_ACCESS_KEY);
      expect(String((expired.detail as { codes?: string[] }).codes)).not.toContain(TEST_SECRET_ACCESS_KEY);
      server.clear();

      server.failNext({ operation: 'GetObject', status: 403, code: 'AccessDenied' });
      const denied = await capture(provider.download(ctx, { remoteId: `${ROOT}/fA/report.pdf` }));
      expect(denied.code).toBe('ERR_AUTH_REVOKED');
      expect(denied.retryable).toBe(false);
      server.clear();
    });
  });

  it('maps per-key DeleteObjects errors from a 200 response', async () => {
    await withFakeS3({}, async (server) => {
      const ctx = makeS3Context(server);
      const folder = `${ROOT}/d1/docs/`;
      server.seed(folder, '', 'application/x-directory');
      server.failNext({
        operation: 'DeleteObjects',
        status: 200,
        bodyXml:
          '<DeleteResult><Error><Key>x</Key><Code>AccessDenied</Code><Message>denied</Message></Error></DeleteResult>',
      });

      const error = await capture(provider.delete(ctx, { remoteId: folder }));
      expect(error.code).toBe('ERR_AUTH_REVOKED');
      expect(error.retryable).toBe(false);
    });
  });

  it('maps connection refusal to an upstream availability error', async () => {
    await withFakeS3({}, async () => {
      const port = await unusedPort();
      const ctx = makeS3Context({ baseUrl: `http://127.0.0.1:${port}` });
      const error = await capture(provider.authenticate(ctx));
      expect(error.code).toBe('ERR_UPSTREAM_UNAVAILABLE');
      expect(error.retryable).toBe(true);
      expect(error.message).toContain('authenticate');
    });
  });
});
