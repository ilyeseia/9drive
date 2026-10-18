import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, any>>,
  updates: [] as Array<Record<string, any>>,
  refreshCalls: 0,
  refreshImpl: null as null | (() => Promise<any>),
}));

vi.mock('../../../config/prisma.js', () => ({
  prisma: {
    connectedAccount: {
      findUnique: async () => h.rows.shift() ?? null,
      update: async ({ data }: { data: Record<string, any> }) => {
        h.updates.push(data);
        return {};
      },
      updateMany: async ({ data }: { data: Record<string, any> }) => {
        h.updates.push(data);
        return { count: 1 };
      },
    },
  },
}));

vi.mock('../../../providers/oauth2.js', () => ({
  refreshAccessToken: async () => {
    h.refreshCalls += 1;
    return h.refreshImpl!();
  },
}));

import { buildContext, OAUTH_REFRESH_WINDOW_MS } from '../../../providers/context.js';
import { ProviderError } from '../../../providers/errors.js';
import { decryptText, encryptText } from '../../../utils/crypto.js';

function row(access: string, refresh: string, expiresInMs: number, status = 'connected') {
  return {
    id: 'acct-1',
    userId: 'user-1',
    provider: 'terabox_open',
    providerAccountId: '424242',
    displayName: null,
    status,
    metadata: null,
    scopes: [],
    accessTokenEncrypted: encryptText(access),
    refreshTokenEncrypted: encryptText(refresh),
    tokenExpiresAt: new Date(Date.now() + expiresInMs),
    providerConfigId: 'cfg-1',
    providerConfig: {
      id: 'cfg-1',
      provider: 'terabox_open',
      clientIdEncrypted: encryptText('cid'),
      clientSecretEncrypted: encryptText('csec'),
      redirectUri: 'https://www.terabox.com/wap/outside/login',
      scopes: [],
    },
    s3StorageConfig: null,
  };
}

beforeEach(() => {
  h.rows = [];
  h.updates = [];
  h.refreshCalls = 0;
  h.refreshImpl = null;
});

describe('buildContext with single-use refresh tokens', () => {
  it('does not refresh a token that is still valid', async () => {
    h.rows = [row('AT-live', 'RT-1', 3_600_000)];
    const ctx = await buildContext('acct-1');
    expect(ctx.credentials).toMatchObject({ kind: 'oauth2', accessToken: 'AT-live', refreshToken: 'RT-1' });
    expect(h.refreshCalls).toBe(0);
  });

  it('refreshes inside the expiry window and persists the rotated pair encrypted', async () => {
    h.rows = [row('AT-old', 'RT-1', OAUTH_REFRESH_WINDOW_MS - 1_000)];
    h.refreshImpl = async () => ({ accessToken: 'AT-new', refreshToken: 'RT-2', expiresAt: Date.now() + 172_800_000 });
    const ctx = await buildContext('acct-1');
    expect(ctx.credentials).toMatchObject({ accessToken: 'AT-new', refreshToken: 'RT-2' });
    expect(h.updates).toHaveLength(1);
    expect(decryptText(h.updates[0].accessTokenEncrypted)).toBe('AT-new');
    expect(decryptText(h.updates[0].refreshTokenEncrypted)).toBe('RT-2');
    expect(h.updates[0].lastError).toBeNull();
  });

  it('adopts tokens already rotated by another process instead of killing the account', async () => {
    // 1st read: stale tokens. Refresh then fails because a peer consumed RT-1.
    // 2nd read (peer lookup): the peer's fresh pair is already stored.
    h.rows = [row('AT-old', 'RT-1', 1_000), row('AT-peer', 'RT-peer', 172_800_000)];
    h.refreshImpl = async () => {
      throw new ProviderError('ERR_AUTH_REVOKED', 'refresh token invalid');
    };
    const ctx = await buildContext('acct-1');
    expect(ctx.credentials).toMatchObject({ accessToken: 'AT-peer', refreshToken: 'RT-peer' });
    // Nothing is overwritten and the account is not flagged unauthorized.
    expect(h.updates).toHaveLength(0);
  });

  it('flags the account unauthorized when the refresh genuinely fails', async () => {
    h.rows = [row('AT-old', 'RT-1', 1_000), row('AT-old', 'RT-1', 1_000)];
    h.refreshImpl = async () => {
      throw new ProviderError('ERR_AUTH_REVOKED', 'refresh token invalid');
    };
    await expect(buildContext('acct-1')).rejects.toMatchObject({ code: 'ERR_AUTH_EXPIRED' });
    expect(h.updates.some((u) => u.status === 'unauthorized')).toBe(true);
  });

  it('does not adopt a peer result that is itself about to expire', async () => {
    h.rows = [row('AT-old', 'RT-1', 1_000), row('AT-other', 'RT-x', 5_000)];
    h.refreshImpl = async () => {
      throw new ProviderError('ERR_AUTH_REVOKED', 'refresh token invalid');
    };
    await expect(buildContext('acct-1')).rejects.toMatchObject({ code: 'ERR_AUTH_EXPIRED' });
  });
});
