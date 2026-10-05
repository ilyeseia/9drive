import { describe, expect, it } from 'vitest';
import {
  GOOGLE_DRIVE_CHUNK_BYTES,
  GOOGLE_DRIVE_RESUMABLE_THRESHOLD_BYTES,
  createGoogleDriveProvider,
  type GoogleDriveProvider,
} from '../../../providers/google-drive/index.js';
import {
  bufferStream,
  expectProviderCode,
  makeContext,
  readAll,
  textStream,
  withFakeDrive,
  type FakeDrive,
} from './helpers.js';

async function seedRoot(provider: GoogleDriveProvider, drive: FakeDrive, ctx: ReturnType<typeof makeContext>): Promise<string> {
  await provider.list(ctx, { parentId: null });
  return drive.rootId();
}

describe('google_drive uploads', () => {
  it('uploads small files as a single multipart request into the9drive folder', async () => {
    await withFakeDrive({}, async (drive) => {
      const provider = createGoogleDriveProvider();
      const ctx = makeContext(drive);
      const rootId = await seedRoot(provider, drive, ctx);
      const content = 'hello multipart world';

      const result = await provider.upload(ctx, {
        stream: textStream(content),
        fileName: 'hello.txt',
        mimeType: 'text/plain',
        sizeBytes: BigInt(content.length),
        parentId: null,
      });

      expect(result.remoteId).toBeTruthy();
      expect(result.sizeBytes).toBe(BigInt(content.length));
      const uploaded = drive.files.get(result.remoteId)!;
      expect(uploaded.content.toString('utf8')).toBe(content);
      expect(uploaded.parents).toEqual([rootId]);
      expect(uploaded.mimeType).toBe('text/plain');

      const request = drive.requests.find((entry) => entry.path === '/upload/drive/v3/files')!;
      expect(request.query.get('uploadType')).toBe('multipart');
      expect(String(request.headers['content-type'])).toContain('multipart/related');
      expect(Number(request.headers['content-length'])).toBe(request.body.byteLength);
      const metadata = request.body.subarray(
        request.body.indexOf('\r\n\r\n') + 4,
        request.body.indexOf('\r\n--9drive-google-drive-boundary\r\n'),
      );
      expect(JSON.parse(metadata.toString('utf8'))).toMatchObject({
        name: 'hello.txt',
        mimeType: 'text/plain',
        parents: [rootId],
      });
    });
  });

  it('uploads into an explicit parent folder', async () => {
    await withFakeDrive({}, async (drive) => {
      const provider = createGoogleDriveProvider();
      const ctx = makeContext(drive);
      const rootId = await seedRoot(provider, drive, ctx);
      drive.seedFile({ id: 'sub-1', name: 'sub', mimeType: 'application/vnd.google-apps.folder', parents: [rootId] });

      const result = await provider.upload(ctx, {
        stream: textStream('nested'),
        fileName: 'nested.txt',
        mimeType: 'text/plain',
        sizeBytes: 6n,
        parentId: 'sub-1',
      });
      expect(drive.files.get(result.remoteId)!.parents).toEqual(['sub-1']);
    });
  });

  it('rejects a stream that delivers fewer bytes than declared', async () => {
    await withFakeDrive({}, async (drive) => {
      const provider = createGoogleDriveProvider();
      const ctx = makeContext(drive);
      await seedRoot(provider, drive, ctx);

      await expectProviderCode(
        provider.upload(ctx, {
          stream: textStream('short'),
          fileName: 'under.txt',
          mimeType: 'text/plain',
          sizeBytes: 100n,
          parentId: null,
        }),
        'ERR_INVALID_INPUT',
      );
      expect([...drive.files.values()].some((file) => file.name === 'under.txt')).toBe(false);
    });
  });

  it('rejects a stream that delivers more bytes than declared', async () => {
    await withFakeDrive({}, async (drive) => {
      const provider = createGoogleDriveProvider();
      const ctx = makeContext(drive);
      await seedRoot(provider, drive, ctx);

      await expectProviderCode(
        provider.upload(ctx, {
          stream: textStream('far too long for this declaration'),
          fileName: 'over.txt',
          mimeType: 'text/plain',
          sizeBytes: 4n,
          parentId: null,
        }),
        'ERR_INVALID_INPUT',
      );
      expect([...drive.files.values()].some((file) => file.name === 'over.txt')).toBe(false);
    });
  });

  it('rejects invalid upload input', async () => {
    await withFakeDrive({}, async (drive) => {
      const provider = createGoogleDriveProvider();
      const ctx = makeContext(drive);
      await expectProviderCode(
        provider.upload(ctx, {
          stream: textStream('x'),
          fileName: '   ',
          mimeType: 'text/plain',
          sizeBytes: 1n,
          parentId: null,
        }),
        'ERR_INVALID_INPUT',
      );
      await expectProviderCode(
        provider.upload(ctx, {
          stream: null as unknown as NodeJS.ReadableStream,
          fileName: 'x.txt',
          mimeType: 'text/plain',
          sizeBytes: 1n,
          parentId: null,
        }),
        'ERR_INVALID_INPUT',
      );
      await expectProviderCode(
        provider.upload(ctx, {
          stream: textStream('x'),
          fileName: 'x.txt',
          mimeType: 'text/plain',
          sizeBytes: -1n,
          parentId: null,
        }),
        'ERR_INVALID_INPUT',
      );
      const apiKeyContext = { ...makeContext(drive), credentials: { kind: 'api_key' as const, apiKey: 'k' } };
      await expectProviderCode(
        provider.upload(apiKeyContext, {
          stream: textStream('x'),
          fileName: 'x.txt',
          mimeType: 'text/plain',
          sizeBytes: 1n,
          parentId: null,
        }),
        'ERR_INVALID_INPUT',
      );
    });
  });

  it('switches to the resumable protocol at the threshold', async () => {
    await withFakeDrive({}, async (drive) => {
      const provider = createGoogleDriveProvider();
      const ctx = makeContext(drive);
      await seedRoot(provider, drive, ctx);
      const threshold = GOOGLE_DRIVE_RESUMABLE_THRESHOLD_BYTES;

      const below = Buffer.alloc(Number(threshold - 1n), 0x61);
      const small = await provider.upload(ctx, {
        stream: bufferStream(below),
        fileName: 'small.bin',
        mimeType: 'application/octet-stream',
        sizeBytes: threshold - 1n,
        parentId: null,
      });
      expect(drive.requests.at(-1)!.query.get('uploadType')).toBe('multipart');
      expect(drive.files.get(small.remoteId)!.content.byteLength).toBe(below.byteLength);

      const atThreshold = Buffer.alloc(Number(threshold), 0x62);
      const large = await provider.upload(ctx, {
        stream: bufferStream(atThreshold),
        fileName: 'large.bin',
        mimeType: 'application/octet-stream',
        sizeBytes: threshold,
        parentId: null,
      });
      const uploads = drive.requests.filter((entry) => entry.path === '/upload/drive/v3/files');
      expect(uploads.at(-1)!.query.get('uploadType')).toBe('resumable');
      expect(drive.sessions.size).toBe(1);
      expect(drive.files.get(large.remoteId)!.content.byteLength).toBe(Number(threshold));
      expect(large.resumeToken).toContain('/upload/resumable/');
    });
  });

  it('uploads files larger than the chunk size in several chunks', async () => {
    await withFakeDrive({}, async (drive) => {
      const provider = createGoogleDriveProvider();
      const ctx = makeContext(drive);
      await seedRoot(provider, drive, ctx);
      const size = GOOGLE_DRIVE_CHUNK_BYTES + 1024;
      const content = Buffer.alloc(size, 0x5a);

      const result = await provider.upload(ctx, {
        stream: bufferStream(content),
        fileName: 'chunked.bin',
        mimeType: 'application/octet-stream',
        sizeBytes: BigInt(size),
        parentId: null,
      });

      const session = [...drive.sessions.values()][0];
      expect(session.chunkCount).toBe(2);
      const stored = drive.files.get(result.remoteId)!.content;
      expect(stored.byteLength).toBe(size);
      expect(stored[0]).toBe(0x5a);
      expect(stored[size - 1]).toBe(0x5a);
      expect(stored.equals(content)).toBe(true);
    });
  });

  it('retries the remainder of a chunk when the upstream reports partial progress', async () => {
    await withFakeDrive({ partialFirstChunk: true }, async (drive) => {
      const provider = createGoogleDriveProvider();
      const ctx = makeContext(drive);
      await seedRoot(provider, drive, ctx);
      const content = Buffer.alloc(Number(GOOGLE_DRIVE_RESUMABLE_THRESHOLD_BYTES), 0x41);

      const result = await provider.upload(ctx, {
        stream: bufferStream(content),
        fileName: 'partial.bin',
        mimeType: 'application/octet-stream',
        sizeBytes: BigInt(content.byteLength),
        parentId: null,
      });

      const session = [...drive.sessions.values()][0];
      expect(session.chunkCount).toBe(2);
      const stored = drive.files.get(result.remoteId)!.content;
      expect(stored.equals(content)).toBe(true);
    });
  });

  it('resumes an interrupted session from a resume token', async () => {
    await withFakeDrive({}, async (drive) => {
      const provider = createGoogleDriveProvider();
      const ctx = makeContext(drive);
      const rootId = await seedRoot(provider, drive, ctx);
      const content = Buffer.alloc(Number(GOOGLE_DRIVE_RESUMABLE_THRESHOLD_BYTES), 0x43);
      const init = await fetch(`${drive.baseUrl}/upload/drive/v3/files?uploadType=resumable`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Upload-Content-Type': 'application/octet-stream',
          'X-Upload-Content-Length': String(content.byteLength),
        },
        body: JSON.stringify({ name: 'resume.bin', mimeType: 'application/octet-stream', parents: [rootId] }),
      });
      expect(init.status).toBe(200);
      const location = init.headers.get('location')!;
      expect(location).toContain('/upload/resumable/');

      const alreadySent = 1000;
      const put = await fetch(location, {
        method: 'PUT',
        headers: { 'Content-Range': `bytes 0-${alreadySent - 1}/${content.byteLength}` },
        body: content.subarray(0, alreadySent),
      });
      expect(put.status).toBe(308);

      const result = await provider.upload(ctx, {
        stream: bufferStream(content),
        fileName: 'resume.bin',
        mimeType: 'application/octet-stream',
        sizeBytes: BigInt(content.byteLength),
        parentId: null,
        resumeToken: location,
      });

      const stored = drive.files.get(result.remoteId)!.content;
      expect(stored.byteLength).toBe(content.byteLength);
      expect(stored.equals(content)).toBe(true);
      const session = [...drive.sessions.values()][0];
      expect(session.chunkCount).toBe(2);
      expect(session.bytesReceived).toBe(content.byteLength);
    });
  });

  it('rejects a resume token on an unexpected host', async () => {
    await withFakeDrive({}, async (drive) => {
      const provider = createGoogleDriveProvider();
      const ctx = makeContext(drive);
      await seedRoot(provider, drive, ctx);
      const before = drive.requests.length;

      await expectProviderCode(
        provider.upload(ctx, {
          stream: textStream('x'),
          fileName: 'evil.txt',
          mimeType: 'text/plain',
          sizeBytes: 1n,
          parentId: null,
          resumeToken: 'http://evil.example.com/upload/session',
        }),
        'ERR_SSRF_BLOCKED',
      );
      expect(drive.requests.length).toBe(before);
    });
  });

  it('rejects a session URL issued on an unexpected host', async () => {
    await withFakeDrive({ sessionLocation: 'http://evil.example.com/upload/session' }, async (drive) => {
      const provider = createGoogleDriveProvider();
      const ctx = makeContext(drive);
      await seedRoot(provider, drive, ctx);

      await expectProviderCode(
        provider.upload(ctx, {
          stream: bufferStream(Buffer.alloc(Number(GOOGLE_DRIVE_RESUMABLE_THRESHOLD_BYTES), 0x44)),
          fileName: 'evil-session.bin',
          mimeType: 'application/octet-stream',
          sizeBytes: GOOGLE_DRIVE_RESUMABLE_THRESHOLD_BYTES,
          parentId: null,
        }),
        'ERR_SSRF_BLOCKED',
      );
      expect(drive.requests.some((request) => request.path.startsWith('/upload/resumable/'))).toBe(false);
    });
  });

  it('maps upstream quota failures on upload', async () => {
    await withFakeDrive({}, async (drive) => {
      const provider = createGoogleDriveProvider();
      const ctx = makeContext(drive);
      await seedRoot(provider, drive, ctx);
      drive.failNext({
        path: '/upload/drive/v3/files',
        method: 'POST',
        status: 403,
        body: { error: { code: 403, message: 'The user\'s Drive storage quota has been exceeded', errors: [{ reason: 'storageQuotaExceeded' }] } },
      });

      await expectProviderCode(
        provider.upload(ctx, {
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

  it('honours the uploadResumable capability gate', async () => {
    await withFakeDrive({}, async (drive) => {
      const provider = createGoogleDriveProvider({ capabilities: ['upload'] });
      const ctx = makeContext(drive);
      await expectProviderCode(
        provider.upload(ctx, {
          stream: textStream('x'),
          fileName: 'x.txt',
          mimeType: 'text/plain',
          sizeBytes: 1n,
          parentId: null,
          resumeToken: 'https://www.googleapis.com/upload/resumable/session-x',
        }),
        'ERR_CAPABILITY_UNSUPPORTED',
      );
      await expectProviderCode(
        provider.upload(ctx, {
          stream: bufferStream(Buffer.alloc(Number(GOOGLE_DRIVE_RESUMABLE_THRESHOLD_BYTES), 0x45)),
          fileName: 'big.bin',
          mimeType: 'application/octet-stream',
          sizeBytes: GOOGLE_DRIVE_RESUMABLE_THRESHOLD_BYTES,
          parentId: null,
        }),
        'ERR_CAPABILITY_UNSUPPORTED',
      );
    });
  });
});

describe('google_drive downloads', () => {
  it('streams file content with size and mime type', async () => {
    await withFakeDrive({}, async (drive) => {
      const provider = createGoogleDriveProvider();
      const ctx = makeContext(drive);
      await seedRoot(provider, drive, ctx);
      drive.seedFile({ id: 'file-1', name: 'doc.txt', mimeType: 'text/plain', parents: [drive.rootId()], content: 'hello world' });

      const result = await provider.download(ctx, { remoteId: 'file-1' });
      expect(result.mimeType).toBe('text/plain');
      expect(result.sizeBytes).toBe(11n);
      expect(result.range).toBeUndefined();
      const body = await readAll(result.stream);
      expect(body.toString('utf8')).toBe('hello world');
    });
  });

  it('serves a byte range with the range actually applied', async () => {
    await withFakeDrive({}, async (drive) => {
      const provider = createGoogleDriveProvider();
      const ctx = makeContext(drive);
      await seedRoot(provider, drive, ctx);
      drive.seedFile({
        id: 'file-1',
        name: 'ranged.bin',
        parents: [drive.rootId()],
        content: 'abcdefghijklmnopqrst',
      });

      const ranged = await provider.download(ctx, { remoteId: 'file-1', range: { start: 0, end: 9 } });
      expect(ranged.sizeBytes).toBe(10n);
      expect(ranged.range).toEqual({ start: 0, end: 9, total: 20 });
      expect((await readAll(ranged.stream)).toString('utf8')).toBe('abcdefghij');

      const tail = await provider.download(ctx, { remoteId: 'file-1', range: { start: 15 } });
      expect(tail.range).toEqual({ start: 15, end: 19, total: 20 });
      expect((await readAll(tail.stream)).toString('utf8')).toBe('pqrst');
    });
  });

  it('rejects an invalid range before contacting Google', async () => {
    await withFakeDrive({}, async (drive) => {
      const provider = createGoogleDriveProvider();
      const ctx = makeContext(drive);
      await seedRoot(provider, drive, ctx);
      const before = drive.requests.length;
      await expectProviderCode(
        provider.download(ctx, { remoteId: 'file-1', range: { start: 5, end: 2 } }),
        'ERR_INVALID_INPUT',
      );
      await expectProviderCode(
        provider.download(ctx, { remoteId: 'file-1', range: { start: -1 } }),
        'ERR_INVALID_INPUT',
      );
      expect(drive.requests.length).toBe(before);
    });
  });

  it('honours the downloadRange capability gate', async () => {
    const provider = createGoogleDriveProvider({ capabilities: ['download'] });
    await expectProviderCode(
      provider.download(makeContext(), { remoteId: 'file-1', range: { start: 0, end: 1 } }),
      'ERR_CAPABILITY_UNSUPPORTED',
    );
  });

  it('refuses to download a folder', async () => {
    await withFakeDrive({}, async (drive) => {
      const provider = createGoogleDriveProvider();
      const ctx = makeContext(drive);
      const rootId = await seedRoot(provider, drive, ctx);
      await expectProviderCode(provider.download(ctx, { remoteId: rootId }), 'ERR_INVALID_INPUT');
    });
  });

  it('exports Google Workspace documents to the legacy target formats', async () => {
    await withFakeDrive({}, async (drive) => {
      const provider = createGoogleDriveProvider();
      const ctx = makeContext(drive);
      const rootId = await seedRoot(provider, drive, ctx);
      const cases: { mimeType: string; exported: string }[] = [
        { mimeType: 'application/vnd.google-apps.document', exported: 'application/pdf' },
        {
          mimeType: 'application/vnd.google-apps.spreadsheet',
          exported: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        },
        { mimeType: 'application/vnd.google-apps.presentation', exported: 'application/pdf' },
        { mimeType: 'application/vnd.google-apps.drawing', exported: 'image/png' },
      ];

      for (const [index, entry] of cases.entries()) {
        const id = `doc-${index}`;
        drive.seedFile({ id, name: `doc-${index}`, mimeType: entry.mimeType, parents: [rootId] });
        const result = await provider.download(ctx, { remoteId: id });
        expect(result.mimeType).toBe(entry.exported);
        expect(drive.exportRequests.at(-1)).toEqual({ remoteId: id, mimeType: entry.exported });
        expect((await readAll(result.stream)).toString('utf8')).toBe(`exported:doc-${index}`);
      }
    });
  });

  it('refuses to export Google Workspace types without a conversion target', async () => {
    await withFakeDrive({}, async (drive) => {
      const provider = createGoogleDriveProvider();
      const ctx = makeContext(drive);
      const rootId = await seedRoot(provider, drive, ctx);
      drive.seedFile({
        id: 'form-1',
        name: 'form',
        mimeType: 'application/vnd.google-apps.form',
        parents: [rootId],
      });

      await expectProviderCode(provider.download(ctx, { remoteId: 'form-1' }), 'ERR_INVALID_INPUT');
      expect(drive.exportRequests).toHaveLength(0);
    });
  });

  it('refuses byte ranges on exported documents', async () => {
    await withFakeDrive({}, async (drive) => {
      const provider = createGoogleDriveProvider();
      const ctx = makeContext(drive);
      const rootId = await seedRoot(provider, drive, ctx);
      drive.seedFile({
        id: 'doc-1',
        name: 'doc',
        mimeType: 'application/vnd.google-apps.document',
        parents: [rootId],
      });

      await expectProviderCode(
        provider.download(ctx, { remoteId: 'doc-1', range: { start: 0, end: 10 } }),
        'ERR_INVALID_INPUT',
      );
      expect(drive.exportRequests).toHaveLength(0);
    });
  });
});

describe('google_drive sharing', () => {
  it('creates reader-only public sharing on demand', async () => {
    await withFakeDrive({}, async (drive) => {
      const provider = createGoogleDriveProvider();
      const ctx = makeContext(drive);
      const rootId = await seedRoot(provider, drive, ctx);
      const seeded = drive.seedFile({ id: 'share-1', name: 'shared.txt', parents: [rootId], content: 'x' });

      const result = await provider.createShare(ctx, { remoteId: 'share-1', visibility: 'public_read' });

      expect(result.visibility).toBe('public_read');
      expect(result.url).toBe(seeded.webViewLink);
      expect(result.expiresAt).toBeNull();
      expect(drive.permissionWrites).toHaveLength(1);
      expect(drive.permissionWrites[0]).toMatchObject({
        op: 'create',
        remoteId: 'share-1',
        body: { type: 'anyone', role: 'reader', allowFileDiscovery: false },
      });
      expect(drive.files.get('share-1')!.permissions).toEqual([
        { id: 'perm-share-1-1', type: 'anyone', role: 'reader' },
      ]);
    });
  });

  it('downgrades an existing writer permission to reader', async () => {
    await withFakeDrive({}, async (drive) => {
      const provider = createGoogleDriveProvider();
      const ctx = makeContext(drive);
      const rootId = await seedRoot(provider, drive, ctx);
      drive.seedFile({
        id: 'share-1',
        name: 'shared.txt',
        parents: [rootId],
        permissions: [{ id: 'perm-1', type: 'anyone', role: 'writer' }],
      });

      const result = await provider.createShare(ctx, { remoteId: 'share-1', visibility: 'public_read' });

      expect(result.visibility).toBe('public_read');
      expect(drive.permissionWrites).toHaveLength(1);
      expect(drive.permissionWrites[0]).toMatchObject({ op: 'patch', body: { role: 'reader' } });
      expect(drive.files.get('share-1')!.permissions[0]).toMatchObject({ role: 'reader', id: 'perm-1' });
    });
  });

  it('does not write when the reader permission already exists', async () => {
    await withFakeDrive({}, async (drive) => {
      const provider = createGoogleDriveProvider();
      const ctx = makeContext(drive);
      const rootId = await seedRoot(provider, drive, ctx);
      drive.seedFile({
        id: 'share-1',
        name: 'shared.txt',
        parents: [rootId],
        permissions: [{ id: 'perm-1', type: 'anyone', role: 'reader' }],
      });

      const result = await provider.createShare(ctx, { remoteId: 'share-1', visibility: 'public_read' });
      expect(result.url).toContain('drive.google.com');
      expect(drive.permissionWrites).toHaveLength(0);
    });
  });

  it('applies an expiry to public sharing', async () => {
    await withFakeDrive({}, async (drive) => {
      const provider = createGoogleDriveProvider();
      const ctx = makeContext(drive);
      const rootId = await seedRoot(provider, drive, ctx);
      drive.seedFile({ id: 'share-1', name: 'shared.txt', parents: [rootId] });

      const result = await provider.createShare(ctx, {
        remoteId: 'share-1',
        visibility: 'public_read',
        expiresAt: '2026-12-31T00:00:00.000Z',
      });

      expect(result.expiresAt).toBe('2026-12-31T00:00:00.000Z');
      expect(drive.permissionWrites[0]).toMatchObject({
        op: 'create',
        body: { expirationTime: '2026-12-31T00:00:00.000Z', role: 'reader' },
      });
      expect(drive.files.get('share-1')!.permissions[0].expirationTime).toBe('2026-12-31T00:00:00.000Z');
    });
  });

  it('removes public sharing on revoke and on private visibility', async () => {
    await withFakeDrive({}, async (drive) => {
      const provider = createGoogleDriveProvider();
      const ctx = makeContext(drive);
      const rootId = await seedRoot(provider, drive, ctx);
      drive.seedFile({
        id: 'share-1',
        name: 'shared.txt',
        parents: [rootId],
        permissions: [{ id: 'perm-1', type: 'anyone', role: 'reader' }],
      });
      drive.seedFile({
        id: 'share-2',
        name: 'shared-2.txt',
        parents: [rootId],
        permissions: [{ id: 'perm-2', type: 'anyone', role: 'reader' }],
      });

      await provider.revokeShare(ctx, { remoteId: 'share-1' });
      expect(drive.permissionWrites).toEqual([{ op: 'delete', remoteId: 'share-1' }]);
      expect(drive.files.get('share-1')!.permissions).toHaveLength(0);

      await provider.revokeShare(ctx, { remoteId: 'share-1' });
      expect(drive.permissionWrites).toHaveLength(1);

      const cleared = await provider.createShare(ctx, { remoteId: 'share-2', visibility: 'private' });
      expect(cleared.visibility).toBe('private');
      expect(cleared.url).toBe('');
      expect(drive.files.get('share-2')!.permissions).toHaveLength(0);
    });
  });

  it('rejects unsupported visibility values', async () => {
    await withFakeDrive({}, async (drive) => {
      const provider = createGoogleDriveProvider();
      const ctx = makeContext(drive);
      await expectProviderCode(
        provider.createShare(ctx, { remoteId: 'share-1', visibility: 'anyone-writer' as never }),
        'ERR_INVALID_INPUT',
      );
    });
  });

  it('honours the createShare and revokeShare capability gates', async () => {
    const provider = createGoogleDriveProvider({ capabilities: ['list'] });
    await expectProviderCode(
      provider.createShare(makeContext(), { remoteId: 'x', visibility: 'public_read' }),
      'ERR_CAPABILITY_UNSUPPORTED',
    );
    await expectProviderCode(
      provider.revokeShare(makeContext(), { remoteId: 'x' }),
      'ERR_CAPABILITY_UNSUPPORTED',
    );
  });
});
