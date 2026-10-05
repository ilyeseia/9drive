/**
 * Google Drive HTTP transport seam — see docs/architecture/providers/google_drive.md.
 *
 * Production traffic is pinned to the fixed googleapis.com endpoints. Tests swap
 * the base URL and token URL for a local server; the override is a module-level
 * test seam and is never derived from user input, so it adds no SSRF surface
 * (security-contract §7).
 */

export const GOOGLE_DRIVE_BASE_URL = 'https://www.googleapis.com';
export const GOOGLE_DRIVE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

export interface GoogleDriveTransport {
  baseUrl: string;
  tokenUrl: string;
}

const DEFAULT_TRANSPORT: GoogleDriveTransport = {
  baseUrl: GOOGLE_DRIVE_BASE_URL,
  tokenUrl: GOOGLE_DRIVE_TOKEN_URL,
};

let current: GoogleDriveTransport = { ...DEFAULT_TRANSPORT };

export function setGoogleDriveTransport(overrides: Partial<GoogleDriveTransport>): void {
  current = { ...DEFAULT_TRANSPORT, ...overrides };
}

export function resetGoogleDriveTransport(): void {
  current = { ...DEFAULT_TRANSPORT };
}

export function googleDriveTransport(): GoogleDriveTransport {
  return current;
}

/** Absolute URL for an API path (or an already-absolute URL) under the configured base. */
export function googleDriveUrl(path: string, query?: Record<string, string | undefined>): string {
  const absolute = /^https?:\/\//i.test(path);
  const base = current.baseUrl.replace(/\/+$/, '');
  const url = new URL(absolute ? path : `${base}${path.startsWith('/') ? '' : '/'}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

/**
 * Resumable session URLs come from the upstream response, so they are accepted
 * only when they point back at the configured origin or at *.googleapis.com.
 */
export function assertSessionUriAllowed(sessionUri: string, baseUrl = current.baseUrl): boolean {
  try {
    const url = new URL(sessionUri);
    const base = new URL(baseUrl);
    if (url.origin === base.origin) return true;
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && (host === 'googleapis.com' || host.endsWith('.googleapis.com'));
  } catch {
    return false;
  }
}
