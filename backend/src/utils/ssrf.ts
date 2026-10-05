/**
 * SSRF guard — see docs/architecture/contracts/security-contract.md §7.
 *
 * Every server-side request whose destination is influenced by user input MUST
 * pass through `assertUrlAllowed()` / `safeFetch()`:
 *   - S3 / MinIO / R2 / B2 custom endpoints
 *   - webhook subscription URLs
 *   - any stored URL fetched by the backend
 *
 * Coordinator-owned: agents consume this module; changes require a contract proposal.
 */

import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { ProviderError } from '../providers/errors.js';

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'instance-data',
  'metadata',
]);

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain'];

/** Ports accepted for user-supplied endpoints unless allow-listed by hostname. */
const DEFAULT_ALLOWED_PORTS = new Set([80, 443, 9000, 9001, 443]);

function envFlag(name: string): boolean {
  return (process.env[name] ?? '').toLowerCase() === 'true';
}

function allowlist(): Set<string> {
  const raw = process.env.SSRF_ALLOWLIST ?? '';
  return new Set(
    raw
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isBlockedIp(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 0) return true;

  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // 10/8
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true; // 192.168/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    if (a === 192 && b === 0) return true; // 192.0.0/24 + 192.0.2/24
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a >= 224) return true; // multicast + broadcast + reserved
    return false;
  }

  // IPv6
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  if (lower.startsWith('fe80')) return true; // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA
  if (lower.startsWith('::ffff:')) return false; // handled below via mapped v4
  if (lower.startsWith('ff')) return true; // multicast
  // IPv4-mapped IPv6
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isBlockedIp(mapped[1]!);
  return false;
}

function normalizeUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ProviderError('ERR_SSRF_BLOCKED', 'Invalid endpoint URL');
  }
  if (u.username || u.password) {
    throw new ProviderError('ERR_SSRF_BLOCKED', 'Credentials in endpoint URL are not allowed');
  }
  if (u.hash) {
    throw new ProviderError('ERR_SSRF_BLOCKED', 'Fragment in endpoint URL is not allowed');
  }
  return u;
}

/**
 * Validate a user-influenced URL. Throws ProviderError('ERR_SSRF_BLOCKED') on rejection.
 * Returns the parsed URL on success.
 */
export function assertUrlAllowed(raw: string): URL {
  const u = normalizeUrl(raw);
  const allowInsecure = envFlag('ALLOW_INSECURE_ENDPOINTS');
  const allowed = allowlist();

  if (u.protocol !== 'https:') {
    if (!(u.protocol === 'http:' && allowInsecure)) {
      throw new ProviderError('ERR_SSRF_BLOCKED', 'Only https endpoints are allowed');
    }
  }

  const hostname = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const isAllowedHost = allowed.has(hostname);

  if (!isAllowedHost) {
    if (BLOCKED_HOSTNAMES.has(hostname)) {
      throw new ProviderError('ERR_SSRF_BLOCKED', 'Endpoint host is not allowed');
    }
    if (BLOCKED_SUFFIXES.some((s) => hostname.endsWith(s))) {
      throw new ProviderError('ERR_SSRF_BLOCKED', 'Endpoint host is not allowed');
    }
    const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
    if (!DEFAULT_ALLOWED_PORTS.has(port)) {
      throw new ProviderError('ERR_SSRF_BLOCKED', 'Endpoint port is not allowed');
    }
  }

  return u;
}

/** Resolve a hostname and reject if any address is private/metadata/loopback. */
export async function assertResolvedAddressesAllowed(hostname: string): Promise<void> {
  const allowed = allowlist();
  const host = hostname.replace(/^\[|\]$/g, '');
  if (allowed.has(host)) return;

  if (net.isIP(host)) {
    if (isBlockedIp(host)) {
      throw new ProviderError('ERR_SSRF_BLOCKED', 'Endpoint address is not allowed');
    }
    return;
  }

  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'Endpoint host could not be resolved');
  }
  if (!addresses.length) {
    throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'Endpoint host could not be resolved');
  }
  for (const a of addresses) {
    if (isBlockedIp(a.address)) {
      throw new ProviderError('ERR_SSRF_BLOCKED', 'Endpoint address is not allowed');
    }
  }
}

/** Full gate: syntax + DNS. Call immediately before connecting. */
export async function assertFetchAllowed(raw: string): Promise<URL> {
  const u = assertUrlAllowed(raw);
  await assertResolvedAddressesAllowed(u.hostname);
  return u;
}

/**
 * `fetch` with the SSRF gate applied and redirects re-validated (max 3 hops).
 * Never follows a redirect that fails the gate.
 */
export async function safeFetch(
  raw: string,
  init: RequestInit & { redirect?: 'manual' | 'follow' } = {},
): Promise<Response> {
  const maxHops = 3;
  let current = raw;
  let base = init;

  for (let hop = 0; hop <= maxHops; hop++) {
    await assertFetchAllowed(current);
    const res = await fetch(current, { ...base, redirect: 'manual' });

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (!loc) return res;
      if (base.redirect !== 'follow') return res;
      current = new URL(loc, current).toString();
      if (hop === maxHops) {
        throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'Too many redirects');
      }
      continue;
    }
    return res;
  }
  throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'Too many redirects');
}

/** Strip query strings from a URL before it is stored/logged as an error message. */
export function sanitizeUrlForDisplay(raw: string): string {
  try {
    const u = new URL(raw);
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return '[invalid-url]';
  }
}
