/**
 * Untrusted-content handling (docs/ai-agent-architecture.md §4.3).
 *
 * File names, metadata, provider messages and anything else read from storage are DATA. They are
 * stripped of control/bidi characters, length-capped, scrubbed of credential-looking fragments and
 * wrapped in an explicit envelope before they reach the model. This reduces injection surface; it is
 * not what protects the system — authorization, scoping and confirmation are enforced in code
 * regardless of what the model says.
 */

// Control characters, zero-width characters and bidi overrides (used for spoofing/hiding text).
// eslint-disable-next-line no-control-regex
const CONTROL_AND_BIDI = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;

export function cleanText(value: unknown, max = 200): string {
  const text = typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
  const stripped = text.replace(CONTROL_AND_BIDI, ' ').replace(/\s+/g, ' ').trim();
  return stripped.length > max ? `${stripped.slice(0, max - 1)}…` : stripped;
}

const SECRET_PAIR =
  /\b(access_tokens?|refresh_token|token|client_secret|secret|password|passwd|api[_-]?key|apikey|authorization|cookie|signature|sign)\s*[=:]\s*[^\s,;&"']{4,}/gi;
const BEARER = /\bbearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi;
const VENDOR_KEY = /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g;

/** Free-text safety net: credential-looking fragments inside strings are redacted. */
export function redactSecretsInText(text: string): string {
  return text.replace(BEARER, 'Bearer [redacted]').replace(SECRET_PAIR, '$1=[redacted]').replace(VENDOR_KEY, '[redacted]');
}

const OPEN_TAG = '<untrusted_data>';
const CLOSE_TAG = '</untrusted_data>';

/** Wrap tool output for the model; any attempt to close the envelope early is neutralised. */
export function wrapUntrusted(json: string): string {
  const safe = json.split(CLOSE_TAG).join('<\\/untrusted_data>').split(OPEN_TAG).join('<\\untrusted_data>');
  return `${OPEN_TAG}\n${safe}\n${CLOSE_TAG}`;
}

const SECRET_KEY =
  /(password|passphrase|secret|token|authorization|credential|api[-_]?key|private[-_]?key|access[-_]?key|signature|cookie|bearer|dlink)/i;

/** Deep-scrub: secret-shaped keys are redacted and every string is cleaned, redacted and capped. */
export function scrubValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') return redactSecretsInText(cleanText(value, 500));
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (depth > 6) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 500).map((entry) => scrubValue(entry, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key) && !/^(has|is|requires)/i.test(key) ? '[redacted]' : scrubValue(entry, depth + 1);
    }
    return out;
  }
  return String(value);
}

/** Scrub then serialise, cutting oversized output at a clean boundary. */
export function toModelJson(value: unknown, maxChars = 24_000): { json: string; truncated: boolean } {
  const json = JSON.stringify(scrubValue(value));
  if (json.length <= maxChars) return { json, truncated: false };
  return {
    json: JSON.stringify({ truncated: true, note: 'Output exceeded the size limit and was cut. Narrow the request.', preview: json.slice(0, maxChars - 200) }),
    truncated: true,
  };
}
