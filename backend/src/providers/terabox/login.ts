/**
 * TeraBox passport login (email + password) → fresh `ndus` session cookie.
 *
 * The reverse-engineered flow mirrors the two live-tested community clients
 * (aioterabox, seiya-npm/terabox-api):
 *
 *   1. GET  /wap/outlogin/login      bootstrap page → `pcftoken` + cookies
 *   2. GET  /passport/getpubkey       AES-128-CBC wrapped RSA public key
 *   3. POST /passport/prelogin        `seval`/`random`/`timestamp` challenge
 *   4. POST /passport/login           RSA(PKCS1v15, md5(password)+'32') + prand
 *   5. GET  /main                     re-scrape the authorized (shorter) jsToken
 *
 * A successful login answers `Set-Cookie: ndus=…` — the same credential the
 * connect-by-cookie flow stores. 9drive uses this to renew dead sessions
 * automatically whenever the stored email+password are present (see the
 * provider's `renew` hook), which is what keeps TeraBox accounts stable
 * instead of expiring after every browser rotation.
 *
 * `need verify` (TeraBox's simple-verify challenge) cannot be completed
 * headlessly; it surfaces as an actionable ERR_AUTH_EXPIRED so the user can
 * log in once from a real browser and retry.
 */

import { createDecipheriv, createHash, constants, publicEncrypt } from 'node:crypto';
import { request } from 'undici';
import { ProviderError } from '../errors.js';
import { extractJsToken } from './sign.js';
import { TERABOX_USER_AGENT } from './transport.js';

const LOGIN_TIMEOUT_MS = 20_000;

const BOOTSTRAP_PATHS = ['/wap/outlogin/login', '/wap/outlogin/emailRegister'] as const;

export interface TeraboxLoginInput {
  email: string;
  password: string;
  /** Override the API base (tests inject a local fake). */
  baseUrl?: string;
  signal?: AbortSignal;
}

export interface TeraboxLoginResult {
  /** Full cookie header ready for `TeraBoxClient` (`ndus=…; browserid=…; lang=en`). */
  cookie: string;
  ndus: string;
  displayName: string | null;
  jsToken: string | null;
}

type CookieJar = Map<string, string>;

function absorbSetCookies(jar: CookieJar, headers: Record<string, string | string[] | undefined>): void {
  const raw = headers['set-cookie'];
  const entries = Array.isArray(raw) ? raw : raw ? [raw] : [];
  for (const entry of entries) {
    const pair = String(entry).split(';', 1)[0];
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name) continue;
    if (value === '' || /^deleted$/i.test(value) || /^null$/i.test(value)) {
      jar.delete(name);
      continue;
    }
    jar.set(name, value);
  }
}

function cookieHeader(jar: CookieJar): string {
  const parts: string[] = [];
  for (const [name, value] of jar) {
    if (!name || !value) continue;
    parts.push(`${name}=${value}`);
  }
  if (!parts.some((part) => part.startsWith('lang='))) parts.push('lang=en');
  return parts.join('; ');
}

function parseTemplateData(html: string): { pcftoken: string } {
  const match = /<script>var templateData = (.*?);<\/script>/.exec(html);
  if (!match || !match[1]) {
    throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'TeraBox login bootstrap page had no templateData');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch (cause) {
    throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'TeraBox login bootstrap page had malformed templateData', {
      cause,
    });
  }
  const pcftoken = (parsed as { pcftoken?: unknown } | null)?.pcftoken;
  return { pcftoken: typeof pcftoken === 'string' ? pcftoken : '' };
}

function looseB64Decode(value: string): Buffer {
  const normalized = value.trim().replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

/** Undo the AES-128-CBC wrapper around the passport RSA public key. */
export function decryptTeraBoxPublicKey(pp1: string, pp2: string): string {
  const key = Buffer.from(pp2, 'utf8');
  if (key.length !== 16) {
    throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'TeraBox public key wrapper had an unexpected key length');
  }
  const iv = Buffer.from(pp1.slice(0, 16), 'utf8');
  const cipherText = looseB64Decode(pp1.slice(16));
  const decipher = createDecipheriv('aes-128-cbc', key, iv);
  try {
    return Buffer.concat([decipher.update(cipherText), decipher.final()]).toString('utf8');
  } catch (cause) {
    throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'TeraBox public key wrapper failed to decrypt', { cause });
  }
}

/** RSA-encrypt `md5(password) + '32'` (mode 2) with the passport public key. */
export function encryptTeraBoxPassword(password: string, publicKeyPem: string): string {
  const digest = createHash('md5').update(password, 'utf8').digest('hex');
  const message = `${digest}${digest.length}`;
  try {
    const encrypted = publicEncrypt(
      { key: publicKeyPem, padding: constants.RSA_PKCS1_PADDING },
      Buffer.from(message, 'utf8'),
    );
    return encrypted.toString('base64');
  } catch (cause) {
    throw new ProviderError('ERR_INTERNAL', 'failed to encrypt the TeraBox password', { cause });
  }
}

/** `sha1(web-{seval}-{encpwd}-{email}-{browserid}-{random})` — the login request fingerprint. */
export function teraboxPrand(
  email: string,
  seval: string,
  encpwd: string,
  browserid: string | undefined,
  random: string,
): string {
  // The reference client stringifies a missing browserid as Python's "None".
  return createHash('sha1')
    .update(`web-${seval}-${encpwd}-${email}-${browserid ?? 'None'}-${random}`, 'utf8')
    .digest('hex');
}

/** url-safe base64 (the `pwd` field travels without `+`/`/`). */
function urlSafeB64(value: string): string {
  return value.replace(/\+/g, '-').replace(/\//g, '_');
}

export async function teraboxPassportLogin(input: TeraboxLoginInput): Promise<TeraboxLoginResult> {
  const email = input.email.trim();
  const password = input.password;
  if (!email || !password) {
    throw new ProviderError('ERR_INVALID_INPUT', 'TeraBox login requires an email and a password');
  }
  const base = (input.baseUrl ?? 'https://www.terabox.com').replace(/\/+$/, '');
  const jar: CookieJar = new Map();

  const call = async (
    method: 'GET' | 'POST',
    path: string,
    options: { headers?: Record<string, string>; body?: string } = {},
  ): Promise<{ status: number; text: string }> => {
    const url = path.startsWith('http') ? path : `${base}${path.startsWith('/') ? '' : '/'}${path}`;
    let response;
    try {
      response = await request(url, {
        method,
        headers: {
          Accept: 'application/json, text/plain, */*',
          'User-Agent': TERABOX_USER_AGENT,
          Cookie: cookieHeader(jar),
          Referer: `${base}/`,
          'X-Requested-With': 'XMLHttpRequest',
          ...options.headers,
        },
        body: options.body,
        signal: input.signal ?? null,
        headersTimeout: LOGIN_TIMEOUT_MS,
        bodyTimeout: LOGIN_TIMEOUT_MS,
      });
    } catch (cause) {
      throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'TeraBox login request failed', { cause });
    }
    absorbSetCookies(jar, response.headers as Record<string, string | string[] | undefined>);
    const text = await response.body.text().catch(() => '');
    return { status: response.statusCode, text };
  };

  // 1. Bootstrap: the wap login page hands out `pcftoken` and the first cookies.
  let html = '';
  for (const path of BOOTSTRAP_PATHS) {
    const page = await call('GET', path);
    if (page.status === 200 && page.text.includes('templateData')) {
      html = page.text;
      break;
    }
  }
  if (!html) {
    throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'TeraBox login bootstrap page is unavailable');
  }
  const { pcftoken } = parseTemplateData(html);

  // 2. Public key (AES-wrapped RSA).
  const keyResponse = await call('GET', '/passport/getpubkey');
  let publicKeyPem: string;
  try {
    const payload = JSON.parse(keyResponse.text) as { data?: { pp1?: string; pp2?: string } };
    publicKeyPem = decryptTeraBoxPublicKey(String(payload.data?.pp1 ?? ''), String(payload.data?.pp2 ?? ''));
  } catch (cause) {
    if (ProviderError.is(cause)) throw cause;
    throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'TeraBox passport public key is unavailable', { cause });
  }

  // 3. Pre-login challenge.
  const preForm = new URLSearchParams({
    client: 'web',
    pass_version: '2.8',
    clientfrom: 'h5',
    pcftoken,
    email,
  });
  const pre = await call('POST', '/passport/prelogin', {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: `${base}/wap/outlogin/emailRegister?tab=1`,
    },
    body: preForm.toString(),
  });
  let preData: { seval?: unknown; random?: unknown; timestamp?: unknown };
  try {
    const payload = JSON.parse(pre.text) as { code?: number; msg?: string; data?: typeof preData };
    if (payload.code !== 0) {
      throw new ProviderError('ERR_AUTH_EXPIRED', `TeraBox prelogin failed: ${payload.msg ?? String(payload.code)}`);
    }
    preData = payload.data ?? {};
  } catch (cause) {
    if (ProviderError.is(cause)) throw cause;
    throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'TeraBox prelogin returned an unreadable response', { cause });
  }
  const seval = String(preData.seval ?? '');
  const random = String(preData.random ?? '');
  const timestamp = String(preData.timestamp ?? '');
  if (!seval || !random) {
    throw new ProviderError('ERR_UPSTREAM_UNAVAILABLE', 'TeraBox prelogin returned an incomplete challenge');
  }

  // 4. Encrypted password + request fingerprint.
  const encpass = urlSafeB64(encryptTeraBoxPassword(password, publicKeyPem));
  const prand = teraboxPrand(email, seval, encpass, jar.get('browserid'), random);

  // 5. The login itself — success answers `Set-Cookie: ndus=…`.
  const loginForm = new URLSearchParams({
    client: 'web',
    pass_version: '2.8',
    clientfrom: 'h5',
    pcftoken,
    prand,
    email,
    pwd: encpass,
    seval,
    random,
    timestamp,
  });
  const login = await call('POST', '/passport/login', {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: `${base}/wap/outlogin/login`,
    },
    body: loginForm.toString(),
  });
  let payload: { code?: number; errmsg?: string; msg?: string; data?: { displayName?: unknown } } | null = null;
  try {
    payload = JSON.parse(login.text);
  } catch {
    payload = null;
  }
  if (!payload || payload.code !== 0) {
    const message = String(payload?.errmsg ?? payload?.msg ?? login.text.slice(0, 200) ?? 'rejected');
    if (/need verify/i.test(message)) {
      throw new ProviderError(
        'ERR_AUTH_EXPIRED',
        'TeraBox requires a one-time verification: log in to terabox.com once in a real browser, then retry.',
        { detail: { needVerify: true } },
      );
    }
    throw new ProviderError('ERR_AUTH_EXPIRED', `TeraBox login failed: ${message}`);
  }
  const ndus = jar.get('ndus');
  if (!ndus) {
    throw new ProviderError('ERR_AUTH_EXPIRED', 'TeraBox login succeeded but issued no ndus cookie');
  }
  const displayName = typeof payload.data?.displayName === 'string' ? payload.data.displayName : null;

  // 6. The shell now serves the authorized (shorter) jsToken — best effort.
  let jsToken: string | null = null;
  try {
    const shell = await call('GET', '/main');
    if (shell.status === 200) jsToken = extractJsToken(shell.text);
  } catch {
    // Best-effort: the client re-scrapes jsToken per session anyway.
  }

  return { cookie: cookieHeader(jar), ndus, displayName, jsToken };
}
