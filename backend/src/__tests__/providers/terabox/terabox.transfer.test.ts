import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TERABOX_CHUNK_BYTES, createTeraBoxProvider } from '../../../providers/terabox/index.js';
import { controlMd5, decodeMd5 } from '../../../providers/terabox/sign.js';
import type { UploadInput } from '../../../providers/types.js';
import { encodeMd5, expectProviderCode, makeContext, readAll, textStream, withFakeTeraBox } from './server.js';

function md5Of(buffer: Buffer): string {
  return createHash('md5').update(buffer).digest('hex');
}

describe('TeraBox sign helpers', () => {
  it('round-trips the obfuscated whole-file md5', () => {
    const samples = [
      'd41d8cd98f00b204e9800998ecf8427e',
      '5d41402abc4b2a76b9719d911017c592',
      '0123456789abcdef0123456789abcdef',
      'ffffffffffffffffffffffffffffffff',
      '5910a591dd8fc18c32a8f3df4fdc1761',
    ];
    for (const md5 of samples) {
      const encoded = encodeMd5(md5);
      expect(encoded).toHaveLength(32);
      expect(decodeMd5(encoded)).toBe(md5);
    }
    // Garbage stays garbage instead of decoding into something else.
    expect(decodeMd5('short')).toBe('short');
  });

  it('computes the control md5 from one or many chunk md5s', () => {
    expect(controlMd5(['a'.repeat(32)])).toBe('a'.repeat(32));
    const multi = controlMd5(['a'.repeat(32), 'b'.repeat(32)]);
    expect(multi).toMatch(/^[0-9a-f]{32}$/);
    expect(multi).not.toBe('a'.repeat(32));
  });
});

describe('TeraBox upload', () => {
  it('uploads a small file through precreate → chunk → create', async () => {
    await withFakeTeraBox({}, async (server) => {
      const content = 'hello terabox';
      const provider = createTeraBoxProvider();
      const result = await provider.upload(makeContext(), {
        stream: textStream(content),
        fileName: 'hello.txt',
        mimeType: 'text/plain',
        sizeBytes: BigInt(content.length),
        parentId: null,
      });
      expect(result).toEqual({ remoteId: '/hello.txt', sizeBytes: 13n, resumeToken: null });
      expect(server.readFile('/hello.txt').toString('utf8')).toBe(content);
      expect(server.uploadChunkCalls).toBe(1);
      expect(server.requests).toContain('POST /api/precreate');
      expect(server.requests).toContain('POST /api/create');
      expect(server.requests).toContain('POST /rest/2.0/pcs/superfile2');
      expect(server.requests).toContain('GET /rest/2.0/pcs/file');
      // Writes carry the scraped jsToken.
      expect(server.tokenRequests).toContain('POST /api/precreate');
      expect(server.tokenRequests).toContain('POST /api/create');
    });
  });

  it('uploads an empty file with no chunk calls', async () => {
    await withFakeTeraBox({}, async (server) => {
      const result = await createTeraBoxProvider().upload(makeContext(), {
        stream: textStream(''),
        fileName: 'empty.txt',
        mimeType: 'text/plain',
        sizeBytes: 0n,
        parentId: null,
      });
      expect(result.remoteId).toBe('/empty.txt');
      expect(result.sizeBytes).toBe(0n);
      expect(server.readFile('/empty.txt').byteLength).toBe(0);
      expect(server.uploadChunkCalls).toBe(0);
    });
  });

  it('streams large files in 4 MiB chunks and verifies the control md5', async () => {
    await withFakeTeraBox({}, async (server) => {
      const size = TERABOX_CHUNK_BYTES + 1_024;
      const buffer = Buffer.alloc(size, '9');
      const messages: string[] = [];
      const ctx = makeContext({ logger: (message) => messages.push(message) });
      const result = await createTeraBoxProvider().upload(ctx, {
        stream: textStream(buffer),
        fileName: 'big.bin',
        mimeType: 'application/octet-stream',
        sizeBytes: BigInt(size),
        parentId: null,
      });
      expect(result.remoteId).toBe('/big.bin');
      expect(result.sizeBytes).toBe(BigInt(size));
      expect(server.uploadChunkCalls).toBe(2);
      expect(server.readFile('/big.bin').equals(buffer)).toBe(true);
      // The server's control md5 is md5(JSON list of chunk md5s), and the
      // adapter accepted the obfuscated answer without logging a mismatch —
      // i.e. decodeMd5(server md5) === controlMd5(block list).
      expect(server.lastControlMd5).toBe(
        controlMd5([md5Of(buffer.subarray(0, TERABOX_CHUNK_BYTES)), md5Of(buffer.subarray(TERABOX_CHUNK_BYTES))]),
      );
      expect(messages.filter((message) => message.includes('mismatch'))).toEqual([]);
    });
  });

  it('retries a chunk when TeraBox stores a different md5', async () => {
    await withFakeTeraBox({}, async (server) => {
      server.corruptNextChunkMd5();
      const content = 'retry me';
      const result = await createTeraBoxProvider().upload(makeContext(), {
        stream: textStream(content),
        fileName: 'retry.txt',
        mimeType: 'text/plain',
        sizeBytes: BigInt(content.length),
        parentId: null,
      });
      expect(result.remoteId).toBe('/retry.txt');
      expect(server.uploadChunkCalls).toBe(2);
      expect(server.readFile('/retry.txt').toString('utf8')).toBe(content);
    });
  });

  it('overwrites an existing file (rtype=3)', async () => {
    await withFakeTeraBox({}, async (server) => {
      server.seedFile('/note.txt', 'old');
      const provider = createTeraBoxProvider();
      const ctx = makeContext();
      const first = await provider.upload(ctx, {
        stream: textStream('new'),
        fileName: 'note.txt',
        mimeType: 'text/plain',
        sizeBytes: 3n,
        parentId: null,
      });
      expect(first.remoteId).toBe('/note.txt');
      expect(server.readFile('/note.txt').toString('utf8')).toBe('new');
      const second = await provider.upload(ctx, {
        stream: textStream('newer'),
        fileName: 'note.txt',
        mimeType: 'text/plain',
        sizeBytes: 5n,
        parentId: null,
      });
      expect(second.remoteId).toBe('/note.txt');
      expect(server.readFile('/note.txt').toString('utf8')).toBe('newer');
    });
  });

  it('uploads into a subfolder', async () => {
    await withFakeTeraBox({}, async (server) => {
      server.seedFolder('/Docs');
      const result = await createTeraBoxProvider().upload(makeContext(), {
        stream: textStream('nested'),
        fileName: 'inside.txt',
        mimeType: 'text/plain',
        sizeBytes: 6n,
        parentId: '/Docs',
      });
      expect(result.remoteId).toBe('/Docs/inside.txt');
      expect(server.readFile('/Docs/inside.txt').toString('utf8')).toBe('nested');
    });
  });

  it('rejects unusable input', async () => {
    await withFakeTeraBox({}, async () => {
      const provider = createTeraBoxProvider();
      const ctx = makeContext();
      const base = {
        stream: textStream('x'),
        fileName: 'ok.txt',
        mimeType: 'text/plain',
        sizeBytes: 1n,
        parentId: null,
      };
      await expectProviderCode(provider.upload(ctx, { ...base, fileName: 'a/b' }), 'ERR_INVALID_INPUT');
      await expectProviderCode(provider.upload(ctx, { ...base, fileName: '' }), 'ERR_INVALID_INPUT');
      await expectProviderCode(
        provider.upload(ctx, { ...base, stream: undefined } as unknown as UploadInput),
        'ERR_INVALID_INPUT',
      );
      await expectProviderCode(
        provider.upload(ctx, { ...base, sizeBytes: 7 as unknown as bigint }),
        'ERR_INVALID_INPUT',
      );
      await expectProviderCode(provider.upload(ctx, { ...base, sizeBytes: -1n }), 'ERR_INVALID_INPUT');
      await expectProviderCode(
        provider.upload(ctx, { ...base, sizeBytes: 9_007_199_254_740_993n }),
        'ERR_INVALID_INPUT',
      );
      await expectProviderCode(
        provider.upload(ctx, { ...base, resumeToken: 'resume-1' }),
        'ERR_CAPABILITY_UNSUPPORTED',
      );
    });
  });

  it('rejects streams that disagree with the declared size', async () => {
    await withFakeTeraBox({}, async () => {
      const provider = createTeraBoxProvider();
      const ctx = makeContext();
      await expectProviderCode(
        provider.upload(ctx, {
          stream: textStream('this is longer than five bytes'),
          fileName: 'long.txt',
          mimeType: 'text/plain',
          sizeBytes: 5n,
          parentId: null,
        }),
        'ERR_INVALID_INPUT',
      );
      await expectProviderCode(
        provider.upload(ctx, {
          stream: textStream('short'),
          fileName: 'short.txt',
          mimeType: 'text/plain',
          sizeBytes: 100n,
          parentId: null,
        }),
        'ERR_INVALID_INPUT',
      );
    });
  });

  it('maps a missing parent folder to ERR_INVALID_INPUT', async () => {
    await withFakeTeraBox({}, async () => {
      await expectProviderCode(
        createTeraBoxProvider().upload(makeContext(), {
          stream: textStream('x'),
          fileName: 'orphan.txt',
          mimeType: 'text/plain',
          sizeBytes: 1n,
          parentId: '/missing-parent',
        }),
        'ERR_INVALID_INPUT',
      );
    });
  });

  it('blocks files over the free-tier limit until the account is premium', async () => {
    const fiveGiB = 5n * 1024n * 1024n * 1024n;
    await withFakeTeraBox({}, async (server) => {
      const provider = createTeraBoxProvider();
      await expectProviderCode(
        provider.upload(makeContext(), {
          stream: textStream('x'),
          fileName: 'huge.bin',
          mimeType: 'application/octet-stream',
          sizeBytes: fiveGiB,
          parentId: null,
        }),
        'ERR_QUOTA_EXCEEDED',
      );
      expect(server.requests).toContain('GET /rest/2.0/membership/proxy/user');
    });

    await withFakeTeraBox({ vip: true }, async (server) => {
      // Premium passes the size gate, so the failure moves on to the stream check.
      await expectProviderCode(
        createTeraBoxProvider().upload(makeContext(), {
          stream: textStream('x'),
          fileName: 'huge.bin',
          mimeType: 'application/octet-stream',
          sizeBytes: fiveGiB,
          parentId: null,
        }),
        'ERR_INVALID_INPUT',
      );
    });
  });

  it('blocks anything over the hard 128 GiB ceiling without a membership call', async () => {
    await withFakeTeraBox({}, async (server) => {
      await expectProviderCode(
        createTeraBoxProvider().upload(makeContext(), {
          stream: textStream('x'),
          fileName: 'impossible.bin',
          mimeType: 'application/octet-stream',
          sizeBytes: 129n * 1024n * 1024n * 1024n,
          parentId: null,
        }),
        'ERR_QUOTA_EXCEEDED',
      );
      expect(server.requests.some((entry) => entry.includes('membership/proxy/user'))).toBe(false);
    });
  });
});

describe('TeraBox download', () => {
  it('downloads the whole object through the signed dlink', async () => {
    await withFakeTeraBox({}, async (server) => {
      const content = 'hello world';
      server.seedFile('/movie.txt', content);
      const provider = createTeraBoxProvider();
      const result = await provider.download(makeContext(), { remoteId: '/movie.txt' });
      expect(result.sizeBytes).toBe(BigInt(content.length));
      expect(result.mimeType).toBe('application/octet-stream');
      const bytes = await readAll(result.stream);
      expect(bytes.toString('utf8')).toBe(content);
      expect(server.downloadCalls).toBe(1);
      // The dlink hop carries the session cookie, like the web player.
      expect(server.downloadCookies[0]).toBe('ndus=valid-cookie');
    });
  });

  it('serves byte ranges with the parsed Content-Range', async () => {
    await withFakeTeraBox({}, async (server) => {
      server.seedFile('/movie.txt', 'hello world');
      const provider = createTeraBoxProvider();
      const ctx = makeContext();

      const closed = await provider.download(ctx, { remoteId: '/movie.txt', range: { start: 2, end: 5 } });
      expect(closed.range).toEqual({ start: 2, end: 5, total: 11 });
      expect(closed.sizeBytes).toBe(4n);
      expect((await readAll(closed.stream)).toString('utf8')).toBe('llo ');

      const open = await provider.download(ctx, { remoteId: '/movie.txt', range: { start: 6 } });
      expect(open.range).toEqual({ start: 6, end: 10, total: 11 });
      expect(open.sizeBytes).toBe(5n);
      expect((await readAll(open.stream)).toString('utf8')).toBe('world');
    });
  });

  it('falls back to the signed /api/download flow when dlink is absent', async () => {
    await withFakeTeraBox({}, async (server) => {
      const content = 'payload';
      server.seedFile('/doc.txt', content);
      server.omitDlink('/doc.txt');
      const result = await createTeraBoxProvider().download(makeContext(), { remoteId: '/doc.txt' });
      expect(server.requests).toContain('GET /api/home/info');
      expect(server.requests).toContain('GET /api/download');
      expect((await readAll(result.stream)).toString('utf8')).toBe(content);
      expect(server.downloadCalls).toBe(1);
    });
  });

  it('maps dlink HTTP failures onto the taxonomy', async () => {
    await withFakeTeraBox({}, async (server) => {
      server.seedFile('/doc.txt', 'payload');
      const provider = createTeraBoxProvider();
      const ctx = makeContext();
      server.failNext('/dl/', { status: 500 });
      await expectProviderCode(provider.download(ctx, { remoteId: '/doc.txt' }), 'ERR_UPSTREAM_UNAVAILABLE');
      server.failNext('/dl/', { status: 404 });
      await expectProviderCode(provider.download(ctx, { remoteId: '/doc.txt' }), 'ERR_NOT_FOUND');
      server.failNext('/dl/', { status: 403 });
      await expectProviderCode(provider.download(ctx, { remoteId: '/doc.txt' }), 'ERR_AUTH_EXPIRED');
    });
  });

  it('rejects folders, missing paths and unusable ranges', async () => {
    await withFakeTeraBox({}, async (server) => {
      server.seedFolder('/Stuff');
      server.seedFile('/doc.txt', 'payload');
      const provider = createTeraBoxProvider();
      const ctx = makeContext();
      await expectProviderCode(provider.download(ctx, { remoteId: '/Stuff' }), 'ERR_INVALID_INPUT');
      await expectProviderCode(provider.download(ctx, { remoteId: '/gone.txt' }), 'ERR_NOT_FOUND');
      await expectProviderCode(provider.download(ctx, { remoteId: '' }), 'ERR_INVALID_INPUT');
      await expectProviderCode(
        provider.download(ctx, { remoteId: '/doc.txt', range: { start: 5, end: 1 } }),
        'ERR_INVALID_INPUT',
      );
      await expectProviderCode(
        provider.download(ctx, { remoteId: '/doc.txt', range: { start: 100 } }),
        'ERR_INVALID_INPUT',
      );
      await expectProviderCode(
        provider.download(ctx, { remoteId: '/doc.txt', range: { start: -1 } }),
        'ERR_INVALID_INPUT',
      );
      // The failed range checks never reached the CDN.
      expect(server.downloadCalls).toBe(0);
    });
  });

  it('honours the downloadRange capability gate', async () => {
    await withFakeTeraBox({}, async (server) => {
      server.seedFile('/doc.txt', 'payload');
      const noRange = createTeraBoxProvider({
        capabilities: ['list', 'download', 'getMetadata', 'healthCheck'],
      });
      const ctx = makeContext();
      const whole = await noRange.download(ctx, { remoteId: '/doc.txt' });
      expect((await readAll(whole.stream)).toString('utf8')).toBe('payload');
      await expectProviderCode(
        noRange.download(ctx, { remoteId: '/doc.txt', range: { start: 0, end: 1 } }),
        'ERR_CAPABILITY_UNSUPPORTED',
      );
    });
  });
});
