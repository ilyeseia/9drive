import { describe, expect, it } from 'vitest';
import { createS3Provider } from '../../../providers/s3/index.js';
import {
  bufferStream,
  expectProviderCode,
  makeS3Context,
  textStream,
  withFakeS3,
  type FakeS3,
  type S3ContextOverrides,
} from './helpers.js';

const provider = createS3Provider();

const KEY_PATTERN = /^9drive\/user-1\/f[0-9a-f]{24}\/[^/]+$/;

function uploadInput(
  fileName: string,
  content: string | Buffer,
  overrides: Record<string, unknown> = {},
): {
  stream: NodeJS.ReadableStream;
  fileName: string;
  mimeType: string;
  sizeBytes: bigint;
  parentId: string | null;
} {
  const body = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  return {
    stream: typeof content === 'string' ? textStream(content) : bufferStream(content),
    fileName,
    mimeType: 'application/octet-stream',
    sizeBytes: BigInt(body.byteLength),
    parentId: null,
    ...overrides,
  };
}

describe('s3 streaming upload', () => {
  it('stores a single PutObject under prefix/userId/fileId/fileName', async () => {
    await withFakeS3({}, async (server) => {
      const ctx = makeS3Context(server);
      const result = await provider.upload(ctx, uploadInput('report.txt', 'hello world'));

      expect(result.remoteId).toMatch(KEY_PATTERN);
      expect(result.remoteId.startsWith('9drive/user-1/')).toBe(true);
      expect(result.sizeBytes).toBe(11n);
      expect(result.resumeToken).toBeNull();

      expect(server.count('PutObject')).toBe(1);
      const request = server.requests.find((entry) => entry.operation === 'PutObject')!;
      expect(request.path).toBe(`/test-bucket/${result.remoteId}`);
      expect(request.body.toString('utf8')).toBe('hello world');
      expect(request.headers['content-type']).toBe('application/octet-stream');
      expect(request.headers['content-length']).toBe('11');
      expect(server.objectFor(result.remoteId)?.body.toString('utf8')).toBe('hello world');
    });
  });

  it('stores a zero-byte object from an empty stream', async () => {
    await withFakeS3({}, async (server) => {
      const ctx = makeS3Context(server);
      const result = await provider.upload(ctx, uploadInput('empty.bin', Buffer.alloc(0)));

      expect(result.sizeBytes).toBe(0n);
      expect(result.remoteId).toMatch(KEY_PATTERN);
      expect(server.objectFor(result.remoteId)?.body.byteLength).toBe(0);
      expect(server.count('PutObject')).toBe(1);
    });
  });

  it('rejects an empty upload that still delivers bytes', async () => {
    await withFakeS3({}, async (server) => {
      const ctx = makeS3Context(server);
      await expectProviderCode(
        provider.upload(ctx, uploadInput('empty.bin', 'not empty', { sizeBytes: 0n })),
        'ERR_INVALID_INPUT',
      );
      expect(server.count('PutObject')).toBe(0);
    });
  });

  it('rejects a stream shorter than the declared size', async () => {
    await withFakeS3({}, async (server) => {
      const ctx = makeS3Context(server);
      await expectProviderCode(
        provider.upload(ctx, uploadInput('short.txt', 'abc', { sizeBytes: 10n })),
        'ERR_INVALID_INPUT',
      );
    });
  });

  it('rejects a stream longer than the declared size', async () => {
    await withFakeS3({}, async (server) => {
      const ctx = makeS3Context(server);
      await expectProviderCode(
        provider.upload(ctx, uploadInput('long.txt', 'abcdef', { sizeBytes: 3n })),
        'ERR_INVALID_INPUT',
      );
    });
  });

  it('validates the upload input before touching the endpoint', async () => {
    await withFakeS3({}, async (server) => {
      const ctx = makeS3Context(server);
      await expectProviderCode(provider.upload(ctx, uploadInput('  ', 'abc')), 'ERR_INVALID_INPUT');
      await expectProviderCode(
        provider.upload(ctx, uploadInput('x.txt', 'abc', { sizeBytes: 1 as unknown as bigint })),
        'ERR_INVALID_INPUT',
      );
      await expectProviderCode(
        provider.upload(ctx, uploadInput('x.txt', 'abc', { sizeBytes: -1n })),
        'ERR_INVALID_INPUT',
      );
      await expectProviderCode(
        provider.upload(ctx, { ...uploadInput('x.txt', 'abc'), stream: undefined as unknown as NodeJS.ReadableStream }),
        'ERR_INVALID_INPUT',
      );
      await expectProviderCode(
        provider.upload(ctx, uploadInput('x.txt', 'abc', { sizeBytes: BigInt(Number.MAX_SAFE_INTEGER) + 1n })),
        'ERR_INVALID_INPUT',
      );
      expect(server.requests).toHaveLength(0);
    });
  });

  it('uploads into a created folder key', async () => {
    await withFakeS3({}, async (server) => {
      const ctx = makeS3Context(server);
      const folder = await provider.createFolder(ctx, { name: 'docs', parentId: null });
      const result = await provider.upload(ctx, uploadInput('notes.txt', 'inside', { parentId: folder.remoteId }));

      expect(result.remoteId.startsWith(`${folder.remoteId}f`)).toBe(true);
      expect(result.remoteId.split('/').length).toBe(6);
      expect(server.objectFor(result.remoteId)?.body.toString('utf8')).toBe('inside');
    });
  });

  it('refuses a parent outside the account namespace', async () => {
    await withFakeS3({}, async (server) => {
      const ctx = makeS3Context(server, { userId: 'user-2' });
      await expectProviderCode(
        provider.upload(ctx, uploadInput('x.txt', 'abc', { parentId: '9drive/user-1/dddd/' })),
        'ERR_NOT_FOUND',
      );
      expect(server.requests).toHaveLength(0);
    });
  });

  it('sanitises file names that contain path separators', async () => {
    await withFakeS3({}, async (server) => {
      const ctx = makeS3Context(server);
      const result = await provider.upload(ctx, uploadInput('../../etc/passwd', 'abc'));
      expect(result.remoteId).toMatch(KEY_PATTERN);
      expect(result.remoteId.endsWith('/..-..-etc-passwd')).toBe(true);
      expect(server.objectFor(result.remoteId)?.body.byteLength).toBe(3);
    });
  });
});

describe('s3 multipart upload', () => {
  const multipartConfig: S3ContextOverrides = {
    config: { multipartThresholdBytes: 1, multipartPartBytes: 1024 },
  };

  it('splits a body into ordered parts and completes the upload', async () => {
    await withFakeS3({}, async (server) => {
      const ctx = makeS3Context(server, multipartConfig);
      const content = 'abcdefghij'.repeat(300);
      const result = await provider.upload(ctx, uploadInput('big.bin', content));

      expect(result.sizeBytes).toBe(3000n);
      expect(result.remoteId).toMatch(KEY_PATTERN);
      expect(server.count('CreateMultipartUpload')).toBe(1);
      expect(server.count('UploadPart')).toBe(3);
      expect(server.count('CompleteMultipartUpload')).toBe(1);
      expect(server.count('PutObject')).toBe(0);
      expect(server.objectFor(result.remoteId)?.body.toString('utf8')).toBe(content);

      const complete = server.requests.find((entry) => entry.operation === 'CompleteMultipartUpload')!;
      expect([...complete.query.getAll('uploadId')]).toHaveLength(1);
    });
  });

  it('rejects a short stream mid-upload with ERR_INVALID_INPUT', async () => {
    await withFakeS3({}, async (server) => {
      const ctx = makeS3Context(server, multipartConfig);
      await expectProviderCode(
        provider.upload(ctx, uploadInput('big.bin', 'short', { sizeBytes: 3000n })),
        'ERR_INVALID_INPUT',
      );
      expect(server.count('CreateMultipartUpload')).toBe(1);
      expect(server.count('CompleteMultipartUpload')).toBe(0);
    });
  });

  it('carries a resume token on a retryable part failure and resumes without re-uploading', async () => {
    await withFakeS3({}, async (server) => {
      const ctx = makeS3Context(server, multipartConfig);
      const content = 'resume-me-'.repeat(300);

      server.failNext({ operation: 'CompleteMultipartUpload', status: 500, code: 'InternalError', times: 3 });
      const failure = await provider.upload(ctx, uploadInput('resume.bin', content)).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeTruthy();
      const error = failure as { code?: string; retryable?: boolean; detail?: Record<string, unknown> };
      expect(error.code).toBe('ERR_UPSTREAM_UNAVAILABLE');
      expect(error.retryable).toBe(true);
      const resumeToken = error.detail?.resumeToken;
      expect(typeof resumeToken).toBe('string');
      expect(server.count('UploadPart')).toBe(3);

      const resumed = await provider.upload(
        ctx,
        uploadInput('resume.bin', content, { resumeToken: resumeToken as string }),
      );
      expect(resumed.remoteId).toMatch(KEY_PATTERN);
      expect(server.count('CreateMultipartUpload')).toBe(1);
      expect(server.count('ListParts')).toBe(1);
      expect(server.count('UploadPart')).toBe(3);
      // 3 failed attempts inside the first send + the successful resume.
      expect(server.count('CompleteMultipartUpload')).toBe(4);
      expect(server.objectFor(resumed.remoteId)?.body.toString('utf8')).toBe(content);
    });
  });

  it('never attaches a resume token to a non-retryable failure', async () => {
    await withFakeS3({}, async (server) => {
      const ctx = makeS3Context(server, multipartConfig);
      server.failNext({ operation: 'CreateMultipartUpload', status: 403, code: 'AccessDenied' });
      const error = await provider.upload(ctx, uploadInput('denied.bin', 'abcdef')).then(
        () => null,
        (err: unknown) => err as { code?: string; detail?: unknown },
      );
      expect(error?.code).toBe('ERR_AUTH_REVOKED');
      const detail = error?.detail as Record<string, unknown> | undefined;
      expect(detail?.resumeToken).toBeUndefined();
    });
  });

  it('rejects a resume token that does not match the upload', async () => {
    await withFakeS3({}, async (server) => {
      const ctx = makeS3Context(server, multipartConfig);
      const token = JSON.stringify({ v: 1, key: '9drive/user-1/f00000000000000000000000/a.bin', uploadId: 'upload-1', partSize: 1024, size: '1234' });
      await expectProviderCode(
        provider.upload(ctx, uploadInput('other.bin', 'abcdefghij'.repeat(300), { resumeToken: token })),
        'ERR_INVALID_INPUT',
      );
      await expectProviderCode(
        provider.upload(ctx, uploadInput('other.bin', 'abc', { resumeToken: 'not-json' })),
        'ERR_INVALID_INPUT',
      );
      await expectProviderCode(
        provider.upload(ctx, uploadInput('other.bin', 'abc', { resumeToken: 'null' })),
        'ERR_INVALID_INPUT',
      );
      expect(server.requests).toHaveLength(0);
    });
  });

  it('requires uploadResumable for a resume token', async () => {
    const limited = createS3Provider({ capabilities: ['upload'] });
    await withFakeS3({}, async (server) => {
      const ctx = makeS3Context(server, multipartConfig);
      await expectProviderCode(
        limited.upload(ctx, uploadInput('x.bin', 'abc', { resumeToken: 'irrelevant' })),
        'ERR_CAPABILITY_UNSUPPORTED',
      );
      expect(server.requests).toHaveLength(0);
    });
  });
});
