import { describe, expect, it } from 'vitest';
import { createOnedriveProvider } from '../../../providers/onedrive/index.js';
import { expectProviderCode, makeContext, withFakeOnedrive, type FakeOnedriveServer } from './server.js';

async function seedTree(server: FakeOnedriveServer): Promise<{ docs: string; report: string; notes: string }> {
  const docs = server.seedFolder('docs');
  const report = server.seedFile('report.txt', null, 'quarterly numbers', 'text/plain');
  const notes = server.seedFile('notes.md', docs, '# notes', 'text/markdown');
  return { docs, report, notes };
}

describe('onedrive listing', () => {
  it('lists the root folder with metadata', async () => {
    await withFakeOnedrive({}, async (server) => {
      const { docs, report } = await seedTree(server);
      const provider = createOnedriveProvider();
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
        mimeType: 'text/plain',
        sizeBytes: BigInt('quarterly numbers'.length),
        parentId: null,
        isFolder: false,
      });
      expect(file.checksum).toBeTruthy();
      expect(Number.isNaN(Date.parse(file.createdAt ?? ''))).toBe(false);
      expect(server.requests).toContain('/v1.0/me/drive/root/children');
    });
  });

  it('treats the literal root parent id as the root folder', async () => {
    await withFakeOnedrive({}, async (server) => {
      await seedTree(server);
      const provider = createOnedriveProvider();
      const result = await provider.list(makeContext(), { parentId: 'root' });
      expect(result.entries).toHaveLength(2);
      expect(server.requests.filter((path) => path === '/v1.0/me/drive/root/children')).toHaveLength(1);
    });
  });

  it('lists a nested folder by remote id', async () => {
    await withFakeOnedrive({}, async (server) => {
      const { docs, notes } = await seedTree(server);
      const provider = createOnedriveProvider();
      const result = await provider.list(makeContext(), { parentId: docs });

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]).toMatchObject({
        remoteId: notes,
        name: 'notes.md',
        parentId: docs,
        isFolder: false,
        mimeType: 'text/markdown',
      });
    });
  });

  it('paginates with an @odata.nextLink cursor', async () => {
    await withFakeOnedrive({}, async (server) => {
      const ids = [
        server.seedFile('a.txt', null, 'a'),
        server.seedFile('b.txt', null, 'b'),
        server.seedFile('c.txt', null, 'c'),
      ];
      const provider = createOnedriveProvider();
      const ctx = makeContext();

      const first = await provider.list(ctx, { parentId: null, limit: 2 });
      expect(first.entries.map((entry) => entry.remoteId)).toEqual([ids[0], ids[1]]);
      expect(first.nextCursor).toContain('skiptoken=2');

      const second = await provider.list(ctx, { parentId: null, limit: 2, cursor: first.nextCursor });
      expect(second.entries.map((entry) => entry.remoteId)).toEqual([ids[2]]);
      expect(second.nextCursor).toBeNull();
      expect(server.requests).toContain('/v1.0/me/drive/root/children');
    });
  });

  it('rejects an invalid page size', async () => {
    await withFakeOnedrive({}, async () => {
      const provider = createOnedriveProvider();
      await expectProviderCode(provider.list(makeContext(), { parentId: null, limit: 0 }), 'ERR_INVALID_INPUT');
      await expectProviderCode(provider.list(makeContext(), { parentId: null, limit: 1.5 }), 'ERR_INVALID_INPUT');
    });
  });

  it('maps a missing parent folder to ERR_NOT_FOUND', async () => {
    await withFakeOnedrive({}, async () => {
      const provider = createOnedriveProvider();
      await expectProviderCode(provider.list(makeContext(), { parentId: 'item-missing' }), 'ERR_NOT_FOUND');
    });
  });

  it('honours the list capability gate', async () => {
    await withFakeOnedrive({}, async () => {
      const provider = createOnedriveProvider({ capabilities: ['getMetadata'] });
      await expectProviderCode(provider.list(makeContext(), { parentId: null }), 'ERR_CAPABILITY_UNSUPPORTED');
    });
  });
});

describe('onedrive metadata', () => {
  it('reads the root folder', async () => {
    await withFakeOnedrive({}, async (server) => {
      const provider = createOnedriveProvider();
      const root = await provider.getMetadata(makeContext(), { remoteId: 'root' });
      expect(root).toMatchObject({
        remoteId: 'root',
        mimeType: 'inode/directory',
        sizeBytes: 0n,
        parentId: null,
        isFolder: true,
      });
      expect(server.requests).toContain('/v1.0/me/drive/root');
    });
  });

  it('reads a file with its parent id', async () => {
    await withFakeOnedrive({}, async (server) => {
      const { docs, notes } = await seedTree(server);
      const provider = createOnedriveProvider();
      const meta = await provider.getMetadata(makeContext(), { remoteId: notes });

      expect(meta).toMatchObject({
        remoteId: notes,
        name: 'notes.md',
        parentId: docs,
        isFolder: false,
        sizeBytes: BigInt('# notes'.length),
        mimeType: 'text/markdown',
      });
      expect(meta.webUrl).toBeTruthy();
    });
  });

  it('maps a missing remote id to ERR_NOT_FOUND', async () => {
    await withFakeOnedrive({}, async () => {
      const provider = createOnedriveProvider();
      await expectProviderCode(provider.getMetadata(makeContext(), { remoteId: 'item-nope' }), 'ERR_NOT_FOUND');
    });
  });

  it('requires a remote id', async () => {
    await withFakeOnedrive({}, async () => {
      const provider = createOnedriveProvider();
      await expectProviderCode(provider.getMetadata(makeContext(), { remoteId: '' }), 'ERR_INVALID_INPUT');
      await expectProviderCode(provider.getMetadata(makeContext(), {} as never), 'ERR_INVALID_INPUT');
    });
  });
});

describe('onedrive folder creation', () => {
  it('creates a folder under the resolved parent', async () => {
    await withFakeOnedrive({}, async (server) => {
      const { docs } = await seedTree(server);
      const provider = createOnedriveProvider();
      const folder = await provider.createFolder(makeContext(), { name: 'invoices', parentId: docs });

      expect(folder).toMatchObject({ name: 'invoices', parentId: docs, isFolder: true, sizeBytes: 0n });
      expect(server.requests).toContain(`/v1.0/me/drive/items/${docs}/children`);
    });
  });

  it('returns the existing folder when the name is already taken', async () => {
    await withFakeOnedrive({}, async () => {
      const provider = createOnedriveProvider();
      const ctx = makeContext();
      const first = await provider.createFolder(ctx, { name: 'shared', parentId: null });
      const second = await provider.createFolder(ctx, { name: 'shared', parentId: null });

      expect(second.remoteId).toBe(first.remoteId);
      expect(second.isFolder).toBe(true);
    });
  });

  it('rejects invalid folder names', async () => {
    await withFakeOnedrive({}, async () => {
      const provider = createOnedriveProvider();
      const ctx = makeContext();
      for (const name of ['', '   ', 'nested/name', '.', '..']) {
        await expectProviderCode(provider.createFolder(ctx, { name, parentId: null }), 'ERR_INVALID_INPUT');
      }
    });
  });

  it('maps a missing parent folder to ERR_NOT_FOUND', async () => {
    await withFakeOnedrive({}, async () => {
      const provider = createOnedriveProvider();
      await expectProviderCode(
        provider.createFolder(makeContext(), { name: 'child', parentId: 'item-missing' }),
        'ERR_NOT_FOUND',
      );
    });
  });

  it('honours the createFolder capability gate', async () => {
    await withFakeOnedrive({}, async () => {
      const provider = createOnedriveProvider({ capabilities: ['list'] });
      await expectProviderCode(
        provider.createFolder(makeContext(), { name: 'x', parentId: null }),
        'ERR_CAPABILITY_UNSUPPORTED',
      );
    });
  });
});

describe('onedrive rename', () => {
  it('renames a file in place', async () => {
    await withFakeOnedrive({}, async (server) => {
      const { report } = await seedTree(server);
      const provider = createOnedriveProvider();
      const renamed = await provider.rename(makeContext(), { remoteId: report, newName: 'summary.txt' });

      expect(renamed).toMatchObject({ remoteId: report, name: 'summary.txt', parentId: null });
      expect(server.readFile(report).toString('utf8')).toBe('quarterly numbers');
      expect(server.requests).toContain(`/v1.0/me/drive/items/${report}`);
    });
  });

  it('skips the write when the name is unchanged', async () => {
    await withFakeOnedrive({}, async (server) => {
      const { report } = await seedTree(server);
      const provider = createOnedriveProvider();
      const result = await provider.rename(makeContext(), { remoteId: report, newName: 'report.txt' });

      expect(result.remoteId).toBe(report);
      expect(server.requests.filter((path) => path === `/v1.0/me/drive/items/${report}`)).toHaveLength(1);
    });
  });

  it('rejects an invalid new name', async () => {
    await withFakeOnedrive({}, async (server) => {
      const { report } = await seedTree(server);
      const provider = createOnedriveProvider();
      await expectProviderCode(
        provider.rename(makeContext(), { remoteId: report, newName: 'a/b' }),
        'ERR_INVALID_INPUT',
      );
    });
  });

  it('maps a name conflict to ERR_INVALID_INPUT', async () => {
    await withFakeOnedrive({}, async (server) => {
      const { report } = await seedTree(server);
      server.seedFile('taken.txt', null, 'occupied');
      const provider = createOnedriveProvider();
      await expectProviderCode(
        provider.rename(makeContext(), { remoteId: report, newName: 'taken.txt' }),
        'ERR_INVALID_INPUT',
      );
    });
  });

  it('maps a missing source to ERR_NOT_FOUND', async () => {
    await withFakeOnedrive({}, async () => {
      const provider = createOnedriveProvider();
      await expectProviderCode(
        provider.rename(makeContext(), { remoteId: 'item-missing', newName: 'next.txt' }),
        'ERR_NOT_FOUND',
      );
    });
  });
});

describe('onedrive move', () => {
  it('moves a file into a folder', async () => {
    await withFakeOnedrive({}, async (server) => {
      const { docs, report } = await seedTree(server);
      const provider = createOnedriveProvider();
      const moved = await provider.move(makeContext(), { remoteId: report, newParentId: docs });

      expect(moved).toMatchObject({ remoteId: report, name: 'report.txt', parentId: docs });
      expect(server.readFile(report).toString('utf8')).toBe('quarterly numbers');
    });
  });

  it('moves a file back to the root folder', async () => {
    await withFakeOnedrive({}, async (server) => {
      const { docs, notes } = await seedTree(server);
      const provider = createOnedriveProvider();
      const moved = await provider.move(makeContext(), { remoteId: notes, newParentId: null });

      expect(moved.parentId).toBeNull();
      expect(moved.remoteId).toBe(notes);
      expect(docs).toBeTruthy();
    });
  });

  it('skips the write when the file is already in place', async () => {
    await withFakeOnedrive({}, async (server) => {
      const { report } = await seedTree(server);
      const provider = createOnedriveProvider();
      const result = await provider.move(makeContext(), { remoteId: report, newParentId: null });

      expect(result.remoteId).toBe(report);
      expect(server.requests.filter((path) => path === `/v1.0/me/drive/items/${report}`)).toHaveLength(1);
    });
  });

  it('rejects moving a folder into itself', async () => {
    await withFakeOnedrive({}, async (server) => {
      const { docs } = await seedTree(server);
      const provider = createOnedriveProvider();
      await expectProviderCode(
        provider.move(makeContext(), { remoteId: docs, newParentId: docs }),
        'ERR_INVALID_INPUT',
      );
    });
  });

  it('rejects a destination that is a file', async () => {
    await withFakeOnedrive({}, async (server) => {
      const { report, notes } = await seedTree(server);
      const provider = createOnedriveProvider();
      await expectProviderCode(
        provider.move(makeContext(), { remoteId: notes, newParentId: report }),
        'ERR_INVALID_INPUT',
      );
    });
  });

  it('maps a missing destination folder to ERR_NOT_FOUND', async () => {
    await withFakeOnedrive({}, async (server) => {
      const { report } = await seedTree(server);
      const provider = createOnedriveProvider();
      await expectProviderCode(
        provider.move(makeContext(), { remoteId: report, newParentId: 'item-missing' }),
        'ERR_NOT_FOUND',
      );
    });
  });

  it('honours the move capability gate', async () => {
    await withFakeOnedrive({}, async () => {
      const provider = createOnedriveProvider({ capabilities: ['list'] });
      await expectProviderCode(
        provider.move(makeContext(), { remoteId: 'item-x', newParentId: null }),
        'ERR_CAPABILITY_UNSUPPORTED',
      );
    });
  });
});

describe('onedrive copy', () => {
  it('copies a file with an optional new name', async () => {
    await withFakeOnedrive({}, async (server) => {
      const { docs, report } = await seedTree(server);
      const provider = createOnedriveProvider({ copyPollDelayMs: 0 });
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
      expect(server.requests).toContain(`/v1.0/me/drive/items/${report}/copy`);
    });
  });

  it('keeps the original name when no new name is given', async () => {
    await withFakeOnedrive({}, async (server) => {
      const { docs, report } = await seedTree(server);
      const provider = createOnedriveProvider({ copyPollDelayMs: 0 });
      const copy = await provider.copy(makeContext(), { remoteId: report, newParentId: docs });

      expect(copy.name).toBe('report.txt');
      expect(copy.parentId).toBe(docs);
      expect(copy.remoteId).not.toBe(report);
    });
  });

  it('resolves the copy by name when the monitor body is empty', async () => {
    await withFakeOnedrive({ copyMonitorBare: true }, async (server) => {
      const { docs, report } = await seedTree(server);
      const provider = createOnedriveProvider({ copyPollDelayMs: 0 });
      const copy = await provider.copy(makeContext(), {
        remoteId: report,
        newParentId: docs,
        newName: 'bare.txt',
      });

      expect(copy).toMatchObject({ name: 'bare.txt', parentId: docs, isFolder: false });
      expect(server.readFile(copy.remoteId).toString('utf8')).toBe('quarterly numbers');
    });
  });

  it('maps a name conflict to ERR_INVALID_INPUT', async () => {
    await withFakeOnedrive({}, async (server) => {
      const { report } = await seedTree(server);
      server.seedFile('taken.txt', null, 'occupied');
      const provider = createOnedriveProvider({ copyPollDelayMs: 0 });
      await expectProviderCode(
        provider.copy(makeContext(), { remoteId: report, newParentId: null, newName: 'taken.txt' }),
        'ERR_INVALID_INPUT',
      );
    });
  });

  it('gives up with ERR_TIMEOUT when the monitor never finishes', async () => {
    await withFakeOnedrive({ copyPolls: 10 }, async (server) => {
      const { report } = await seedTree(server);
      const provider = createOnedriveProvider({ copyPollAttempts: 2, copyPollDelayMs: 0 });
      await expectProviderCode(
        provider.copy(makeContext(), { remoteId: report, newParentId: null, newName: 'stuck.txt' }),
        'ERR_TIMEOUT',
      );
    });
  });

  it('maps a missing source to ERR_NOT_FOUND', async () => {
    await withFakeOnedrive({}, async () => {
      const provider = createOnedriveProvider({ copyPollDelayMs: 0 });
      await expectProviderCode(
        provider.copy(makeContext(), { remoteId: 'item-missing', newParentId: null }),
        'ERR_NOT_FOUND',
      );
    });
  });

  it('honours the copy capability gate', async () => {
    await withFakeOnedrive({}, async () => {
      const provider = createOnedriveProvider({ capabilities: ['list'] });
      await expectProviderCode(
        provider.copy(makeContext(), { remoteId: 'item-x', newParentId: null }),
        'ERR_CAPABILITY_UNSUPPORTED',
      );
    });
  });
});

describe('onedrive delete', () => {
  it('removes a file and its folder subtree', async () => {
    await withFakeOnedrive({}, async (server) => {
      const { docs, report, notes } = await seedTree(server);
      const provider = createOnedriveProvider();
      const ctx = makeContext();
      const before = server.nodeCount();

      await provider.delete(ctx, { remoteId: docs });
      expect(server.nodeCount()).toBe(before - 2);
      await expectProviderCode(provider.getMetadata(ctx, { remoteId: notes }), 'ERR_NOT_FOUND');
      expect(server.requests).toContain(`/v1.0/me/drive/items/${docs}`);
      expect(report).toBeTruthy();
    });
  });

  it('ignores the permanent flag because Graph has a single delete path', async () => {
    await withFakeOnedrive({}, async (server) => {
      const { report } = await seedTree(server);
      const provider = createOnedriveProvider();
      await provider.delete(makeContext(), { remoteId: report, permanent: true });
      await expectProviderCode(provider.getMetadata(makeContext(), { remoteId: report }), 'ERR_NOT_FOUND');
    });
  });

  it('refuses to delete the root folder', async () => {
    await withFakeOnedrive({}, async (server) => {
      const provider = createOnedriveProvider();
      const before = server.nodeCount();
      await expectProviderCode(provider.delete(makeContext(), { remoteId: 'root' }), 'ERR_INVALID_INPUT');
      expect(server.nodeCount()).toBe(before);
    });
  });

  it('maps a missing remote id to ERR_NOT_FOUND', async () => {
    await withFakeOnedrive({}, async () => {
      const provider = createOnedriveProvider();
      await expectProviderCode(provider.delete(makeContext(), { remoteId: 'item-missing' }), 'ERR_NOT_FOUND');
    });
  });

  it('honours the delete capability gate', async () => {
    await withFakeOnedrive({}, async () => {
      const provider = createOnedriveProvider({ capabilities: ['list'] });
      await expectProviderCode(provider.delete(makeContext(), { remoteId: 'item-x' }), 'ERR_CAPABILITY_UNSUPPORTED');
    });
  });
});

describe('onedrive search', () => {
  it('finds files and folders by name across the account', async () => {
    await withFakeOnedrive({}, async (server) => {
      const { docs, report, notes } = await seedTree(server);
      server.seedFile('report-archive.txt', docs, 'older report');
      const provider = createOnedriveProvider();

      const result = await provider.search(makeContext(), { query: 'report' });

      expect(result.entries.map((entry) => entry.name).sort()).toEqual(['report-archive.txt', 'report.txt']);
      expect(result.entries.find((entry) => entry.remoteId === report)).toBeTruthy();
      expect(result.entries.find((entry) => entry.name === 'report-archive.txt')?.parentId).toBe(docs);
      expect(result.nextCursor).toBeNull();
      expect(server.requests).toContain(`/v1.0/me/drive/root/search(q='report')`);
      expect(notes).toBeTruthy();
    });
  });

  it('escapes single quotes in the Graph search literal', async () => {
    await withFakeOnedrive({}, async (server) => {
      server.seedFile("o'brien.txt", null, 'x', 'text/plain');
      const provider = createOnedriveProvider();

      const result = await provider.search(makeContext(), { query: "o'brien" });
      expect(result.entries.map((entry) => entry.name)).toEqual(["o'brien.txt"]);
      expect(server.requests).toContain(`/v1.0/me/drive/root/search(q='o''brien')`);
    });
  });

  it('paginates search results through the nextLink cursor', async () => {
    await withFakeOnedrive({}, async (server) => {
      server.seedFile('alpha-1.txt', null, 'x');
      server.seedFile('alpha-2.txt', null, 'x');
      server.seedFile('alpha-3.txt', null, 'x');
      const provider = createOnedriveProvider();
      const ctx = makeContext();

      const first = await provider.search(ctx, { query: 'alpha', limit: 1 });
      expect(first.entries.map((entry) => entry.name)).toEqual(['alpha-1.txt']);
      expect(first.nextCursor).toContain('skiptoken=1');

      const second = await provider.search(ctx, { query: 'alpha', limit: 1, cursor: first.nextCursor });
      expect(second.entries.map((entry) => entry.name)).toEqual(['alpha-2.txt']);
      expect(second.nextCursor).toBeTruthy();

      const third = await provider.search(ctx, { query: 'alpha', limit: 1, cursor: second.nextCursor });
      expect(third.entries.map((entry) => entry.name)).toEqual(['alpha-3.txt']);
      expect(third.nextCursor).toBeNull();
    });
  });

  it('returns an empty page when nothing matches', async () => {
    await withFakeOnedrive({}, async (server) => {
      await seedTree(server);
      const provider = createOnedriveProvider();
      const result = await provider.search(makeContext(), { query: 'nothing-matches-this' });

      expect(result.entries).toEqual([]);
      expect(result.nextCursor).toBeNull();
    });
  });

  it('requires a non-empty query', async () => {
    await withFakeOnedrive({}, async () => {
      const provider = createOnedriveProvider();
      const ctx = makeContext();
      await expectProviderCode(provider.search(ctx, { query: '' }), 'ERR_INVALID_INPUT');
      await expectProviderCode(provider.search(ctx, { query: '   ' }), 'ERR_INVALID_INPUT');
      await expectProviderCode(provider.search(ctx, {} as never), 'ERR_INVALID_INPUT');
    });
  });

  it('rejects an invalid page size', async () => {
    await withFakeOnedrive({}, async () => {
      const provider = createOnedriveProvider();
      await expectProviderCode(provider.search(makeContext(), { query: 'x', limit: 0 }), 'ERR_INVALID_INPUT');
    });
  });

  it('honours the search capability gate', async () => {
    await withFakeOnedrive({}, async () => {
      const provider = createOnedriveProvider({ capabilities: ['list'] });
      await expectProviderCode(provider.search(makeContext(), { query: 'anything' }), 'ERR_CAPABILITY_UNSUPPORTED');
    });
  });
});

describe('onedrive sharing', () => {
  it('creates a public link on demand', async () => {
    await withFakeOnedrive({}, async (server) => {
      const { report } = await seedTree(server);
      const provider = createOnedriveProvider();
      const result = await provider.createShare(makeContext(), { remoteId: report, visibility: 'public_read' });

      expect(result.visibility).toBe('public_read');
      expect(result.url).toContain('onedrive.example/s/');
      expect(result.expiresAt).toBeNull();
      expect(server.shareCount()).toBe(1);
      expect(server.requests).toContain(`/v1.0/me/drive/items/${report}/createLink`);
    });
  });

  it('reuses an existing shared link instead of failing', async () => {
    await withFakeOnedrive({}, async (server) => {
      const { report } = await seedTree(server);
      const provider = createOnedriveProvider();
      const ctx = makeContext();

      const first = await provider.createShare(ctx, { remoteId: report, visibility: 'public_read' });
      const second = await provider.createShare(ctx, { remoteId: report, visibility: 'public_read' });

      expect(second.url).toBe(first.url);
      expect(server.shareCount()).toBe(1);
      expect(server.requests).toContain(`/v1.0/me/drive/items/${report}/permissions`);
    });
  });

  it('applies an expiry to the shared link', async () => {
    await withFakeOnedrive({}, async (server) => {
      const { report } = await seedTree(server);
      const provider = createOnedriveProvider();
      const result = await provider.createShare(makeContext(), {
        remoteId: report,
        visibility: 'public_read',
        expiresAt: '2030-06-01T12:00:00.000Z',
      });

      expect(result.expiresAt).toBe('2030-06-01T12:00:00Z');
    });
  });

  it('rejects malformed and past expiry timestamps', async () => {
    await withFakeOnedrive({}, async (server) => {
      const { report } = await seedTree(server);
      const provider = createOnedriveProvider();
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

  it('rejects unsupported visibilities', async () => {
    await withFakeOnedrive({}, async (server) => {
      const { report } = await seedTree(server);
      const provider = createOnedriveProvider();
      await expectProviderCode(
        provider.createShare(makeContext(), { remoteId: report, visibility: 'internal' as never }),
        'ERR_INVALID_INPUT',
      );
      expect(server.shareCount()).toBe(0);
    });
  });

  it('turns private visibility into link removal', async () => {
    await withFakeOnedrive({}, async (server) => {
      const { report } = await seedTree(server);
      const provider = createOnedriveProvider();
      const ctx = makeContext();

      await provider.createShare(ctx, { remoteId: report, visibility: 'public_read' });
      expect(server.shareCount()).toBe(1);

      const result = await provider.createShare(ctx, { remoteId: report, visibility: 'private' });
      expect(result).toEqual({ url: '', visibility: 'private', expiresAt: null });
      expect(server.shareCount()).toBe(0);
    });
  });

  it('revokes an existing link and stays idempotent afterwards', async () => {
    await withFakeOnedrive({}, async (server) => {
      const { report } = await seedTree(server);
      const provider = createOnedriveProvider();
      const ctx = makeContext();

      await provider.createShare(ctx, { remoteId: report, visibility: 'public_read' });
      expect(server.shareCount()).toBe(1);

      await provider.revokeShare(ctx, { remoteId: report });
      expect(server.shareCount()).toBe(0);

      await provider.revokeShare(ctx, { remoteId: report });
      expect(server.shareCount()).toBe(0);
      expect(server.requests.filter((path) => path.includes('/permissions/'))).toHaveLength(1);
    });
  });

  it('maps a missing remote id to ERR_NOT_FOUND', async () => {
    await withFakeOnedrive({}, async () => {
      const provider = createOnedriveProvider();
      await expectProviderCode(
        provider.createShare(makeContext(), { remoteId: 'item-missing', visibility: 'public_read' }),
        'ERR_NOT_FOUND',
      );
    });
  });

  it('honours the createShare and revokeShare capability gates', async () => {
    await withFakeOnedrive({}, async () => {
      const provider = createOnedriveProvider({ capabilities: ['list'] });
      await expectProviderCode(
        provider.createShare(makeContext(), { remoteId: 'x', visibility: 'public_read' }),
        'ERR_CAPABILITY_UNSUPPORTED',
      );
      await expectProviderCode(provider.revokeShare(makeContext(), { remoteId: 'x' }), 'ERR_CAPABILITY_UNSUPPORTED');
    });
  });
});
