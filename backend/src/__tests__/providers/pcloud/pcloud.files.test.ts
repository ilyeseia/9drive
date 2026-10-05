import { describe, expect, it } from 'vitest';
import { createPcloudProvider } from '../../../providers/pcloud/index.js';
import { expectProviderCode, makeContext, withFakePcloud } from './server.js';

describe('pCloud list', () => {
  it('lists the root folder with normalized metadata', async () => {
    await withFakePcloud({}, async (server) => {
      const folderId = server.seedFolder('Alpha');
      server.seedFile('note.txt', 0, 'hello', 'text/plain');
      server.seedFolder('Zebra');
      const provider = createPcloudProvider();
      const page = await provider.list(makeContext(), { parentId: null });
      expect(page.nextCursor).toBeNull();
      expect(page.entries).toHaveLength(3);
      expect(server.requests).toContain('/listfolder');
      const [alpha, note, zebra] = page.entries;
      expect(alpha.remoteId).toBe(folderId);
      expect(alpha.name).toBe('Alpha');
      expect(alpha.isFolder).toBe(true);
      expect(alpha.mimeType).toBe('inode/directory');
      expect(alpha.sizeBytes).toBe(0n);
      expect(alpha.parentId).toBeNull();
      expect(note.remoteId).toMatch(/^f\d+$/);
      expect(note.name).toBe('note.txt');
      expect(note.isFolder).toBe(false);
      expect(note.mimeType).toBe('text/plain');
      expect(note.sizeBytes).toBe(5n);
      expect(note.parentId).toBeNull();
      expect(note.checksum).toBeNull();
      expect(note.webUrl).toBeNull();
      expect(note.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect(zebra.name).toBe('Zebra');
    });
  });

  it('lists a nested folder and resolves root aliases', async () => {
    await withFakePcloud({}, async (server) => {
      const subId = server.seedFolder('Docs');
      server.seedFile('a.txt', Number(subId.slice(1)), 'aa');
      const provider = createPcloudProvider();
      const ctx = makeContext();
      const nested = await provider.list(ctx, { parentId: subId });
      expect(nested.entries).toHaveLength(1);
      expect(nested.entries[0].name).toBe('a.txt');
      expect(nested.entries[0].parentId).toBe(subId);
      for (const parentId of [null, 'root', 'd0']) {
        const page = await provider.list(ctx, { parentId });
        expect(page.entries).toHaveLength(1);
        expect(page.entries[0].name).toBe('Docs');
      }
    });
  });

  it('pages with offset cursors', async () => {
    await withFakePcloud({}, async (server) => {
      server.seedFile('p1.txt', 0, '1');
      server.seedFile('p2.txt', 0, '2');
      server.seedFile('p3.txt', 0, '3');
      const provider = createPcloudProvider();
      const ctx = makeContext();
      const first = await provider.list(ctx, { parentId: null, limit: 2 });
      expect(first.entries.map((entry) => entry.name)).toEqual(['p1.txt', 'p2.txt']);
      expect(first.nextCursor).not.toBeNull();
      const second = await provider.list(ctx, { parentId: null, limit: 2, cursor: first.nextCursor });
      expect(second.entries.map((entry) => entry.name)).toEqual(['p3.txt']);
      expect(second.nextCursor).toBeNull();
    });
  });

  it('rejects invalid input, missing folders, and unsupported caps', async () => {
    await withFakePcloud({}, async () => {
      const ctx = makeContext();
      const limited = createPcloudProvider({ capabilities: ['search'] });
      await expectProviderCode(
        createPcloudProvider().list(ctx, { parentId: null, limit: 0 }),
        'ERR_INVALID_INPUT',
      );
      await expectProviderCode(createPcloudProvider().list(ctx, { parentId: 'd9999999' }), 'ERR_NOT_FOUND');
      await expectProviderCode(limited.list(ctx, { parentId: null }), 'ERR_CAPABILITY_UNSUPPORTED');
    });
  });
});

describe('pCloud getMetadata', () => {
  it('reads files through stat and folders through listfolder', async () => {
    await withFakePcloud({}, async (server) => {
      const fileId = server.seedFile('doc.txt', 0, '12345', 'text/plain');
      const folderId = server.seedFolder('Stuff');
      const provider = createPcloudProvider();
      const ctx = makeContext();
      const file = await provider.getMetadata(ctx, { remoteId: fileId });
      expect(file).toMatchObject({
        remoteId: fileId,
        name: 'doc.txt',
        isFolder: false,
        mimeType: 'text/plain',
        sizeBytes: 5n,
        parentId: null,
        checksum: null,
        webUrl: null,
      });
      const folder = await provider.getMetadata(ctx, { remoteId: folderId });
      expect(folder).toMatchObject({ remoteId: folderId, name: 'Stuff', isFolder: true, parentId: null });
      expect(server.requests).toContain('/stat');
      expect(server.requests).toContain('/listfolder');
    });
  });

  it('resolves the root through both aliases', async () => {
    await withFakePcloud({}, async () => {
      const provider = createPcloudProvider();
      const ctx = makeContext();
      for (const remoteId of ['root', 'd0']) {
        const root = await provider.getMetadata(ctx, { remoteId });
        expect(root.remoteId).toBe('d0');
        expect(root.name).toBe('');
        expect(root.isFolder).toBe(true);
        expect(root.parentId).toBeNull();
      }
    });
  });

  it('reports deleted and missing entries as ERR_NOT_FOUND', async () => {
    await withFakePcloud({}, async (server) => {
      const fileId = server.seedFile('gone.txt', 0, 'x');
      const provider = createPcloudProvider();
      const ctx = makeContext();
      await provider.delete(ctx, { remoteId: fileId });
      await expectProviderCode(provider.getMetadata(ctx, { remoteId: fileId }), 'ERR_NOT_FOUND');
      await expectProviderCode(provider.getMetadata(ctx, { remoteId: 'd9999999' }), 'ERR_NOT_FOUND');
    });
  });

  it('rejects malformed ids and unsupported caps', async () => {
    await withFakePcloud({}, async () => {
      const ctx = makeContext();
      const limited = createPcloudProvider({ capabilities: ['list'] });
      await expectProviderCode(createPcloudProvider().getMetadata(ctx, { remoteId: 'nope' }), 'ERR_INVALID_INPUT');
      await expectProviderCode(limited.getMetadata(ctx, { remoteId: 'd0' }), 'ERR_CAPABILITY_UNSUPPORTED');
    });
  });
});

describe('pCloud createFolder', () => {
  it('creates folders at the root and in subfolders', async () => {
    await withFakePcloud({}, async (server) => {
      const provider = createPcloudProvider();
      const ctx = makeContext();
      const created = await provider.createFolder(ctx, { name: 'Projects', parentId: null });
      expect(created.isFolder).toBe(true);
      expect(created.name).toBe('Projects');
      expect(created.parentId).toBeNull();
      const nested = await provider.createFolder(ctx, { name: '2026', parentId: created.remoteId });
      expect(nested.isFolder).toBe(true);
      expect(nested.parentId).toBe(created.remoteId);
      expect(server.requests).toContain('/createfolder');
    });
  });

  it('returns the existing folder on a name conflict', async () => {
    await withFakePcloud({}, async () => {
      const provider = createPcloudProvider();
      const ctx = makeContext();
      const first = await provider.createFolder(ctx, { name: 'Shared', parentId: null });
      const second = await provider.createFolder(ctx, { name: 'Shared', parentId: null });
      expect(second.remoteId).toBe(first.remoteId);
      expect(second.name).toBe('Shared');
    });
  });

  it('rejects invalid names, non-folder parents, and unsupported caps', async () => {
    await withFakePcloud({}, async (server) => {
      const fileId = server.seedFile('f.txt', 0, 'x');
      const ctx = makeContext();
      const provider = createPcloudProvider();
      const limited = createPcloudProvider({ capabilities: ['list'] });
      await expectProviderCode(provider.createFolder(ctx, { name: 'a/b', parentId: null }), 'ERR_INVALID_INPUT');
      await expectProviderCode(provider.createFolder(ctx, { name: '', parentId: null }), 'ERR_INVALID_INPUT');
      await expectProviderCode(provider.createFolder(ctx, { name: 'ok', parentId: fileId }), 'ERR_INVALID_INPUT');
      await expectProviderCode(
        limited.createFolder(ctx, { name: 'ok', parentId: null }),
        'ERR_CAPABILITY_UNSUPPORTED',
      );
    });
  });
});

describe('pCloud rename', () => {
  it('renames files and folders without changing the parent', async () => {
    await withFakePcloud({}, async (server) => {
      const fileId = server.seedFile('old.txt', 0, 'x');
      const folderId = server.seedFolder('OldDir');
      const provider = createPcloudProvider();
      const ctx = makeContext();
      const renamedFile = await provider.rename(ctx, { remoteId: fileId, newName: 'new.txt' });
      expect(renamedFile.name).toBe('new.txt');
      expect(renamedFile.parentId).toBeNull();
      const renamedFolder = await provider.rename(ctx, { remoteId: folderId, newName: 'NewDir' });
      expect(renamedFolder.name).toBe('NewDir');
      expect(renamedFolder.isFolder).toBe(true);
      expect(server.requests).toContain('/renamefile');
      expect(server.requests).toContain('/renamefolder');
    });
  });

  it('short-circuits when the name is unchanged', async () => {
    await withFakePcloud({}, async (server) => {
      const fileId = server.seedFile('same.txt', 0, 'x');
      const result = await createPcloudProvider().rename(makeContext(), {
        remoteId: fileId,
        newName: 'same.txt',
      });
      expect(result.name).toBe('same.txt');
      expect(server.requests).not.toContain('/renamefile');
    });
  });

  it('rejects invalid names and reports missing entries', async () => {
    await withFakePcloud({}, async (server) => {
      const fileId = server.seedFile('valid.txt', 0, 'x');
      const ctx = makeContext();
      const provider = createPcloudProvider();
      const limited = createPcloudProvider({ capabilities: ['list'] });
      await expectProviderCode(provider.rename(ctx, { remoteId: fileId, newName: 'a/b' }), 'ERR_INVALID_INPUT');
      await expectProviderCode(provider.rename(ctx, { remoteId: 'f9999999', newName: 'x' }), 'ERR_NOT_FOUND');
      await expectProviderCode(limited.rename(ctx, { remoteId: 'f1', newName: 'x' }), 'ERR_CAPABILITY_UNSUPPORTED');
    });
  });
});

describe('pCloud move', () => {
  it('moves files and folders to another folder', async () => {
    await withFakePcloud({}, async (server) => {
      const destId = server.seedFolder('Dest');
      const fileId = server.seedFile('movable.txt', 0, 'x');
      const folderId = server.seedFolder('MovableDir');
      const provider = createPcloudProvider();
      const ctx = makeContext();
      const movedFile = await provider.move(ctx, { remoteId: fileId, newParentId: destId });
      expect(movedFile.parentId).toBe(destId);
      const movedFolder = await provider.move(ctx, { remoteId: folderId, newParentId: destId });
      expect(movedFolder.parentId).toBe(destId);
      expect(movedFolder.isFolder).toBe(true);
    });
  });

  it('short-circuits when the destination is unchanged', async () => {
    await withFakePcloud({}, async (server) => {
      const fileId = server.seedFile('stay.txt', 0, 'x');
      const result = await createPcloudProvider().move(makeContext(), {
        remoteId: fileId,
        newParentId: null,
      });
      expect(result.parentId).toBeNull();
      expect(server.requests).not.toContain('/renamefile');
    });
  });

  it('rejects self-moves and maps upstream rejections', async () => {
    await withFakePcloud({}, async (server) => {
      const outerId = server.seedFolder('Outer');
      const innerId = server.seedFolder('Inner', Number(outerId.slice(1)));
      const ctx = makeContext();
      const provider = createPcloudProvider();
      const limited = createPcloudProvider({ capabilities: ['list'] });
      await expectProviderCode(provider.move(ctx, { remoteId: outerId, newParentId: outerId }), 'ERR_INVALID_INPUT');
      await expectProviderCode(
        provider.move(ctx, { remoteId: outerId, newParentId: innerId }),
        'ERR_INVALID_INPUT',
      );
      await expectProviderCode(
        provider.move(ctx, { remoteId: outerId, newParentId: 'd9999999' }),
        'ERR_NOT_FOUND',
      );
      await expectProviderCode(
        limited.move(ctx, { remoteId: outerId, newParentId: null }),
        'ERR_CAPABILITY_UNSUPPORTED',
      );
    });
  });
});

describe('pCloud copy', () => {
  it('copies files and recursive folders with distinct ids', async () => {
    await withFakePcloud({}, async (server) => {
      const destId = server.seedFolder('Dest');
      const fileId = server.seedFile('src.txt', 0, 'payload');
      const folderId = server.seedFolder('Tree');
      server.seedFile('child.txt', Number(folderId.slice(1)), 'child');
      const provider = createPcloudProvider();
      const ctx = makeContext();
      const copiedFile = await provider.copy(ctx, { remoteId: fileId, newParentId: destId });
      expect(copiedFile.remoteId).not.toBe(fileId);
      expect(copiedFile.name).toBe('src.txt');
      expect(copiedFile.parentId).toBe(destId);
      expect(copiedFile.sizeBytes).toBe(7n);
      const copiedFolder = await provider.copy(ctx, { remoteId: folderId, newParentId: destId });
      expect(copiedFolder.remoteId).not.toBe(folderId);
      expect(copiedFolder.isFolder).toBe(true);
      const childPage = await provider.list(ctx, { parentId: copiedFolder.remoteId });
      expect(childPage.entries.map((entry) => entry.name)).toEqual(['child.txt']);
    });
  });

  it('copies under a new name', async () => {
    await withFakePcloud({}, async (server) => {
      const fileId = server.seedFile('src.txt', 0, 'x');
      const copied = await createPcloudProvider().copy(makeContext(), {
        remoteId: fileId,
        newParentId: null,
        newName: 'dst.txt',
      });
      expect(copied.name).toBe('dst.txt');
      expect(copied.remoteId).not.toBe(fileId);
    });
  });

  it('fails on destination conflicts instead of overwriting', async () => {
    await withFakePcloud({}, async (server) => {
      const destId = server.seedFolder('Dest');
      const fileId = server.seedFile('dup.txt', 0, 'first');
      server.seedFile('dup.txt', Number(destId.slice(1)), 'second');
      const provider = createPcloudProvider();
      const ctx = makeContext();
      const before = await provider.list(ctx, { parentId: destId });
      expect(before.entries).toHaveLength(1);
      await expectProviderCode(provider.copy(ctx, { remoteId: fileId, newParentId: destId }), 'ERR_INVALID_INPUT');
      const after = await provider.list(ctx, { parentId: destId });
      expect(after.entries).toHaveLength(1);
      expect(server.readFile(after.entries[0].remoteId).toString('utf8')).toBe('second');
    });
  });

  it('rejects self-copies and unsupported caps', async () => {
    await withFakePcloud({}, async (server) => {
      const folderId = server.seedFolder('Solo');
      const ctx = makeContext();
      const provider = createPcloudProvider();
      const limited = createPcloudProvider({ capabilities: ['list'] });
      await expectProviderCode(
        provider.copy(ctx, { remoteId: folderId, newParentId: folderId }),
        'ERR_INVALID_INPUT',
      );
      await expectProviderCode(
        limited.copy(ctx, { remoteId: folderId, newParentId: null }),
        'ERR_CAPABILITY_UNSUPPORTED',
      );
    });
  });
});

describe('pCloud delete', () => {
  it('moves a file to the trash', async () => {
    await withFakePcloud({}, async (server) => {
      const fileId = server.seedFile('trash.txt', 0, 'x');
      const provider = createPcloudProvider();
      const ctx = makeContext();
      await provider.delete(ctx, { remoteId: fileId });
      expect(server.requests).toContain('/deletefile');
      await expectProviderCode(provider.getMetadata(ctx, { remoteId: fileId }), 'ERR_NOT_FOUND');
      const page = await provider.list(ctx, { parentId: null });
      expect(page.entries).toHaveLength(0);
    });
  });

  it('trashes an empty folder without touching the recursive endpoint', async () => {
    await withFakePcloud({}, async (server) => {
      const folderId = server.seedFolder('Empty');
      const provider = createPcloudProvider();
      const ctx = makeContext();
      await provider.delete(ctx, { remoteId: folderId });
      expect(server.requests).toContain('/deletefolder');
      expect(server.requests).not.toContain('/deletefolderrecursive');
      await expectProviderCode(provider.getMetadata(ctx, { remoteId: folderId }), 'ERR_NOT_FOUND');
    });
  });

  it('falls back to the recursive purge for non-empty folders', async () => {
    await withFakePcloud({}, async (server) => {
      const folderId = server.seedFolder('Full');
      server.seedFile('inside.txt', Number(folderId.slice(1)), 'x');
      const provider = createPcloudProvider();
      const ctx = makeContext();
      await provider.delete(ctx, { remoteId: folderId });
      expect(server.requests).toContain('/deletefolder');
      expect(server.requests).toContain('/deletefolderrecursive');
      await expectProviderCode(provider.getMetadata(ctx, { remoteId: folderId }), 'ERR_NOT_FOUND');
      const page = await provider.list(ctx, { parentId: null });
      expect(page.entries).toHaveLength(0);
    });
  });

  it('skips the trash attempt when permanent=true', async () => {
    await withFakePcloud({}, async (server) => {
      const folderId = server.seedFolder('Purge');
      server.seedFile('inside.txt', Number(folderId.slice(1)), 'x');
      const provider = createPcloudProvider();
      await provider.delete(makeContext(), { remoteId: folderId, permanent: true });
      expect(server.requests).toContain('/deletefolderrecursive');
      expect(server.requests).not.toContain('/deletefolder');
    });
  });

  it('refuses to delete the root and maps missing entries', async () => {
    await withFakePcloud({}, async () => {
      const ctx = makeContext();
      const provider = createPcloudProvider();
      const limited = createPcloudProvider({ capabilities: ['list'] });
      await expectProviderCode(provider.delete(ctx, { remoteId: 'root' }), 'ERR_INVALID_INPUT');
      await expectProviderCode(provider.delete(ctx, { remoteId: 'd0' }), 'ERR_INVALID_INPUT');
      await expectProviderCode(provider.delete(ctx, { remoteId: 'f9999999' }), 'ERR_NOT_FOUND');
      await expectProviderCode(limited.delete(ctx, { remoteId: 'f1' }), 'ERR_CAPABILITY_UNSUPPORTED');
    });
  });
});

describe('pCloud search', () => {
  it('matches names case-insensitively across the tree', async () => {
    await withFakePcloud({}, async (server) => {
      const reportsId = server.seedFolder('Reports');
      server.seedFile('annual-report.pdf', Number(reportsId.slice(1)), 'x');
      server.seedFile('notes.txt', 0, 'x');
      const provider = createPcloudProvider();
      const ctx = makeContext();
      const first = await provider.search(ctx, { query: 'REPORT', limit: 1 });
      expect(first.entries).toHaveLength(1);
      expect(first.entries[0].name).toBe('Reports');
      expect(first.nextCursor).not.toBeNull();
      const second = await provider.search(ctx, { query: 'REPORT', limit: 1, cursor: first.nextCursor });
      expect(second.entries.map((entry) => entry.name)).toEqual(['annual-report.pdf']);
      expect(second.entries[0].parentId).toBe(reportsId);
      expect(second.nextCursor).toBeNull();
      expect(server.requests).toContain('/listfolder');
    });
  });

  it('returns an empty page when nothing matches', async () => {
    await withFakePcloud({}, async (server) => {
      server.seedFile('only.txt', 0, 'x');
      const page = await createPcloudProvider().search(makeContext(), { query: 'zzz-unfindable' });
      expect(page.entries).toEqual([]);
      expect(page.nextCursor).toBeNull();
    });
  });

  it('rejects an empty query and unsupported caps', async () => {
    await withFakePcloud({}, async () => {
      const ctx = makeContext();
      const provider = createPcloudProvider();
      const limited = createPcloudProvider({ capabilities: ['list'] });
      await expectProviderCode(provider.search(ctx, { query: '   ' }), 'ERR_INVALID_INPUT');
      await expectProviderCode(provider.search(ctx, { query: 'x', limit: 0 }), 'ERR_INVALID_INPUT');
      await expectProviderCode(limited.search(ctx, { query: 'x' }), 'ERR_CAPABILITY_UNSUPPORTED');
    });
  });
});
