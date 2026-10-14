import { describe, expect, it } from 'vitest';
import { createTeraBoxOpenProvider } from '../../../providers/terabox-open/index.js';
import {
  baseName,
  fromWirePath,
  joinPath,
  normalizeRelativePath,
  parentOf,
  toWirePath,
  validateFileName,
} from '../../../providers/terabox-open/paths.js';
import { expectProviderCode, makeContext, withFakeTeraBox } from './server.js';

const provider = createTeraBoxOpenProvider();

describe('path mapping', () => {
  it('normalises and rejects traversal / control characters', () => {
    expect(normalizeRelativePath('a//b/')).toBe('/a/b');
    expect(normalizeRelativePath('')).toBe('/');
    for (const bad of ['/a/../b', '/a/./b', '/a\u0000b', '..']) {
      expect(() => normalizeRelativePath(bad), bad).toThrow();
    }
    for (const bad of ['', '.', '..', 'a/b', 'a\nb', 'x'.repeat(300)]) {
      expect(() => validateFileName(bad), bad).toThrow();
    }
  });

  it('maps through the configured app root and back', () => {
    const root = '/From: Other Applications/9drive-250528';
    expect(toWirePath('/docs/a.txt', root)).toBe(`${root}/docs/a.txt`);
    expect(toWirePath('/', root)).toBe(root);
    expect(fromWirePath(`${root}/docs/a.txt`, root)).toBe('/docs/a.txt');
    expect(fromWirePath(root, root)).toBe('/');
    expect(toWirePath('/docs', '')).toBe('/docs');
  });

  it('reports root children with a null parent', () => {
    expect(parentOf('/a.txt')).toBeNull();
    expect(parentOf('/d/a.txt')).toBe('/d');
    expect(parentOf('/')).toBeNull();
    expect(joinPath(null, 'a.txt')).toBe('/a.txt');
    expect(joinPath('/d', 'a.txt')).toBe('/d/a.txt');
    expect(baseName('/d/a.txt')).toBe('a.txt');
  });
});

describe('list / metadata / search', () => {
  it('lists the app root with page-number cursors', async () => {
    await withFakeTeraBox({}, async (server) => {
      server.seedDir('/docs');
      for (const name of ['a.txt', 'b.txt', 'c.txt']) server.seedFile(`/${name}`, name);
      const ctx = makeContext(server);

      const first = await provider.list(ctx, { parentId: null, limit: 2 });
      expect(first.entries.map((e) => e.remoteId)).toEqual(['/a.txt', '/b.txt']);
      expect(first.nextCursor).toBe('2');

      const second = await provider.list(ctx, { parentId: null, limit: 2, cursor: first.nextCursor });
      expect(second.entries.map((e) => e.remoteId)).toEqual(['/c.txt', '/docs']);

      const third = await provider.list(ctx, { parentId: null, limit: 2, cursor: second.nextCursor });
      expect(third.entries).toEqual([]);
      expect(third.nextCursor).toBeNull();

      const folder = second.entries.find((e) => e.isFolder)!;
      expect(folder).toMatchObject({ name: 'docs', mimeType: 'inode/directory', parentId: null, sizeBytes: 0n });
    });
  });

  it('rejects malformed cursors and sizes', async () => {
    await withFakeTeraBox({}, async (server) => {
      const ctx = makeContext(server);
      await expectProviderCode(provider.list(ctx, { parentId: null, cursor: 'abc' }), 'ERR_INVALID_INPUT');
      await expectProviderCode(provider.list(ctx, { parentId: null, cursor: '0' }), 'ERR_INVALID_INPUT');
      await expectProviderCode(provider.list(ctx, { parentId: null, limit: 0 }), 'ERR_INVALID_INPUT');
    });
  });

  it('maps file metadata and synthesises the root', async () => {
    await withFakeTeraBox({}, async (server) => {
      server.seedDir('/docs');
      server.seedFile('/docs/a.txt', 'hello');
      const ctx = makeContext(server);
      const meta = await provider.getMetadata(ctx, { remoteId: '/docs/a.txt' });
      expect(meta).toMatchObject({ remoteId: '/docs/a.txt', name: 'a.txt', sizeBytes: 5n, parentId: '/docs', isFolder: false, webUrl: null });
      expect(meta.checksum).toMatch(/^[0-9a-f]{32}$/);
      expect(meta.modifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(await provider.getMetadata(ctx, { remoteId: '/' })).toMatchObject({ isFolder: true, name: '' });
      await expectProviderCode(provider.getMetadata(ctx, { remoteId: '/missing' }), 'ERR_NOT_FOUND');
    });
  });

  it('searches the application space', async () => {
    await withFakeTeraBox({}, async (server) => {
      server.seedFile('/report-2026.pdf', 'x');
      server.seedFile('/notes.txt', 'y');
      const result = await provider.search(makeContext(server), { query: 'report' });
      expect(result.entries.map((e) => e.name)).toEqual(['report-2026.pdf']);
      await expectProviderCode(provider.search(makeContext(server), { query: '  ' }), 'ERR_INVALID_INPUT');
    });
  });

  it('applies the namespace root on the wire and strips it from remote ids', async () => {
    const root = '/From: Other Applications/9drive-250528';
    await withFakeTeraBox({ appRoot: root }, async (server) => {
      process.env.TERABOX_APP_ROOT = root;
      server.seedFile('/a.txt', 'x');
      const ctx = makeContext(server);
      const listed = await provider.list(ctx, { parentId: null });
      expect(listed.entries.map((e) => e.remoteId)).toEqual(['/a.txt']);
      const listRequest = server.requests.find((r) => r.path === '/openapi/api/list')!;
      expect(listRequest.query.dir).toBe(root);
    });
  });
});

describe('rename / move / copy / delete', () => {
  it('renames, moves, copies and deletes through filemanager', async () => {
    await withFakeTeraBox({}, async (server) => {
      server.seedDir('/docs');
      server.seedFile('/a.txt', 'alpha');
      const ctx = makeContext(server);

      const renamed = await provider.rename(ctx, { remoteId: '/a.txt', newName: 'b.txt' });
      expect(renamed.remoteId).toBe('/b.txt');
      expect(server.readFile('/a.txt')).toBeNull();

      const moved = await provider.move(ctx, { remoteId: '/b.txt', newParentId: '/docs' });
      expect(moved.remoteId).toBe('/docs/b.txt');
      expect(moved.parentId).toBe('/docs');

      const copied = await provider.copy(ctx, { remoteId: '/docs/b.txt', newParentId: null, newName: 'c.txt' });
      expect(copied.remoteId).toBe('/c.txt');
      expect(server.readFile('/c.txt')?.toString()).toBe('alpha');
      expect(server.readFile('/docs/b.txt')?.toString()).toBe('alpha');

      await provider.delete(ctx, { remoteId: '/c.txt' });
      expect(server.readFile('/c.txt')).toBeNull();

      const ops = server.requests.filter((r) => r.path === '/openapi/api/filemanager').map((r) => r.query.opera);
      expect(ops).toEqual(['rename', 'move', 'copy', 'delete']);
    });
  });

  it('maps documented filemanager errnos (-8 exists, -9 missing)', async () => {
    await withFakeTeraBox({}, async (server) => {
      server.seedFile('/a.txt', '1');
      server.seedFile('/b.txt', '2');
      const ctx = makeContext(server);
      await expectProviderCode(provider.rename(ctx, { remoteId: '/a.txt', newName: 'b.txt' }), 'ERR_INVALID_INPUT');
      await expectProviderCode(provider.delete(ctx, { remoteId: '/nope.txt' }), 'ERR_NOT_FOUND');
      expect(server.readFile('/a.txt')?.toString()).toBe('1');
    });
  });

  it('refuses root modification and moving a folder into itself', async () => {
    await withFakeTeraBox({}, async (server) => {
      server.seedDir('/docs');
      server.seedDir('/docs/sub');
      const ctx = makeContext(server);
      await expectProviderCode(provider.delete(ctx, { remoteId: '/' }), 'ERR_INVALID_INPUT');
      await expectProviderCode(provider.rename(ctx, { remoteId: '/', newName: 'x' }), 'ERR_INVALID_INPUT');
      await expectProviderCode(provider.move(ctx, { remoteId: '/docs', newParentId: '/docs/sub' }), 'ERR_INVALID_INPUT');
      await expectProviderCode(provider.copy(ctx, { remoteId: '/docs', newParentId: '/docs' }), 'ERR_INVALID_INPUT');
      expect(server.requests.some((r) => r.path === '/openapi/api/filemanager')).toBe(false);
    });
  });

  it('sends async=0 and a JSON filelist body (not in the URL)', async () => {
    await withFakeTeraBox({}, async (server) => {
      server.seedFile('/a.txt', '1');
      await provider.delete(makeContext(server), { remoteId: '/a.txt' });
      const request = server.requests.find((r) => r.path === '/openapi/api/filemanager')!;
      expect(request.query.async).toBe('0');
      expect(JSON.parse(request.form.filelist)).toEqual(['/a.txt']);
    });
  });
});

describe('unsupported operations fail honestly', () => {
  it('rejects undocumented capabilities with ERR_CAPABILITY_UNSUPPORTED and makes no request', async () => {
    await withFakeTeraBox({}, async (server) => {
      const ctx = makeContext(server);
      await expectProviderCode(provider.createFolder(ctx, { name: 'x', parentId: null }), 'ERR_CAPABILITY_UNSUPPORTED');
      await expectProviderCode(provider.createShare(ctx, { remoteId: '/a', visibility: 'public_read' }), 'ERR_CAPABILITY_UNSUPPORTED');
      await expectProviderCode(provider.download(ctx, { remoteId: '/a', range: { start: 0 } }), 'ERR_CAPABILITY_UNSUPPORTED');
      await expectProviderCode(
        provider.upload(ctx, { stream: (await import('./server.js')).bufferStream('x'), fileName: 'a', mimeType: 'text/plain', sizeBytes: 1n, parentId: null, resumeToken: 'r' }),
        'ERR_CAPABILITY_UNSUPPORTED',
      );
      expect(server.requests).toHaveLength(0);
    });
  });
});
