/**
 * Object key layout for the S3 adapter — provider-contract.md §11:
 * `prefix/userId/fileId/fileName` for objects at the account root.
 *
 * Folders are zero-byte marker keys `…/{folderId}/{folderName}/`; a file key is
 * `…/{fileId}/{fileName}`. Every key stays inside the `prefix/userId` namespace,
 * so a remoteId from another user can never be addressed.
 */

import { randomBytes } from 'node:crypto';
import { ProviderError } from '../errors.js';

export const FOLDER_MARKER_CONTENT_TYPE = 'application/x-directory';

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]+/g;
const PATH_SEPARATORS = /[\\/]+/g;
const MAX_NAME_LENGTH = 180;

/** Operator-controlled prefix: trimmed to bare `a/b` segments, never `.`/`..`. */
export function normalizePrefix(prefix: string | null | undefined): string {
  if (typeof prefix !== 'string') return '';
  return prefix
    .replace(PATH_SEPARATORS, '/')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
    .join('/');
}

/** `prefix/userId` — the isolation boundary for every key this adapter touches. */
export function namespaceRoot(prefix: string | null | undefined, userId: string): string {
  if (typeof userId !== 'string' || userId.trim() === '') {
    throw new ProviderError('ERR_INVALID_INPUT', 'userId is required for the S3 key namespace');
  }
  const user = userId.trim();
  if (user.includes('/') || user.includes('\\') || user === '.' || user === '..') {
    throw new ProviderError('ERR_INVALID_INPUT', 'userId cannot be used as an S3 key segment');
  }
  const segments = [normalizePrefix(prefix), user].filter((segment) => segment !== '');
  return segments.join('/');
}

function sanitizeName(raw: string): string {
  return raw.trim().replace(PATH_SEPARATORS, '-').replace(CONTROL_CHARACTERS, '').slice(0, MAX_NAME_LENGTH);
}

/** Upload/file names: separators flattened, control characters removed, never `.`/`..`. */
export function sanitizeFileName(raw: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ProviderError('ERR_INVALID_INPUT', 'fileName is required');
  }
  const name = sanitizeName(raw);
  if (name === '' || name === '.' || name === '..') {
    throw new ProviderError('ERR_INVALID_INPUT', 'fileName has no usable characters');
  }
  return name;
}

/** Folder display names follow the same rules but are optional only by absence. */
export function sanitizeFolderName(raw: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ProviderError('ERR_INVALID_INPUT', 'folder name is required');
  }
  return sanitizeFileName(raw);
}

/** `dir` ends with `/`; the result is a file key (`…/{fileId}/{fileName}`). */
export function fileKey(dir: string, fileId: string, name: string): string {
  return `${dir}${fileId}/${name}`;
}

/** `dir` ends with `/`; the result is a folder marker key (`…/{folderId}/{name}/`). */
export function folderKey(dir: string, folderId: string, name: string): string {
  return `${dir}${folderId}/${name}/`;
}

/** Random segment id: `f` prefix for files, `d` for folders (24 hex chars). */
export function newKeySegment(prefix: 'f' | 'd'): string {
  return `${prefix}${randomBytes(12).toString('hex')}`;
}

/** Reject remoteIds outside the caller's own namespace (tenant isolation). */
export function assertOwnKey(root: string, remoteId: string): void {
  if (typeof remoteId !== 'string' || !remoteId.startsWith(`${root}/`)) {
    throw new ProviderError('ERR_NOT_FOUND', 'object not found in this account');
  }
}

/** The listing prefix for a folder directory; `null` resolves to the account root. */
export function listDir(root: string, parentId: string | null): string {
  if (parentId === null) return `${root}/`;
  assertOwnKey(root, parentId);
  if (!parentId.endsWith('/')) {
    throw new ProviderError('ERR_NOT_FOUND', 'parent folder not found in this account');
  }
  return parentId;
}

export interface ParsedChild {
  fileId: string;
  name: string;
  isFolder: boolean;
}

/**
 * Parse a listed key relative to `dir` (ends with `/`). Returns null for keys
 * that are not a direct child (deeper descendants, or the folder's own marker).
 */
export function parseChild(dir: string, key: string): ParsedChild | null {
  if (!key.startsWith(dir) || key === dir) return null;
  const relative = key.slice(dir.length);
  const isFolder = relative.endsWith('/');
  const body = isFolder ? relative.slice(0, -1) : relative;
  const segments = body.split('/');
  if (segments.length !== 2) return null;
  const [fileId, name] = segments;
  if (!fileId || !name) return null;
  return { fileId, name, isFolder };
}

export interface ParsedKey {
  fileId: string;
  name: string;
  isFolder: boolean;
  parentId: string | null;
}

/** Derive name, fileId and parent folder from any key inside the namespace. */
export function parseKey(root: string, key: string): ParsedKey {
  assertOwnKey(root, key);
  const isFolder = key.endsWith('/');
  const body = isFolder ? key.slice(0, -1) : key;
  const relative = body.slice(root.length + 1);
  const segments = relative.split('/');
  if (segments.length < 2 || segments.some((segment) => segment === '')) {
    throw new ProviderError('ERR_INVALID_INPUT', 'malformed object key');
  }
  const name = segments[segments.length - 1]!;
  const fileId = segments[segments.length - 2]!;
  const parentSegments = segments.slice(0, -2);
  const parentId = parentSegments.length === 0 ? null : `${root}/${parentSegments.join('/')}/`;
  return { fileId, name, isFolder, parentId };
}

/** Parent directory of a file/folder key, always ending with `/` (null = account root). */
export function parentDirOf(root: string, key: string): string | null {
  return parseKey(root, key).parentId;
}

/** Replace the `dir` prefix of `key` with `newDir` (both end with `/`). */
export function rebaseKey(dir: string, newDir: string, key: string): string {
  if (!key.startsWith(dir)) {
    throw new ProviderError('ERR_INTERNAL', 'key is not inside the expected directory');
  }
  return `${newDir}${key.slice(dir.length)}`;
}
