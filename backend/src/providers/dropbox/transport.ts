/**
 * Dropbox HTTP transport seam — see docs/architecture/providers/dropbox.md.
 *
 * Production traffic is pinned to the fixed dropboxapi.com endpoints. Tests swap
 * the base URLs and the token URL for a local server through this module-level
 * seam; it is never derived from user input, so it adds no SSRF surface (security-contract §7).
 * Account-supplied endpoint overrides (`ctx.account.config`) are gated with
 * `assertUrlAllowed()` inside the adapter instead.
 */

import { DROPBOX_TOKEN_URL } from './oauth2.js';

export const DROPBOX_API_URL = 'https://api.dropboxapi.com/2';
export const DROPBOX_CONTENT_URL = 'https://content.dropboxapi.com/2';

export interface DropboxTransport {
  /** JSON-RPC base, e.g. https://api.dropboxapi.com/2 */
  apiUrl: string;
  /** Binary/content base, e.g. https://content.dropboxapi.com/2 */
  contentUrl: string;
  /** OAuth2 token endpoint used by the 401 refresh path. */
  tokenUrl: string;
}

const DEFAULT_TRANSPORT: DropboxTransport = {
  apiUrl: DROPBOX_API_URL,
  contentUrl: DROPBOX_CONTENT_URL,
  tokenUrl: DROPBOX_TOKEN_URL,
};

let current: DropboxTransport = { ...DEFAULT_TRANSPORT };

export function setDropboxTransport(overrides: Partial<DropboxTransport>): void {
  current = { ...DEFAULT_TRANSPORT, ...overrides };
}

export function resetDropboxTransport(): void {
  current = { ...DEFAULT_TRANSPORT };
}

export function dropboxTransport(): DropboxTransport {
  return current;
}

/** Absolute URL for a `/2`-style endpoint under the configured base. */
export function dropboxUrl(
  base: string,
  endpoint: string,
  query?: Record<string, string | undefined>,
): string {
  const root = base.replace(/\/+$/, '');
  const url = new URL(`${root}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') url.searchParams.set(key, value);
    }
  }
  return url.toString();
}
