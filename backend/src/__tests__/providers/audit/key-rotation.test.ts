import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../../config/prisma.js';
import { reencryptValue, rotateEncryptionKey } from '../../../utils/key-rotation.js';
import { decryptText, encryptText } from '../../../utils/crypto.js';
import { createTestUser, pingDb } from '../platform/helpers.js';

const OLD = process.env.TOKEN_ENCRYPTION_KEY ?? 'test-old-key-for-rotation-tests';
const NEW = `${OLD}-rotated`;

describe('reencryptValue', () => {
  it('re-encrypts with the new key, keeps the v1: prefix and is idempotent', () => {
    const stored = encryptText('plain-secret');
    const first = reencryptValue(stored, OLD, NEW);
    expect(first.outcome).toBe('migrated');
    expect(first.next).not.toBe(stored);
    expect(reencryptValue(first.next!, OLD, NEW).outcome).toBe('already_migrated');

    const prefixed = reencryptValue(`v1:${stored}`, OLD, NEW);
    expect(prefixed.next!.startsWith('v1:')).toBe(true);
  });

  it('reports values that neither key can decrypt and never throws', () => {
    expect(reencryptValue('garbage', OLD, NEW).outcome).toBe('undecryptable');
    expect(reencryptValue(encryptText('x'), 'some-other-key', NEW).outcome).toBe('undecryptable');
  });
});

describe('rotateEncryptionKey (real DB)', () => {
  let dbOk = false;
  let userId = '';
  let accountId = '';

  beforeAll(async () => {
    dbOk = await pingDb();
    if (!dbOk) return;
    userId = (await createTestUser('rotation')).id;
    accountId = (
      await prisma.connectedAccount.create({
        data: {
          userId,
          provider: 'dropbox',
          providerAccountId: `rot-${randomUUID().slice(0, 6)}`,
          email: 'rot@example.test',
          scopes: [],
          status: 'connected',
          accessTokenEncrypted: encryptText('access-A'),
          refreshTokenEncrypted: encryptText('refresh-A'),
        },
      })
    ).id;
  });

  afterAll(async () => {
    if (!dbOk) return;
    await prisma.connectedAccount.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
  });

  it('dry run writes nothing; apply migrates; a second apply changes nothing', async (ctx) => {
    if (!dbOk) ctx.skip();
    const before = await prisma.connectedAccount.findUniqueOrThrow({ where: { id: accountId } });

    const dry = await rotateEncryptionKey(prisma, { oldSecret: OLD, newSecret: NEW, apply: false });
    expect(dry.mode).toBe('dry-run');
    expect(dry.tables.connected_accounts.migrated).toBeGreaterThanOrEqual(2);
    const unchanged = await prisma.connectedAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(unchanged.accessTokenEncrypted).toBe(before.accessTokenEncrypted);

    const applied = await rotateEncryptionKey(prisma, { oldSecret: OLD, newSecret: NEW, apply: true });
    expect(applied.totalUndecryptable).toBe(0);
    const after = await prisma.connectedAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(after.accessTokenEncrypted).not.toBe(before.accessTokenEncrypted);
    // Old key no longer decrypts it; the new key does (checked via the pure helper).
    expect(() => decryptText(after.accessTokenEncrypted!)).toThrow();
    expect(reencryptValue(after.accessTokenEncrypted!, OLD, NEW).outcome).toBe('already_migrated');

    const again = await rotateEncryptionKey(prisma, { oldSecret: OLD, newSecret: NEW, apply: true });
    expect(again.tables.connected_accounts.migrated).toBe(0);
    expect(JSON.stringify(applied)).not.toContain('access-A');

    // Roll back to the original key so other tests in this process see consistent data.
    await rotateEncryptionKey(prisma, { oldSecret: NEW, newSecret: OLD, apply: true });
    const restored = await prisma.connectedAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(decryptText(restored.accessTokenEncrypted!)).toBe('access-A');
  });

  it('refuses identical or missing keys', async () => {
    await expect(rotateEncryptionKey(prisma, { oldSecret: OLD, newSecret: OLD, apply: false })).rejects.toThrow();
    await expect(rotateEncryptionKey(prisma, { oldSecret: '', newSecret: NEW, apply: false })).rejects.toThrow();
  });
});
