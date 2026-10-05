import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../../config/prisma.js';
import { buildContext, OAUTH_REFRESH_WINDOW_MS, type AccessKeyContextCredentials } from '../../../providers/context.js';
import { ProviderError } from '../../../providers/errors.js';
import { registerOAuth2Client } from '../../../providers/oauth2.js';
import { decryptText, encryptText } from '../../../utils/crypto.js';
import { createTestUser, pingDb } from './helpers.js';

type TokenMode = 'rotate' | 'no-rotation' | 'fail';

describe('buildContext', () => {
  let dbOk = false;
  let userId = '';
  let providerConfigId = '';
  const accountIds: string[] = [];
  let server: Server | null = null;
  let tokenUrl = '';
  let tokenMode: TokenMode = 'rotate';
  const tokenRequests: string[] = [];

  beforeAll(async () => {
    dbOk = await pingDb();
    if (!dbOk) return;
    const user = await createTestUser('context');
    userId = user.id;
    const providerConfig = await prisma.providerConfig.create({
      data: {
        userId,
        provider: 'google_drive',
        clientIdEncrypted: encryptText('test-client-id'),
        clientSecretEncrypted: encryptText('test-client-secret'),
        redirectUri: 'http://localhost:5173/api/connected-accounts/google_drive/callback',
        scopes: ['drive'],
      },
    });
    providerConfigId = providerConfig.id;
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        tokenRequests.push(Buffer.concat(chunks).toString('utf8'));
        res.setHeader('content-type', 'application/json');
        if (tokenMode === 'fail') {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been revoked.' }));
          return;
        }
        const payload: Record<string, unknown> = { access_token: 'rotated-access-token', expires_in: 3600 };
        if (tokenMode === 'rotate') payload.refresh_token = 'rotated-refresh-token';
        res.end(JSON.stringify(payload));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    tokenUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/token`;
    registerOAuth2Client({
      id: 'google_drive',
      authorizationUrl: 'http://127.0.0.1/authorize',
      tokenUrl,
      scopes: [],
    });
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (!dbOk) return;
    await prisma.providerConfig.delete({ where: { id: providerConfigId } }).catch(() => undefined);
    await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
  });

  async function createAccount(options: {
    provider?: string;
    status?: string;
    accessToken?: string | null;
    refreshToken?: string | null;
    tokenExpiresAt?: Date | null;
    metadata?: Prisma.InputJsonValue | null;
    withProviderConfig?: boolean;
  }): Promise<string> {
    const account = await prisma.connectedAccount.create({
      data: {
        userId,
        provider: options.provider ?? 'google_drive',
        providerAccountId: `pa-${randomUUID().slice(0, 8)}`,
        email: `${randomUUID().slice(0, 8)}@example.test`,
        accessTokenEncrypted:
          options.accessToken === null ? null : encryptText(options.accessToken ?? 'initial-access-token'),
        refreshTokenEncrypted:
          options.refreshToken === null ? null : encryptText(options.refreshToken ?? 'initial-refresh-token'),
        tokenExpiresAt:
          options.tokenExpiresAt === undefined ? new Date(Date.now() + 3_600_000) : options.tokenExpiresAt,
        scopes: [],
        status: options.status ?? 'connected',
        metadata: options.metadata ?? undefined,
        providerConfigId: options.withProviderConfig === false ? null : providerConfigId,
      },
    });
    accountIds.push(account.id);
    return account.id;
  }

  async function createS3Account(options: {
    provider: string;
    bucket: string;
    region: string;
    endpoint?: string | null;
    forcePathStyle?: boolean;
  }): Promise<string> {
    const accountId = await createAccount({ provider: options.provider, accessToken: 's3', withProviderConfig: false });
    await prisma.s3StorageConfig.create({
      data: {
        userId,
        connectedAccountId: accountId,
        name: 'platform test bucket',
        bucket: options.bucket,
        region: options.region,
        endpoint: options.endpoint ?? null,
        accessKeyIdEncrypted: encryptText('AKIA-PLATFORM-TEST'),
        secretAccessKeyEncrypted: encryptText('platform-secret-key'),
        forcePathStyle: options.forcePathStyle ?? false,
      },
    });
    return accountId;
  }

  it('throws ERR_NOT_FOUND for an account that does not exist', async (testCtx) => {
    if (!dbOk) testCtx.skip();
    const error = await buildContext(randomUUID()).catch((err: unknown) => err);
    expect(ProviderError.is(error)).toBe(true);
    expect((error as ProviderError).code).toBe('ERR_NOT_FOUND');
    expect((error as ProviderError).status).toBe(404);
  });

  it('builds decrypted access_key credentials and keeps secrets out of account.config', async (testCtx) => {
    if (!dbOk) testCtx.skip();
    const accountId = await createS3Account({
      provider: 's3',
      bucket: 'platform-bucket',
      region: 'eu-central-1',
      endpoint: 'https://s3.platform.test',
      forcePathStyle: true,
    });
    const controller = new AbortController();
    const ctx = await buildContext(accountId, { signal: controller.signal });

    expect(ctx.signal).toBe(controller.signal);
    expect(ctx.credentials.kind).toBe('access_key');
    const credentials = ctx.credentials as AccessKeyContextCredentials;
    expect(credentials.accessKeyId).toBe('AKIA-PLATFORM-TEST');
    expect(credentials.secretAccessKey).toBe('platform-secret-key');
    expect(credentials.bucket).toBe('platform-bucket');
    expect(credentials.region).toBe('eu-central-1');
    expect(credentials.endpoint).toBe('https://s3.platform.test');
    expect(credentials.forcePathStyle).toBe(true);
    expect(ctx.account.provider).toBe('s3');
    expect(ctx.account.config.bucket).toBe('platform-bucket');
    expect(ctx.account.config.prefix).toBe('9drive');
    expect(JSON.stringify(ctx.account)).not.toContain('AKIA-PLATFORM-TEST');
    expect(JSON.stringify(ctx.account)).not.toContain('platform-secret-key');
  });

  it('merges the catalog s3Preset when S3 fields are unset', async (testCtx) => {
    if (!dbOk) testCtx.skip();
    const accountId = await createS3Account({
      provider: 'minio',
      bucket: 'minio-bucket',
      region: '',
      endpoint: null,
      forcePathStyle: false,
    });
    const ctx = await buildContext(accountId);
    const credentials = ctx.credentials as AccessKeyContextCredentials;
    expect(credentials.endpoint).toBe('http://127.0.0.1:9000');
    expect(credentials.region).toBe('us-east-1');
    expect(credentials.forcePathStyle).toBe(true);
    expect(ctx.account.config.endpoint).toBe('http://127.0.0.1:9000');
  });

  it('prefers ConnectedAccount.metadata over catalog preset defaults', async (testCtx) => {
    if (!dbOk) testCtx.skip();
    const accountId = await createS3Account({
      provider: 'wasabi',
      bucket: 'wasabi-bucket',
      region: '',
      endpoint: null,
      forcePathStyle: false,
    });
    await prisma.connectedAccount.update({
      where: { id: accountId },
      data: { metadata: { endpoint: 'https://s3.eu-west-1.wasabisys.com', forcePathStyle: false } },
    });
    const ctx = await buildContext(accountId);
    const credentials = ctx.credentials as AccessKeyContextCredentials;
    expect(credentials.endpoint).toBe('https://s3.eu-west-1.wasabisys.com');
    expect(credentials.region).toBe('us-east-1');
    expect(credentials.forcePathStyle).toBe(false);
  });

  it('throws ERR_NOT_FOUND for an access-key account without an S3 storage config', async (testCtx) => {
    if (!dbOk) testCtx.skip();
    const accountId = await createAccount({ provider: 's3', accessToken: 's3', withProviderConfig: false });
    const error = await buildContext(accountId).catch((err: unknown) => err);
    expect(ProviderError.is(error)).toBe(true);
    expect((error as ProviderError).code).toBe('ERR_NOT_FOUND');
  });

  it('returns oauth2 credentials without refreshing a token that is not near expiry', async (testCtx) => {
    if (!dbOk) testCtx.skip();
    const requestsBefore = tokenRequests.length;
    const accountId = await createAccount({
      accessToken: 'still-fresh-access-token',
      refreshToken: 'still-fresh-refresh-token',
      metadata: { region: 'eu' },
    });
    const ctx = await buildContext(accountId);
    expect(tokenRequests.length).toBe(requestsBefore);
    expect(ctx.credentials.kind).toBe('oauth2');
    if (ctx.credentials.kind !== 'oauth2') throw new Error('expected oauth2 credentials');
    expect(ctx.credentials.accessToken).toBe('still-fresh-access-token');
    expect(ctx.credentials.refreshToken).toBe('still-fresh-refresh-token');
    expect(ctx.credentials.clientId).toBe('test-client-id');
    expect(ctx.credentials.clientSecret).toBe('test-client-secret');
    expect(ctx.credentials.redirectUri).toBe('http://localhost:5173/api/connected-accounts/google_drive/callback');
    expect(ctx.account.config.region).toBe('eu');
    expect(ctx.account.config.redirectUri).toBe('http://localhost:5173/api/connected-accounts/google_drive/callback');
  });

  it('refreshes a token inside the 120s window and persists the rotated refresh token', async (testCtx) => {
    if (!dbOk) testCtx.skip();
    tokenMode = 'rotate';
    const requestsBefore = tokenRequests.length;
    const accountId = await createAccount({
      accessToken: 'stale-access-token',
      refreshToken: 'stale-refresh-token',
      tokenExpiresAt: new Date(Date.now() + OAUTH_REFRESH_WINDOW_MS - 60_000),
      status: 'unauthorized',
    });

    const ctx = await buildContext(accountId);
    expect(tokenRequests.length).toBe(requestsBefore + 1);
    expect(tokenRequests[requestsBefore]).toContain('grant_type=refresh_token');
    expect(tokenRequests[requestsBefore]).toContain('refresh_token=stale-refresh-token');
    expect(ctx.credentials.kind).toBe('oauth2');
    if (ctx.credentials.kind !== 'oauth2') throw new Error('expected oauth2 credentials');
    expect(ctx.credentials.accessToken).toBe('rotated-access-token');
    expect(ctx.credentials.refreshToken).toBe('rotated-refresh-token');
    expect(ctx.credentials.expiresAt).toBeGreaterThan(Date.now());

    const stored = await prisma.connectedAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(decryptText(stored.accessTokenEncrypted!)).toBe('rotated-access-token');
    expect(decryptText(stored.refreshTokenEncrypted!)).toBe('rotated-refresh-token');
    expect(stored.tokenExpiresAt).not.toBeNull();
    expect(stored.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 3_000_000);
    expect(stored.status).toBe('connected');
    expect(stored.lastError).toBeNull();
  });

  it('keeps the stored refresh token when the upstream does not rotate it', async (testCtx) => {
    if (!dbOk) testCtx.skip();
    tokenMode = 'no-rotation';
    const requestsBefore = tokenRequests.length;
    const accountId = await createAccount({
      accessToken: 'expiring-access-token',
      refreshToken: 'stable-refresh-token',
      tokenExpiresAt: new Date(Date.now() - 1_000),
    });

    const ctx = await buildContext(accountId);
    expect(tokenRequests.length).toBe(requestsBefore + 1);
    if (ctx.credentials.kind !== 'oauth2') throw new Error('expected oauth2 credentials');
    expect(ctx.credentials.accessToken).toBe('rotated-access-token');

    const stored = await prisma.connectedAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(decryptText(stored.refreshTokenEncrypted!)).toBe('stable-refresh-token');
    expect(decryptText(stored.accessTokenEncrypted!)).toBe('rotated-access-token');
  });

  it('marks the account unauthorized and throws ERR_AUTH_EXPIRED when refresh fails', async (testCtx) => {
    if (!dbOk) testCtx.skip();
    tokenMode = 'fail';
    const accountId = await createAccount({
      accessToken: 'failing-access-token',
      refreshToken: 'failing-refresh-token',
      tokenExpiresAt: new Date(Date.now() - 1_000),
    });

    const error = await buildContext(accountId).catch((err: unknown) => err);
    expect(ProviderError.is(error)).toBe(true);
    expect((error as ProviderError).code).toBe('ERR_AUTH_EXPIRED');
    expect((error as ProviderError).status).toBe(401);

    const stored = await prisma.connectedAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(stored.status).toBe('unauthorized');
    expect(stored.lastError).not.toBeNull();
    expect(stored.lastError!.length).toBeLessThanOrEqual(500);
  });

  it('throws ERR_AUTH_EXPIRED when no OAuth client is registered for the provider', async (testCtx) => {
    if (!dbOk) testCtx.skip();
    const accountId = await createAccount({
      provider: 'box',
      accessToken: 'box-access-token',
      refreshToken: 'box-refresh-token',
      tokenExpiresAt: new Date(Date.now() - 1_000),
      metadata: { clientId: 'box-id', clientSecret: 'box-secret' },
      withProviderConfig: false,
    });
    const error = await buildContext(accountId).catch((err: unknown) => err);
    expect(ProviderError.is(error)).toBe(true);
    expect((error as ProviderError).code).toBe('ERR_AUTH_EXPIRED');
    const stored = await prisma.connectedAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(stored.status).toBe('unauthorized');
  });

  it('decrypts stored API keys for api_key accounts', async (testCtx) => {
    if (!dbOk) testCtx.skip();
    const accountId = await createAccount({
      provider: 'koofr',
      accessToken: 'koofr-api-key',
      tokenExpiresAt: null,
      withProviderConfig: false,
    });
    const ctx = await buildContext(accountId);
    expect(ctx.credentials).toEqual({ kind: 'api_key', apiKey: 'koofr-api-key' });
    expect(ctx.account.provider).toBe('koofr');
  });

  it('rejects an empty accountId', async (testCtx) => {
    if (!dbOk) testCtx.skip();
    const error = await buildContext('   ').catch((err: unknown) => err);
    expect(ProviderError.is(error)).toBe(true);
    expect((error as ProviderError).code).toBe('ERR_INVALID_INPUT');
  });

  it('never logs credential material through the context logger', async (testCtx) => {
    if (!dbOk) testCtx.skip();
    const accountId = await createAccount({ accessToken: 'logger-access-token' });
    const ctx = await buildContext(accountId);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      ctx.logger('operation finished', {
        accessToken: 'logger-access-token',
        nested: { clientSecret: 'top-secret-value' },
        accountId,
        detail: 'visible-value',
      });
      const output = spy.mock.calls.map((call) => call.map((arg) => String(arg)).join(' ')).join('\n');
      expect(output).not.toContain('logger-access-token');
      expect(output).not.toContain('top-secret-value');
      expect(output).toContain('[redacted]');
      expect(output).toContain('visible-value');
      expect(output).toContain(accountId);
    } finally {
      spy.mockRestore();
    }
  });
});
