import { describe, expect, it } from 'vitest';
import { createPcloudProvider } from '../../../providers/pcloud/index.js';
import { expectProviderCode, makeContext, readAll, textStream, withFakePcloud } from './server.js';

const SAMPLE = Buffer.from('0123456789', 'utf8');

describe('pCloud upload', () => {
  it('uploads a new file with PUT uploadfile', async () => {
    await withFakePcloud({}, async (server) => {
      const provider = createPcloudProvider();
      const result = await provider.upload(makeContext(), {
        fileName: 'hello.txt',
        parentId: null,
        stream: textStream('hello'),
        sizeBytes: 5n,
        mimeType: 'text/plain',
      });
      expect(result.remoteId).toMatch(/^f\d+$/);
      expect(result.sizeBytes).toBe(5n);
      expect(result.resumeToken).toBeNull();
      expect(server.readFile(result.remoteId).toString('utf8')).toBe('hello');
      expect(server.requests).toContain('/uploadfile');
      const roundTrip = await provider.download(makeContext(), { remoteId: result.remoteId });
      expect(roundTrip.mimeType).toBe('text/plain');
      expect((await readAll(roundTrip.stream)).toString('utf8')).toBe('hello');
    });
  });

  it('uploads into a folder and overwrites an existing file in place', async () => {
    await withFakePcloud({}, async (server) => {
      const folderId = server.seedFolder('Inbox');
      const provider = createPcloudProvider();
      const ctx = makeContext();
      const nested = await provider.upload(ctx, {
        fileName: 'in.txt',
        parentId: folderId,
        stream: textStream('nested'),
        sizeBytes: 6n,
        mimeType: 'text/plain',
      });
      expect(nested.remoteId).toMatch(/^f\d+$/);
      const listed = await provider.list(ctx, { parentId: folderId });
      expect(listed.entries.map((entry) => entry.name)).toEqual(['in.txt']);

      const existing = server.seedFile('dup.txt', 0, 'old-content');
      const before = server.nodeCount();
      const overwritten = await provider.upload(ctx, {
        fileName: 'dup.txt',
        parentId: null,
        stream: textStream('new'),
        sizeBytes: 3n,
        mimeType: 'application/octet-stream',
      });
      expect(overwritten.remoteId).toBe(existing);
      expect(server.nodeCount()).toBe(before);
      expect(server.readFile(existing).toString('utf8')).toBe('new');
    });
  });

  it('rejects a resumeToken because uploadResumable is not supported', async () => {
    await withFakePcloud({}, async () => {
      const provider = createPcloudProvider();
      await expectProviderCode(
        provider.upload(makeContext(), {
          fileName: 'a.txt',
          parentId: null,
          stream: textStream('x'),
          sizeBytes: 1n,
          mimeType: 'application/octet-stream',
          resumeToken: 'resume-1',
        }),
        'ERR_CAPABILITY_UNSUPPORTED',
      );
    });
  });

  it('validates input before touching the network', async () => {
    await withFakePcloud({}, async (server) => {
      const fileId = server.seedFile('file.txt', 0, 'x');
      const provider = createPcloudProvider();
      const limited = createPcloudProvider({ capabilities: ['list'] });
      const ctx = makeContext();
      const base = {
        parentId: null,
        stream: textStream('x'),
        sizeBytes: 1n,
        mimeType: 'application/octet-stream',
      };
      await expectProviderCode(
        provider.upload(ctx, { parentId: null, stream: textStream('x'), sizeBytes: 1n } as never),
        'ERR_INVALID_INPUT',
      );
      await expectProviderCode(
        provider.upload(ctx, { ...base, fileName: 'a/b' }),
        'ERR_INVALID_INPUT',
      );
      await expectProviderCode(
        provider.upload(ctx, { ...base, fileName: 'a.txt', stream: undefined as never }),
        'ERR_INVALID_INPUT',
      );
      await expectProviderCode(
        provider.upload(ctx, { ...base, fileName: 'a.txt', sizeBytes: undefined as never }),
        'ERR_INVALID_INPUT',
      );
      await expectProviderCode(
        provider.upload(ctx, { ...base, fileName: 'a.txt', sizeBytes: -1n }),
        'ERR_INVALID_INPUT',
      );
      await expectProviderCode(
        provider.upload(ctx, { ...base, fileName: 'a.txt', sizeBytes: BigInt(Number.MAX_SAFE_INTEGER) + 1n }),
        'ERR_INVALID_INPUT',
      );
      await expectProviderCode(
        provider.upload(ctx, { ...base, fileName: 'a.txt', parentId: fileId }),
        'ERR_INVALID_INPUT',
      );
      await expectProviderCode(
        limited.upload(ctx, { ...base, fileName: 'a.txt' }),
        'ERR_CAPABILITY_UNSUPPORTED',
      );
    });
  });
});

describe('pCloud download', () => {
  it('downloads a whole file through the CDN link', async () => {
    await withFakePcloud({}, async (server) => {
      const fileId = server.seedFile('data.bin', 0, SAMPLE);
      const provider = createPcloudProvider();
      const result = await provider.download(makeContext(), { remoteId: fileId });
      expect(result.sizeBytes).toBe(10n);
      expect(result.mimeType).toBe('application/octet-stream');
      expect(result.range).toBeUndefined();
      expect((await readAll(result.stream)).equals(SAMPLE)).toBe(true);
      expect(server.requests).toContain('/stat');
      expect(server.requests).toContain('/getfilelink');
      expect(server.requests.some((path) => path.startsWith('/dl/'))).toBe(true);
    });
  });

  it('serves byte ranges with a 206 response', async () => {
    await withFakePcloud({}, async (server) => {
      const fileId = server.seedFile('data.bin', 0, SAMPLE);
      const provider = createPcloudProvider();
      const ctx = makeContext();
      const closed = await provider.download(ctx, { remoteId: fileId, range: { start: 2, end: 5 } });
      expect(closed.sizeBytes).toBe(4n);
      expect(closed.range).toEqual({ start: 2, end: 5, total: 10 });
      expect((await readAll(closed.stream)).toString('utf8')).toBe('2345');
      const open = await provider.download(ctx, { remoteId: fileId, range: { start: 7 } });
      expect(open.sizeBytes).toBe(3n);
      expect(open.range).toEqual({ start: 7, end: 9, total: 10 });
      expect((await readAll(open.stream)).toString('utf8')).toBe('789');
    });
  });

  it('falls back to the full object when the CDN ignores the Range header', async () => {
    await withFakePcloud({}, async (server) => {
      const fileId = server.seedFile('data.bin', 0, SAMPLE);
      server.ignoreRange(fileId);
      const result = await createPcloudProvider().download(makeContext(), {
        remoteId: fileId,
        range: { start: 0, end: 2 },
      });
      expect(result.sizeBytes).toBe(10n);
      expect(result.range).toEqual({ start: 0, end: 9, total: 10 });
      expect((await readAll(result.stream)).equals(SAMPLE)).toBe(true);
    });
  });

  it('rejects bad ranges, folders, and missing files', async () => {
    await withFakePcloud({}, async (server) => {
      const folderId = server.seedFolder('Dir');
      const fileId = server.seedFile('ok.bin', 0, SAMPLE);
      const provider = createPcloudProvider();
      const ctx = makeContext();
      await expectProviderCode(provider.download(ctx, { remoteId: fileId, range: { start: -1 } }), 'ERR_INVALID_INPUT');
      await expectProviderCode(
        provider.download(ctx, { remoteId: fileId, range: { start: 5, end: 2 } }),
        'ERR_INVALID_INPUT',
      );
      await expectProviderCode(
        provider.download(ctx, { remoteId: fileId, range: { start: 10 } }),
        'ERR_INVALID_INPUT',
      );
      await expectProviderCode(provider.download(ctx, { remoteId: folderId }), 'ERR_INVALID_INPUT');
      await expectProviderCode(provider.download(ctx, { remoteId: 'f9999999' }), 'ERR_NOT_FOUND');
    });
  });

  it('honours the download and downloadRange capability gates', async () => {
    await withFakePcloud({}, async () => {
      const ctx = makeContext();
      const noDownload = createPcloudProvider({ capabilities: ['list'] });
      await expectProviderCode(noDownload.download(ctx, { remoteId: 'f1' }), 'ERR_CAPABILITY_UNSUPPORTED');
      const noRange = createPcloudProvider({ capabilities: ['download'] });
      await expectProviderCode(
        noRange.download(ctx, { remoteId: 'f1', range: { start: 0 } }),
        'ERR_CAPABILITY_UNSUPPORTED',
      );
    });
  });

  it('maps a missing CDN object to ERR_NOT_FOUND', async () => {
    await withFakePcloud({}, async (server) => {
      const fileId = server.seedFile('data.bin', 0, SAMPLE);
      server.failNext('download', { status: 404 });
      await expectProviderCode(
        createPcloudProvider().download(makeContext(), { remoteId: fileId }),
        'ERR_NOT_FOUND',
      );
    });
  });
});

describe('pCloud shares', () => {
  it('creates a public file link without an expiry', async () => {
    await withFakePcloud({}, async (server) => {
      const fileId = server.seedFile('shared.txt', 0, 'x');
      const share = await createPcloudProvider().createShare(makeContext(), {
        remoteId: fileId,
        visibility: 'public_read',
      });
      expect(share.url).toContain('publink');
      expect(share.visibility).toBe('public_read');
      expect(share.expiresAt).toBeNull();
      expect(server.shareCount()).toBe(1);
    });
  });

  it('creates an expiring folder link and echoes the expiry', async () => {
    await withFakePcloud({}, async (server) => {
      const folderId = server.seedFolder('Shared');
      const expiresAt = new Date(Math.ceil((Date.now() + 3_600_000) / 1000) * 1000);
      const share = await createPcloudProvider().createShare(makeContext(), {
        remoteId: folderId,
        visibility: 'public_read',
        expiresAt: expiresAt.toISOString(),
      });
      expect(share.url).toContain('publink');
      expect(share.visibility).toBe('public_read');
      expect(share.expiresAt).toBe(expiresAt.toISOString().replace('.000Z', 'Z'));
    });
  });

  it('rejects past or malformed expiries and unknown visibilities', async () => {
    await withFakePcloud({}, async (server) => {
      const fileId = server.seedFile('x.txt', 0, 'x');
      const provider = createPcloudProvider();
      const ctx = makeContext();
      await expectProviderCode(
        provider.createShare(ctx, { remoteId: fileId, visibility: 'public_read', expiresAt: 'yesterday' }),
        'ERR_INVALID_INPUT',
      );
      await expectProviderCode(
        provider.createShare(ctx, {
          remoteId: fileId,
          visibility: 'public_read',
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        }),
        'ERR_INVALID_INPUT',
      );
      await expectProviderCode(
        provider.createShare(ctx, { remoteId: fileId } as never),
        'ERR_INVALID_INPUT',
      );
      await expectProviderCode(
        provider.createShare(ctx, { remoteId: fileId, visibility: 'password' as never }),
        'ERR_INVALID_INPUT',
      );
      await expectProviderCode(
        createPcloudProvider({ capabilities: ['list'] }).createShare(ctx, {
          remoteId: fileId,
          visibility: 'public_read',
        }),
        'ERR_CAPABILITY_UNSUPPORTED',
      );
    });
  });

  it('switches to private by removing every public link', async () => {
    await withFakePcloud({}, async (server) => {
      const fileId = server.seedFile('revoked.txt', 0, 'x');
      const ctx = makeContext();
      const provider = createPcloudProvider();
      await provider.createShare(ctx, { remoteId: fileId, visibility: 'public_read' });
      await provider.createShare(ctx, { remoteId: fileId, visibility: 'public_read' });
      expect(server.shareCount()).toBe(2);
      const share = await provider.createShare(ctx, { remoteId: fileId, visibility: 'private' });
      expect(share).toEqual({ url: '', visibility: 'private', expiresAt: null });
      expect(server.shareCount()).toBe(0);
      const again = await provider.createShare(ctx, { remoteId: fileId, visibility: 'private' });
      expect(again.visibility).toBe('private');
      expect(server.shareCount()).toBe(0);
    });
  });

  it('revokes shares idempotently', async () => {
    await withFakePcloud({}, async (server) => {
      const fileId = server.seedFile('linked.txt', 0, 'x');
      const ctx = makeContext();
      const provider = createPcloudProvider();
      await provider.createShare(ctx, { remoteId: fileId, visibility: 'public_read' });
      await provider.createShare(ctx, { remoteId: fileId, visibility: 'public_read' });
      expect(server.shareCount()).toBe(2);
      await provider.revokeShare(ctx, { remoteId: fileId });
      expect(server.shareCount()).toBe(0);
      await provider.revokeShare(ctx, { remoteId: fileId });
      expect(server.shareCount()).toBe(0);
      await expectProviderCode(
        createPcloudProvider({ capabilities: ['list'] }).revokeShare(ctx, { remoteId: fileId }),
        'ERR_CAPABILITY_UNSUPPORTED',
      );
    });
  });

  it('does not leak links that belong to another object', async () => {
    await withFakePcloud({}, async (server) => {
      const first = server.seedFile('first.txt', 0, 'x');
      const second = server.seedFile('second.txt', 0, 'x');
      const ctx = makeContext();
      const provider = createPcloudProvider();
      await provider.createShare(ctx, { remoteId: first, visibility: 'public_read' });
      await provider.revokeShare(ctx, { remoteId: second });
      expect(server.shareCount()).toBe(1);
      await provider.revokeShare(ctx, { remoteId: first });
      expect(server.shareCount()).toBe(0);
    });
  });
});
