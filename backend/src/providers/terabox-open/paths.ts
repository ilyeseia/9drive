/**
 * Path mapping for the TeraBox application namespace.
 *
 * The official document confines every file operation to the application's own
 * folder ("can only be performed within this space") but names that folder
 * inconsistently, so the root prefix is configuration (`TERABOX_APP_ROOT`,
 * default empty = send paths exactly as given, as the doc's curl examples do).
 *
 * `remoteId` stored by 9Drive is always **relative to the app root**
 * (`/dir/file.txt`); the root prefix is added/stripped only at the wire.
 */

import { ProviderError } from '../errors.js';

const MAX_NAME_BYTES = 255;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function configuredAppRoot(): string {
  const raw = process.env.TERABOX_APP_ROOT?.trim() ?? '';
  if (raw === '' || raw === '/') return '';
  return normalizeRelativePath(raw);
}

export function validateFileName(name: string): string {
  if (typeof name !== 'string' || name.trim() === '' || name === '.' || name === '..') {
    throw new ProviderError('ERR_INVALID_INPUT', 'invalid file name');
  }
  if (name.includes('/') || CONTROL_CHARS.test(name) || Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES) {
    throw new ProviderError('ERR_INVALID_INPUT', 'invalid file name');
  }
  return name;
}

/** Normalise to `/a/b` form; `/` stays `/`. Rejects traversal and control characters. */
export function normalizeRelativePath(input: string): string {
  if (typeof input !== 'string' || CONTROL_CHARS.test(input)) {
    throw new ProviderError('ERR_INVALID_INPUT', 'invalid path');
  }
  const segments = input.split('/').filter((segment) => segment !== '');
  for (const segment of segments) {
    if (segment === '.' || segment === '..') throw new ProviderError('ERR_INVALID_INPUT', 'invalid path');
  }
  return segments.length === 0 ? '/' : `/${segments.join('/')}`;
}

export function toWirePath(relative: string, root = configuredAppRoot()): string {
  const rel = normalizeRelativePath(relative);
  if (root === '') return rel;
  return rel === '/' ? root : `${root}${rel}`;
}

/** Strip the app root from a path TeraBox returned; paths outside the root are rejected. */
export function fromWirePath(wire: string, root = configuredAppRoot()): string {
  const normalized = normalizeRelativePath(wire);
  if (root === '') return normalized;
  if (normalized === root) return '/';
  if (normalized.startsWith(`${root}/`)) return normalized.slice(root.length);
  // Some responses already return app-relative paths; keep them.
  return normalized;
}

export function joinPath(parent: string | null, name: string): string {
  const base = parent === null ? '/' : normalizeRelativePath(parent);
  return base === '/' ? `/${name}` : `${base}/${name}`;
}

/** Direct children of the root report `null` (the platform's "no remote parent"). */
export function parentOf(relative: string): string | null {
  const rel = normalizeRelativePath(relative);
  if (rel === '/') return null;
  const idx = rel.lastIndexOf('/');
  return idx <= 0 ? null : rel.slice(0, idx);
}

export function baseName(relative: string): string {
  const rel = normalizeRelativePath(relative);
  return rel === '/' ? '' : rel.slice(rel.lastIndexOf('/') + 1);
}
