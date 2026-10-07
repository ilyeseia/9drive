import { describe, expect, it } from 'vitest';
import { createTeraBoxProvider } from '../../../providers/terabox/index.js';
import { expectProviderCode, makeContext, withFakeTeraBox } from './server.js';

describe('TeraBox list', () => {
  it('lists the root folder with path-shaped remoteIds', async () => {
    await withFakeTeraBox({}, async (server) => {
      server.seedFolder('/Alpha');
      server.seedFile('/note.txt', 'hello');
      server.seedFolder('/Zebra');
      const provider = createTeraBoxProvider();
      const page = await provider.list(makeContext(), { parentId: null });
      expect(page.nextCursor).toBeNull();
      expect(page.entries.map((entry) => entry.name)).toEqual(['Alpha', 'note.txt', 'Zebra']);
      expect(server.requests).toContain('GET /api/list');

      const [alpha, note] = page.entries;
      expect(alpha.remoteId).toBe('/Alpha');
      expect(alpha.name).toBe('Alpha');
      expect(alpha.isFolder).toBe(true);
      expect(alpha.mimeType).toBe('inode/directory');
      expect(alpha.sizeBytes).toBe(0n);
      // Root children report parentId null (Dropbox parity).
      expect(alpha.parentId).toBeNull();
      expect(alpha.webUrl).toBeNull();

      expect(note.remoteId).toBe('/note.txt');
      expect(note.isFolder).toBe(false);
      expect(note.mimeType).toBe('application/octet-stream');
      expect(note.sizeBytes).toBe(5n);
      expect(note.parentId).toBeNull();
      expect(note.checksum).toBe('5d41402abc4b2a76b9719d911017c592');
      expect(note.createdAt).toBe('2023-11-14T22:13:20.000Z');
      expect(note.modifiedAt).toBe('2023-11-14T22:15:00.000Z');
    });
  });

  it('lists nested folders and resolves every root alias', async () => {
    await withFakeTeraBox({}, async (server) => {
      server.seedFolder('/Docs');
      server.seedFile('/Docs/a.txt', 'aa');
      const provider = createTeraBoxProvider();
      const ctx = makeContext();
      const nested = await provider.list(ctx, { parentId: '/Docs' });
      expect(nested.entries).toHaveLength(1);
      expect(nested.entries[0].name).toBe('a.txt');
      expect(nested.entries[0].parentId).toBe('/Docs');

      // Root aliases all resolve to the root listing; a bare folder name is
      // an unslashed remoteId, not an alias.
      for (const parentId of [null, '/', '']) {
        const page = await provider.list(ctx, { parentId });
        expect(page.entries.map((entry) => entry.name)).toEqual(['Docs']);
        expect(page.entries[0].parentId).toBeNull();
      }
      const unslashed = await provider.list(ctx, { parentId: 'Docs' });
      expect(unslashed.entries.map((entry) => entry.name)).toEqual(['a.txt']);
    });
  });

  it('pages with cursor objects until the listing is exhausted', async () => {
    await withFakeTeraBox({}, async (server) => {
      for (let i = 1; i <= 5; i++) server.seedFile(`/p${i}.txt`, String(i));
      const provider = createTeraBoxProvider();
      const ctx = makeContext();

      const first = await provider.list(ctx, { parentId: null, limit: 2 });
      expect(first.entries.map((entry) => entry.name)).toEqual(['p1.txt', 'p2.txt']);
      expect(first.nextCursor).toBe('2');

      const second = await provider.list(ctx, { parentId: null, limit: 2, cursor: first.nextCursor });
      expect(second.entries.map((entry) => entry.name)).toEqual(['p3.txt', 'p4.txt']);
      expect(second.nextCursor).toBe('3');

      const third = await provider.list(ctx, { parentId: null, limit: 2, cursor: second.nextCursor });
      expect(third.entries.map((entry) => entry.name)).toEqual(['p5.txt']);
      expect(third.nextCursor).toBeNull();
    });
  });

  it('returns an empty page for a folder TeraBox does not know', async () => {
    await withFakeTeraBox({}, async () => {
      const page = await createTeraBoxProvider().list(makeContext(), { parentId: '/does-not-exist' });
      expect(page.entries).toEqual([]);
      expect(page.nextCursor).toBeNull();
    });
  });

  it('rejects invalid limits and cursors', async () => {
    await withFakeTeraBox({}, async () => {
      const ctx = makeContext();
      const provider = createTeraBoxProvider();
      await expectProviderCode(provider.list(ctx, { parentId: null, limit: 0 }), 'ERR_INVALID_INPUT');
      await expectProviderCode(provider.list(ctx, { parentId: null, cursor: 'page-two' }), 'ERR_INVALID_INPUT');
      await expectProviderCode(provider.list(ctx, { parentId: null, cursor: '0' }), 'ERR_INVALID_INPUT');
    });
  });
});

describe('TeraBox getMetadata', () => {
  it('reads files and folders through filemetas', async () => {
    await withFakeTeraBox({}, async (server) => {
      server.seedFile('/doc.txt', '12345');
      server.seedFolder('/Stuff');
      const provider = createTeraBoxProvider();
      const ctx = makeContext();

      const file = await provider.getMetadata(ctx, { remoteId: '/doc.txt' });
      expect(file).toMatchObject({
        remoteId: '/doc.txt',
        name: 'doc.txt',
        isFolder: false,
        mimeType: 'application/octet-stream',
        sizeBytes: 5n,
        parentId: null,
        checksum: '827ccb0eea8a706c4c34a16891f84e7b',
        webUrl: null,
      });
      expect(file.createdAt).toBe('2023-11-14T22:13:20.000Z');

      const folder = await provider.getMetadata(ctx, { remoteId: 'Stuff' });
      expect(folder).toMatchObject({
        remoteId: '/Stuff',
        name: 'Stuff',
        isFolder: true,
        mimeType: 'inode/directory',
        parentId: null,
        checksum: null,
      });
      expect(server.requests).toContain('GET /api/filemetas');
    });
  });

  it('answers the root from local state without an HTTP call', async () => {
    await withFakeTeraBox({}, async (server) => {
      const root = await createTeraBoxProvider().getMetadata(makeContext(), { remoteId: '/' });
      expect(root).toMatchObject({ remoteId: '/', name: '', isFolder: true, parentId: null, mimeType: 'inode/directory' });
      expect(server.requests).toHaveLength(0);
    });
  });

  it('maps the filemetas errno:12/info:-9 envelope to ERR_NOT_FOUND', async () => {
    await withFakeTeraBox({}, async () => {
      await expectProviderCode(
        createTeraBoxProvider().getMetadata(makeContext(), { remoteId: '/gone.txt' }),
        'ERR_NOT_FOUND',
      );
    });
  });

  it('rejects an empty remoteId', async () => {
    await withFakeTeraBox({}, async () => {
      await expectProviderCode(
        createTeraBoxProvider().getMetadata(makeContext(), { remoteId: '  ' }),
        'ERR_INVALID_INPUT',
      );
    });
  });
});

describe('TeraBox createFolder', () => {
  it('creates folders at the root and inside folders, carrying the jsToken', async () => {
    await withFakeTeraBox({}, async (server) => {
      const provider = createTeraBoxProvider();
      const ctx = makeContext();
      const created = await provider.createFolder(ctx, { name: 'Projects', parentId: null });
      expect(created.isFolder).toBe(true);
      expect(created.name).toBe('Projects');
      expect(created.remoteId).toBe('/Projects');
      expect(created.parentId).toBeNull();

      const nested = await provider.createFolder(ctx, { name: '2026', parentId: created.remoteId });
      expect(nested.remoteId).toBe('/Projects/2026');
      expect(nested.parentId).toBe('/Projects');
      expect(server.requests).toContain('POST /api/create');
      expect(server.tokenRequests).toContain('POST /api/create');
    });
  });

  it('returns the existing folder on a name conflict', async () => {
    await withFakeTeraBox({}, async (server) => {
      const provider = createTeraBoxProvider();
      const ctx = makeContext();
      const first = await provider.createFolder(ctx, { name: 'Shared', parentId: null });
      const second = await provider.createFolder(ctx, { name: 'Shared', parentId: null });
      expect(second.remoteId).toBe(first.remoteId);
      expect(server.has('/Shared')).toBe(true);
    });
  });

  it('rejects invalid names and missing parents', async () => {
    await withFakeTeraBox({}, async () => {
      const ctx = makeContext();
      const provider = createTeraBoxProvider();
      for (const name of ['', 'a/b', '.', '..', '  ']) {
        await expectProviderCode(provider.createFolder(ctx, { name, parentId: null }), 'ERR_INVALID_INPUT');
      }
      await expectProviderCode(
        provider.createFolder(ctx, { name: 'ok', parentId: '/missing-parent' }),
        'ERR_INVALID_INPUT',
      );
    });
  });
});

describe('TeraBox rename', () => {
  it('renames files without changing the parent', async () => {
    await withFakeTeraBox({}, async (server) => {
      server.seedFile('/old.txt', 'x');
      const provider = createTeraBoxProvider();
      const renamed = await provider.rename(makeContext(), { remoteId: '/old.txt', newName: 'new.txt' });
      expect(renamed.name).toBe('new.txt');
      expect(renamed.remoteId).toBe('/new.txt');
      expect(renamed.parentId).toBeNull();
      expect(server.has('/old.txt')).toBe(false);
      expect(server.has('/new.txt')).toBe(true);
      expect(server.requests).toContain('POST /api/filemanager');
    });
  });

  it('moves a folder subtree along with its new name', async () => {
    await withFakeTeraBox({}, async (server) => {
      server.seedFolder('/Tree');
      server.seedFile('/Tree/child.txt', 'child');
      const renamed = await createTeraBoxProvider().rename(makeContext(), {
        remoteId: '/Tree',
        newName: 'Forest',
      });
      expect(renamed.remoteId).toBe('/Forest');
      expect(server.has('/Tree/child.txt')).toBe(false);
      expect(server.has('/Forest/child.txt')).toBe(true);
      const children = await createTeraBoxProvider().list(makeContext(), { parentId: '/Forest' });
      expect(children.entries.map((entry) => entry.name)).toEqual(['child.txt']);
    });
  });

  it('short-circuits when the name is unchanged', async () => {
    await withFakeTeraBox({}, async (server) => {
      server.seedFile('/same.txt', 'x');
      const result = await createTeraBoxProvider().rename(makeContext(), {
        remoteId: '/same.txt',
        newName: 'same.txt',
      });
      expect(result.name).toBe('same.txt');
      expect(server.requests).not.toContain('POST /api/filemanager');
    });
  });

  it('rejects invalid names, the root, and missing entries', async () => {
    await withFakeTeraBox({}, async (server) => {
      server.seedFile('/valid.txt', 'x');
      const ctx = makeContext();
      const provider = createTeraBoxProvider();
      await expectProviderCode(provider.rename(ctx, { remoteId: '/valid.txt', newName: 'a/b' }), 'ERR_INVALID_INPUT');
      await expectProviderCode(provider.rename(ctx, { remoteId: '/', newName: 'root' }), 'ERR_INVALID_INPUT');
      await expectProviderCode(provider.rename(ctx, { remoteId: '/gone.txt', newName: 'x' }), 'ERR_NOT_FOUND');
    });
  });
});

describe('TeraBox move', () => {
  it('moves files and folder subtrees into another folder', async () => {
    await withFakeTeraBox({}, async (server) => {
      server.seedFolder('/Dest');
      server.seedFile('/movable.txt', 'x');
      server.seedFolder('/Tree');
      server.seedFile('/Tree/child.txt', 'child');
      const provider = createTeraBoxProvider();
      const ctx = makeContext();

      const movedFile = await provider.move(ctx, { remoteId: '/movable.txt', newParentId: '/Dest' });
      expect(movedFile.parentId).toBe('/Dest');
      expect(movedFile.remoteId).toBe('/Dest/movable.txt');

      const movedFolder = await provider.move(ctx, { remoteId: '/Tree', newParentId: '/Dest' });
      expect(movedFolder.remoteId).toBe('/Dest/Tree');
      expect(server.has('/Tree/child.txt')).toBe(false);
      expect(server.has('/Dest/Tree/child.txt')).toBe(true);
    });
  });

  it('short-circuits when the destination is unchanged', async () => {
    await withFakeTeraBox({}, async (server) => {
      server.seedFile('/stay.txt', 'x');
      const result = await createTeraBoxProvider().move(makeContext(), {
        remoteId: '/stay.txt',
        newParentId: null,
      });
      expect(result.parentId).toBeNull();
      expect(server.requests).not.toContain('POST /api/filemanager');
    });
  });

  it('rejects self-moves and maps missing destinations', async () => {
    await withFakeTeraBox({}, async (server) => {
      server.seedFolder('/Outer');
      server.seedFolder('/Outer/Inner');
      const ctx = makeContext();
      const provider = createTeraBoxProvider();
      await expectProviderCode(
        provider.move(ctx, { remoteId: '/Outer', newParentId: '/Outer/Inner' }),
        'ERR_INVALID_INPUT',
      );
      await expectProviderCode(provider.move(ctx, { remoteId: '/Outer', newParentId: '/Outer' }), 'ERR_INVALID_INPUT');
      await expectProviderCode(
        provider.move(ctx, { remoteId: '/Outer', newParentId: '/nowhere' }),
        'ERR_INVALID_INPUT',
      );
      await expectProviderCode(
        provider.move(ctx, { remoteId: '/Outer/gone', newParentId: null }),
        'ERR_NOT_FOUND',
      );
      expect(server.has('/Outer')).toBe(true);
    });
  });
});

describe('TeraBox copy', () => {
  it('copies files and recursive folders through the async task', async () => {
    await withFakeTeraBox({}, async (server) => {
      server.seedFolder('/Dest');
      server.seedFile('/src.txt', 'payload');
      server.seedFolder('/Tree');
      server.seedFile('/Tree/child.txt', 'child');
      const provider = createTeraBoxProvider();
      const ctx = makeContext();

      const copiedFile = await provider.copy(ctx, { remoteId: '/src.txt', newParentId: '/Dest' });
      expect(copiedFile.remoteId).toBe('/Dest/src.txt');
      expect(copiedFile.parentId).toBe('/Dest');
      expect(copiedFile.sizeBytes).toBe(7n);
      expect(server.readFile('/src.txt').toString('utf8')).toBe('payload');

      const copiedFolder = await provider.copy(ctx, { remoteId: '/Tree', newParentId: '/Dest' });
      expect(copiedFolder.remoteId).toBe('/Dest/Tree');
      expect(copiedFolder.isFolder).toBe(true);
      const children = await provider.list(ctx, { parentId: '/Dest/Tree' });
      expect(children.entries.map((entry) => entry.name)).toEqual(['child.txt']);
      expect(server.requests).toContain('GET /share/taskquery');
    });
  });

  it('copies under a new name', async () => {
    await withFakeTeraBox({}, async (server) => {
      server.seedFile('/src.txt', 'x');
      const copied = await createTeraBoxProvider().copy(makeContext(), {
        remoteId: '/src.txt',
        newParentId: null,
        newName: 'dst.txt',
      });
      expect(copied.remoteId).toBe('/dst.txt');
      expect(server.has('/src.txt')).toBe(true);
    });
  });

  it('fails on destination conflicts instead of overwriting', async () => {
    await withFakeTeraBox({}, async (server) => {
      server.seedFolder('/Dest');
      server.seedFile('/dup.txt', 'first');
      server.seedFile('/Dest/dup.txt', 'second');
      const provider = createTeraBoxProvider();
      const ctx = makeContext();
      await expectProviderCode(provider.copy(ctx, { remoteId: '/dup.txt', newParentId: '/Dest' }), 'ERR_INVALID_INPUT');
      expect(server.readFile('/Dest/dup.txt').toString('utf8')).toBe('second');
    });
  });

  it('rejects self-copies, missing destinations and unsupported caps', async () => {
    await withFakeTeraBox({}, async (server) => {
      server.seedFolder('/Solo');
      const ctx = makeContext();
      const provider = createTeraBoxProvider();
      const limited = createTeraBoxProvider({ capabilities: ['list'] });
      await expectProviderCode(provider.copy(ctx, { remoteId: '/Solo', newParentId: '/Solo' }), 'ERR_INVALID_INPUT');
      await expectProviderCode(provider.copy(ctx, { remoteId: '/Solo', newParentId: '/nowhere' }), 'ERR_INVALID_INPUT');
      await expectProviderCode(provider.copy(ctx, { remoteId: '/Solo/gone', newParentId: null }), 'ERR_NOT_FOUND');
      await expectProviderCode(limited.copy(ctx, { remoteId: '/Solo', newParentId: null }), 'ERR_CAPABILITY_UNSUPPORTED');
    });
  });
});

describe('TeraBox delete', () => {
  it('deletes a file', async () => {
    await withFakeTeraBox({}, async (server) => {
      server.seedFile('/trash.txt', 'x');
      const provider = createTeraBoxProvider();
      const ctx = makeContext();
      await provider.delete(ctx, { remoteId: '/trash.txt' });
      expect(server.requests).toContain('POST /api/filemanager');
      await expectProviderCode(provider.getMetadata(ctx, { remoteId: '/trash.txt' }), 'ERR_NOT_FOUND');
      const page = await provider.list(ctx, { parentId: null });
      expect(page.entries).toHaveLength(0);
    });
  });

  it('deletes a folder subtree in one call', async () => {
    await withFakeTeraBox({}, async (server) => {
      server.seedFolder('/Full');
      server.seedFile('/Full/inside.txt', 'x');
      const provider = createTeraBoxProvider();
      const ctx = makeContext();
      const before = server.nodeCount();
      await provider.delete(ctx, { remoteId: '/Full' });
      expect(server.nodeCount()).toBe(before - 2);
      await expectProviderCode(provider.getMetadata(ctx, { remoteId: '/Full' }), 'ERR_NOT_FOUND');
    });
  });

  it('accepts and ignores the permanent flag (shared recycle bin)', async () => {
    await withFakeTeraBox({}, async (server) => {
      server.seedFile('/purge.txt', 'x');
      await createTeraBoxProvider().delete(makeContext(), { remoteId: '/purge.txt', permanent: true });
      expect(server.has('/purge.txt')).toBe(false);
      expect(server.requests.filter((entry) => entry === 'POST /api/filemanager')).toHaveLength(1);
    });
  });

  it('refuses the root and maps missing entries', async () => {
    await withFakeTeraBox({}, async () => {
      const ctx = makeContext();
      const provider = createTeraBoxProvider();
      await expectProviderCode(provider.delete(ctx, { remoteId: '/' }), 'ERR_INVALID_INPUT');
      await expectProviderCode(provider.delete(ctx, { remoteId: '' }), 'ERR_INVALID_INPUT');
      await expectProviderCode(provider.delete(ctx, { remoteId: '/never-existed.txt' }), 'ERR_NOT_FOUND');
    });
  });
});

describe('TeraBox search', () => {
  it('matches names case-insensitively across the tree', async () => {
    await withFakeTeraBox({}, async (server) => {
      server.seedFolder('/Reports');
      server.seedFile('/Reports/annual-report.pdf', 'x');
      server.seedFile('/notes.txt', 'x');
      const provider = createTeraBoxProvider();
      const ctx = makeContext();
      const page = await provider.search(ctx, { query: 'REPORT' });
      expect(page.entries.map((entry) => entry.name)).toEqual(['annual-report.pdf', 'Reports']);
      expect(page.entries[0].parentId).toBe('/Reports');
      expect(page.entries[1].parentId).toBeNull();
      expect(page.nextCursor).toBeNull();
      expect(server.requests).toContain('GET /api/search');
    });
  });

  it('pages through matches with a limit of one', async () => {
    await withFakeTeraBox({}, async (server) => {
      server.seedFolder('/Reports');
      server.seedFile('/Reports/annual-report.pdf', 'x');
      server.seedFile('/notes.txt', 'x');
      const provider = createTeraBoxProvider();
      const ctx = makeContext();
      const first = await provider.search(ctx, { query: 'REPORT', limit: 1 });
      expect(first.entries.map((entry) => entry.name)).toEqual(['annual-report.pdf']);
      expect(first.nextCursor).toBe('2');
      const second = await provider.search(ctx, { query: 'REPORT', limit: 1, cursor: first.nextCursor });
      expect(second.entries.map((entry) => entry.name)).toEqual(['Reports']);
      expect(second.nextCursor).toBe('3');
      const third = await provider.search(ctx, { query: 'REPORT', limit: 1, cursor: second.nextCursor });
      expect(third.entries).toEqual([]);
      expect(third.nextCursor).toBeNull();
    });
  });

  it('returns an empty page when nothing matches', async () => {
    await withFakeTeraBox({}, async (server) => {
      server.seedFile('/only.txt', 'x');
      const page = await createTeraBoxProvider().search(makeContext(), { query: 'zzz-unfindable' });
      expect(page.entries).toEqual([]);
      expect(page.nextCursor).toBeNull();
    });
  });

  it('rejects an empty query and an invalid limit', async () => {
    await withFakeTeraBox({}, async () => {
      const ctx = makeContext();
      const provider = createTeraBoxProvider();
      await expectProviderCode(provider.search(ctx, { query: '   ' }), 'ERR_INVALID_INPUT');
      await expectProviderCode(provider.search(ctx, { query: 'x', limit: 0 }), 'ERR_INVALID_INPUT');
    });
  });
});
