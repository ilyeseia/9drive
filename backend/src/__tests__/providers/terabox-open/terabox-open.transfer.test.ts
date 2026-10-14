import { createHash, randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createTeraBoxOpenProvider, resetUploadSemaphore } from '../../../providers/terabox-open/index.js';
import { SHARD_BYTES, Semaphore, spoolBaseDir } from '../../../providers/terabox-open/spool.js';
import { bufferStream, expectProviderCode, makeContext, readAll, withFakeTeraBox } from './server.js';

const provider = createTeraBoxOpenProvider();

function upload(ctx: ReturnType<typeof makeContext>, data: Buffer, opts: { name?: string; parentId?: string | null; size?: bigint } = {}) {
  return provider.upload(ctx, {
    stream: bufferStream(data),
    fileName: opts.name ?? 'file.bin',
    mimeType: 'application/octet-stream',
    sizeBytes: opts.size ?? BigInt(data.length),
    parentId: opts.parentId ?? null,
  });
}

function stagedDirs(): string[] {
  try {
    return readdirSync(spoolBaseDir()).filter((name) => name.startsWith('9drive-tb-'));
  } catch {
    return [];
  }
}

describe('upload (precreate → shards → create)', () => {
  it('uploads a small file in one shard and returns the stored path', async () => {
    await withFakeTeraBox({}, async (server) => {
      const data = Buffer.from('hello terabox');
      const result = await upload(makeContext(server), data, { name: 'hello.txt' });
      expect(result).toEqual({ remoteId: '/hello.txt', sizeBytes: BigInt(data.length), resumeToken: null });
      expect(server.readFile('/hello.txt')?.equals(data)).toBe(true);
      expect(server.counts.shards).toBe(1);

      const precreate = server.requests.find((r) => r.path === '/openapi/api/precreate')!;
      expect(precreate.form.autoinit).toBe('1');
      expect(JSON.parse(precreate.form.block_list)).toEqual([createHash('md5').update(data).digest('hex')]);
      const create = server.requests.find((r) => r.path === '/openapi/api/create')!;
      expect(create.form.rtype).toBe('1');
    });
  });

  it('streams multi-shard files in order with exact md5 block lists', async () => {
    await withFakeTeraBox({}, async (server) => {
      const data = randomBytes(SHARD_BYTES * 2 + 12345);
      const result = await upload(makeContext(server), data, { name: 'big.bin' });
      expect(result.remoteId).toBe('/big.bin');
      expect(server.counts.shards).toBe(3);
      expect(server.readFile('/big.bin')?.equals(data)).toBe(true);
      const shardRequests = server.requests.filter((r) => r.path === '/rest/2.0/pcs/superfile2');
      expect(shardRequests.map((r) => r.query.partseq)).toEqual(['0', '1', '2']);
      const blockList = JSON.parse(server.requests.find((r) => r.path === '/openapi/api/precreate')!.form.block_list) as string[];
      expect(blockList).toHaveLength(3);
      expect(blockList[0]).toBe(createHash('md5').update(data.subarray(0, SHARD_BYTES)).digest('hex'));
    });
  });

  it('retries a shard whose echoed md5 is wrong (shards are idempotent)', async () => {
    await withFakeTeraBox({}, async (server) => {
      server.corruptNextShard();
      const data = randomBytes(1024);
      const result = await upload(makeContext(server), data);
      expect(result.remoteId).toBe('/file.bin');
      expect(server.counts.shards).toBe(2);
      expect(server.readFile('/file.bin')?.equals(data)).toBe(true);
    });
  });

  it('retries transient shard failures but never auth failures', async () => {
    await withFakeTeraBox({}, async (server) => {
      server.failNext('/rest/2.0/pcs/superfile2', { errno: 500001 });
      const data = randomBytes(2048);
      await upload(makeContext(server), data);
      expect(server.counts.shards).toBe(1);
      expect(server.requests.filter((r) => r.path === '/rest/2.0/pcs/superfile2')).toHaveLength(2);
    });
    await withFakeTeraBox({}, async (server) => {
      server.failNext('/rest/2.0/pcs/superfile2', { errno: 200003 });
      await expectProviderCode(upload(makeContext(server), randomBytes(2048)), 'ERR_AUTH_EXPIRED');
      expect(server.requests.filter((r) => r.path === '/rest/2.0/pcs/superfile2')).toHaveLength(1);
    });
  });

  it('never replays create automatically (no duplicate files)', async () => {
    await withFakeTeraBox({}, async (server) => {
      server.failNext('/openapi/api/create', { errno: 500001 });
      await expectProviderCode(upload(makeContext(server), randomBytes(2048)), 'ERR_UPSTREAM_UNAVAILABLE');
      expect(server.requests.filter((r) => r.path === '/openapi/api/create')).toHaveLength(1);
      expect(server.paths()).toEqual([]);
    });
  });

  it('keeps duplicates apart (rtype=1 renames, never overwrites)', async () => {
    await withFakeTeraBox({}, async (server) => {
      server.seedFile('/report.pdf', 'original');
      const result = await upload(makeContext(server), Buffer.from('new content'), { name: 'report.pdf' });
      expect(result.remoteId).toBe('/report(1).pdf');
      expect(server.readFile('/report.pdf')?.toString()).toBe('original');
      expect(server.readFile('/report(1).pdf')?.toString()).toBe('new content');
    });
  });

  it('accepts return_type 2 (already stored) without sending shards', async () => {
    await withFakeTeraBox({ dedupeExisting: true }, async (server) => {
      server.seedFile('/same.bin', 'existing');
      const result = await upload(makeContext(server), Buffer.from('existing'), { name: 'same.bin' });
      expect(result.remoteId).toBe('/same.bin');
      expect(server.counts.shards).toBe(0);
      expect(server.counts.creates).toBe(0);
    });
  });

  it('uploads into a parent folder path', async () => {
    await withFakeTeraBox({}, async (server) => {
      server.seedDir('/docs');
      const result = await upload(makeContext(server), Buffer.from('x'), { name: 'a.txt', parentId: '/docs' });
      expect(result.remoteId).toBe('/docs/a.txt');
    });
  });

  it('validates input before staging anything', async () => {
    await withFakeTeraBox({}, async (server) => {
      const ctx = makeContext(server);
      await expectProviderCode(upload(ctx, Buffer.from('x'), { name: '../evil' }), 'ERR_INVALID_INPUT');
      await expectProviderCode(upload(ctx, Buffer.alloc(0), { name: 'empty' }), 'ERR_INVALID_INPUT');
      await expectProviderCode(upload(ctx, Buffer.from('x'), { size: -1n }), 'ERR_INVALID_INPUT');
      expect(server.requests).toHaveLength(0);
    });
  });

  it('rejects streams that disagree with the declared size and cleans up', async () => {
    const before = stagedDirs().length;
    await withFakeTeraBox({}, async (server) => {
      const ctx = makeContext(server);
      await expectProviderCode(upload(ctx, Buffer.from('12345'), { size: 10n }), 'ERR_INVALID_INPUT');
      await expectProviderCode(upload(ctx, Buffer.from('1234567890'), { size: 5n }), 'ERR_INVALID_INPUT');
      expect(server.requests.some((r) => r.path === '/openapi/api/precreate')).toBe(false);
    });
    expect(stagedDirs().length).toBe(before);
  });

  it('fails fast on expired credentials before consuming any disk', async () => {
    const before = stagedDirs().length;
    await withFakeTeraBox({}, async (server) => {
      const ctx = makeContext(server);
      server.expireAccessToken();
      await expectProviderCode(upload(ctx, randomBytes(1024)), 'ERR_AUTH_EXPIRED');
    });
    expect(stagedDirs().length).toBe(before);
  });

  it('cancels mid-stream, removes the temp file and never calls precreate', async () => {
    const before = stagedDirs().length;
    await withFakeTeraBox({}, async (server) => {
      const controller = new AbortController();
      const stream = new PassThrough();
      const pending = provider.upload(makeContext(server, { signal: controller.signal }), {
        stream,
        fileName: 'slow.bin',
        mimeType: 'application/octet-stream',
        sizeBytes: 1000n,
        parentId: null,
      });
      stream.write(Buffer.alloc(100));
      await new Promise((resolve) => setTimeout(resolve, 50));
      controller.abort();
      await expect(pending).rejects.toBeInstanceOf(Error);
      expect(server.requests.some((r) => r.path === '/openapi/api/precreate')).toBe(false);
    });
    expect(stagedDirs().length).toBe(before);
  });

  it('cleans the temp file after a failed upload as well', async () => {
    const before = stagedDirs().length;
    await withFakeTeraBox({}, async (server) => {
      server.failNext('/openapi/api/precreate', { errno: 500001 });
      await expectProviderCode(upload(makeContext(server), randomBytes(4096)), 'ERR_UPSTREAM_UNAVAILABLE');
    });
    expect(stagedDirs().length).toBe(before);
  });

  it('fails closed when TeraBox returns no upload_domain', async () => {
    await withFakeTeraBox({ uploadDomain: null }, async (server) => {
      await expectProviderCode(upload(makeContext(server), randomBytes(1024)), 'ERR_UPSTREAM_UNAVAILABLE');
      expect(server.counts.shards).toBe(0);
    });
  });

  it('rejects an out-of-range shard index from the server', async () => {
    await withFakeTeraBox({}, async (server) => {
      server.failNext('/openapi/api/precreate', { body: { errno: 0, return_type: 1, uploadid: 'u', block_list: [0, 7] } });
      await expectProviderCode(upload(makeContext(server), randomBytes(1024)), 'ERR_UPSTREAM_UNAVAILABLE');
      expect(server.counts.shards).toBe(0);
    });
  });
});

describe('upload concurrency', () => {
  it('Semaphore never exceeds its limit and hands slots over in order', async () => {
    const semaphore = new Semaphore(2);
    let active = 0;
    let peak = 0;
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 6 }, async (_, i) => {
        const release = await semaphore.acquire();
        active += 1;
        peak = Math.max(peak, active);
        order.push(i);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        release();
      }),
    );
    expect(peak).toBe(2);
    expect(order).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('a queued acquire can be cancelled', async () => {
    const semaphore = new Semaphore(1);
    const release = await semaphore.acquire();
    const controller = new AbortController();
    const queued = semaphore.acquire(controller.signal);
    controller.abort();
    await expect(queued).rejects.toMatchObject({ code: 'ERR_TIMEOUT' });
    release();
    await (await semaphore.acquire())();
  });

  it('runs concurrent uploads without mixing their data', async () => {
    process.env.TERABOX_UPLOAD_CONCURRENCY = '2';
    resetUploadSemaphore();
    await withFakeTeraBox({}, async (server) => {
      const ctx = makeContext(server);
      const payloads = Array.from({ length: 5 }, (_, i) => randomBytes(2000 + i));
      const results = await Promise.all(payloads.map((data, i) => upload(ctx, data, { name: `f${i}.bin` })));
      results.forEach((result, i) => {
        expect(result.remoteId).toBe(`/f${i}.bin`);
        expect(server.readFile(`/f${i}.bin`)?.equals(payloads[i])).toBe(true);
      });
    });
    delete process.env.TERABOX_UPLOAD_CONCURRENCY;
    resetUploadSemaphore();
  });
});

describe('download', () => {
  it('streams the file via the documented dlink and appends the token', async () => {
    await withFakeTeraBox({}, async (server) => {
      const content = randomBytes(5000);
      server.seedFile('/docs/a.bin', content);
      const result = await provider.download(makeContext(server), { remoteId: '/docs/a.bin' });
      const body = await readAll(result.stream);
      expect(body.equals(content)).toBe(true);
      expect(result.sizeBytes).toBe(5000n);
      const download = server.requests.find((r) => r.path === '/openapi/api/download')!;
      expect(download.query.type).toBe('dlink');
      expect(JSON.parse(download.query.fidlist)).toHaveLength(1);
      const dl = server.requests.find((r) => r.path.startsWith('/dl/'))!;
      expect(dl.query.access_tokens).toBe(server.tokens.access);
    });
  });

  it('refuses folders and missing files', async () => {
    await withFakeTeraBox({}, async (server) => {
      server.seedDir('/docs');
      const ctx = makeContext(server);
      await expectProviderCode(provider.download(ctx, { remoteId: '/docs' }), 'ERR_INVALID_INPUT');
      await expectProviderCode(provider.download(ctx, { remoteId: '/nope' }), 'ERR_NOT_FOUND');
    });
  });

  it('maps a CDN 403 on the download link to ERR_AUTH_EXPIRED', async () => {
    await withFakeTeraBox({}, async (server) => {
      const fsId = server.seedFile('/a.bin', 'abc');
      server.failNext(`/dl/${fsId}`, { status: 403 });
      await expectProviderCode(provider.download(makeContext(server), { remoteId: '/a.bin' }), 'ERR_AUTH_EXPIRED');
    });
  });

  it('maps an expired access token on the API lookups to ERR_AUTH_EXPIRED', async () => {
    await withFakeTeraBox({}, async (server) => {
      server.seedFile('/a.bin', 'abc');
      const ctx = makeContext(server);
      server.expireAccessToken();
      await expectProviderCode(provider.download(ctx, { remoteId: '/a.bin' }), 'ERR_AUTH_EXPIRED');
    });
  });
});
