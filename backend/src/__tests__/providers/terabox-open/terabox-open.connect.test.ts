import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  created: [] as Array<Record<string, any>>,
  updates: [] as Array<{ id: string; data: Record<string, any> }>,
  deleted: [] as string[],
  duplicate: null as Record<string, any> | null,
  info: { providerAccountId: '424242', displayName: 'Tester', email: null, avatarUrl: null } as any,
  infoError: null as Error | null,
  quota: [] as string[],
}));

vi.mock('../../../config/prisma.js', () => ({
  prisma: {
    connectedAccount: {
      create: async ({ data }: { data: Record<string, any> }) => {
        const row = { id: `pending-${h.created.length + 1}`, ...data };
        h.created.push(row);
        return row;
      },
      findFirst: async () => h.duplicate,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, any> }) => {
        h.updates.push({ id: where.id, data });
        return {};
      },
      delete: async ({ where }: { where: { id: string } }) => {
        h.deleted.push(where.id);
        return {};
      },
    },
  },
}));

vi.mock('../../../providers/index.js', () => ({
  buildContext: async () => ({}),
  refreshQuota: async (id: string) => {
    h.quota.push(id);
  },
  registry: {
    get: () => ({
      getAccountInfo: async () => {
        if (h.infoError) throw h.infoError;
        return h.info;
      },
    }),
  },
}));

import { finalizeAccount } from '../../../modules/providers/terabox-device-flow.js';
import { RequestError } from '../../../modules/providers/http-error.js';
import { decryptText } from '../../../utils/crypto.js';

const config = { id: 'cfg-1' } as never;
const tokens = { accessToken: 'AT-new', refreshToken: 'RT-new', expiresAt: Date.now() + 172_800_000 };

beforeEach(() => {
  h.created = [];
  h.updates = [];
  h.deleted = [];
  h.duplicate = null;
  h.info = { providerAccountId: '424242', displayName: 'Tester', email: null, avatarUrl: null };
  h.infoError = null;
  h.quota = [];
});

describe('finalising a TeraBox connection', () => {
  it('stores tokens encrypted at rest and activates a new account', async () => {
    const { accountId } = await finalizeAccount('user-1', config, tokens);
    expect(accountId).toBe('pending-1');
    const pending = h.created[0];
    expect(pending.provider).toBe('terabox_open');
    expect(pending.status).toBe('pending');
    expect(pending.accessTokenEncrypted).not.toContain('AT-new');
    expect(pending.refreshTokenEncrypted).not.toContain('RT-new');
    expect(decryptText(pending.accessTokenEncrypted)).toBe('AT-new');
    expect(decryptText(pending.refreshTokenEncrypted)).toBe('RT-new');
    const activation = h.updates.find((u) => u.id === 'pending-1')!;
    expect(activation.data).toMatchObject({ providerAccountId: '424242', displayName: 'Tester', status: 'connected', lastError: null });
    expect(h.quota).toEqual(['pending-1']);
  });

  it('reauthorizes an existing account in place (keeps its id and settings)', async () => {
    h.duplicate = { id: 'existing-1', displayName: 'Old name', avatarUrl: null };
    const { accountId } = await finalizeAccount('user-1', config, tokens);
    expect(accountId).toBe('existing-1');
    const update = h.updates.find((u) => u.id === 'existing-1')!;
    expect(update.data.status).toBe('connected');
    expect(update.data.lastError).toBeNull();
    expect(decryptText(update.data.accessTokenEncrypted)).toBe('AT-new');
    // The throw-away pending row is removed and the quota is refreshed for the real account.
    expect(h.deleted).toEqual(['pending-1']);
    expect(h.quota).toEqual(['existing-1']);
    // Routing metadata is untouched by reauthorization.
    expect(update.data.metadata).toBeUndefined();
  });

  it('discards the pending row when the account profile cannot be read', async () => {
    h.infoError = new Error('profile failed');
    await expect(finalizeAccount('user-1', config, tokens)).rejects.toBeInstanceOf(RequestError);
    expect(h.deleted).toEqual(['pending-1']);
    expect(h.updates).toHaveLength(0);
    expect(h.quota).toEqual([]);
  });

  it('discards the pending row when TeraBox returns no stable account id', async () => {
    h.info = { providerAccountId: '  ', displayName: null };
    await expect(finalizeAccount('user-1', config, tokens)).rejects.toMatchObject({ code: 'ACCOUNT_PROFILE_FAILED' });
    expect(h.deleted).toEqual(['pending-1']);
  });

  it('scopes duplicate detection to the same user and provider', async () => {
    h.duplicate = null;
    const spy = vi.spyOn(await import('../../../config/prisma.js').then((m) => m.prisma.connectedAccount), 'findFirst');
    await finalizeAccount('user-9', config, tokens);
    const where = spy.mock.calls[0][0]!.where as Record<string, any>;
    expect(where).toMatchObject({ userId: 'user-9', provider: 'terabox_open', providerAccountId: '424242' });
  });
});
