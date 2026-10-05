import { describe, expect, it } from 'vitest';
import { createDropboxProvider, encodeDropboxResumeToken } from '../../../providers/dropbox/index.js';
import {
  bufferStream,
  expectProviderCode,
  makeContext,
  readAll,
  textStream,
  withFakeDropbox,
  type FakeDropboxServer,
} from './server.js';

const FOUR_MIB = 4 * 1024 * 1024;

async function seedFile(server: FakeDropboxServer, content: string, name = 'doc.txt'): Promise<string> {
  return server.seedFile(name, null, content, 'text/plain');
}

describe('dropbox uploads', () => {
  it('uploads small files through the simple upload endpoint', async () => {
    await withFakeDropbox({}, async (server) => {
      const provider = createDropboxProvider();
      const content = 'hello dropbox';
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
      expect(server.requests).toContain('/2/files/upload');
      expect(server.sessionCalls()).toEqual({ start: 0, append: 0, finish: 0 });
    });
  });

  it('uploads into an explicit parent folder', async () => {
    await withFakeDropbox({}, async (server) => {
      const docs = server.seedFolder('docs');
      const provider = createDropboxProvider();
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
    });
  });

  it('overwrites an existing file at the same path', async () => {
    await withFakeDropbox({}, async (server) => {
      const provider = createDropboxProvider();
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
    await withFakeDropbox({}, async (server) => {
      const provider = createDropboxProvider();
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
      expect(server.requests.filter((path) => path === '/2/files/upload')).toHaveLength(0);
    });
  });

  it('honours the upload capability gate', async () => {
    await withFakeDropbox({}, async () => {
      const provider = createDropboxProvider({ capabilities: ['list'] });
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
    await withFakeDropbox({}, async (server) => {
      const provider = createDropboxProvider({ simpleUploadThresholdBytes: 4n });
      const content = 'abcdefghij';
      const result = await provider.upload(makeContext(), {
        stream: textStream(content),
        fileName: 'big.txt',
        mimeType: 'text/plain',
        sizeBytes: BigInt(content.length),
        parentId: null,
      });

      expect(server.sessionCalls()).toEqual({ start: 1, append: 0, finish: 1 });
      expect(server.readFile(result.remoteId).toString('utf8')).toBe(content);
      expect(server.requests).toContain('/2/upload_session/start');
      expect(server.requests).toContain('/2/upload_session/finish');
    });
  });

  it('uploads files larger than the chunk size in several chunks', async () => {
    await withFakeDropbox({}, async (server) => {
      const provider = createDropboxProvider({
        simpleUploadThresholdBytes: 1n,
        uploadChunkBytes: FOUR_MIB,
      });
      const size = FOUR_MIB * 2 + 100;
      const content = Buffer.alloc(size, 0x5a);

      const result = await provider.upload(makeContext(), {
        stream: bufferStream(content),
        fileName: 'chunked.bin',
        mimeType: 'application/octet-stream',
        sizeBytes: BigInt(size),
        parentId: null,
      });

      expect(server.sessionCalls()).toEqual({ start: 1, append: 1, finish: 1 });
      const stored = server.readFile(result.remoteId);
      expect(stored.byteLength).toBe(size);
      expect(stored.equals(content)).toBe(true);
    });
  });

  it('resumes an interrupted session from a resume token', async () => {
    await withFakeDropbox({}, async (server) => {
      const provider = createDropboxProvider();
      const content = Buffer.from('0123456789abcdef', 'utf8');
      const alreadySent = 6;

      const started = await fetch(`${server.origin}/2/upload_session/start`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
          'Dropbox-API-Arg': JSON.stringify({ close: false }),
        },
        body: content.subarray(0, alreadySent),
      });
      const session = (await started.json()) as { session_id?: string };
      expect(session.session_id).toBeTruthy();

      const result = await provider.upload(makeContext(), {
        stream: bufferStream(content),
        fileName: 'resume.bin',
        mimeType: 'application/octet-stream',
        sizeBytes: BigInt(content.byteLength),
        parentId: null,
        resumeToken: encodeDropboxResumeToken({ sessionId: session.session_id!, offset: alreadySent }),
      });

      expect(server.readFile(result.remoteId).equals(content)).toBe(true);
      expect(server.sessionCalls()).toEqual({ start: 1, append: 0, finish: 1 });
    });
  });

  it('rejects malformed resume tokens before contacting Dropbox', async () => {
    await withFakeDropbox({}, async (server) => {
      const provider = createDropboxProvider();
      const ctx = makeContext();
      const before = server.requests.length;

      await expectProviderCode(
        provider.upload(ctx, {
          stream: textStream('x'),
          fileName: 'x.txt',
          mimeType: 'text/plain',
          sizeBytes: 1n,
          parentId: null,
          resumeToken: 'not-a-dropbox-token',
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
          resumeToken: encodeDropboxResumeToken({ sessionId: 'sess-1', offset: 99 }),
        }),
        'ERR_INVALID_INPUT',
      );
      expect(server.requests.length).toBe(before);
    });
  });

  it('rejects a stream that is longer than the declared size', async () => {
    await withFakeDropbox({}, async (server) => {
      const provider = createDropboxProvider({ simpleUploadThresholdBytes: 1n });
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
      expect(server.sessionCalls()).toEqual({ start: 0, append: 0, finish: 0 });
      expect(server.nodeCount()).toBe(0);
    });
  });

  it('honours the uploadResumable gate', async () => {
    await withFakeDropbox({}, async (server) => {
      const provider = createDropboxProvider({ capabilities: ['upload'], simpleUploadThresholdBytes: 1n });
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
          resumeToken: encodeDropboxResumeToken({ sessionId: 'sess-1', offset: 0 }),
        }),
        'ERR_CAPABILITY_UNSUPPORTED',
      );
      expect(server.sessionCalls()).toEqual({ start: 0, append: 0, finish: 0 });
      expect(server.requests.filter((path) => path === '/2/files/upload')).toHaveLength(0);
    });
  });

  it('maps upstream quota failures on upload', async () => {
    await withFakeDropbox({}, async (server) => {
      server.failNext('/2/files/upload', { status: 409, summary: 'insufficient_space/.' });
      const provider = createDropboxProvider();
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

describe('dropbox downloads', () => {
  it('streams file content with size and mime type', async () => {
    await withFakeDropbox({}, async (server) => {
      const remoteId = await seedFile(server, 'hello world');
      const provider = createDropboxProvider();

      const result = await provider.download(makeContext(), { remoteId });

      expect(result.mimeType).toBe('text/plain');
      expect(result.sizeBytes).toBe(11n);
      expect(result.range).toBeUndefined();
      expect((await readAll(result.stream)).toString('utf8')).toBe('hello world');
      expect(server.requests.some((path) => path.startsWith('/download/'))).toBe(true);
    });
  });

  it('serves a byte range with the range actually applied', async () => {
    await withFakeDropbox({}, async (server) => {
      const remoteId = await seedFile(server, 'abcdefghijklmnopqrst');
      const provider = createDropboxProvider();
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
    await withFakeDropbox({}, async (server) => {
      const remoteId = await seedFile(server, 'abcdefghijklmnopqrst');
      server.ignoreRange(remoteId);
      const provider = createDropboxProvider();

      const result = await provider.download(makeContext(), { remoteId, range: { start: 0, end: 4 } });

      expect(result.range).toEqual({ start: 0, end: 19, total: 20 });
      expect(result.sizeBytes).toBe(20n);
      expect((await readAll(result.stream)).toString('utf8')).toBe('abcdefghijklmnopqrst');
    });
  });

  it('follows a redirect on the temporary link', async () => {
    await withFakeDropbox({}, async (server) => {
      const remoteId = await seedFile(server, 'redirected content');
      server.overrideTemporaryLink(remoteId, `${server.origin}/download/redirect/${remoteId}`);
      const provider = createDropboxProvider();

      const result = await provider.download(makeContext(), { remoteId });
      expect((await readAll(result.stream)).toString('utf8')).toBe('redirected content');
    });
  });

  it('blocks temporary links that fail the SSRF gate', async () => {
    await withFakeDropbox({}, async (server) => {
      const remoteId = await seedFile(server, 'secret');
      server.overrideTemporaryLink(remoteId, 'http://169.254.169.254/latest/meta-data/');
      const provider = createDropboxProvider();

      await expectProviderCode(provider.download(makeContext(), { remoteId }), 'ERR_SSRF_BLOCKED');
      expect(server.requests.some((path) => path.startsWith('/latest/'))).toBe(false);
    });
  });

  it('rejects an invalid range before contacting Dropbox', async () => {
    await withFakeDropbox({}, async (server) => {
      const remoteId = await seedFile(server, 'abc');
      const provider = createDropboxProvider();
      const ctx = makeContext();
      const before = server.requests.length;

      await expectProviderCode(provider.download(ctx, { remoteId, range: { start: -1 } }), 'ERR_INVALID_INPUT');
      await expectProviderCode(provider.download(ctx, { remoteId, range: { start: 5, end: 2 } }), 'ERR_INVALID_INPUT');
      expect(server.requests.length).toBe(before);
    });
  });

  it('rejects a range that starts beyond the object', async () => {
    await withFakeDropbox({}, async (server) => {
      const remoteId = await seedFile(server, 'short');
      const provider = createDropboxProvider();

      await expectProviderCode(
        provider.download(makeContext(), { remoteId, range: { start: 100 } }),
        'ERR_INVALID_INPUT',
      );
      expect(server.requests.some((path) => path.startsWith('/download/'))).toBe(false);
    });
  });

  it('refuses to download a folder', async () => {
    await withFakeDropbox({}, async (server) => {
      const docs = server.seedFolder('docs');
      const provider = createDropboxProvider();
      await expectProviderCode(provider.download(makeContext(), { remoteId: docs }), 'ERR_INVALID_INPUT');
      expect(server.requests.some((path) => path.startsWith('/download/'))).toBe(false);
    });
  });

  it('maps a missing remote id to ERR_NOT_FOUND', async () => {
    await withFakeDropbox({}, async () => {
      const provider = createDropboxProvider();
      await expectProviderCode(provider.download(makeContext(), { remoteId: 'id:missing' }), 'ERR_NOT_FOUND');
    });
  });

  it('honours the downloadRange gate', async () => {
    await withFakeDropbox({}, async (server) => {
      const remoteId = await seedFile(server, 'ranged');
      const provider = createDropboxProvider({ capabilities: ['download'] });

      await expectProviderCode(
        provider.download(makeContext(), { remoteId, range: { start: 0, end: 1 } }),
        'ERR_CAPABILITY_UNSUPPORTED',
      );

      const plain = await createDropboxProvider({ capabilities: ['download'] }).download(makeContext(), { remoteId });
      expect((await readAll(plain.stream)).toString('utf8')).toBe('ranged');
    });
  });

  it('honours the download capability gate', async () => {
    await withFakeDropbox({}, async () => {
      const provider = createDropboxProvider({ capabilities: ['list'] });
      await expectProviderCode(provider.download(makeContext(), { remoteId: 'x' }), 'ERR_CAPABILITY_UNSUPPORTED');
    });
  });
});
