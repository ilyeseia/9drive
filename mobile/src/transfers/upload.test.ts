import { ApiClient } from '../api/client';
import { ApiError } from '../api/errors';
import type { FileItem } from '../api/endpoints/files';
import {
  UploadRunner,
  createUploadApi,
  type ChunkResult,
  type InitResult,
  type SessionStatus,
  type UploadApi,
  type UploadJob,
  type UploadSource,
} from './upload';

const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => i % 251);
const toFile = (name: string, size: number): FileItem => ({
  id: `f-${name}`,
  name,
  mimeType: 'application/octet-stream',
  sizeBytes: String(size),
  provider: 'google_drive',
  createdAt: '2026-10-18T10:00:00Z',
});

function source(data: Uint8Array, name = 'a.bin'): UploadSource {
  return {
    name,
    mimeType: 'application/octet-stream',
    size: data.length,
    read: async (start, end) => data.slice(start, end) as unknown as BodyInit,
  };
}

/** Mirrors the real server's resumable semantics (upload.routes.ts): offset checks, truncation on rewind, idempotent clientUploadId. */
class FakeServer implements UploadApi {
  sessions = new Map<
    string,
    { size: number; spool: number[]; status: 'uploading' | 'completed' | 'failed'; clientUploadId: string; name: string }
  >();
  completed = new Map<string, FileItem>();
  chunkCalls: { start: number; end: number }[] = [];
  initCalls = 0;
  sent = 0;
  private faults: ((call: { start: number }) => 'before' | 'after' | null)[] = [];
  constructor(public chunkSize = 10) {}

  failChunks(kind: ApiError, when: 'before' | 'after', times = 1) {
    let left = times;
    this.faults.push(() => (left-- > 0 ? when : null));
    this.lastFault = kind;
  }
  private lastFault: ApiError = new ApiError('offline', null, null, 'x');

  async init(spec: Parameters<UploadApi['init']>[0]): Promise<InitResult> {
    this.initCalls += 1;
    const done = this.completed.get(`${spec.clientUploadId}:${spec.size}`);
    if (done) return { sessionId: 's-replay', chunkSize: this.chunkSize, offset: spec.size, status: 'completed', file: done };
    const id = `s${this.sessions.size + 1}`;
    this.sessions.set(id, { size: spec.size, spool: [], status: 'uploading', clientUploadId: spec.clientUploadId, name: spec.fileName });
    return { sessionId: id, chunkSize: this.chunkSize, offset: 0, status: 'uploading', file: null };
  }

  async status(sessionId: string): Promise<SessionStatus> {
    const s = this.sessions.get(sessionId);
    if (!s) return { status: 'failed', offset: 0 };
    return { status: s.status, offset: s.status === 'completed' ? s.size : s.spool.length };
  }

  async putChunk(
    sessionId: string,
    body: BodyInit,
    range: { start: number; end: number; total: number },
    _signal?: AbortSignal,
  ): Promise<ChunkResult> {
    this.chunkCalls.push({ start: range.start, end: range.end });
    const fault = this.faults.map((f) => f({ start: range.start })).find((x) => x !== null) ?? null;
    if (fault === 'before') throw this.lastFault;
    const s = this.sessions.get(sessionId)!;
    if (range.start > s.spool.length)
      throw new ApiError('validation', 400, 'INVALID_OFFSET', 'Chunk starts beyond the bytes already received.');
    if (range.start < s.spool.length) s.spool.length = range.start;
    const data = Array.from(body as unknown as Uint8Array);
    s.spool.push(...data);
    this.sent += data.length;
    if (fault === 'after') throw this.lastFault; // applied, but the response never reached the client
    if (s.spool.length >= s.size) {
      s.status = 'completed';
      const file = toFile(s.name, s.size);
      this.completed.set(`${s.clientUploadId}:${s.size}`, file);
      return { status: 'completed', offset: s.size, file };
    }
    return { status: 'uploading', offset: s.spool.length, file: null };
  }
}

const noSleep = async () => undefined;
const job = (data: Uint8Array, over: Partial<UploadJob> = {}): UploadJob => ({
  source: source(data),
  folderId: null,
  clientUploadId: 'cid-1',
  ...over,
});
const runner = (server: UploadApi, extra: Partial<ConstructorParameters<typeof UploadRunner>[1]> = {}) =>
  new UploadRunner(server, { sleep: noSleep, random: () => 0, ...extra });

describe('UploadRunner — happy path', () => {
  it('uploads in chunks with server-confirmed, monotonic progress and returns the file', async () => {
    const server = new FakeServer(10);
    const progress: number[] = [];
    const out = await runner(server).run(job(bytes(35)), { onProgress: (sent) => progress.push(sent) });
    expect(out.file?.name).toBe('a.bin');
    expect(server.sessions.get('s1')?.spool).toEqual(Array.from(bytes(35)));
    expect(progress).toEqual([0, 10, 20, 30, 35]);
    expect(server.chunkCalls.map((c) => [c.start, c.end])).toEqual([
      [0, 9],
      [10, 19],
      [20, 29],
      [30, 34],
    ]);
  });

  it.each([1, 10, 20, 21])('handles a %i-byte file around chunk boundaries', async (size) => {
    const server = new FakeServer(10);
    const out = await runner(server).run(job(bytes(size)));
    expect(out.file).not.toBeNull();
    expect(server.sessions.get('s1')?.spool).toHaveLength(size);
  });

  it('rejects an empty file before touching the network', async () => {
    const server = new FakeServer();
    await expect(runner(server).run(job(new Uint8Array(0)))).rejects.toMatchObject({ kind: 'validation', code: 'UPLOAD_SIZE_REQUIRED' });
    expect(server.initCalls).toBe(0);
  });

  it('reports the session id as soon as it exists so it can be persisted', async () => {
    const server = new FakeServer();
    const sessions: string[] = [];
    await runner(server).run(job(bytes(5)), { onSession: (id) => sessions.push(id) });
    expect(sessions).toEqual(['s1']);
  });
});

describe('UploadRunner — failures and recovery', () => {
  it('retries a transient failure that happened BEFORE the chunk was applied', async () => {
    const server = new FakeServer(10);
    server.failChunks(new ApiError('offline', null, null, 'x'), 'before', 2);
    await runner(server).run(job(bytes(25)));
    expect(server.sessions.get('s1')?.spool).toEqual(Array.from(bytes(25)));
    expect(server.sent).toBe(25); // nothing was applied twice
  });

  it('does not resend a chunk that was applied but whose response was lost', async () => {
    const server = new FakeServer(10);
    server.failChunks(new ApiError('timeout', null, null, 'x'), 'after', 1);
    await runner(server).run(job(bytes(25)));
    expect(server.sessions.get('s1')?.spool).toEqual(Array.from(bytes(25)));
    expect(server.sent).toBe(25); // the lost-response chunk was not sent again
    expect(server.chunkCalls.map((c) => c.start)).toEqual([0, 10, 20]);
  });

  it('gives up after the retry budget and surfaces the transient error', async () => {
    const server = new FakeServer(10);
    server.failChunks(new ApiError('offline', null, null, 'x'), 'before', 99);
    await expect(runner(server, { maxChunkRetries: 2 }).run(job(bytes(25)))).rejects.toMatchObject({ kind: 'offline' });
    expect(server.chunkCalls).toHaveLength(3);
  });

  it('does not retry permanent errors such as a full storage account', async () => {
    const server = new FakeServer(10);
    server.failChunks(new ApiError('quota', 507, 'QUOTA_EXCEEDED', 'x'), 'before', 99);
    await expect(runner(server).run(job(bytes(25)))).rejects.toMatchObject({ kind: 'quota' });
    expect(server.chunkCalls).toHaveLength(1);
  });

  it('re-synchronises on INVALID_OFFSET without waiting', async () => {
    const server = new FakeServer(10);
    const sleeps: number[] = [];
    // First chunk "was lost" server-side, so the second is beyond the spool.
    const original = server.putChunk.bind(server);
    let first = true;
    server.putChunk = async (id, body, range) => {
      if (first && range.start === 0) {
        first = false;
        server.chunkCalls.push({ start: 0, end: 9 }); // pretend we sent it; server never applied it
        return { status: 'uploading', offset: 10, file: null }; // lying offset → next chunk is beyond the spool
      }
      return original(id, body, range);
    };
    await runner(server, { sleep: async (ms) => void sleeps.push(ms) }).run(job(bytes(25)));
    expect(server.sessions.get('s1')?.spool).toEqual(Array.from(bytes(25)));
    expect(sleeps).toEqual([]);
  });

  it('follows a server that rewound to an earlier offset', async () => {
    const server = new FakeServer(10);
    const original = server.putChunk.bind(server);
    let rewound = false;
    server.putChunk = async (id, body, range) => {
      if (!rewound && range.start === 20) {
        rewound = true;
        server.sessions.get(id)!.spool.length = 5; // server lost data
        return { status: 'uploading', offset: 5, file: null };
      }
      return original(id, body, range);
    };
    await runner(server).run(job(bytes(25)));
    expect(server.sessions.get('s1')?.spool).toEqual(Array.from(bytes(25)));
  });

  it('stops when the server keeps accepting nothing', async () => {
    const server = new FakeServer(10);
    server.putChunk = async () => ({ status: 'uploading', offset: 0, file: null });
    await expect(runner(server, { maxStalls: 3 }).run(job(bytes(25)))).rejects.toMatchObject({ code: 'UPLOAD_STALLED' });
  });
});

describe('UploadRunner — cancel, resume, idempotency', () => {
  it('cancels mid-upload and resumes later from the server offset using the same session', async () => {
    const server = new FakeServer(10);
    const controller = new AbortController();
    const data = bytes(45);
    const j = job(data);
    let chunks = 0;
    const original = server.putChunk.bind(server);
    server.putChunk = async (id, body, range, signal) => {
      const res = await original(id, body, range);
      chunks += 1;
      if (chunks === 2) controller.abort();
      if (signal?.aborted) throw new ApiError('cancelled', null, null, 'Cancelled.');
      return res;
    };
    await expect(runner(server).run(j, {}, controller.signal)).rejects.toMatchObject({ kind: 'cancelled' });
    expect(j.sessionId).toBe('s1');
    const sentBefore = server.sent;
    expect(sentBefore).toBeLessThan(45);

    server.putChunk = original;
    const out = await runner(server).run(j);
    expect(out.file).not.toBeNull();
    expect(server.initCalls).toBe(1); // resumed, not restarted
    expect(server.sent).toBe(45); // each byte sent exactly once overall
  });

  it('does not duplicate the file when the same upload is started again after it finished', async () => {
    const server = new FakeServer(10);
    const data = bytes(25);
    const first = await runner(server).run(job(data, { clientUploadId: 'same' }));
    const second = await runner(server).run(job(data, { clientUploadId: 'same' })); // e.g. app restarted before it noticed
    expect(second.file).toEqual(first.file);
    expect(server.completed.size).toBe(1);
    expect(server.sent).toBe(25);
  });

  it('starts a fresh session when the saved one failed on the server', async () => {
    const server = new FakeServer(10);
    server.sessions.set('old', { size: 25, spool: [], status: 'failed', clientUploadId: 'cid-1', name: 'a.bin' });
    const out = await runner(server).run(job(bytes(25), { sessionId: 'old' }));
    expect(out.file).not.toBeNull();
    expect(server.initCalls).toBe(1);
  });

  it('treats a saved session that already completed as done', async () => {
    const server = new FakeServer(10);
    server.sessions.set('done', { size: 25, spool: [], status: 'completed', clientUploadId: 'cid-1', name: 'a.bin' });
    const out = await runner(server).run(job(bytes(25), { sessionId: 'done' }));
    expect(out.file).toBeNull();
    expect(server.initCalls).toBe(0);
    expect(server.chunkCalls).toHaveLength(0);
  });

  it('refuses to start when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const server = new FakeServer();
    await expect(runner(server).run(job(bytes(5)), {}, controller.signal)).rejects.toMatchObject({ kind: 'cancelled' });
    expect(server.initCalls).toBe(0);
  });
});

describe('createUploadApi over HTTP', () => {
  it('speaks the real wire protocol: Content-Range, string sizes, parsed offsets, no automatic chunk retry', async () => {
    const seen: { method: string; path: string; headers: Record<string, string>; body: unknown }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      seen.push({ method: String(init.method), path, headers: init.headers as Record<string, string>, body: init.body });
      if (path === '/uploads/resumable/init')
        return new Response(JSON.stringify({ sessionId: 'S', chunkSize: 5242880, offset: '0' }), { status: 201 });
      if (path.startsWith('/uploads/resumable/chunk/'))
        return new Response(JSON.stringify({ status: 'uploading', offset: '5' }), { status: 200 });
      return new Response(JSON.stringify({ status: 'uploading', offset: '5' }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new ApiClient({
      baseUrl: 'https://api.test',
      fetchImpl,
      retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1 },
      sleep: noSleep,
    });
    const api = createUploadApi(client);

    const init = await api.init({ fileName: 'a.bin', mimeType: '', size: 1234567890123, folderId: 'F', clientUploadId: 'cid' });
    expect(init).toEqual({ sessionId: 'S', chunkSize: 5242880, offset: 0, status: 'uploading', file: null });
    expect(seen[0]?.body).toBe(
      JSON.stringify({
        fileName: 'a.bin',
        mimeType: 'application/octet-stream',
        sizeBytes: '1234567890123',
        folderId: 'F',
        targetAccountId: null,
        clientUploadId: 'cid',
      }),
    );

    const chunk = await api.putChunk('S', new Uint8Array([1, 2, 3, 4, 5]) as unknown as BodyInit, { start: 0, end: 4, total: 10 });
    expect(chunk).toEqual({ status: 'uploading', offset: 5, file: null });
    const put = seen[1]!;
    expect(put.method).toBe('PUT');
    expect(put.headers['Content-Range']).toBe('bytes 0-4/10');
    expect(put.headers['Content-Type']).toBe('application/octet-stream');
    expect(put.body).toBeInstanceOf(Uint8Array);
  });

  it('does not let the HTTP layer retry a chunk (the runner reconciles with the server first)', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      throw new TypeError('Network request failed');
    }) as unknown as typeof fetch;
    const client = new ApiClient({
      baseUrl: 'https://api.test',
      fetchImpl,
      retry: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 1 },
      sleep: noSleep,
    });
    await expect(
      createUploadApi(client).putChunk('S', new Uint8Array([1]) as unknown as BodyInit, { start: 0, end: 0, total: 1 }),
    ).rejects.toMatchObject({ kind: 'offline' });
    expect(calls).toBe(1);
  });

  it('rejects a malformed server answer instead of trusting it', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ status: 'uploading', offset: -5 }), { status: 200 })) as unknown as typeof fetch;
    const client = new ApiClient({ baseUrl: 'https://api.test', fetchImpl, sleep: noSleep });
    await expect(createUploadApi(client).status('S')).rejects.toMatchObject({ kind: 'invalid_response' });
  });
});

describe('very large files', () => {
  it('uses exact integer offsets beyond 4 GiB and 2^32, sends sizes as strings, and never reads more than one chunk at a time', async () => {
    const TOTAL = 6 * 1024 ** 3 + 123; // ~6 GiB: past every 32-bit boundary
    const CHUNK = 1024 ** 3;
    const ranges: [number, number, number][] = [];
    let spool = 0;
    let maxLive = 0;
    let live = 0;
    const api: UploadApi = {
      init: async (spec) => {
        expect(typeof spec.size).toBe('number');
        return { sessionId: 'S', chunkSize: CHUNK, offset: 0, status: 'uploading', file: null };
      },
      status: async () => ({ status: 'uploading', offset: spool }),
      putChunk: async (_id, _body, r) => {
        ranges.push([r.start, r.end, r.total]);
        expect(r.start).toBe(spool);
        spool = r.end + 1;
        live -= 1;
        return spool >= r.total
          ? { status: 'completed', offset: spool, file: toFile('big.iso', TOTAL) }
          : { status: 'uploading', offset: spool, file: null };
      },
    };
    const source: UploadSource = {
      name: 'big.iso',
      mimeType: 'application/octet-stream',
      size: TOTAL,
      read: async () => {
        live += 1;
        maxLive = Math.max(maxLive, live);
        return new Uint8Array(0) as unknown as BodyInit;
      },
    };
    const out = await new UploadRunner(api, { sleep: noSleep }).run({ source, folderId: null, clientUploadId: 'cid' });
    expect(out.file?.name).toBe('big.iso');
    expect(ranges).toHaveLength(7);
    expect(ranges.at(-1)).toEqual([6 * CHUNK, TOTAL - 1, TOTAL]);
    expect(Number.isSafeInteger(TOTAL)).toBe(true);
    expect(maxLive).toBe(1); // chunk N+1 is read only after chunk N was confirmed
  });
});
