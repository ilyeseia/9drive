import fs from 'node:fs';
import path from 'node:path';

/**
 * Executable security/architecture rules. Each one encodes a decision from docs/mobile/05-security-review.md so a
 * future change cannot quietly break it. They scan production source (not tests).
 */
const SRC = path.join(__dirname, '..');

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name) && !full.includes(`${path.sep}test${path.sep}`))
      yield full;
  }
}

const files = [...walk(SRC)].map((f) => ({ rel: path.relative(SRC, f).split(path.sep).join('/'), text: fs.readFileSync(f, 'utf8') }));

const offenders = (pattern: RegExp, allowed: string[] = []) =>
  files.filter((f) => !allowed.includes(f.rel) && pattern.test(f.text)).map((f) => f.rel);

describe('security architecture rules', () => {
  it('credentials live only in secure storage: expo-secure-store is imported by exactly one module', () => {
    expect(offenders(/from 'expo-secure-store'|require\('expo-secure-store'\)/, ['auth/tokenStore.ts'])).toEqual([]);
    expect(files.find((f) => f.rel === 'auth/tokenStore.ts')?.text).toMatch(/WHEN_UNLOCKED_THIS_DEVICE_ONLY/);
  });

  it('AsyncStorage (unencrypted) is used only by the preferences wrapper', () => {
    expect(offenders(/@react-native-async-storage\/async-storage/, ['core/prefs.ts'])).toEqual([]);
  });

  it('nothing token-shaped is ever written through the preferences wrapper', () => {
    const writers = files.filter((f) => /writePref\(/.test(f.text));
    for (const f of writers) expect(f.text).not.toMatch(/writePref\([^)]*(accessToken|refreshToken|password|secret)/i);
  });

  it('no raw console output outside the redacting logger', () => {
    expect(offenders(/\bconsole\.(log|warn|error|info|debug)\(/, ['core/logger.ts'])).toEqual([]);
  });

  it('no dynamic code execution, no WebView, no raw HTML injection', () => {
    expect(offenders(/\beval\(|new Function\(|dangerouslySetInnerHTML|react-native-webview|<WebView/)).toEqual([]);
  });

  it('the app never opens URLs on its own: Linking.openURL / Linking.canOpenURL are not used', () => {
    expect(offenders(/Linking\.(openURL|canOpenURL|openSettings)\(/)).toEqual([]);
  });

  it('no deep-link handling is configured (the registered scheme opens the app but routes nowhere)', () => {
    expect(offenders(/linking\s*=\s*\{|prefixes\s*:|Linking\.addEventListener|Linking\.getInitialURL/)).toEqual([]);
  });

  it('TLS is never weakened: no certificate-validation switches, no custom agents, no rejectUnauthorized', () => {
    expect(offenders(/rejectUnauthorized|NODE_TLS_REJECT_UNAUTHORIZED|trustAllCerts|insecureSkipVerify|ssl\s*:\s*false/i)).toEqual([]);
  });

  it('cleartext http appears only where it is validated (config) or compared against, never as a hard-coded endpoint', () => {
    const hardCoded = files.flatMap((f) => [...f.text.matchAll(/['"`]http:\/\/[^'"`\s]+['"`]/g)].map((m) => `${f.rel}: ${m[0]}`));
    // placeholders inside user-facing hints/placeholders for the S3 form are the only literal http URLs allowed
    expect(hardCoded.filter((h) => !h.startsWith('features/storage/'))).toEqual([]);
  });

  it('no secrets-looking literals ship in source', () => {
    expect(offenders(/AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}|-----BEGIN (RSA |EC )?PRIVATE KEY-----|ghp_[A-Za-z0-9]{30,}/)).toEqual([]);
  });

  it('only the API client, the upload/download transports and the config build network requests', () => {
    expect(offenders(/\bfetch\(|XMLHttpRequest|new WebSocket\(/, ['api/client.ts', 'transfers/device.ts'])).toEqual([]);
  });

  it('the share link is only ever handed to the clipboard helper and the OS share sheet', () => {
    const sharers = files.filter((f) => /Clipboard\./.test(f.text)).map((f) => f.rel);
    expect(sharers).toEqual(['core/clipboard.ts']);
  });
});
