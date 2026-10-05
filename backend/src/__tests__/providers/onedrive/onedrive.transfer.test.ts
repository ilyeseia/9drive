import { describe, expect, it } from 'vitest';
import { createOnedriveProvider, encodeOnedriveResumeToken } from '../../../providers/onedrive/index.js';
import {
  bufferStream,
  expectProviderCode,
  makeContext,
  readAll,
  textStream,
  withFakeOnedrive,
  type FakeOnedriveServer,
} from './server.js';

const SIXTY_FOUR_KIB = 64 * 1024;

async function seedFile(server: FakeOnedriveServer, content: string, name = 'doc.txt'): Promise<string> {
  return server.seedFile(name, null, content, 'text/plain');
}

describe('onedrive uploads', () => {
  it('uploads small files through the simple content endpoint', async () => {
    await withFakeOnedrive({}, async (server) => {
      const provider = createOnedriveProvider();
      const content = 'hello one drive';
      const result = await provider.upload(makeContext(), {
        stream: textStream(content),
        fileName: 'hello.txt',
        mimeType: 'text/plain',
        sizeBytes: BigInt(content.length),
        parentId: null,
      });

      expect(result.remoteId).toBeTruthy();
      expect(result.sizeBytes).toBe(BigInt(content.length));
      expect(result.resumeToken).toBeNull();
      expect(server.readFile(result.remoteId).toString('utf8')).toBe(content);
      expect(server.requests).toContain('/v1.0/me/drive/root/children/hello.txt/content');
      expect(server.sessionCalls()).toEqual({ create: 0, put: 0 });
    });
  });

  it('uploads into an explicit parent folder', async () => {
    await withFakeOnedrive({}, async (server) => {
      const docs = server.seedFolder('docs');
      const provider = createOnedriveProvider();
      const result = await provider.upload(makeContext(), {
        stream: textStream('nested'),
        fileName: 'nested.txt',
        mimeType: 'text/plain',
        sizeBytes: 6n,
        parentId: docs,
      });

      const meta = await provider.getMetadata(makeContext(), { remoteId: result.remoteId });
      expect(meta.parentId).toBe(docs);
      expect(server.readFile(result.remoteId).toString('utf8')).toBe('nested');
      expect(server.requests).toContain(`/v1.0/me/drive/items/${docs}/children/nested.txt/content`);
    });
  });

  it('overwrites an existing file at the same path', async () => {
    await withFakeOnedrive({}, async (server) => {
      const provider = createOnedriveProvider();
      const ctx = makeContext();
      const first = await provider.upload(ctx, {
        stream: textStream('version one'),
        fileName: 'dup.txt',
        mimeType: 'text/plain',
        sizeBytes: 11n,
        parentId: null,
      });
      const second = await provider.upload(ctx, {
        stream: textStream('version two!'),
        fileName: 'dup.txt',
        mimeType: 'text/plain',
        sizeBytes: 12n,
        parentId: null,
      });

      expect(second.remoteId).toBe(first.remoteId);
      expect(server.readFile(first.remoteId).toString('utf8')).toBe('version two!');
      expect(server.nodeCount()).toBe(1);
    });
  });

  it('rejects invalid upload input', async () => {
    await withFakeOnedrive({}, async (server) => {
      const provider = createOnedriveProvider();
      const ctx = makeContext();
      const base = {
        stream: textStream('x'),
        fileName: 'x.txt',
        mimeType: 'text/plain',
        sizeBytes: 1n,
        parentId: null,
      };

      await expectProviderCode(provider.upload(ctx, { ...base, fileName: '   ' }), 'ERR_INVALID_INPUT');
      await expectProviderCode(provider.upload(ctx, { ...base, fileName: 'nested/name.txt' }), 'ERR_INVALID_INPUT');
      await expectProviderCode(provider.upload(ctx, { ...base, stream: null as never }), 'ERR_INVALID_INPUT');
      await expectProviderCode(provider.upload(ctx, { ...base, sizeBytes: -1n }), 'ERR_INVALID_INPUT');
      await expectProviderCode(provider.upload(ctx, { ...base, sizeBytes: 5 as never }), 'ERR_INVALID_INPUT');
      await expectProviderCode(
        provider.upload(ctx, { ...base, sizeBytes: 9007199254740993n }),
        'ERR_INVALID_INPUT',
      );

      const apiKeyContext = { ...ctx, credentials: { kind: 'api_key' as const, apiKey: 'k' } };
      await expectProviderCode(provider.upload(apiKeyContext, base), 'ERR_INVALID_INPUT');
      expect(server.requests.filter((path) => path.endsWith('/content'))).toHaveLength(0);
    });
  });

  it('honours the upload capability gate', async () => {
    await withFakeOnedrive({}, async () => {
      const provider = createOnedriveProvider({ capabilities: ['list'] });
      await expectProviderCode(
        provider.upload(makeContext(), {
          stream: textStream('x'),
          fileName: 'x.txt',
          mimeType: 'text/plain',
          sizeBytes: 1n,
          parentId: null,
        }),
        'ERR_CAPABILITY_UNSUPPORTED',
      );
    });
  });

  it('switches to upload sessions above the simple-upload threshold', async () => {
    await withFakeOnedrive({}, async (server) => {
      const provider = createOnedriveProvider({ simpleUploadThresholdBytes: 4n });
      const content = 'abcdefghij';
      const result = await provider.upload(makeContext(), {
        stream: textStream(content),
        fileName: 'big.txt',
        mimeType: 'text/plain',
        sizeBytes: BigInt(content.length),
        parentId: null,
      });

      expect(server.sessionCalls()).toEqual({ create: 1, put: 1 });
      expect(server.readFile(result.remoteId).toString('utf8')).toBe(content);
      expect(server.requests).toContain('/v1.0/me/drive/root/children/big.txt/createUploadSession');
    });
  });

  it('uploads files larger than the chunk size in several chunks', async () => {
    await withFakeOnedrive({}, async (server) => {
      const provider = createOnedriveProvider({
        simpleUploadThresholdBytes: 1n,
        uploadChunkBytes: SIXTY_FOUR_KIB,
      });
      const size = 150_000;
      const content = Buffer.alloc(size, 0x5a);

      const result = await provider.upload(makeContext(), {
        stream: bufferStream(content),
        fileName: 'chunked.bin',
        mimeType: 'application/octet-stream',
        sizeBytes: BigInt(size),
        parentId: null,
      });

      expect(server.sessionCalls()).toEqual({ create: 1, put: 3 });
      const stored = server.readFile(result.remoteId);
      expect(stored.byteLength).toBe(size);
      expect(stored.equals(content)).toBe(true);
    });
  });

  it('resumes an interrupted session from a resume token', async () => {
    await withFakeOnedrive({}, async (server) => {
      const provider = createOnedriveProvider();
      const content = Buffer.from('0123456789abcdef', 'utf8');
      const alreadySent = 6;

      const started = await fetch(
        `${server.origin}/v1.0/me/drive/root/children/resume.bin/createUploadSession`,
        {
          method: 'POST',
          headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
          body: '{}',
        },
      );
      const session = (await started.json()) as { uploadUrl?: string };
      expect(session.uploadUrl).toBeTruthy();

      const put = await fetch(session.uploadUrl!, {
        method: 'PUT',
        headers: { 'Content-Range': `bytes 0-${alreadySent - 1}/${content.byteLength}` },
        body: content.subarray(0, alreadySent),
      });
      expect(put.status).toBe(202);

      const result = await provider.upload(makeContext(), {
        stream: bufferStream(content),
        fileName: 'resume.bin',
        mimeType: 'application/octet-stream',
        sizeBytes: BigInt(content.byteLength),
        parentId: null,
        resumeToken: encodeOnedriveResumeToken({ sessionUrl: session.uploadUrl!, offset: alreadySent }),
      });

      expect(server.readFile(result.remoteId).equals(content)).toBe(true);
      expect(server.sessionCalls()).toEqual({ create: 1, put: 2 });
    });
  });

  it('rejects malformed resume tokens before contacting OneDrive', async () => {
    await withFakeOnedrive({}, async (server) => {
      const provider = createOnedriveProvider();
      const ctx = makeContext();
      const before = server.requests.length;

      await expectProviderCode(
        provider.upload(ctx, {
          stream: textStream('x'),
          fileName: 'x.txt',
          mimeType: 'text/plain',
          sizeBytes: 1n,
          parentId: null,
          resumeToken: 'not-a-onedrive-token',
        }),
        'ERR_INVALID_INPUT',
      );
      await expectProviderCode(
        provider.upload(ctx, {
          stream: textStream('x'),
          fileName: 'x.txt',
          mimeType: 'text/plain',
          sizeBytes: 10n,
          parentId: null,
          resumeToken: encodeOnedriveResumeToken({ sessionUrl: `${server.origin}/upload-session/s1`, offset: 99 }),
        }),
        'ERR_INVALID_INPUT',
      );
      expect(server.requests.length).toBe(before);
    });
  });

  it('rejects a stream that is longer than the declared size', async () => {
    await withFakeOnedrive({}, async (server) => {
      const provider = createOnedriveProvider({ simpleUploadThresholdBytes: 1n });
      await expectProviderCode(
        provider.upload(makeContext(), {
          stream: textStream('far too long'),
          fileName: 'over.txt',
          mimeType: 'text/plain',
          sizeBytes: 5n,
          parentId: null,
        }),
        'ERR_INVALID_INPUT',
      );
      expect(server.sessionCalls()).toEqual({ create: 1, put: 0 });
      expect(server.nodeCount()).toBe(0);
    });
  });

  it('honours the uploadResumable gate', async () => {
    await withFakeOnedrive({}, async (server) => {
      const provider = createOnedriveProvider({ capabilities: ['upload'], simpleUploadThresholdBytes: 1n });
      const ctx = makeContext();

      await expectProviderCode(
        provider.upload(ctx, {
          stream: textStream('abcdefghij'),
          fileName: 'session.txt',
          mimeType: 'text/plain',
          sizeBytes: 10n,
          parentId: null,
        }),
        'ERR_CAPABILITY_UNSUPPORTED',
      );
      await expectProviderCode(
        provider.upload(ctx, {
          stream: textStream('x'),
          fileName: 'resume.txt',
          mimeType: 'text/plain',
          sizeBytes: 1n,
          parentId: null,
          resumeToken: encodeOnedriveResumeToken({ sessionUrl: `${server.origin}/upload-session/s1`, offset: 0 }),
        }),
        'ERR_CAPABILITY_UNSUPPORTED',
      );
      expect(server.sessionCalls()).toEqual({ create: 0, put: 0 });
      expect(server.requests.filter((path) => path.endsWith('/content'))).toHaveLength(0);
    });
  });

  it('maps upstream quota failures on upload', async () => {
    await withFakeOnedrive({}, async (server) => {
      server.failNext('children/quota.txt/content', {
        status: 409,
        code: 'insufficientStorage',
        message: 'the drive is full',
      });
      const provider = createOnedriveProvider();
      await expectProviderCode(
        provider.upload(makeContext(), {
          stream: textStream('payload'),
          fileName: 'quota.txt',
          mimeType: 'text/plain',
          sizeBytes: 7n,
          parentId: null,
        }),
        'ERR_QUOTA_EXCEEDED',
      );
    });
  });
});

describe('onedrive downloads', () => {
  it('streams file content with size and mime type', async () => {
    await withFakeOnedrive({}, async (server) => {
      const remoteId = await seedFile(server, 'hello world');
      const provider = createOnedriveProvider();

      const result = await provider.download(makeContext(), { remoteId });

      expect(result.mimeType).toBe('text/plain');
      expect(result.sizeBytes).toBe(11n);
      expect(result.range).toBeUndefined();
      expect((await readAll(result.stream)).toString('utf8')).toBe('hello world');
      expect(server.requests.some((path) => path.startsWith('/download/'))).toBe(true);
    });
  });

  it('serves a byte range with the range actually applied', async () => {
    await withFakeOnedrive({}, async (server) => {
      const remoteId = await seedFile(server, 'abcdefghijklmnopqrst');
      const provider = createOnedriveProvider();
      const ctx = makeContext();

      const ranged = await provider.download(ctx, { remoteId, range: { start: 0, end: 9 } });
      expect(ranged.sizeBytes).toBe(10n);
      expect(ranged.range).toEqual({ start: 0, end: 9, total: 20 });
      expect((await readAll(ranged.stream)).toString('utf8')).toBe('abcdefghij');

      const tail = await provider.download(ctx, { remoteId, range: { start: 15 } });
      expect(tail.range).toEqual({ start: 15, end: 19, total: 20 });
      expect((await readAll(tail.stream)).toString('utf8')).toBe('pqrst');
    });
  });

  it('reports the whole object when the link ignores the Range header', async () => {
    await withFakeOnedrive({}, async (server) => {
      const remoteId = await seedFile(server, 'abcdefghijklmnopqrst');
      server.ignoreRange(remoteId);
      const provider = createOnedriveProvider();

      const result = await provider.download(makeContext(), { remoteId, range: { start: 0, end: 4 } });

      expect(result.range).toEqual({ start: 0, end: 19, total: 20 });
      expect(result.sizeBytes).toBe(20n);
      expect((await readAll(result.stream)).toString('utf8')).toBe('abcdefghijklmnopqrst');
    });
  });

  it('follows a redirect on the content endpoint', async () => {
    await withFakeOnedrive({}, async (server) => {
      const remoteId = await seedFile(server, 'redirected content');
      server.overrideDownloadLink(remoteId, `${server.origin}/download/redirect/${remoteId}`);
      const provider = createOnedriveProvider();

      const result = await provider.download(makeContext(), { remoteId });
      expect((await readAll(result.stream)).toString('utf8')).toBe('redirected content');
    });
  });

  it('blocks content links that fail the SSRF gate', async () => {
    await withFakeOnedrive({}, async (server) => {
      const remoteId = await seedFile(server, 'secret');
      server.overrideDownloadLink(remoteId, 'http://169.254.169.254/latest/meta-data/');
      const provider = createOnedriveProvider();

      await expectProviderCode(provider.download(makeContext(), { remoteId }), 'ERR_SSRF_BLOCKED');
      expect(server.requests.some((path) => path.startsWith('/latest/'))).toBe(false);
    });
  });

  it('rejects an invalid range before contacting OneDrive', async () => {
    await withFakeOnedrive({}, async (server) => {
      const remoteId = await seedFile(server, 'abc');
      const provider = createOnedriveProvider();
      const ctx = makeContext();
      const before = server.requests.length;

      await expectProviderCode(provider.download(ctx, { remoteId, range: { start: -1 } }), 'ERR_INVALID_INPUT');
      await expectProviderCode(provider.download(ctx, { remoteId, range: { start: 5, end: 2 } }), 'ERR_INVALID_INPUT');
      expect(server.requests.length).toBe(before);
    });
  });

  it('rejects a range that starts beyond the object', async () => {
    await withFakeOnedrive({}, async (server) => {
      const remoteId = await seedFile(server, 'short');
      const provider = createOnedriveProvider();

      await expectProviderCode(
        provider.download(makeContext(), { remoteId, range: { start: 100 } }),
        'ERR_INVALID_INPUT',
      );
      expect(server.requests.some((path) => path.startsWith('/download/'))).toBe(false);
    });
  });

  it('refuses to download a folder', async () => {
    await withFakeOnedrive({}, async (server) => {
      const docs = server.seedFolder('docs');
      const provider = createOnedriveProvider();
      await expectProviderCode(provider.download(makeContext(), { remoteId: docs }), 'ERR_INVALID_INPUT');
      expect(server.requests.some((path) => path.startsWith('/download/'))).toBe(false);
    });
  });

  it('maps a missing remote id to ERR_NOT_FOUND', async () => {
    await withFakeOnedrive({}, async () => {
      const provider = createOnedriveProvider();
      await expectProviderCode(provider.download(makeContext(), { remoteId: 'item-missing' }), 'ERR_NOT_FOUND');
    });
  });

  it('honours the downloadRange gate', async () => {
    await withFakeOnedrive({}, async (server) => {
      const remoteId = await seedFile(server, 'ranged');
      const provider = createOnedriveProvider({ capabilities: ['download'] });

      await expectProviderCode(
        provider.download(makeContext(), { remoteId, range: { start: 0, end: 1 } }),
        'ERR_CAPABILITY_UNSUPPORTED',
      );

      const plain = await createOnedriveProvider({ capabilities: ['download'] }).download(makeContext(), {
        remoteId,
      });
      expect((await readAll(plain.stream)).toString('utf8')).toBe('ranged');
    });
  });

  it('honours the download capability gate', async () => {
    await withFakeOnedrive({}, async () => {
      const provider = createOnedriveProvider({ capabilities: ['list'] });
      await expectProviderCode(provider.download(makeContext(), { remoteId: 'x' }), 'ERR_CAPABILITY_UNSUPPORTED');
    });
  });
});
