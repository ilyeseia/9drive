/**
 * pCloud HTTP transport seam — see docs/architecture/providers/pcloud.md.
 *
 * Production traffic is pinned to api.pcloud.com; EU accounts must switch to
 * eapi.pcloud.com, which arrives as an account-configured `apiBaseUrl` /
 * `tokenUrl` and is gated with `assertFetchAllowed()` inside the adapter.
 * The module-level seam below is never derived from user input, so tests swap
 * it freely without adding SSRF surface (security-contract §7).
 *
 * `cdnScheme` exists because `getfilelink` returns a bare host+path that the
 * adapter prefixes with `https://` in production; tests serve plain HTTP.
 */

import { PCLOUD_TOKEN_URL } from './oauth2.js';

export const PCLOUD_API_URL = 'https://api.pcloud.com';

export interface PcloudTransport {
  /** JSON methods base, e.g. https://api.pcloud.com */
  apiUrl: string;
  /** OAuth2 token endpoint used by the 401 refresh path. */
  tokenUrl: string;
  /** Scheme for CDN download URLs built from getfilelink hosts. */
  cdnScheme: 'https' | 'http';
}

const DEFAULT_TRANSPORT: PcloudTransport = {
  apiUrl: PCLOUD_API_URL,
  tokenUrl: PCLOUD_TOKEN_URL,
  cdnScheme: 'https',
};

let current: PcloudTransport = { ...DEFAULT_TRANSPORT };

export function setPcloudTransport(overrides: Partial<PcloudTransport>): void {
  current = { ...DEFAULT_TRANSPORT, ...overrides };
}

export function resetPcloudTransport(): void {
  current = { ...DEFAULT_TRANSPORT };
}

export function pcloudTransport(): PcloudTransport {
  return current;
}

/** Absolute URL for a `/method` endpoint under the configured base. */
export function pcloudUrl(
  base: string,
  method: string,
  query?: Record<string, string | number | undefined>,
): string {
  const root = base.replace(/\/+$/, '');
  const url = new URL(`${root}/${method.replace(/^\/+/, '')}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/** Build the CDN download URL from a getfilelink `hosts[0]` + `path` pair. */
export function pcloudCdnUrl(scheme: 'https' | 'http', host: string, path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${scheme}://${host}${normalizedPath}`;
}
