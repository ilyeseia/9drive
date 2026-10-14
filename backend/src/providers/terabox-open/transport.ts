/**
 * TeraBox Open Platform transport seam and host validation.
 *
 * Contract source: https://www.terabox.com/integrations/docs?lang=en
 * (docs/terabox-integration-assessment.md §2). The authorization host is the
 * documented `www.terabox.com`. Every other host (`api_domain`,
 * `upload_domain`, download links) is returned by TeraBox per user and is
 * therefore untrusted input: it must be a bare `terabox.com` hostname served
 * over https and still passes `assertFetchAllowed()` before every request.
 *
 * Tests redirect traffic to a local fake through `setTeraBoxOpenTransport()`;
 * that seam is a module-level value, never derived from user input.
 */

import { ProviderError } from '../errors.js';

export const TERABOX_OPEN_AUTH_BASE = 'https://www.terabox.com';

/** Fixed `app_id` the shard-upload endpoint documents. */
export const TERABOX_OPEN_APP_ID = '250528';

export interface TeraBoxOpenTransport {
  /** Base URL of the authorization service (`/oauth/*`). */
  authBase: string;
  /** Test-only: accept hostnames outside terabox.com (e.g. 127.0.0.1:port). */
  hostPolicy: 'terabox' | 'any';
  /** Scheme used when expanding `api_domain` / `upload_domain`. */
  scheme: 'https' | 'http';
}

const DEFAULT_TRANSPORT: TeraBoxOpenTransport = {
  authBase: TERABOX_OPEN_AUTH_BASE,
  hostPolicy: 'terabox',
  scheme: 'https',
};

let current: TeraBoxOpenTransport = { ...DEFAULT_TRANSPORT };

export function setTeraBoxOpenTransport(overrides: Partial<TeraBoxOpenTransport>): void {
  current = { ...DEFAULT_TRANSPORT, ...overrides };
}

export function resetTeraBoxOpenTransport(): void {
  current = { ...DEFAULT_TRANSPORT };
}

export function teraboxOpenTransport(): TeraBoxOpenTransport {
  return current;
}

/** True for `terabox.com` itself and any subdomain of it. */
export function isTeraBoxHostname(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (normalized === 'terabox.com') return true;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.terabox\.com$/.test(normalized);
}

/**
 * Expand a domain returned by `/oauth/tokeninfo` into a base URL.
 * Accepts only a bare hostname (no scheme, port, path, query or credentials).
 */
export function serviceBaseFromDomain(domain: unknown, label: string): string {
  if (typeof domain !== 'string' || domain.trim() === '') {
    throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', `TeraBox did not return ${label}`);
  }
  const value = domain.trim().toLowerCase();
  const transport = teraboxOpenTransport();
  if (transport.hostPolicy === 'any') {
    if (!/^[a-z0-9.-]+(:\d{1,5})?$/.test(value)) {
      throw new ProviderError('ERR_SSRF_BLOCKED', `TeraBox returned an invalid ${label}`);
    }
    return `${transport.scheme}://${value}`;
  }
  if (!/^[a-z0-9.-]+$/.test(value) || !isTeraBoxHostname(value)) {
    throw new ProviderError('ERR_SSRF_BLOCKED', `TeraBox returned a ${label} outside terabox.com`);
  }
  return `https://${value}`;
}

/** Validate an upstream-supplied download link before it is fetched. */
export function assertTeraBoxDownloadUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProviderError('ERR_SSRF_BLOCKED', 'TeraBox returned an invalid download link');
  }
  const transport = teraboxOpenTransport();
  if (transport.hostPolicy === 'any') return url;
  if (url.protocol !== 'https:' || url.username || url.password || !isTeraBoxHostname(url.hostname)) {
    throw new ProviderError('ERR_SSRF_BLOCKED', 'TeraBox returned a download link outside terabox.com');
  }
  return url;
}

export function buildUrl(
  base: string,
  endpoint: string,
  query?: Record<string, string | number | undefined>,
): string {
  const url = new URL(`${base.replace(/\/+$/, '')}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === '') continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}
