/**
 * Reverse-engineered TeraBox helpers — see docs/architecture/providers/terabox.md §4.
 *
 * `signDownload()` is the RC4-style obfuscation the web player applies to
 * `/api/home/info`'s `sign3`/`sign1` pair before requesting a dlink; the exact
 * algorithm is version-fragile and mirrored from the community client.
 */

import { createHash } from 'node:crypto';

/** RC4-style signature for `GET /api/download` (`sign=<sign(sign3, sign1)>`). */
export function signDownload(sign3: string, sign1: string): string {
  if (typeof sign3 !== 'string' || sign3.length === 0) return '';
  if (typeof sign1 !== 'string' || sign1.length === 0) return '';

  const p = new Uint8Array(256);
  const a = new Uint8Array(256);
  const result: number[] = [];

  for (let i = 0; i < 256; i++) {
    a[i] = sign3.charCodeAt(i % sign3.length) & 0xff;
    p[i] = i;
  }

  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + p[i] + a[i]) % 256;
    const swap = p[i];
    p[i] = p[j];
    p[j] = swap;
  }

  let i = 0;
  j = 0;
  for (let q = 0; q < sign1.length; q++) {
    i = (i + 1) % 256;
    j = (j + p[i]) % 256;
    const swap = p[i];
    p[i] = p[j];
    p[j] = swap;
    const k = p[(p[i] + p[j]) % 256];
    result.push(sign1.charCodeAt(q) ^ k);
  }

  return Buffer.from(result).toString('base64');
}

/**
 * Pull `jsToken` out of the SPA shell HTML. The value is embedded both raw and
 * URL-encoded depending on how the page is served, so every known shape is
 * tried; `null` means the caller proceeds without a token (read endpoints do
 * not need it).
 */
export function extractJsToken(html: string): string | null {
  if (typeof html !== 'string' || html.length === 0) return null;
  const patterns: RegExp[] = [
    /fn%28%22([A-Za-z0-9_\-+/=]+)%22%29/,
    /fn\("([A-Za-z0-9_\-+/=]+)"\)/,
    /jsToken%20%3D%20a%7D%3Bfn%28%22([A-Za-z0-9_\-+/=]+)%22%29/,
    /window\.jsToken\s*=\s*["']([A-Za-z0-9_\-+/=]+)["']/,
    /"jsToken"\s*:\s*"([A-Za-z0-9_\-+/=]+)"/,
    /jsToken["']?\s*[:=]\s*["']([A-Za-z0-9_\-+/=]{16,})["']/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match && match[1]) return match[1];
  }
  return null;
}

/**
 * Undo the obfuscation `/api/create` puts on the whole-file md5: the 10th
 * character is shifted by 'g', every position is XORed with its index, and the
 * four 8-byte blocks are swapped. Verification only — a mismatch is logged, never
 * fatal, because the per-chunk md5s are what the upload already proved.
 */
export function decodeMd5(encoded: string): string {
  if (typeof encoded !== 'string' || encoded.length !== 32) return encoded;
  const restored = `${encoded.slice(0, 9)}${(encoded.charCodeAt(9) - 'g'.charCodeAt(0)).toString(16)}${encoded.slice(10)}`;
  const xorred: string[] = [];
  for (let i = 0; i < restored.length; i++) {
    const digit = Number.parseInt(restored[i] as string, 16);
    if (!Number.isFinite(digit) || digit < 0 || digit > 15) return encoded;
    xorred.push((digit ^ (i & 15)).toString(16));
  }
  const joined = xorred.join('');
  return `${joined.slice(8, 16)}${joined.slice(0, 8)}${joined.slice(24, 32)}${joined.slice(16, 24)}`;
}

/** Control md5 the server compares against: the single chunk md5, or md5(JSON list). */
export function controlMd5(chunkMd5s: readonly string[]): string {
  if (chunkMd5s.length === 1) return chunkMd5s[0] as string;
  return createHash('md5').update(JSON.stringify(chunkMd5s)).digest('hex');
}
