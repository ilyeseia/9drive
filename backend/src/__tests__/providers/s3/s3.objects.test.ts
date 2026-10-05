/**
 * S3 object operations against the fake server: listing/paging, metadata,
 * folder lifecycle, rename/move/copy/delete, ranged download and isolation.
 */
import { describe, expect, it } from 'vitest';
import { createS3Provider } from '../../../providers/s3/index.js';
import { expectProviderCode, makeS3Context, withFakeS3, type FakeS3 } from './helpers.js';

const provider = createS3Provider();
const ROOT = '9drive/user-1';
const MODIFIED = '2026-01-04T10:00:00.000Z';

function seedTree(server: FakeS3): void {
  server.seed(`${ROOT}/fA/report.pdf`, 'PDFDATA', 'application/pdf');
  server.seed(`${ROOT}/fA/nested/deep.txt`, 'deep');
  server.seed(`${ROOT}/d1/docs/`, '', 'application/x-directory');
  server.seed(`${ROOT}/d1/docs/fB/inner.txt`, 'inner', 'text/plain');
  server.seed(`${ROOT}/fC/notes.md`, '# notes', 'text/markdown');
  server.seed('9drive/user-2/fX/other.txt', 'other');
  server.seed('elsewhere/fY/outside.txt', 'outside');
}

describe('s3 listing and paging', () => {
  it('lists direct children with metadata and hides deeper or foreign keys', async () => {
    await withFakeS3({}, async (server) => {
      seedTree(server);
      const ctx = makeS3Context(server);
      const page = await provider.list(ctx, { parentId: null });

      expect(page.entries.map((entry) => entry.name)).toEqual(['docs', 'notes.md', 'report.pdf']);
      expect(page.nextCursor).toBeNull();

      const folder = page.entries[0]!;
      expect(folder).toEqual({
        remoteId: `${ROOT}/d1/docs/`,
        name: 'docs',
        mimeType: 'inode/directory',
        sizeBytes: 0n,
        parentId: null,
        isFolder: true,
        createdAt: null,
        modifiedAt: MODIFIED,
        checksum: expect.any(String),
        webUrl: null,
      });

      const pdf = page.entries[2]!;
      expect(pdf.mimeType).toBe('application/pdf');
      expect(pdf.sizeBytes).toBe(7n);
      expect(pdf.modifiedAt).toBe(MODIFIED);
      expect(pdf.checksum).not.toMatch(/"/);

      const inner = await provider.list(ctx, { parentId: `${ROOT}/d1/docs/` });
      expect(inner.entries).toHaveLength(1);
      expect(inner.entries[0]!.remoteId).toBe(`${ROOT}/d1/docs/fB/inner.txt`);
      expect(inner.entries[0]!.parentId).toBe(`${ROOT}/d1/docs/`);
      expect(inner.entries[0]!.sizeBytes).toBe(5n);
    });
  });

  it('pages a long listing with a stable cursor', async () => {
    await withFakeS3({}, async (server) => {
      for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']) {
        server.seed(`${ROOT}/f00000000000000000000000${name[0]}/${name}`, name);
      }
      const ctx = makeS3Context(server);

      const seen: string[] = [];
      let cursor: string | null | undefined = undefined;
      let pages = 0;
      do {
        const page: { entries: { name: string }[]; nextCursor?: string | null } = await provider.list(ctx, {
          parentId: null,
          limit: 2,
          ...(cursor === undefined ? {} : { cursor }),
        });
        seen.push(...page.entries.map((entry) => entry.name));
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor && pages < 10);

      expect(seen).toEqual(['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']);
      expect(pages).toBe(3);
    });
  });

  it('rejects bad cursors, limits and parents', async () => {
    await withFakeS3({}, async (server) => {
      seedTree(server);
      const ctx = makeS3Context(server);
      await expectProviderCode(provider.list(ctx, { parentId: null, cursor: 'zzzz' }), 'ERR_INVALID_INPUT');
      await expectProviderCode(provider.list(ctx, { parentId: null, limit: 0 }), 'ERR_INVALID_INPUT');
      await expectProviderCode(provider.list(ctx, { parentId: `${ROOT}/fC/notes.md` }), 'ERR_NOT_FOUND');
      await expectProviderCode(provider.list(ctx, { parentId: '9drive/user-2/d9/docs/' }), 'ERR_NOT_FOUND');
      await expectProviderCode(provider.list(ctx, { parentId: 'elsewhere/' }), 'ERR_NOT_FOUND');
    });
  });
});

describe('s3 metadata', () => {
  it('reads file and folder metadata through HEAD', async () => {
    await withFakeS3({}, async (server) => {
      seedTree(server);
      const ctx = makeS3Context(server);

      const file = await provider.getMetadata(ctx, { remoteId: `${ROOT}/fA/report.pdf` });
      expect(file).toEqual({
        remoteId: `${ROOT}/fA/report.pdf`,
        name: 'report.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 7n,
        parentId: null,
        isFolder: false,
        createdAt: null,
        modifiedAt: MODIFIED,
        checksum: expect.any(String),
        webUrl: null,
      });

      const folder = await provider.getMetadata(ctx, { remoteId: `${ROOT}/d1/docs/` });
      expect(folder.isFolder).toBe(true);
      expect(folder.sizeBytes).toBe(0n);
      expect(folder.name).toBe('docs');
      expect(folder.parentId).toBeNull();
    });
  });

  it('rejects missing, foreign and malformed ids', async () => {
    await withFakeS3({}, async (server) => {
      seedTree(server);
      const ctx = makeS3Context(server);
      await expectProviderCode(provider.getMetadata(ctx, { remoteId: `${ROOT}/fZZ/missing.txt` }), 'ERR_NOT_FOUND');
      await expectProviderCode(provider.getMetadata(ctx, { remoteId: '9drive/user-2/fX/other.txt' }), 'ERR_NOT_FOUND');
      await expectProviderCode(provider.getMetadata(ctx, { remoteId: ' ' }), 'ERR_INVALID_INPUT');
      await expectProviderCode(provider.getMetadata(ctx, { remoteId: `${ROOT}/orphan.txt` }), 'ERR_NOT_FOUND');
    });
  });
});

describe('s3 folder lifecycle', () => {
  it('creates a folder marker once and reuses it for the same name', async () => {
    await withFakeS3({}, async (server) => {
      const ctx = makeS3Context(server);
      const folder = await provider.createFolder(ctx, { name: 'Documents', parentId: null });

      expect(folder.isFolder).toBe(true);
      expect(folder.mimeType).toBe('inode/directory');
      expect(folder.sizeBytes).toBe(0n);
      expect(folder.parentId).toBeNull();
      expect(folder.remoteId).toMatch(/^9drive\/user-1\/d[0-9a-f]{24}\/Documents\/$/);
      expect(server.objectFor(folder.remoteId)?.body.byteLength).toBe(0);
      expect(server.objectFor(folder.remoteId)?.contentType).toBe('application/x-directory');
      expect(server.count('PutObject')).toBe(1);

      const again = await provider.createFolder(ctx, { name: 'Documents', parentId: null });
      expect(again.remoteId).toBe(folder.remoteId);
      expect(server.count('PutObject')).toBe(1);

      const nested = await provider.createFolder(ctx, { name: '2026', parentId: folder.remoteId });
      expect(nested.parentId).toBe(folder.remoteId);
      expect(nested.remoteId.startsWith(`${folder.remoteId}d`)).toBe(true);
      expect(server.objectFor(nested.remoteId)).toBeDefined();
    });
  });

  it('validates folder names and parents', async () => {
    await withFakeS3({}, async (server) => {
      seedTree(server);
      const ctx = makeS3Context(server);
      await expectProviderCode(provider.createFolder(ctx, { name: '   ', parentId: null }), 'ERR_INVALID_INPUT');
      await expectProviderCode(provider.createFolder(ctx, { name: '..', parentId: null }), 'ERR_INVALID_INPUT');
      await expectProviderCode(provider.createFolder(ctx, { name: 'x', parentId: '9drive/user-2/' }), 'ERR_NOT_FOUND');
      await expectProviderCode(provider.createFolder(ctx, { name: 'x', parentId: `${ROOT}/fC/notes.md` }), 'ERR_NOT_FOUND');
    });
  });
});

describe('s3 rename, move and copy', () => {
  it('renames a file by copying next to it and deleting the original', async () => {
    await withFakeS3({}, async (server) => {
      seedTree(server);
      const ctx = makeS3Context(server);
      const renamed = await provider.rename(ctx, { remoteId: `${ROOT}/fA/report.pdf`, newName: 'annual.pdf' });

      expect(renamed.remoteId).toBe(`${ROOT}/fA/annual.pdf`);
      expect(renamed.name).toBe('annual.pdf');
      expect(renamed.sizeBytes).toBe(7n);
      expect(server.objectFor(`${ROOT}/fA/report.pdf`)).toBeUndefined();
      expect(server.objectFor(`${ROOT}/fA/annual.pdf`)?.body.toString('utf8')).toBe('PDFDATA');
      expect(server.count('CopyObject')).toBe(1);
      expect(server.count('DeleteObject')).toBe(1);

      server.clear();
      const same = await provider.rename(ctx, { remoteId: `${ROOT}/fA/annual.pdf`, newName: 'annual.pdf' });
      expect(same.remoteId).toBe(`${ROOT}/fA/annual.pdf`);
      expect(server.count('CopyObject')).toBe(0);
    });
  });

  it('renames a folder subtree', async () => {
    await withFakeS3({}, async (server) => {
      seedTree(server);
      const ctx = makeS3Context(server);
      const renamed = await provider.rename(ctx, { remoteId: `${ROOT}/d1/docs/`, newName: 'handbook' });

      expect(renamed.remoteId).toBe(`${ROOT}/d1/handbook/`);
      expect(renamed.isFolder).toBe(true);
      expect(server.objectFor(`${ROOT}/d1/handbook/`)).toBeDefined();
      expect(server.objectFor(`${ROOT}/d1/handbook/fB/inner.txt`)?.body.toString('utf8')).toBe('inner');
      expect(server.objectFor(`${ROOT}/d1/docs/`)).toBeUndefined();
      expect(server.objectFor(`${ROOT}/d1/docs/fB/inner.txt`)).toBeUndefined();
    });
  });

  it('rejects invalid renames and foreign ids', async () => {
    await withFakeS3({}, async (server) => {
      seedTree(server);
      const ctx = makeS3Context(server);
      await expectProviderCode(provider.rename(ctx, { remoteId: `${ROOT}/fA/report.pdf`, newName: '..' }), 'ERR_INVALID_INPUT');
      await expectProviderCode(provider.rename(ctx, { remoteId: `${ROOT}/fZZ/report.pdf`, newName: 'x.txt`' }), 'ERR_NOT_FOUND');
      await expectProviderCode(provider.rename(ctx, { remoteId: '9drive/user-2/fX/other.txt', newName: 'x.txt`' }), 'ERR_NOT_FOUND');
    });
  });

  it('moves a file into a folder and skips work inside the same directory', async () => {
    await withFakeS3({}, async (server) => {
      seedTree(server);
      const ctx = makeS3Context(server);
      const moved = await provider.move(ctx, { remoteId: `${ROOT}/fA/report.pdf`, newParentId: `${ROOT}/d1/docs/` });

      expect(moved.remoteId).toBe(`${ROOT}/d1/docs/fA/report.pdf`);
      expect(moved.parentId).toBe(`${ROOT}/d1/docs/`);
      expect(server.objectFor(`${ROOT}/fA/report.pdf`)).toBeUndefined();
      expect(server.objectFor(`${ROOT}/d1/docs/fA/report.pdf`)?.body.toString('utf8')).toBe('PDFDATA');

      server.clear();
      const stay = await provider.move(ctx, { remoteId: `${ROOT}/fC/notes.md`, newParentId: null });
      expect(stay.remoteId).toBe(`${ROOT}/fC/notes.md`);
      expect(server.count('CopyObject')).toBe(0);
      expect(server.count('DeleteObject')).toBe(0);
    });
  });

  it('refuses to move a folder into itself', async () => {
    await withFakeS3({}, async (server) => {
      seedTree(server);
      const ctx = makeS3Context(server);
      await expectProviderCode(provider.move(ctx, { remoteId: `${ROOT}/d1/docs/`, newParentId: `${ROOT}/d1/docs/` }), 'ERR_INVALID_INPUT');
    });
  });

  it('copies files with a fresh fileId and keeps the source', async () => {
    await withFakeS3({}, async (server) => {
      seedTree(server);
      const ctx = makeS3Context(server);
      const copy = await provider.copy(ctx, { remoteId: `${ROOT}/fA/report.pdf`, newParentId: null, newName: 'copy.pdf' });

      expect(copy.remoteId).toMatch(/^9drive\/user-1\/f[0-9a-f]{24}\/copy\.pdf$/);
      expect(copy.remoteId).not.toBe(`${ROOT}/fA/copy.pdf`);
      expect(server.objectFor(copy.remoteId)?.body.toString('utf8')).toBe('PDFDATA');
      expect(server.objectFor(`${ROOT}/fA/report.pdf`)).toBeDefined();
    });
  });

  it('copies a folder subtree and refuses folder-into-itself', async () => {
    await withFakeS3({}, async (server) => {
      seedTree(server);
      const ctx = makeS3Context(server);
      const copy = await provider.copy(ctx, { remoteId: `${ROOT}/d1/docs/`, newParentId: null });

      expect(copy.isFolder).toBe(true);
      expect(copy.remoteId).toMatch(/^9drive\/user-1\/d[0-9a-f]{24}\/docs\/$/);
      expect(server.objectFor(`${copy.remoteId}fB/inner.txt`)?.body.toString('utf8')).toBe('inner');
      expect(server.objectFor(`${ROOT}/d1/docs/fB/inner.txt`)).toBeDefined();

      await expectProviderCode(
        provider.copy(ctx, { remoteId: `${ROOT}/d1/docs/`, newParentId: `${ROOT}/d1/docs/` }),
        'ERR_INVALID_INPUT',
      );
    });
  });
});

describe('s3 delete', () => {
  it('deletes a single object', async () => {
    await withFakeS3({}, async (server) => {
      seedTree(server);
      const ctx = makeS3Context(server);
      await provider.delete(ctx, { remoteId: `${ROOT}/fA/report.pdf` });
      expect(server.objectFor(`${ROOT}/fA/report.pdf`)).toBeUndefined();
      expect(server.objectFor(`${ROOT}/fA/nested/deep.txt`)).toBeDefined();
    });
  });

  it('deletes a folder and its subtree in one call', async () => {
    await withFakeS3({}, async (server) => {
      seedTree(server);
      const ctx = makeS3Context(server);
      await provider.delete(ctx, { remoteId: `${ROOT}/d1/docs/` });
      expect(server.objectFor(`${ROOT}/d1/docs/`)).toBeUndefined();
      expect(server.objectFor(`${ROOT}/d1/docs/fB/inner.txt`)).toBeUndefined();
      expect(server.objectFor(`${ROOT}/fC/notes.md`)).toBeDefined();
    });
  });

  it('rejects missing and foreign targets', async () => {
    await withFakeS3({}, async (server) => {
      seedTree(server);
      const ctx = makeS3Context(server);
      await expectProviderCode(provider.delete(ctx, { remoteId: `${ROOT}/fZZ/gone.txt` }), 'ERR_NOT_FOUND');
      server.clear();
      await expectProviderCode(provider.delete(ctx, { remoteId: '9drive/user-2/fX/other.txt' }), 'ERR_NOT_FOUND');
      expect(server.count('HeadObject')).toBe(0);
      expect(server.count('DeleteObject')).toBe(0);
    });
  });
});

describe('s3 download', () => {
  it('streams a whole object with its type and size', async () => {
    await withFakeS3({}, async (server) => {
      seedTree(server);
      const ctx = makeS3Context(server);
      const result = await provider.download(ctx, { remoteId: `${ROOT}/fC/notes.md` });

      expect(result.mimeType).toBe('text/markdown');
      expect(result.sizeBytes).toBe(7n);
      expect(result.range).toBeUndefined();
      const chunks: Buffer[] = [];
      for await (const chunk of result.stream as AsyncIterable<Buffer>) chunks.push(chunk);
      expect(Buffer.concat(chunks).toString('utf8')).toBe('# notes');
    });
  });

  it('serves a byte range and reports the served window', async () => {
    await withFakeS3({}, async (server) => {
      seedTree(server);
      const ctx = makeS3Context(server);
      const result = await provider.download(ctx, { remoteId: `${ROOT}/fA/report.pdf`, range: { start: 1, end: 3 } });

      expect(result.range).toEqual({ start: 1, end: 3, total: 7 });
      expect(result.sizeBytes).toBe(3n);
      const chunks: Buffer[] = [];
      for await (const chunk of result.stream as AsyncIterable<Buffer>) chunks.push(chunk);
      expect(Buffer.concat(chunks).toString('utf8')).toBe('DFD');
    });
  });

  it('rejects ranges outside the object, folders and foreign keys', async () => {
    await withFakeS3({}, async (server) => {
      seedTree(server);
      const ctx = makeS3Context(server);
      const clamped = await provider.download(ctx, { remoteId: `${ROOT}/fA/report.pdf`, range: { start: 0, end: 99 } });
      expect(clamped.range).toEqual({ start: 0, end: 6, total: 7 });
      await expectProviderCode(provider.download(ctx, { remoteId: `${ROOT}/fA/report.pdf`, range: { start: 100, end: 200 } }), 'ERR_INVALID_INPUT');
      await expectProviderCode(provider.download(ctx, { remoteId: `${ROOT}/d1/docs/` }), 'ERR_INVALID_INPUT');
      await expectProviderCode(provider.download(ctx, { remoteId: '9drive/user-2/fX/other.txt' }), 'ERR_NOT_FOUND');
      await expectProviderCode(provider.download(ctx, { remoteId: `${ROOT}/fA/report.pdf`, range: { start: 5, end: 2 } }), 'ERR_INVALID_INPUT');
    });
  });
});

describe('s3 tenant isolation', () => {
  it('never lists, reads or resolves another user key', async () => {
    await withFakeS3({}, async (server) => {
      seedTree(server);
      const ctx = makeS3Context(server, { userId: 'user-2' });

      const page = await provider.list(ctx, { parentId: null });
      expect(page.entries.map((entry) => entry.name)).toEqual(['other.txt']);

      await expectProviderCode(provider.getMetadata(ctx, { remoteId: `${ROOT}/fA/report.pdf` }), 'ERR_NOT_FOUND');
      await expectProviderCode(provider.download(ctx, { remoteId: `${ROOT}/fA/report.pdf` }), 'ERR_NOT_FOUND');
      await expectProviderCode(provider.delete(ctx, { remoteId: `${ROOT}/fA/report.pdf` }), 'ERR_NOT_FOUND');
      expect(server.objectFor(`${ROOT}/fA/report.pdf`)).toBeDefined();
    });
  });
});
