/**
 * TeraBox HTTP transport seam — see docs/architecture/providers/terabox.md.
 *
 * Production traffic is pinned to the fixed terabox.com endpoints. Tests swap
 * the base URL and the upload host for a local server through this module-level
 * seam; it is never derived from user input, so it adds no SSRF surface
 * (security-contract §7). Upstream-supplied hosts (regional prefix, upload host,
 * download links) are validated against the terabox.com suffix or re-entered
 * through `assertFetchAllowed()` inside the adapter instead.
 */

export const TERABOX_BASE_URL = 'https://www.terabox.com';
export const TERABOX_UPLOAD_HOST = 'https://c-all.terabox.com';

/**
 * Desktop web client fingerprint the unofficial API expects. Rotating this
 * string (or `app_id`) is one of the version-fragility risks documented in the
 * provider note.
 */
export const TERABOX_USER_AGENT =
  'terabox;1.40.0.132;PC;PC-Windows;10.0.26100;WindowsTeraBox';

export const TERABOX_APP_QUERY = {
  app_id: '250528',
  channel: 'dubox',
  clienttype: '0',
} as const;

export interface TeraBoxTransport {
  /** API base, e.g. https://www.terabox.com */
  baseUrl: string;
  /** Fallback upload host, e.g. https://c-all.terabox.com */
  uploadHost: string;
}

const DEFAULT_TRANSPORT: TeraBoxTransport = {
  baseUrl: TERABOX_BASE_URL,
  uploadHost: TERABOX_UPLOAD_HOST,
};

let current: TeraBoxTransport = { ...DEFAULT_TRANSPORT };

export function setTeraBoxTransport(overrides: Partial<TeraBoxTransport>): void {
  current = { ...DEFAULT_TRANSPORT, ...overrides };
}

export function resetTeraBoxTransport(): void {
  current = { ...DEFAULT_TRANSPORT };
}

export function teraboxTransport(): TeraBoxTransport {
  return current;
}

/** Absolute URL for an endpoint under the configured base. */
export function teraboxUrl(
  base: string,
  endpoint: string,
  query?: Record<string, string | number | undefined>,
): string {
  const root = base.replace(/\/+$/, '');
  const url = new URL(`${root}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === '') continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/** True for `terabox.com` itself and any subdomain of it. */
export function isTeraboxHostname(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (normalized === 'terabox.com') return true;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.terabox\.com$/.test(normalized);
}

/**
 * Regional routing: `/api/check/login` answers with a `region-domain-prefix`
 * header that must be prefixed onto terabox.com. Anything else is ignored, so
 * an upstream response can never move the client off the pinned suffix.
 */
export function regionBaseUrl(prefix: string | undefined): string | null {
  if (typeof prefix !== 'string') return null;
  const value = prefix.trim().toLowerCase();
  if (!/^[a-z0-9-]{1,63}$/.test(value)) return null;
  if (value === 'terabox') return null;
  return `https://${value}.terabox.com`;
}

/** Upstream upload host → absolute URL, or null when it is not a terabox host. */
export function uploadHostUrl(host: string | undefined): string | null {
  if (typeof host !== 'string') return null;
  const value = host.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (value === '' || !isTeraboxHostname(value)) return null;
  return `https://${value}`;
}
