/**
 * Provider context builder — provider-contract.md §6.1.
 * buildContext() is the single choke point that loads a ConnectedAccount and
 * decrypts its credential material; no other module may decrypt provider secrets.
 */

import type { ConnectedAccount, ProviderConfig, S3StorageConfig } from '@prisma/client';
import { env } from '../config/env.js';
import { prisma } from '../config/prisma.js';
import { createLogger } from '../queues/logger.js';
import { decryptText, encryptText } from '../utils/crypto.js';
import { catalog, type ProviderCatalogEntry } from './catalog.js';
import { ProviderError } from './errors.js';
import { refreshAccessToken, type OAuth2TokenResult } from './oauth2.js';
import { registry, truncateStoredMessage } from './registry.js';
import type { ProviderContext, ProviderCredentials } from './types.js';

/** OAuth access tokens are refreshed once they are within this window of expiry. */
export const OAUTH_REFRESH_WINDOW_MS = 120_000;

type ConnectedAccountRecord = ConnectedAccount & {
  providerConfig: ProviderConfig | null;
  s3StorageConfig: S3StorageConfig | null;
};

/** access_key credentials as produced by buildContext: contract fields plus S3 targeting data. */
export interface AccessKeyContextCredentials extends Extract<ProviderCredentials, { kind: 'access_key' }> {
  bucket: string;
  prefix?: string;
}

type JsonRecord = Record<string, unknown>;

const SENSITIVE_KEY_PATTERN =
  /(token|secret|password|credential|authorization|api[-_]?key|access[-_]?key|refresh|private|signature|cookie|session)/i;

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asJsonRecord(value: unknown): JsonRecord {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return isJsonRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return isJsonRecord(value) ? value : {};
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

function isMissingRecordError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'P2023' || code === 'P2025';
}

function decryptStored(value: string, label: string): string {
  try {
    return decryptText(value.startsWith('v1:') ? value.slice(3) : value);
  } catch (cause) {
    throw new ProviderError('ERR_INTERNAL', `failed to decrypt stored ${label}`, { cause });
  }
}

function decryptOptional(value: string | null | undefined, label: string): string | undefined {
  if (!value) return undefined;
  try {
    return decryptStored(value, label);
  } catch {
    return undefined;
  }
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function markAuthFailure(account: { id: string; status: string }, message: string): Promise<void> {
  const data = {
    lastError: truncateStoredMessage(message),
    ...(account.status === 'disconnected' ? {} : { status: 'unauthorized' }),
  };
  try {
    await prisma.connectedAccount.update({ where: { id: account.id }, data });
  } catch {
    return;
  }
}

interface ResolvedS3Settings {
  bucket: string;
  region?: string;
  endpoint?: string;
  forcePathStyle: boolean;
  prefix: string;
}

function resolveS3Settings(
  s3: S3StorageConfig,
  metadata: JsonRecord,
  preset?: ProviderCatalogEntry['s3Preset'],
): ResolvedS3Settings {
  const bucket = firstString(s3.bucket, metadata.bucket);
  if (!bucket) throw new ProviderError('ERR_INVALID_INPUT', 'S3 storage configuration has no bucket');
  const region = firstString(s3.region, metadata.region, preset?.region);
  const endpoint = firstString(s3.endpoint, metadata.endpoint, preset?.endpoint);
  const forcePathStyle =
    typeof metadata.forcePathStyle === 'boolean'
      ? metadata.forcePathStyle
      : s3.forcePathStyle === true
        ? true
        : (preset?.forcePathStyle ?? s3.forcePathStyle);
  const prefix = firstString(s3.prefix, metadata.prefix) ?? '9drive';
  return { bucket, region, endpoint, forcePathStyle, prefix };
}

function buildAccountConfig(
  account: ConnectedAccountRecord,
  providerConfig: ProviderConfig | null,
  metadata: JsonRecord,
  entry: ProviderCatalogEntry | null,
): JsonRecord {
  const config: JsonRecord = {};
  if (providerConfig) {
    config.redirectUri = providerConfig.redirectUri;
  }
  config.scopes = account.scopes ?? providerConfig?.scopes ?? [];
  Object.assign(config, metadata);
  if (account.s3StorageConfig) {
    const resolved = resolveS3Settings(account.s3StorageConfig, metadata, entry?.s3Preset);
    config.bucket = resolved.bucket;
    config.region = resolved.region ?? null;
    config.endpoint = resolved.endpoint ?? null;
    config.forcePathStyle = resolved.forcePathStyle;
    config.prefix = resolved.prefix;
  }
  return config;
}

function redactMeta(meta: JsonRecord, depth = 0): JsonRecord {
  if (depth > 4) return {};
  const out: JsonRecord = {};
  for (const [key, value] of Object.entries(meta)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      out[key] = '[redacted]';
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value
        .slice(0, 20)
        .map((item) => (isJsonRecord(item) ? redactMeta(item, depth + 1) : item));
    } else if (isJsonRecord(value)) {
      out[key] = redactMeta(value, depth + 1);
    } else {
      out[key] = value;
    }
  }
  return out;
}

async function resolveOAuthCredentials(
  account: ConnectedAccountRecord,
  signal?: AbortSignal,
): Promise<ProviderCredentials> {
  const metadata = asJsonRecord(account.metadata);
  const providerConfig =
    account.providerConfig && account.providerConfig.provider === account.provider ? account.providerConfig : null;
  const clientId = firstString(
    decryptOptional(providerConfig?.clientIdEncrypted, 'client id'),
    metadata.clientId,
    metadata.client_id,
  );
  const clientSecret = firstString(
    decryptOptional(providerConfig?.clientSecretEncrypted, 'client secret'),
    metadata.clientSecret,
    metadata.client_secret,
  );
  const redirectUri = firstString(
    providerConfig?.redirectUri,
    metadata.redirectUri,
    metadata.redirect_uri,
    account.provider === 'google_drive' ? env.GOOGLE_REDIRECT_URI : undefined,
  );

  let accessToken = decryptOptional(account.accessTokenEncrypted, 'access token');
  let refreshToken = decryptOptional(account.refreshTokenEncrypted, 'refresh token');
  let expiresAt = account.tokenExpiresAt?.getTime() ?? null;
  const needsRefresh =
    accessToken === undefined ||
    (expiresAt !== null && expiresAt - Date.now() <= OAUTH_REFRESH_WINDOW_MS);

  if (needsRefresh) {
    let refreshed: OAuth2TokenResult;
    try {
      if (!clientId || !clientSecret) {
        throw new ProviderError('ERR_AUTH_EXPIRED', 'OAuth client credentials are not configured for this account');
      }
      if (!refreshToken) {
        throw new ProviderError('ERR_AUTH_EXPIRED', 'account has no refresh token');
      }
      refreshed = await refreshAccessToken({
        provider: account.provider,
        clientId,
        clientSecret,
        redirectUri,
        refreshToken,
        signal,
      });
    } catch (err) {
      await markAuthFailure(account, errorText(err));
      throw new ProviderError('ERR_AUTH_EXPIRED', `OAuth token refresh failed for provider '${account.provider}'`, {
        cause: err,
      });
    }
    try {
      await prisma.connectedAccount.update({
        where: { id: account.id },
        data: {
          accessTokenEncrypted: encryptText(refreshed.accessToken),
          ...(refreshed.refreshToken ? { refreshTokenEncrypted: encryptText(refreshed.refreshToken) } : {}),
          tokenExpiresAt: refreshed.expiresAt === null ? null : new Date(refreshed.expiresAt),
          lastError: null,
          ...(account.status === 'unauthorized' ? { status: 'connected' as const } : {}),
        },
      });
    } catch (cause) {
      throw new ProviderError('ERR_INTERNAL', 'failed to persist refreshed OAuth tokens', { cause });
    }
    accessToken = refreshed.accessToken;
    refreshToken = refreshed.refreshToken ?? refreshToken;
    expiresAt = refreshed.expiresAt;
  }

  if (!accessToken) {
    throw new ProviderError('ERR_AUTH_EXPIRED', `account '${account.id}' has no access token`);
  }

  return {
    kind: 'oauth2',
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    expiresAt: expiresAt ?? null,
    ...(clientId ? { clientId } : {}),
    ...(clientSecret ? { clientSecret } : {}),
    ...(redirectUri ? { redirectUri } : {}),
  };
}

async function buildContextInternal(
  accountId: string,
  opts: { signal?: AbortSignal },
): Promise<ProviderContext> {
  if (typeof accountId !== 'string' || accountId.trim() === '') {
    throw new ProviderError('ERR_INVALID_INPUT', 'accountId is required');
  }

  let account: ConnectedAccountRecord | null;
  try {
    account = await prisma.connectedAccount.findUnique({
      where: { id: accountId },
      include: { providerConfig: true, s3StorageConfig: true },
    });
  } catch (err) {
    if (isMissingRecordError(err)) {
      throw new ProviderError('ERR_NOT_FOUND', `connected account '${accountId}' not found`);
    }
    throw err;
  }
  if (!account) {
    throw new ProviderError('ERR_NOT_FOUND', `connected account '${accountId}' not found`);
  }

  const entry = catalog.get(account.provider);
  const authMode = entry?.authMode ?? registry.tryGet(account.provider)?.authMode ?? 'oauth2';
  const metadata = asJsonRecord(account.metadata);
  const providerConfig =
    account.providerConfig && account.providerConfig.provider === account.provider ? account.providerConfig : null;
  const config = buildAccountConfig(account, providerConfig, metadata, entry);

  let credentials: ProviderCredentials;
  if (account.s3StorageConfig) {
    const resolved = resolveS3Settings(account.s3StorageConfig, metadata, entry?.s3Preset);
    const accessKey: AccessKeyContextCredentials = {
      kind: 'access_key',
      accessKeyId: decryptStored(account.s3StorageConfig.accessKeyIdEncrypted, 'access key id'),
      secretAccessKey: decryptStored(account.s3StorageConfig.secretAccessKeyEncrypted, 'secret access key'),
      bucket: resolved.bucket,
      prefix: resolved.prefix,
      endpoint: resolved.endpoint,
      region: resolved.region,
      forcePathStyle: resolved.forcePathStyle,
    };
    credentials = accessKey;
  } else if (authMode === 'access_key') {
    throw new ProviderError('ERR_NOT_FOUND', `account '${accountId}' has no S3 storage configuration`);
  } else if (authMode === 'api_key') {
    const apiKey = decryptOptional(account.accessTokenEncrypted, 'api key') ?? firstString(metadata.apiKey, metadata.api_key);
    if (!apiKey) throw new ProviderError('ERR_AUTH_EXPIRED', `account '${accountId}' has no API key`);
    credentials = { kind: 'api_key', apiKey };
  } else {
    credentials = await resolveOAuthCredentials(account, opts.signal);
  }

  const log = createLogger({ component: 'provider.context', accountId, provider: account.provider });
  return {
    credentials,
    account: {
      id: account.id,
      userId: account.userId,
      provider: account.provider,
      providerAccountId: account.providerAccountId,
      displayName: account.displayName,
      config,
    },
    signal: opts.signal,
    logger: (msg, meta) => log.info(msg, meta ? redactMeta(meta) : undefined),
  };
}

export async function buildContext(
  accountId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<ProviderContext> {
  try {
    return await buildContextInternal(accountId, opts);
  } catch (err) {
    throw ProviderError.is(err)
      ? err
      : new ProviderError('ERR_INTERNAL', 'failed to build provider context', { cause: err });
  }
}
