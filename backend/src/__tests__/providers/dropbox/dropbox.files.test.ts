import { describe, expect, it } from 'vitest';
import { createDropboxProvider } from '../../../providers/dropbox/index.js';
import { expectProviderCode, makeContext, withFakeDropbox, type FakeDropboxServer } from './server.js';

async function seedTree(server: FakeDropboxServer): Promise<{ docs: string; report: string; notes: string }> {
  const docs = server.seedFolder('docs');
  const report = server.seedFile('report.txt', null, 'quarterly numbers', 'text/plain');
  const notes = server.seedFile('notes.md', docs, '# notes', 'text/markdown');
  return { docs, report, notes };
}

describe('dropbox listing', () => {
  it('lists the root folder with metadata', async () => {
    await withFakeDropbox({}, async (server) => {
      const { docs, report } = await seedTree(server);
      const provider = createDropboxProvider();
      const result = await provider.list(makeContext(), { parentId: null });

      expect(result.entries.map((entry) => entry.remoteId)).toEqual([docs, report]);
      expect(result.nextCursor).toBeNull();

      const folder = result.entries[0];
      expect(folder).toMatchObject({
        name: 'docs',
        mimeType: 'inode/directory',
        sizeBytes: 0n,
        parentId: null,
        isFolder: true,
      });
      const file = result.entries[1];
      expect(file).toMatchObject({
        name: 'report.txt',
        mimeType: 'application/octet-stream',
        sizeBytes: BigInt('quarterly numbers'.length),
        parentId: null,
        isFolder: false,
      });
      expect(file.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(Number.isNaN(Date.parse(file.createdAt ?? ''))).toBe(false);
      expect(server.requests).toContain('/2/files/list_folder');
    });
  });

  it('treats the literal root parent id as the root folder', async () => {
    await withFakeDropbox({}, async (server) => {
      await seedTree(server);
      const provider = createDropboxProvider();
      const result = await provider.list(makeContext(), { parentId: 'root' });
      expect(result.entries).toHaveLength(2);
      expect(server.requests.filter((path) => path === '/2/files/list_folder')).toHaveLength(1);
    });
  });

  it('lists a nested folder by remote id', async () => {
    await withFakeDropbox({}, async (server) => {
      const { docs, notes } = await seedTree(server);
      const provider = createDropboxProvider();
      const result = await provider.list(makeContext(), { parentId: docs });

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]).toMatchObject({
        remoteId: notes,
        name: 'notes.md',
        parentId: docs,
        isFolder: false,
      });
    });
  });

  it('paginates with a stable cursor', async () => {
    await withFakeDropbox({}, async (server) => {
      const ids = [
        server.seedFile('a.txt', null, 'a'),
        server.seedFile('b.txt', null, 'b'),
        server.seedFile('c.txt', null, 'c'),
      ];
      const provider = createDropboxProvider();
      const ctx = makeContext();

      const first = await provider.list(ctx, { parentId: null, limit: 2 });
      expect(first.entries.map((entry) => entry.remoteId)).toEqual([ids[0], ids[1]]);
      expect(first.nextCursor).toBeTruthy();

      const second = await provider.list(ctx, { parentId: null, limit: 2, cursor: first.nextCursor });
      expect(second.entries.map((entry) => entry.remoteId)).toEqual([ids[2]]);
      expect(second.nextCursor).toBeNull();
      expect(server.requests).toContain('/2/files/list_folder/continue');
    });
  });

  it('rejects an invalid page size', async () => {
    await withFakeDropbox({}, async () => {
      const provider = createDropboxProvider();
      await expectProviderCode(provider.list(makeContext(), { parentId: null, limit: 0 }), 'ERR_INVALID_INPUT');
      await expectProviderCode(provider.list(makeContext(), { parentId: null, limit: 1.5 }), 'ERR_INVALID_INPUT');
    });
  });

  it('maps a missing parent folder to ERR_NOT_FOUND', async () => {
    await withFakeDropbox({}, async () => {
      const provider = createDropboxProvider();
      await expectProviderCode(provider.list(makeContext(), { parentId: 'id:missing' }), 'ERR_NOT_FOUND');
    });
  });

  it('honours the list capability gate', async () => {
    await withFakeDropbox({}, async () => {
      const provider = createDropboxProvider({ capabilities: ['getMetadata'] });
      await expectProviderCode(provider.list(makeContext(), { parentId: null }), 'ERR_CAPABILITY_UNSUPPORTED');
    });
  });
});

describe('dropbox metadata', () => {
  it('synthesises the root folder metadata', async () => {
    await withFakeDropbox({}, async (server) => {
      const provider = createDropboxProvider();
      const root = await provider.getMetadata(makeContext(), { remoteId: 'root' });
      expect(root).toEqual({
        remoteId: 'root',
        name: '',
        mimeType: 'inode/directory',
        sizeBytes: 0n,
        parentId: null,
        isFolder: true,
        createdAt: null,
        modifiedAt: null,
        checksum: null,
        webUrl: null,
      });
      expect(server.requests.filter((path) => path === '/2/files/get_metadata')).toHaveLength(0);
    });
  });

  it('reads a file with its parent id', async () => {
    await withFakeDropbox({}, async (server) => {
      const { docs, notes } = await seedTree(server);
      const provider = createDropboxProvider();
      const meta = await provider.getMetadata(makeContext(), { remoteId: notes });

      expect(meta).toMatchObject({
        remoteId: notes,
        name: 'notes.md',
        parentId: docs,
        isFolder: false,
        sizeBytes: BigInt('# notes'.length),
      });
      expect(meta.mimeType).toBe('application/octet-stream');
      expect(meta.webUrl).toBeNull();
    });
  });

  it('maps a missing remote id to ERR_NOT_FOUND', async () => {
    await withFakeDropbox({}, async () => {
      const provider = createDropboxProvider();
      await expectProviderCode(provider.getMetadata(makeContext(), { remoteId: 'id:nope' }), 'ERR_NOT_FOUND');
    });
  });

  it('requires a remote id', async () => {
    await withFakeDropbox({}, async () => {
      const provider = createDropboxProvider();
      await expectProviderCode(provider.getMetadata(makeContext(), { remoteId: '' }), 'ERR_INVALID_INPUT');
      await expectProviderCode(provider.getMetadata(makeContext(), {} as never), 'ERR_INVALID_INPUT');
    });
  });
});

describe('dropbox folder creation', () => {
  it('creates a folder under the resolved parent', async () => {
    await withFakeDropbox({}, async (server) => {
      const { docs } = await seedTree(server);
      const provider = createDropboxProvider();
      const folder = await provider.createFolder(makeContext(), { name: 'invoices', parentId: docs });

      expect(folder).toMatchObject({ name: 'invoices', parentId: docs, isFolder: true, sizeBytes: 0n });
      expect(server.requests).toContain('/2/files/create_folder_v2');
    });
  });

  it('returns the existing folder when the name is already taken', async () => {
    await withFakeDropbox({}, async () => {
      const provider = createDropboxProvider();
      const ctx = makeContext();
      const first = await provider.createFolder(ctx, { name: 'shared', parentId: null });
      const second = await provider.createFolder(ctx, { name: 'shared', parentId: null });

      expect(second.remoteId).toBe(first.remoteId);
      expect(second.isFolder).toBe(true);
    });
  });

  it('rejects invalid folder names', async () => {
    await withFakeDropbox({}, async () => {
      const provider = createDropboxProvider();
      const ctx = makeContext();
      for (const name of ['', '   ', 'nested/name', '.', '..']) {
        await expectProviderCode(provider.createFolder(ctx, { name, parentId: null }), 'ERR_INVALID_INPUT');
      }
    });
  });

  it('maps a missing parent folder to ERR_NOT_FOUND', async () => {
    await withFakeDropbox({}, async () => {
      const provider = createDropboxProvider();
      await expectProviderCode(
        provider.createFolder(makeContext(), { name: 'child', parentId: 'id:missing' }),
        'ERR_NOT_FOUND',
      );
    });
  });

  it('honours the createFolder capability gate', async () => {
    await withFakeDropbox({}, async () => {
      const provider = createDropboxProvider({ capabilities: ['list'] });
      await expectProviderCode(
        provider.createFolder(makeContext(), { name: 'x', parentId: null }),
        'ERR_CAPABILITY_UNSUPPORTED',
      );
    });
  });
});

describe('dropbox rename', () => {
  it('renames a file in place', async () => {
    await withFakeDropbox({}, async (server) => {
      const { docs, report } = await seedTree(server);
      const provider = createDropboxProvider();
      const renamed = await provider.rename(makeContext(), { remoteId: report, newName: 'summary.txt' });

      expect(renamed).toMatchObject({ remoteId: report, name: 'summary.txt', parentId: null });
      expect(server.readFile(report).toString('utf8')).toBe('quarterly numbers');
      expect(server.requests).toContain('/2/files/move_v2');
      expect(docs).toBeTruthy();
    });
  });

  it('skips the write when the name is unchanged', async () => {
    await withFakeDropbox({}, async (server) => {
      const { report } = await seedTree(server);
      const provider = createDropboxProvider();
      const result = await provider.rename(makeContext(), { remoteId: report, newName: 'report.txt' });

      expect(result.remoteId).toBe(report);
      expect(server.requests.filter((path) => path === '/2/files/move_v2')).toHaveLength(0);
    });
  });

  it('rejects an invalid new name', async () => {
    await withFakeDropbox({}, async (server) => {
      const { report } = await seedTree(server);
      const provider = createDropboxProvider();
      await expectProviderCode(
        provider.rename(makeContext(), { remoteId: report, newName: 'a/b' }),
        'ERR_INVALID_INPUT',
      );
    });
  });

  it('maps a name conflict to ERR_INVALID_INPUT', async () => {
    await withFakeDropbox({}, async (server) => {
      const { report } = await seedTree(server);
      server.seedFile('taken.txt', null, 'occupied');
      const provider = createDropboxProvider();
      await expectProviderCode(
        provider.rename(makeContext(), { remoteId: report, newName: 'taken.txt' }),
        'ERR_INVALID_INPUT',
      );
    });
  });

  it('maps a missing source to ERR_NOT_FOUND', async () => {
    await withFakeDropbox({}, async () => {
      const provider = createDropboxProvider();
      await expectProviderCode(
        provider.rename(makeContext(), { remoteId: 'id:missing', newName: 'next.txt' }),
        'ERR_NOT_FOUND',
      );
    });
  });
});

describe('dropbox move', () => {
  it('moves a file into a folder', async () => {
    await withFakeDropbox({}, async (server) => {
      const { docs, report } = await seedTree(server);
      const provider = createDropboxProvider();
      const moved = await provider.move(makeContext(), { remoteId: report, newParentId: docs });

      expect(moved).toMatchObject({ remoteId: report, name: 'report.txt', parentId: docs });
      expect(server.readFile(report).toString('utf8')).toBe('quarterly numbers');
    });
  });

  it('moves a file back to the root folder', async () => {
    await withFakeDropbox({}, async (server) => {
      const { docs, notes } = await seedTree(server);
      const provider = createDropboxProvider();
      const moved = await provider.move(makeContext(), { remoteId: notes, newParentId: null });

      expect(moved.parentId).toBeNull();
      expect(moved.remoteId).toBe(notes);
      expect(docs).toBeTruthy();
    });
  });

  it('skips the write when the file is already in place', async () => {
    await withFakeDropbox({}, async (server) => {
      const { report } = await seedTree(server);
      const provider = createDropboxProvider();
      const result = await provider.move(makeContext(), { remoteId: report, newParentId: null });

      expect(result.remoteId).toBe(report);
      expect(server.requests.filter((path) => path === '/2/files/move_v2')).toHaveLength(0);
    });
  });

  it('rejects moving a folder into itself', async () => {
    await withFakeDropbox({}, async (server) => {
      const { docs } = await seedTree(server);
      const provider = createDropboxProvider();
      await expectProviderCode(
        provider.move(makeContext(), { remoteId: docs, newParentId: docs }),
        'ERR_INVALID_INPUT',
      );
    });
  });

  it('rejects a destination that is a file', async () => {
    await withFakeDropbox({}, async (server) => {
      const { report, notes } = await seedTree(server);
      const provider = createDropboxProvider();
      await expectProviderCode(
        provider.move(makeContext(), { remoteId: notes, newParentId: report }),
        'ERR_INVALID_INPUT',
      );
    });
  });

  it('maps a missing destination folder to ERR_NOT_FOUND', async () => {
    await withFakeDropbox({}, async (server) => {
      const { report } = await seedTree(server);
      const provider = createDropboxProvider();
      await expectProviderCode(
        provider.move(makeContext(), { remoteId: report, newParentId: 'id:missing' }),
        'ERR_NOT_FOUND',
      );
    });
  });

  it('honours the move capability gate', async () => {
    await withFakeDropbox({}, async () => {
      const provider = createDropboxProvider({ capabilities: ['list'] });
      await expectProviderCode(
        provider.move(makeContext(), { remoteId: 'id:x', newParentId: null }),
        'ERR_CAPABILITY_UNSUPPORTED',
      );
    });
  });
});

describe('dropbox copy', () => {
  it('copies a file with an optional new name', async () => {
    await withFakeDropbox({}, async (server) => {
      const { docs, report } = await seedTree(server);
      const provider = createDropboxProvider();
      const copy = await provider.copy(makeContext(), {
        remoteId: report,
        newParentId: docs,
        newName: 'report-copy.txt',
      });

      expect(copy).toMatchObject({
        name: 'report-copy.txt',
        parentId: docs,
        isFolder: false,
        sizeBytes: BigInt('quarterly numbers'.length),
      });
      expect(copy.remoteId).not.toBe(report);
      expect(server.readFile(copy.remoteId).toString('utf8')).toBe('quarterly numbers');
      expect(server.requests).toContain('/2/files/copy_v2');
    });
  });

  it('keeps the original name when no new name is given', async () => {
    await withFakeDropbox({}, async (server) => {
      const { docs, report } = await seedTree(server);
      const provider = createDropboxProvider();
      const copy = await provider.copy(makeContext(), { remoteId: report, newParentId: docs });

      expect(copy.name).toBe('report.txt');
      expect(copy.parentId).toBe(docs);
      expect(copy.remoteId).not.toBe(report);
    });
  });

  it('maps a name conflict to ERR_INVALID_INPUT', async () => {
    await withFakeDropbox({}, async (server) => {
      const { report } = await seedTree(server);
      server.seedFile('taken.txt', null, 'occupied');
      const provider = createDropboxProvider();
      await expectProviderCode(
        provider.copy(makeContext(), { remoteId: report, newParentId: null, newName: 'taken.txt' }),
        'ERR_INVALID_INPUT',
      );
    });
  });

  it('maps a missing source to ERR_NOT_FOUND', async () => {
    await withFakeDropbox({}, async () => {
      const provider = createDropboxProvider();
      await expectProviderCode(
        provider.copy(makeContext(), { remoteId: 'id:missing', newParentId: null }),
        'ERR_NOT_FOUND',
      );
    });
  });

  it('honours the copy capability gate', async () => {
    await withFakeDropbox({}, async () => {
      const provider = createDropboxProvider({ capabilities: ['list'] });
      await expectProviderCode(
        provider.copy(makeContext(), { remoteId: 'id:x', newParentId: null }),
        'ERR_CAPABILITY_UNSUPPORTED',
      );
    });
  });
});

describe('dropbox delete', () => {
  it('removes a file and its folder subtree', async () => {
    await withFakeDropbox({}, async (server) => {
      const { docs, report, notes } = await seedTree(server);
      const provider = createDropboxProvider();
      const ctx = makeContext();
      const before = server.nodeCount();

      await provider.delete(ctx, { remoteId: docs });
      expect(server.nodeCount()).toBe(before - 2);
      await expectProviderCode(provider.getMetadata(ctx, { remoteId: notes }), 'ERR_NOT_FOUND');
      expect(server.requests).toContain('/2/files/delete_v2');
      expect(report).toBeTruthy();
    });
  });

  it('ignores the permanent flag because Dropbox only offers a trash', async () => {
    await withFakeDropbox({}, async (server) => {
      const { report } = await seedTree(server);
      const provider = createDropboxProvider();
      await provider.delete(makeContext(), { remoteId: report, permanent: true });
      await expectProviderCode(provider.getMetadata(makeContext(), { remoteId: report }), 'ERR_NOT_FOUND');
    });
  });

  it('refuses to delete the root folder', async () => {
    await withFakeDropbox({}, async (server) => {
      const provider = createDropboxProvider();
      const before = server.nodeCount();
      await expectProviderCode(provider.delete(makeContext(), { remoteId: 'root' }), 'ERR_INVALID_INPUT');
      expect(server.nodeCount()).toBe(before);
    });
  });

  it('maps a missing remote id to ERR_NOT_FOUND', async () => {
    await withFakeDropbox({}, async () => {
      const provider = createDropboxProvider();
      await expectProviderCode(provider.delete(makeContext(), { remoteId: 'id:missing' }), 'ERR_NOT_FOUND');
    });
  });

  it('honours the delete capability gate', async () => {
    await withFakeDropbox({}, async () => {
      const provider = createDropboxProvider({ capabilities: ['list'] });
      await expectProviderCode(provider.delete(makeContext(), { remoteId: 'id:x' }), 'ERR_CAPABILITY_UNSUPPORTED');
    });
  });
});

describe('dropbox search', () => {
  it('finds files and folders by name across the account', async () => {
    await withFakeDropbox({}, async (server) => {
      const { docs, report, notes } = await seedTree(server);
      server.seedFile('report-archive.txt', docs, 'older report');
      const provider = createDropboxProvider();

      const result = await provider.search(makeContext(), { query: 'report' });

      expect(result.entries.map((entry) => entry.name)).toEqual(['report-archive.txt', 'report.txt']);
      expect(result.entries[1]).toMatchObject({ remoteId: report, parentId: null, isFolder: false });
      expect(result.entries[0].parentId).toBe(docs);
      expect(result.nextCursor).toBeNull();
      expect(server.requests).toContain('/2/files/search_v2');
      expect(notes).toBeTruthy();
    });
  });

  it('paginates search results through search/continue_v2', async () => {
    await withFakeDropbox({}, async (server) => {
      server.seedFile('alpha-1.txt', null, 'x');
      server.seedFile('alpha-2.txt', null, 'x');
      server.seedFile('alpha-3.txt', null, 'x');
      const provider = createDropboxProvider();
      const ctx = makeContext();

      const first = await provider.search(ctx, { query: 'alpha', limit: 1 });
      expect(first.entries.map((entry) => entry.name)).toEqual(['alpha-1.txt']);
      expect(first.nextCursor).toBeTruthy();

      const second = await provider.search(ctx, { query: 'alpha', limit: 1, cursor: first.nextCursor });
      expect(second.entries.map((entry) => entry.name)).toEqual(['alpha-2.txt']);
      expect(second.nextCursor).toBeTruthy();

      const third = await provider.search(ctx, { query: 'alpha', limit: 1, cursor: second.nextCursor });
      expect(third.entries.map((entry) => entry.name)).toEqual(['alpha-3.txt']);
      expect(third.nextCursor).toBeNull();
      expect(server.requests).toContain('/2/files/search/continue_v2');
    });
  });

  it('returns an empty page when nothing matches', async () => {
    await withFakeDropbox({}, async (server) => {
      await seedTree(server);
      const provider = createDropboxProvider();
      const result = await provider.search(makeContext(), { query: 'nothing-matches-this' });

      expect(result.entries).toEqual([]);
      expect(result.nextCursor).toBeNull();
    });
  });

  it('requires a non-empty query', async () => {
    await withFakeDropbox({}, async () => {
      const provider = createDropboxProvider();
      const ctx = makeContext();
      await expectProviderCode(provider.search(ctx, { query: '' }), 'ERR_INVALID_INPUT');
      await expectProviderCode(provider.search(ctx, { query: '   ' }), 'ERR_INVALID_INPUT');
      await expectProviderCode(provider.search(ctx, {} as never), 'ERR_INVALID_INPUT');
    });
  });

  it('rejects an invalid page size', async () => {
    await withFakeDropbox({}, async () => {
      const provider = createDropboxProvider();
      await expectProviderCode(
        provider.search(makeContext(), { query: 'x', limit: 0 }),
        'ERR_INVALID_INPUT',
      );
    });
  });

  it('honours the search capability gate', async () => {
    await withFakeDropbox({}, async () => {
      const provider = createDropboxProvider({ capabilities: ['list'] });
      await expectProviderCode(provider.search(makeContext(), { query: 'anything' }), 'ERR_CAPABILITY_UNSUPPORTED');
    });
  });
});

describe('dropbox sharing', () => {
  it('creates a public link on demand', async () => {
    await withFakeDropbox({}, async (server) => {
      const { report } = await seedTree(server);
      const provider = createDropboxProvider();
      const result = await provider.createShare(makeContext(), { remoteId: report, visibility: 'public_read' });

      expect(result.visibility).toBe('public_read');
      expect(result.url).toBe(`${server.origin}/link/${report}`);
      expect(result.expiresAt).toBeNull();
      expect(server.shareCount()).toBe(1);
      expect(server.requests).toContain('/2/sharing/create_shared_link_with_settings');
    });
  });

  it('reuses an existing shared link instead of failing', async () => {
    await withFakeDropbox({}, async (server) => {
      const { report } = await seedTree(server);
      const provider = createDropboxProvider();
      const ctx = makeContext();

      const first = await provider.createShare(ctx, { remoteId: report, visibility: 'public_read' });
      const second = await provider.createShare(ctx, { remoteId: report, visibility: 'public_read' });

      expect(second.url).toBe(first.url);
      expect(server.shareCount()).toBe(1);
      expect(server.requests).toContain('/2/sharing/list_shared_links');
    });
  });

  it('applies an expiry to the shared link', async () => {
    await withFakeDropbox({}, async (server) => {
      const { report } = await seedTree(server);
      const provider = createDropboxProvider();
      const result = await provider.createShare(makeContext(), {
        remoteId: report,
        visibility: 'public_read',
        expiresAt: '2030-06-01T12:00:00.000Z',
      });

      expect(result.expiresAt).toBe('2030-06-01T12:00:00Z');
    });
  });

  it('rejects malformed and past expiry timestamps', async () => {
    await withFakeDropbox({}, async (server) => {
      const { report } = await seedTree(server);
      const provider = createDropboxProvider();
      const ctx = makeContext();
      await expectProviderCode(
        provider.createShare(ctx, { remoteId: report, visibility: 'public_read', expiresAt: 'never' }),
        'ERR_INVALID_INPUT',
      );
      await expectProviderCode(
        provider.createShare(ctx, {
          remoteId: report,
          visibility: 'public_read',
          expiresAt: '2020-01-01T00:00:00.000Z',
        }),
        'ERR_INVALID_INPUT',
      );
      expect(server.shareCount()).toBe(0);
    });
  });

  it('rejects private visibility because Dropbox sharing is link-based', async () => {
    await withFakeDropbox({}, async (server) => {
      const { report } = await seedTree(server);
      const provider = createDropboxProvider();
      await expectProviderCode(
        provider.createShare(makeContext(), { remoteId: report, visibility: 'private' }),
        'ERR_INVALID_INPUT',
      );
      expect(server.shareCount()).toBe(0);
    });
  });

  it('revokes an existing link and stays idempotent afterwards', async () => {
    await withFakeDropbox({}, async (server) => {
      const { report } = await seedTree(server);
      const provider = createDropboxProvider();
      const ctx = makeContext();

      await provider.createShare(ctx, { remoteId: report, visibility: 'public_read' });
      expect(server.shareCount()).toBe(1);

      await provider.revokeShare(ctx, { remoteId: report });
      expect(server.shareCount()).toBe(0);

      await provider.revokeShare(ctx, { remoteId: report });
      expect(server.shareCount()).toBe(0);
      expect(server.requests).toContain('/2/sharing/revoke_shared_link');
    });
  });

  it('maps a missing remote id to ERR_NOT_FOUND', async () => {
    await withFakeDropbox({}, async () => {
      const provider = createDropboxProvider();
      await expectProviderCode(
        provider.createShare(makeContext(), { remoteId: 'id:missing', visibility: 'public_read' }),
        'ERR_NOT_FOUND',
      );
    });
  });

  it('honours the createShare and revokeShare capability gates', async () => {
    await withFakeDropbox({}, async () => {
      const provider = createDropboxProvider({ capabilities: ['list'] });
      await expectProviderCode(
        provider.createShare(makeContext(), { remoteId: 'x', visibility: 'public_read' }),
        'ERR_CAPABILITY_UNSUPPORTED',
      );
      await expectProviderCode(provider.revokeShare(makeContext(), { remoteId: 'x' }), 'ERR_CAPABILITY_UNSUPPORTED');
    });
  });
});
