import { createCipheriv, createHash, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ProviderError } from '../../../providers/errors.js';
import { TeraBoxClient } from '../../../providers/terabox/client.js';
import {
  decryptTeraBoxPublicKey,
  encryptTeraBoxPassword,
  teraboxPassportLogin,
  teraboxPrand,
} from '../../../providers/terabox/login.js';
import { createTeraBoxProvider } from '../../../providers/terabox/index.js';
import { resetTeraBoxTransport, setTeraBoxTransport } from '../../../providers/terabox/transport.js';
import {
  enableLocalEndpoint,
  startFakeTeraBox,
  withFakeTeraBox,
  type FakeContextOverrides,
} from './server.js';

function wrapPublicKeyLikeTeraBox(): { pp1: string; pp2: string; pem: string } {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const pp2 = '0123456789abcdef';
  const cipher = createCipheriv('aes-128-cbc', Buffer.from(pp2, 'utf8'), Buffer.from(pp2, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(Buffer.from(pem, 'utf8')), cipher.final()]);
  return { pp1: `${pp2}${encrypted.toString('base64')}`, pp2, pem };
}

async function withPassportServer(
  options: FakeContextOverrides,
  run: (server: Awaited<ReturnType<typeof startFakeTeraBox>>) => Promise<void>,
): Promise<void> {
  enableLocalEndpoint();
  const server = await startFakeTeraBox(options);
  setTeraBoxTransport({ baseUrl: server.origin, uploadHost: server.origin });
  try {
    await run(server);
  } finally {
    await server.close();
    resetTeraBoxTransport();
  }
}

describe('TeraBox passport crypto', () => {
  it('unwraps the AES-wrapped RSA public key', () => {
    const { pp1, pp2, pem } = wrapPublicKeyLikeTeraBox();
    expect(decryptTeraBoxPublicKey(pp1, pp2)).toBe(pem);
  });

  it('rejects a wrapper with the wrong key length', () => {
    expect(() => decryptTeraBoxPublicKey('0123456789', 'short')).toThrow(ProviderError);
  });

  it('encrypts the password as an RSA-2048 PKCS1 ciphertext', () => {
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const encpass = encryptTeraBoxPassword('hunter2', pem);
    // RSA-2048 ciphertext is always one 256-byte block. (Node refuses
    // RSA_PKCS1 private decryption since CVE-2023-46809, so the plaintext
    // shape md5(password) + '32' is asserted by the module's own contract
    // and exercised end-to-end by teraboxPassportLogin below.)
    expect(Buffer.from(encpass, 'base64')).toHaveLength(256);
  });

  it('builds the prand fingerprint', () => {
    const expected = createHash('sha1')
      .update('web-seval-encpwd-user@example.com-browserid-424242', 'utf8')
      .digest('hex');
    expect(teraboxPrand('user@example.com', 'seval', 'encpwd', 'browserid', '424242')).toBe(expected);
    // browserid missing → the literal 'None' (matching the web client).
    const noBrowserId = createHash('sha1')
      .update('web-seval-encpwd-user@example.com-None-424242', 'utf8')
      .digest('hex');
    expect(teraboxPrand('user@example.com', 'seval', 'encpwd', undefined, '424242')).toBe(noBrowserId);
  });
});

describe('teraboxPassportLogin', () => {
  it('logs in through the fake passport endpoints and mints an ndus cookie', async () => {
    await withPassportServer({ passport: true, cookie: 'valid-cookie' }, async (server) => {
      const result = await teraboxPassportLogin({
        email: 'user@terabox.com',
        password: 'hunter2',
        baseUrl: server.origin,
      });
      expect(result.ndus).toBe('fresh-cookie-1');
      expect(result.cookie).toContain('ndus=fresh-cookie-1');
      expect(result.cookie).toContain('browserid=fake-browser');
      expect(result.displayName).toBe('Passport User');
      expect(result.jsToken).toBe('TEST-JS-TOKEN');
      expect(server.passportLogins).toBe(1);
      expect(server.requests).toContain('GET /wap/outlogin/login');
      expect(server.requests).toContain('GET /passport/getpubkey');
      expect(server.requests).toContain('POST /passport/prelogin');
      expect(server.requests).toContain('POST /passport/login');
    });
  });

  it('surfaces need verify as an actionable auth error', async () => {
    await withPassportServer({ passport: true, passportNeedVerify: true, cookie: 'valid-cookie' }, async (server) => {
      await expect(
        teraboxPassportLogin({ email: 'user@terabox.com', password: 'hunter2', baseUrl: server.origin }),
      ).rejects.toMatchObject({ code: 'ERR_AUTH_EXPIRED', message: expect.stringContaining('verification') });
    });
  });

  it('requires an email and a password', async () => {
    await expect(teraboxPassportLogin({ email: '', password: '' })).rejects.toMatchObject({
      code: 'ERR_INVALID_INPUT',
    });
  });
});

describe('TeraBox client session renewal', () => {
  it('renews once via the hook after an auth errno and retries the request', async () => {
    enableLocalEndpoint();
    const server = await startFakeTeraBox({ cookie: 'renewed-cookie' });
    setTeraBoxTransport({ baseUrl: server.origin, uploadHost: server.origin });
    try {
      server.failNext('/rest/2.0/pcs/file', -6);
      let renewCalls = 0;
      const client = new TeraBoxClient({
        cookie: 'ndus=dead-cookie',
        baseUrl: server.origin,
        renew: async () => {
          renewCalls += 1;
          return 'ndus=renewed-cookie';
        },
      });
      const host = await client.locateUploadHost();
      expect(host).toContain('127.0.0.1');
      expect(renewCalls).toBe(1);
    } finally {
      await server.close();
      resetTeraBoxTransport();
    }
  });

  it('gives up after one renewal attempt (no renew loop)', async () => {
    enableLocalEndpoint();
    const server = await startFakeTeraBox({ cookie: 'renewed-cookie' });
    setTeraBoxTransport({ baseUrl: server.origin, uploadHost: server.origin });
    try {
      // Both the first call and the post-renew retry fail auth.
      server.failNext('/rest/2.0/pcs/file', -6);
      server.failNext('/rest/2.0/pcs/file', -6);
      let renewCalls = 0;
      const client = new TeraBoxClient({
        cookie: 'ndus=dead-cookie',
        baseUrl: server.origin,
        renew: async () => {
          renewCalls += 1;
          return 'ndus=still-dead';
        },
      });
      await expect(client.locateUploadHost()).rejects.toMatchObject({ code: 'ERR_AUTH_EXPIRED' });
      expect(renewCalls).toBe(1);
    } finally {
      await server.close();
      resetTeraBoxTransport();
    }
  });
});

describe('TeraBox provider auto-renewal', () => {
  it('logs in with stored credentials, persists the new cookie, and continues the call', async () => {
    const persisted: Array<{ apiKey: string; apiSecret?: string }> = [];
    await withFakeTeraBox(
      {
        passport: true,
        cookie: 'valid-cookie',
        apiKey: 'ndus=dead-cookie',
        apiSecret: JSON.stringify({ email: 'user@terabox.com', password: 'hunter2' }),
        persistCredentials: async (next) => {
          persisted.push({ apiKey: next.apiKey, ...(next.apiSecret ? { apiSecret: next.apiSecret } : {}) });
        },
      },
      async (server, ctx) => {
        const quota = await createTeraBoxProvider().getQuota(ctx);
        expect(quota.usedBytes).toBe(10_485_760n);
        expect(server.passportLogins).toBe(1);
        expect(persisted).toHaveLength(1);
        expect(persisted[0].apiKey).toContain('ndus=fresh-cookie-1');
        expect(JSON.parse(persisted[0].apiSecret!)).toEqual({
          email: 'user@terabox.com',
          password: 'hunter2',
        });
      },
    );
  });

  it('keeps throwing auth errors when the account has no stored password', async () => {
    await withFakeTeraBox({ cookie: 'valid-cookie', apiKey: 'ndus=dead-cookie' }, async (server, ctx) => {
      await expect(createTeraBoxProvider().getQuota(ctx)).rejects.toMatchObject({ code: 'ERR_AUTH_EXPIRED' });
      expect(server.passportLogins).toBe(0);
    });
  });
});
