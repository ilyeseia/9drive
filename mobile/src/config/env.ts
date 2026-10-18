/**
 * Runtime configuration. The only required value is the API base URL (EXPO_PUBLIC_API_URL).
 *
 * Security rules enforced here, not left to callers:
 *  - Release builds accept `https:` only. There is no switch that disables TLS verification.
 *  - Debug builds may use plain `http:` so a developer can reach a local backend; this is compiled in
 *    only through `isDev` (React Native's `__DEV__`), which is false in release bundles.
 *  - A URL may not contain credentials, a query string or a fragment.
 *
 * Nothing secret belongs here: EXPO_PUBLIC_* values are embedded in the app bundle and readable by anyone.
 */

export class ConfigError extends Error {
  constructor(
    readonly reason: 'missing' | 'invalid' | 'insecure',
    message: string,
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface AppConfig {
  /** API origin plus optional path prefix, without a trailing slash. */
  apiBaseUrl: string;
  /** True when the app talks to a non-TLS endpoint (debug builds only). */
  insecureTransport: boolean;
}

export function resolveApiBaseUrl(raw: string | undefined, isDev: boolean): AppConfig {
  const value = raw?.trim();
  if (!value) {
    throw new ConfigError('missing', 'EXPO_PUBLIC_API_URL is not set.');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError('invalid', 'EXPO_PUBLIC_API_URL is not a valid URL.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ConfigError('invalid', 'EXPO_PUBLIC_API_URL must start with https:// (or http:// in debug builds).');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ConfigError('invalid', 'EXPO_PUBLIC_API_URL must not contain credentials, a query string or a fragment.');
  }
  const insecure = url.protocol === 'http:';
  if (insecure && !isDev) {
    throw new ConfigError('insecure', 'Release builds require an https:// API URL.');
  }
  return { apiBaseUrl: `${url.origin}${url.pathname.replace(/\/+$/, '')}`, insecureTransport: insecure };
}

let cached: AppConfig | ConfigError | undefined;

/** Loads the configuration once. Returns the error instead of throwing so the UI can explain it. */
export function loadConfig(): AppConfig | ConfigError {
  if (cached) return cached;
  try {
    cached = resolveApiBaseUrl(process.env.EXPO_PUBLIC_API_URL, __DEV__);
  } catch (error) {
    cached = error instanceof ConfigError ? error : new ConfigError('invalid', 'Invalid configuration.');
  }
  return cached;
}

export function isConfigError(value: AppConfig | ConfigError): value is ConfigError {
  return value instanceof ConfigError;
}
