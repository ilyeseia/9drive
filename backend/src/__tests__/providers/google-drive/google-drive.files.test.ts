import { describe, expect, it } from 'vitest';
import { createGoogleDriveProvider, type GoogleDriveProvider } from '../../../providers/google-drive/index.js';
import { expectProviderCode, makeContext, withFakeDrive, type FakeDrive } from './helpers.js';

async function seedRoot(
  provider: GoogleDriveProvider,
  drive: FakeDrive,
  ctx: ReturnType<typeof makeContext>,
  names: string[],
): Promise<string> {
  await provider.list(ctx, { parentId: null });
  const rootId = drive.rootId();
  names.forEach((name, index) => {
    drive.seedFile({ id: `child-${index + 1}`, name, parents: [rootId], content: 'seed' });
  });
  return rootId;
}

describe('google_drive 9drive root folder', () => {
  it('creates the9drive folder once and reuses it for the account', async () => {
    await withFakeDrive({}, async (drive) => {
      const provider = createGoogleDriveProvider();
      const ctx = makeContext(drive);
      await provider.list(ctx, { parentId: null });
      await provider.list(ctx, { parentId: null });
      await provider.createFolder(ctx, { name: 'sub', parentId: null });

      const root = drive.rootFolder();
      expect(root).toBeDefined();
      expect(root!.mimeType).toBe('application/vnd.google-apps.folder');
      expect(root!.parents).toEqual(['root']);
      const creations = drive.requests.filter(
        (request) => request.path === '/drive/v3/files' && request.method === 'POST',
      );
      expect(creations).toHaveLength(2);
      const rootBody = JSON.parse(creations[0].body.toString('utf8')) as { name: string; mimeType: string };
      expect(rootBody).toMatchObject({ name: '9drive', mimeType: 'application/vnd.google-apps.folder' });
      const subBody = JSON.parse(creations[1].body.toString('utf8')) as { name: string; parents: string[] };
      expect(subBody).toMatchObject({ name: 'sub', parents: [root!.id] });
    });
  });

  it('lists the9drive folder when parentId is null', async () => {
    await withFakeDrive({}, async (drive) => {
      const provider = createGoogleDriveProvider();
      const ctx = makeContext(drive);
      await seedRoot(provider, drive, ctx, ['notes.txt', 'archive.zip']);
      drive.seedFile({ id: 'outside', name: 'elsewhere.txt', parents: ['root'] });

      const result = await provider.list(ctx, { parentId: null });
      expect(result.entries.map((entry) => entry.remoteId)).toEqual(['child-2', 'child-1']);
      expect(result.entries.every((entry) => entry.parentId === null)).toBe(true);
      expect(result.nextCursor).toBeNull();
    });
  });

  it('lists a nested folder by remote id', async () => {
    await withFakeDrive({}, async (drive) => {
      const provider = createGoogleDriveProvider();
      const ctx = makeContext(drive);
      await seedRoot(provider, drive, ctx, []);
      const rootId = drive.rootId();
      drive.seedFile({ id: 'sub-1', name: 'sub', mimeType: 'application/vnd.google-apps.folder', parents: [rootId] });
      drive.seedFile({ id: 'nested-1', name: 'inside.txt', parents: ['sub-1'], content: 'inside' });

      const result = await provider.list(ctx, { parentId: 'sub-1' });
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]).toMatchObject({
        remoteId: 'nested-1',
        parentId: 'sub-1',
        isFolder: false,
        sizeBytes: 6n,
        webUrl: 'https://drive.google.com/file/d/nested-1/view',
      });
    });
  });

  it('keeps the Drive root parent id for files outside the9drive folder', async () => {
    await withFakeDrive({}, async (drive) => {
      const provider = createGoogleDriveProvider();
      const ctx = makeContext(drive);
      await seedRoot(provider, drive, ctx, []);
      drive.seedFile({ id: 'stray', name: 'stray.txt', parents: ['root'], content: 'abc' });

      const meta = await provider.getMetadata(ctx, { remoteId: 'stray' });
      expect(meta.parentId).toBe('root');
      expect(meta.isFolder).toBe(false);
      expect(meta.sizeBytes).toBe(3n);
      expect(meta.name).toBe('stray.txt');
      expect(meta.createdAt).toBe('2026-01-04T10:00:00.000Z');
    });
  });

  it('sorts folders before files inside each page', async () => {
    await withFakeDrive({}, async (drive) => {
      const provider = createGoogleDriveProvider();
      const ctx = makeContext(drive);
      await seedRoot(provider, drive, ctx, ['zebra.txt', 'alpha.txt']);
      drive.seedFile({ id: 'z-folder', name: 'zeta', mimeType: 'application/vnd.google-apps.folder', parents: [drive.rootId()] });
      drive.seedFile({ id: 'a-folder', name: 'alpha', mimeType: 'application/vnd.google-apps.folder', parents: [drive.rootId()] });

      const result = await provider.list(ctx, { parentId: null });
      expect(result.entries.map((entry) => entry.remoteId)).toEqual(['a-folder', 'z-folder', 'child-2', 'child-1']);
      expect(result.entries.filter((entry) => entry.isFolder)).toHaveLength(2);
    });
  });

  it('paginates with a stable cursor', async () => {
    await withFakeDrive({}, async (drive) => {
      const provider = createGoogleDriveProvider();
      const ctx = makeContext(drive);
      await seedRoot(provider, drive, ctx, ['one.txt', 'two.txt', 'three.txt', 'four.txt', 'five.txt']);

      const first = await provider.list(ctx, { parentId: null, limit: 2 });
      expect(first.entries).toHaveLength(2);
      expect(first.nextCursor).toBeTruthy();

      const second = await provider.list(ctx, { parentId: null, limit: 2, cursor: first.nextCursor });
      expect(second.entries).toHaveLength(2);
      expect(second.nextCursor).toBeTruthy();

      const third = await provider.list(ctx, { parentId: null, limit: 2, cursor: second.nextCursor });
      expect(third.entries).toHaveLength(1);
      expect(third.nextCursor).toBeNull();

      const ids = [...first.entries, ...second.entries, ...third.entries].map((entry) => entry.remoteId);
      expect(new Set(ids).size).toBe(5);
    });
  });

  it('rejects an invalid page size', async () => {
    await withFakeDrive({}, async (drive) => {
      const provider = createGoogleDriveProvider();
      await expectProviderCode(provider.list(makeContext(drive), { parentId: null, limit: 0 }), 'ERR_INVALID_INPUT');
      await expectProviderCode(
        provider.list(makeContext(drive), { parentId: null, limit: 1.5 }),
        'ERR_INVALID_INPUT',
      );
    });
  });

  it('invalidates the cached root folder when it disappears upstream', async () => {
    await withFakeDrive({}, async (drive) => {
      const provider = createGoogleDriveProvider();
      const ctx = makeContext(drive);
      await provider.list(ctx, { parentId: null });
      const staleId = drive.rootId();

      drive.files.delete(staleId);
      await expectProviderCode(provider.createFolder(ctx, { name: 'orphan', parentId: null }), 'ERR_NOT_FOUND');

      const recovered = await provider.createFolder(ctx, { name: 'recovered', parentId: null });
      expect(recovered.parentId).toBeNull();
      expect(drive.rootId()).not.toBe(staleId);
      const lookups = drive.requests.filter(
        (request) =>
          request.path === '/drive/v3/files' &&
          request.method === 'GET' &&
          (request.query.get('q') ?? '').includes("name = '9drive'"),
      );
      expect(lookups.length).toBeGreaterThanOrEqual(2);
    });
  });
});

describe('google_drive file operations', () => {
  it('creates folders under the resolved parent', async () => {
    await withFakeDrive({}, async (drive) => {
      const provider = createGoogleDriveProvider();
      const ctx = makeContext(drive);
      const rootId = await seedRoot(provider, drive, ctx, []);
      drive.seedFile({ id: 'sub-1', name: 'sub', mimeType: 'application/vnd.google-apps.folder', parents: [rootId] });

      const inRoot = await provider.createFolder(ctx, { name: 'top', parentId: null });
      expect(inRoot.isFolder).toBe(true);
      expect(inRoot.parentId).toBeNull();

      const nested = await provider.createFolder(ctx, { name: 'deep', parentId: 'sub-1' });
      expect(nested.parentId).toBe('sub-1');
      expect(drive.files.get('sub-1')).toBeDefined();
      const created = [...drive.files.values()].find((file) => file.name === 'deep');
      expect(created?.parents).toEqual(['sub-1']);
    });
  });

  it('rejects a folder without a name', async () => {
    await withFakeDrive({}, async (drive) => {
      const provider = createGoogleDriveProvider();
      await expectProviderCode(
        provider.createFolder(makeContext(drive), { name: '   ', parentId: null }),
        'ERR_INVALID_INPUT',
      );
    });
  });

  it('renames a file', async () => {
    await withFakeDrive({}, async (drive) => {
      const provider = createGoogleDriveProvider();
      const ctx = makeContext(drive);
      await seedRoot(provider, drive, ctx, ['old.txt']);

      const renamed = await provider.rename(ctx, { remoteId: 'child-1', newName: 'new.txt' });
      expect(renamed.name).toBe('new.txt');
      expect(drive.files.get('child-1')!.name).toBe('new.txt');
      await expectProviderCode(
        provider.rename(ctx, { remoteId: 'child-1', newName: '  ' }),
        'ERR_INVALID_INPUT',
      );
      await expectProviderCode(provider.rename(ctx, { remoteId: '', newName: 'x' }), 'ERR_INVALID_INPUT');
    });
  });

  it('moves a file and skips the write when it is already in place', async () => {
    await withFakeDrive({}, async (drive) => {
      const provider = createGoogleDriveProvider();
      const ctx = makeContext(drive);
      const rootId = await seedRoot(provider, drive, ctx, ['move-me.txt']);
      drive.seedFile({ id: 'sub-1', name: 'sub', mimeType: 'application/vnd.google-apps.folder', parents: [rootId] });

      const samePlace = await provider.move(ctx, { remoteId: 'child-1', newParentId: null });
      expect(samePlace.parentId).toBeNull();
      const patchesBefore = drive.requests.filter(
        (request) => request.method === 'PATCH' && request.path === '/drive/v3/files/child-1',
      );
      expect(patchesBefore).toHaveLength(0);

      const moved = await provider.move(ctx, { remoteId: 'child-1', newParentId: 'sub-1' });
      expect(moved.parentId).toBe('sub-1');
      expect(drive.files.get('child-1')!.parents).toEqual(['sub-1']);

      const back = await provider.move(ctx, { remoteId: 'child-1', newParentId: null });
      expect(back.parentId).toBeNull();
      expect(drive.files.get('child-1')!.parents).toEqual([rootId]);
    });
  });

  it('copies a file with an optional new name', async () => {
    await withFakeDrive({}, async (drive) => {
      const provider = createGoogleDriveProvider();
      const ctx = makeContext(drive);
      const rootId = await seedRoot(provider, drive, ctx, ['source.txt']);

      const copy = await provider.copy(ctx, { remoteId: 'child-1', newParentId: null, newName: 'source-copy.txt' });
      expect(copy.name).toBe('source-copy.txt');
      expect(copy.remoteId).not.toBe('child-1');
      expect(drive.files.get(copy.remoteId)!.parents).toEqual([rootId]);
      expect(drive.files.get(copy.remoteId)!.content.toString('utf8')).toBe('seed');
    });
  });

  it('trashes by default and deletes permanently on request', async () => {
    await withFakeDrive({}, async (drive) => {
      const provider = createGoogleDriveProvider();
      const ctx = makeContext(drive);
      await seedRoot(provider, drive, ctx, ['trash-me.txt', 'purge-me.txt']);

      await provider.delete(ctx, { remoteId: 'child-1' });
      expect(drive.files.get('child-1')!.trashed).toBe(true);

      await provider.delete(ctx, { remoteId: 'child-2', permanent: true });
      expect(drive.files.has('child-2')).toBe(false);

      const remaining = await provider.list(ctx, { parentId: null });
      expect(remaining.entries.map((entry) => entry.remoteId)).not.toContain('child-1');
      expect(remaining.entries.map((entry) => entry.remoteId)).not.toContain('child-2');
    });
  });

  it('rejects a missing remoteId', async () => {
    await withFakeDrive({}, async (drive) => {
      const provider = createGoogleDriveProvider();
      const ctx = makeContext(drive);
      await expectProviderCode(provider.getMetadata(ctx, { remoteId: '' }), 'ERR_INVALID_INPUT');
      await expectProviderCode(provider.delete(ctx, { remoteId: '   ' }), 'ERR_INVALID_INPUT');
      await expectProviderCode(provider.rename(ctx, { remoteId: 'x', newName: '' }), 'ERR_INVALID_INPUT');
    });
  });
});

describe('google_drive search', () => {
  it('finds files by name across the account', async () => {
    await withFakeDrive({}, async (drive) => {
      const provider = createGoogleDriveProvider();
      const ctx = makeContext(drive);
      await seedRoot(provider, drive, ctx, ["o'brien report", 'other.txt']);
      drive.seedFile({ id: 'outside-match', name: "o'brien notes", parents: ['root'] });

      const result = await provider.search(ctx, { query: "o'brien" });
      expect(result.entries.map((entry) => entry.remoteId).sort()).toEqual(['child-1', 'outside-match']);
      const last = drive.requests.filter((request) => request.path === '/drive/v3/files').at(-1)!;
      expect(last.query.get('corpora')).toBe('user');
      expect(last.query.get('q')).toContain("name contains 'o\\'brien'");
      expect(last.query.get('q')).toContain('trashed = false');
    });
  });

  it('paginates search results', async () => {
    await withFakeDrive({}, async (drive) => {
      const provider = createGoogleDriveProvider();
      const ctx = makeContext(drive);
      await seedRoot(provider, drive, ctx, ['match-one.txt', 'match-two.txt', 'other.txt']);

      const first = await provider.search(ctx, { query: 'match', limit: 1 });
      expect(first.entries).toHaveLength(1);
      expect(first.nextCursor).toBeTruthy();
      const second = await provider.search(ctx, { query: 'match', limit: 1, cursor: first.nextCursor });
      expect(second.entries).toHaveLength(1);
      expect(second.nextCursor).toBeNull();
      const ids = [first.entries[0].remoteId, second.entries[0].remoteId].sort();
      expect(ids).toEqual(['child-1', 'child-2']);
    });
  });

  it('requires a non-empty query', async () => {
    await withFakeDrive({}, async (drive) => {
      const provider = createGoogleDriveProvider();
      await expectProviderCode(provider.search(makeContext(drive), { query: '   ' }), 'ERR_INVALID_INPUT');
    });
  });

  it('honours the search capability gate', async () => {
    const provider = createGoogleDriveProvider({ capabilities: ['list'] });
    await expectProviderCode(provider.search(makeContext(), { query: 'anything' }), 'ERR_CAPABILITY_UNSUPPORTED');
  });
});
