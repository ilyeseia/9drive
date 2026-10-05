/** S3 quota aggregation: namespace scoping, pagination, configured totals, JSON safety. */
import { describe, expect, it } from 'vitest';
import { createS3Provider } from '../../../providers/s3/index.js';
import { jsonSafe } from '../../../utils/serialize.js';
import { makeS3Context, withFakeS3, type FakeS3 } from './helpers.js';

const provider = createS3Provider();
const ROOT = '9drive/user-1';

function seedQuotaTree(server: FakeS3): void {
  server.seed(`${ROOT}/fA/a.bin`, Buffer.alloc(10));
  server.seed(`${ROOT}/fB/b.bin`, Buffer.alloc(20));
  server.seed(`${ROOT}/d1/docs/`, '', 'application/x-directory');
  server.seed(`${ROOT}/fC/c.bin`, Buffer.alloc(30));
  server.seed('9drive/user-2/fX/big.bin', Buffer.alloc(1000));
  server.seed('elsewhere/fY/out.bin', Buffer.alloc(500));
}

describe('s3 getQuota', () => {
  it('sums only the caller namespace across every ListObjectsV2 page', async () => {
    await withFakeS3({ pageKeys: 2 }, async (server) => {
      seedQuotaTree(server);
      const ctx = makeS3Context(server);
      const quota = await provider.getQuota(ctx);

      expect(quota.usedBytes).toBe(60n);
      expect(quota.totalBytes).toBeNull();
      expect(quota.availableBytes).toBeNull();
      expect(quota.trashBytes).toBeNull();
      expect(quota.raw).toMatchObject({
        source: 'ListObjectsV2',
        approximate: true,
        prefix: '9drive/user-1/',
        objectCount: 4,
        pages: 2,
        truncated: false,
      });
      expect(server.count('ListObjectsV2')).toBe(2);
    });
  });

  it('applies configured quotaBytes and clamps available at zero', async () => {
    await withFakeS3({ pageKeys: 3 }, async (server) => {
      seedQuotaTree(server);

      const roomy = await provider.getQuota(makeS3Context(server, { config: { quotaBytes: '100' } }));
      expect(roomy.totalBytes).toBe(100n);
      expect(roomy.usedBytes).toBe(60n);
      expect(roomy.availableBytes).toBe(40n);

      const tight = await provider.getQuota(makeS3Context(server, { config: { quotaBytes: '30' } }));
      expect(tight.totalBytes).toBe(30n);
      expect(tight.availableBytes).toBe(0n);
    });
  });

  it('survives JSON transport through jsonSafe', async () => {
    await withFakeS3({}, async (server) => {
      seedQuotaTree(server);
      const quota = await provider.getQuota(makeS3Context(server, { config: { quotaBytes: '100' } }));

      expect(() => JSON.stringify(quota)).toThrow(TypeError);

      const safe = jsonSafe(quota) as Record<string, unknown>;
      expect(JSON.parse(JSON.stringify(safe))).toEqual({
        totalBytes: '100',
        usedBytes: '60',
        availableBytes: '40',
        trashBytes: null,
        raw: {
          source: 'ListObjectsV2',
          approximate: true,
          prefix: '9drive/user-1/',
          objectCount: 4,
          pages: 1,
          truncated: false,
        },
      });
    });
  });
});
