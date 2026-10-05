/**
 * OneDrive HTTP transport seam — see docs/architecture/providers/onedrive.md.
 *
 * Production traffic is pinned to the fixed graph.microsoft.com endpoint. Tests
 * swap the Graph base URL and the token URL for a local server through this
 * module-level seam; it is never derived from user input, so it adds no SSRF
 * surface (security-contract §7). Account-supplied endpoint overrides
 * (`ctx.account.config`) are gated with `assertFetchAllowed()` inside the
 * adapter instead. Upstream-supplied URLs (upload session URLs, `@odata.nextLink`
 * continuations, download redirects, copy monitors) are gated per use.
 */

import { ONEDRIVE_TOKEN_URL } from './oauth2.js';

export const ONEDRIVE_GRAPH_URL = 'https://graph.microsoft.com/v1.0';

export interface OnedriveTransport {
  /** Graph REST base, e.g. https://graph.microsoft.com/v1.0 */
  graphUrl: string;
  /** OAuth2 token endpoint used by the 401 refresh path. */
  tokenUrl: string;
}

const DEFAULT_TRANSPORT: OnedriveTransport = {
  graphUrl: ONEDRIVE_GRAPH_URL,
  tokenUrl: ONEDRIVE_TOKEN_URL,
};

let current: OnedriveTransport = { ...DEFAULT_TRANSPORT };

export function setOnedriveTransport(overrides: Partial<OnedriveTransport>): void {
  current = { ...DEFAULT_TRANSPORT, ...overrides };
}

export function resetOnedriveTransport(): void {
  current = { ...DEFAULT_TRANSPORT };
}

export function onedriveTransport(): OnedriveTransport {
  return current;
}

/** Absolute URL for a `/v1.0`-style path under the configured base. */
export function graphUrl(
  base: string,
  path: string,
  query?: Record<string, string | undefined>,
): string {
  const root = base.replace(/\/+$/, '');
  const url = new URL(`${root}${path.startsWith('/') ? '' : '/'}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') url.searchParams.set(key, value);
    }
  }
  return url.toString();
}
