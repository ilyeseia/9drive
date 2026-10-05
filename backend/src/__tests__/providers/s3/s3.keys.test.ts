import { describe, expect, it } from 'vitest';
import { ProviderError } from '../../../providers/errors.js';
import {
  assertOwnKey,
  fileKey,
  folderKey,
  listDir,
  namespaceRoot,
  newKeySegment,
  normalizePrefix,
  parseChild,
  parseKey,
  parentDirOf,
  rebaseKey,
  sanitizeFileName,
  sanitizeFolderName,
} from '../../../providers/s3/keys.js';

function expectCode(run: () => unknown, code: string): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(ProviderError.is(caught), `expected ProviderError ${code}`).toBe(true);
  expect((caught as ProviderError).code).toBe(code);
}

describe('s3 key layout (prefix/userId/fileId/fileName)', () => {
  it('builds the namespace root from prefix and userId', () => {
    expect(namespaceRoot('9drive', 'user-1')).toBe('9drive/user-1');
    expect(namespaceRoot('', 'user-1')).toBe('user-1');
    expect(namespaceRoot('/team//ops/', 'user-1')).toBe('team/ops/user-1');
    expect(namespaceRoot('.', 'user-1')).toBe('user-1');
    expect(namespaceRoot('a/../b', 'user-1')).toBe('a/b/user-1');
  });

  it('rejects an unusable userId', () => {
    expectCode(() => namespaceRoot('9drive', ''), 'ERR_INVALID_INPUT');
    expectCode(() => namespaceRoot('9drive', '   '), 'ERR_INVALID_INPUT');
    expectCode(() => namespaceRoot('9drive', 'user/1'), 'ERR_INVALID_INPUT');
    expectCode(() => namespaceRoot('9drive', 'user\\1'), 'ERR_INVALID_INPUT');
    expectCode(() => namespaceRoot('9drive', '..'), 'ERR_INVALID_INPUT');
  });

  it('normalises the operator prefix', () => {
    expect(normalizePrefix('/a/b/')).toBe('a/b');
    expect(normalizePrefix('a\\b')).toBe('a/b');
    expect(normalizePrefix('../secret')).toBe('secret');
    expect(normalizePrefix(undefined)).toBe('');
  });

  it('derives file and folder keys under a directory', () => {
    const dir = '9drive/user-1/';
    expect(fileKey(dir, 'fabc', 'report.txt')).toBe('9drive/user-1/fabc/report.txt');
    expect(folderKey(dir, 'dabc', 'docs')).toBe('9drive/user-1/dabc/docs/');
    expect(newKeySegment('f')).toMatch(/^f[0-9a-f]{24}$/);
    expect(newKeySegment('d')).toMatch(/^d[0-9a-f]{24}$/);
    expect(newKeySegment('f')).not.toEqual(newKeySegment('f'));
  });

  it('sanitises upload file names', () => {
    expect(sanitizeFileName('  report.txt  ')).toBe('report.txt');
    expect(sanitizeFileName('../../etc/passwd')).toBe('..-..-etc-passwd');
    expect(sanitizeFileName('a\\b')).toBe('a-b');
    expect(sanitizeFileName('bad\u0000name.txt')).toBe('badname.txt');
    expect(sanitizeFileName('x'.repeat(300))).toHaveLength(180);
    expectCode(() => sanitizeFileName('   '), 'ERR_INVALID_INPUT');
    expectCode(() => sanitizeFileName('..'), 'ERR_INVALID_INPUT');
    expectCode(() => sanitizeFileName('\u0000\u0001'), 'ERR_INVALID_INPUT');
    expectCode(() => sanitizeFolderName(''), 'ERR_INVALID_INPUT');
    expect(sanitizeFolderName('my folder')).toBe('my folder');
  });

  it('keeps every remote id inside the caller namespace', () => {
    const root = '9drive/user-1';
    expect(() => assertOwnKey(root, `${root}/fabc/report.txt`)).not.toThrow();
    expectCode(() => assertOwnKey(root, '9drive/user-2/fabc/report.txt'), 'ERR_NOT_FOUND');
    expectCode(() => assertOwnKey(root, 'other/fabc/report.txt'), 'ERR_NOT_FOUND');
    expectCode(() => assertOwnKey(root, `${root}`), 'ERR_NOT_FOUND');
    expectCode(() => assertOwnKey(root, ''), 'ERR_NOT_FOUND');
  });

  it('resolves listing directories', () => {
    const root = '9drive/user-1';
    expect(listDir(root, null)).toBe('9drive/user-1/');
    expect(listDir(root, '9drive/user-1/dabc/docs/')).toBe('9drive/user-1/dabc/docs/');
    expectCode(() => listDir(root, '9drive/user-1/dabc/docs'), 'ERR_NOT_FOUND');
    expectCode(() => listDir(root, '9drive/user-2/dabc/docs/'), 'ERR_NOT_FOUND');
  });

  it('parses only direct children of a directory', () => {
    const dir = '9drive/user-1/';
    expect(parseChild(dir, '9drive/user-1/fabc/report.txt')).toEqual({
      fileId: 'fabc',
      name: 'report.txt',
      isFolder: false,
    });
    expect(parseChild(dir, '9drive/user-1/dabc/docs/')).toEqual({
      fileId: 'dabc',
      name: 'docs',
      isFolder: true,
    });
    expect(parseChild(dir, '9drive/user-1/')).toBeNull();
    expect(parseChild(dir, '9drive/user-1/dabc/docs/fxyz/inner.txt')).toBeNull();
    expect(parseChild(dir, '9drive/user-2/fabc/report.txt')).toBeNull();
    expect(parseChild(dir, '9drive/user-1/fabc/')).toBeNull();
  });

  it('derives name, folder and parent from a key', () => {
    const root = '9drive/user-1';
    const top = parseKey(root, '9drive/user-1/fabc/report.txt');
    expect(top).toEqual({
      fileId: 'fabc',
      name: 'report.txt',
      isFolder: false,
      parentId: null,
    });

    const nested = parseKey(root, '9drive/user-1/dabc/docs/fxyz/inner.txt');
    expect(nested.parentId).toBe('9drive/user-1/dabc/docs/');
    expect(nested.fileId).toBe('fxyz');
    expect(nested.isFolder).toBe(false);

    const folder = parseKey(root, '9drive/user-1/dabc/docs/');
    expect(folder.isFolder).toBe(true);
    expect(folder.name).toBe('docs');
    expect(folder.parentId).toBeNull();

    expect(parentDirOf(root, '9drive/user-1/dabc/docs/fxyz/inner.txt')).toBe('9drive/user-1/dabc/docs/');
    expect(parentDirOf(root, '9drive/user-1/fabc/report.txt')).toBeNull();

    expectCode(() => parseKey(root, '9drive/user-1/report.txt'), 'ERR_INVALID_INPUT');
    expectCode(() => parseKey(root, '9drive/user-2/fabc/report.txt'), 'ERR_NOT_FOUND');
    expectCode(() => parseKey(root, '9drive/user-1/fabc//report.txt'), 'ERR_INVALID_INPUT');
  });

  it('rebases keys between directories', () => {
    expect(rebaseKey('9drive/user-1/da/', '9drive/user-1/db/', '9drive/user-1/da/fx/file.txt')).toBe(
      '9drive/user-1/db/fx/file.txt',
    );
    expectCode(() => rebaseKey('9drive/user-1/da/', '9drive/user-1/db/', '9drive/user-1/dc/fx/file.txt'), 'ERR_INTERNAL');
  });
});
