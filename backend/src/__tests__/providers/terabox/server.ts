/**
 * In-process fake of the TeraBox web API used by the adapter tests.
 *
 * It speaks the same envelopes as the reverse-engineered service (JSON with an
 * `errno` code on HTTP 200, `filemetas.info[].errno` per-item codes, `errno` vs
 * `error_code` between endpoints, precreate → superfile2 chunks → create,
 * filemanager with async task polling, signed dlink downloads with Range) so the
 * tests exercise the adapter's real request building.
 */

import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { ProviderError } from '../../../providers/errors.js';
import { resetTeraBoxTransport, setTeraBoxTransport } from '../../../providers/terabox/transport.js';
import type { ProviderContext } from '../../../providers/types.js';

export interface FakeTeraBoxFailure {
  /** Body `errno` answered with HTTP 200 (the normal TeraBox shape). */
  errno?: number;
  /** Answer with this HTTP status instead (gateway/WAF style). */
  status?: number;
}

export interface FakeTeraBoxOptions {
  /** Expected `ndus` cookie value. */
  cookie?: string;
  total?: number;
  used?: number;
  vip?: boolean;
  /** `/api/check/login` answers without the `uk` account id. */
  omitUk?: boolean;
  /** Shell entries that answer `302 /login` (the real site's behaviour for `/`). */
  shellRedirects?: Array<'/' | '/main'>;
}

interface FakeNode {
  path: string;
  fsId: number;
  isdir: boolean;
  content: Buffer;
  ctime: number;
  mtime: number;
}

interface FakeUpload {
  id: string;
  chunks: Map<number, Buffer>;
}

export interface FakeTeraBoxServer {
  origin: string;
  requests: string[];
  tokenRequests: string[];
  /** Cookie header observed on every `GET /dl/…` (the gated dlink hop). */
  downloadCookies: (string | null)[];
  uploadChunkCalls: number;
  downloadCalls: number;
  /** Plaintext control md5 the last `/api/create` answered (obfuscated). */
  lastControlMd5: string | null;
  close(): Promise<void>;
  seedFolder(path: string): void;
  seedFile(path: string, content: Buffer | string): void;
  readFile(path: string): Buffer;
  has(path: string): boolean;
  nodeCount(): number;
  /** Queue an answer for the next request whose path contains `endpoint`. */
  failNext(endpoint: string, spec: number | FakeTeraBoxFailure): void;
  /** Make the next chunk upload answer a different md5 (integrity retry path). */
  corruptNextChunkMd5(): void;
  /** Answer `filemetas` without a `dlink` field (signed-download fallback path). */
  omitDlink(path: string): void;
}

const SAVED_ENV: Record<string, string | undefined> = {};

/** Temporary download links are gated: loopback http needs an explicit opt-in. */
export function enableLocalEndpoint(): void {
  for (const name of ['ALLOW_INSECURE_ENDPOINTS', 'SSRF_ALLOWLIST']) SAVED_ENV[name] = process.env[name];
  process.env.ALLOW_INSECURE_ENDPOINTS = 'true';
  process.env.SSRF_ALLOWLIST = '127.0.0.1';
}

export function restoreEndpointEnv(): void {
  for (const [name, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function normalizePath(value: string | null | undefined): string {
  const raw = (value ?? '').trim();
  const withSlash = raw === '' ? '/' : raw.startsWith('/') ? raw : `/${raw}`;
  return withSlash.length > 1 && withSlash.endsWith('/') ? withSlash.slice(0, -1) : withSlash;
}

function parentOf(path: string): string {
  if (path === '/') return '/';
  const separator = path.lastIndexOf('/');
  return separator <= 0 ? '/' : path.slice(0, separator);
}

function baseName(path: string): string {
  if (path === '/') return '';
  return path.slice(path.lastIndexOf('/') + 1);
}

async function readRaw(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}

function sendJson(res: ServerResponse, payload: unknown): void {
  const body = JSON.stringify(payload ?? {});
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function formFields(raw: Buffer): Record<string, string> {
  const params = new URLSearchParams(raw.toString('utf8'));
  const fields: Record<string, string> = {};
  for (const [key, value] of params) fields[key] = value;
  return fields;
}

/** Single-file multipart body exactly as `buildMultipartBody()` writes it. */
function multipartFile(raw: Buffer, contentType: string | undefined): Buffer {
  const boundary = /boundary=(.+)$/.exec(contentType ?? '')?.[1] ?? '';
  if (boundary === '') return Buffer.alloc(0);
  const start = raw.indexOf(Buffer.from('\r\n\r\n'));
  const end = raw.lastIndexOf(Buffer.from(`\r\n--${boundary}--\r\n`));
  if (start < 0 || end < 0 || end <= start) return Buffer.alloc(0);
  return raw.subarray(start + 4, end);
}

/**
 * Inverse of the adapter's `decodeMd5()`: re-obfuscate a whole-file md5 so the
 * upload integrity path can be asserted end to end. The decoder applies the
 * character shift, the index XOR and the block swap in that order, so the
 * encoder runs them backwards (swap → XOR → shift).
 */
export function encodeMd5(plaintext: string): string {
  if (typeof plaintext !== 'string' || plaintext.length !== 32) return plaintext;
  const swapped = `${plaintext.slice(8, 16)}${plaintext.slice(0, 8)}${plaintext.slice(24, 32)}${plaintext.slice(16, 24)}`;
  const xored: string[] = [];
  for (let i = 0; i < 32; i++) {
    const digit = Number.parseInt(swapped[i] as string, 16);
    xored.push((digit ^ (i & 15)).toString(16));
  }
  const chars = xored.join('').split('');
  chars[9] = String.fromCharCode('g'.charCodeAt(0) + Number.parseInt(chars[9] as string, 16));
  return chars.join('');
}

function toMeta(node: FakeNode, dlink: string | null): Record<string, unknown> {
  return {
    fs_id: node.fsId,
    server_filename: baseName(node.path),
    path: node.path,
    size: node.isdir ? 0 : node.content.byteLength,
    isdir: node.isdir ? 1 : 0,
    server_ctime: node.ctime,
    server_mtime: node.mtime,
    md5: node.isdir ? '' : createHash('md5').update(node.content).digest('hex'),
    ...(dlink ? { dlink } : {}),
  };
}

export async function startFakeTeraBox(options: FakeTeraBoxOptions = {}): Promise<FakeTeraBoxServer> {
  const expectedCookie = options.cookie ?? 'valid-cookie';
  const quota = {
    total: options.total ?? 1_073_741_824,
    used: options.used ?? 10_485_760,
  };
  const isVip = options.vip ?? false;
  const shellRedirects = new Set(options.shellRedirects ?? []);

  const nodes = new Map<string, FakeNode>();
  const byId = new Map<number, string>();
  const uploads = new Map<string, FakeUpload>();
  const failures = new Map<string, FakeTeraBoxFailure[]>();
  const noDlink = new Set<string>();
  const requests: string[] = [];
  const tokenRequests: string[] = [];
  const downloadCookies: (string | null)[] = [];
  let corruptNextChunk = false;
  let uploadChunkCalls = 0;
  let downloadCalls = 0;
  let lastControlMd5: string | null = null;
  let fsSeq = 1000;
  let uploadSeq = 0;

  const put = (node: FakeNode): void => {
    nodes.set(node.path, node);
    byId.set(node.fsId, node.path);
  };

  const seedFolder = (rawPath: string): void => {
    const path = normalizePath(rawPath);
    if (nodes.has(path)) return;
    put({ path, fsId: fsSeq++, isdir: true, content: Buffer.alloc(0), ctime: 1_700_000_000, mtime: 1_700_000_000 });
  };

  const seedFile = (rawPath: string, content: Buffer | string): void => {
    const path = normalizePath(rawPath);
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const existing = nodes.get(path);
    if (existing) {
      existing.content = buffer;
      existing.mtime = 1_700_000_100;
      return;
    }
    put({ path, fsId: fsSeq++, isdir: false, content: buffer, ctime: 1_700_000_000, mtime: 1_700_000_100 });
  };

  seedFolder('/');

  const childrenOf = (dir: string): FakeNode[] =>
    [...nodes.values()]
      .filter((node) => node.path !== '/' && parentOf(node.path) === dir)
      .sort((a, b) => baseName(a.path).localeCompare(baseName(b.path)));

  const removeTree = (path: string): void => {
    for (const candidate of [...nodes.keys()]) {
      if (candidate === path || candidate.startsWith(`${path}/`)) {
        const node = nodes.get(candidate);
        if (node) byId.delete(node.fsId);
        nodes.delete(candidate);
      }
    }
  };

  const copyTree = (source: string, destination: string): FakeNode[] => {
    const created: FakeNode[] = [];
    for (const node of [...nodes.values()]) {
      if (node.path !== source && !node.path.startsWith(`${source}/`)) continue;
      const target = normalizePath(destination + node.path.slice(source.length));
      if (nodes.has(target)) continue;
      const copy: FakeNode = {
        path: target,
        fsId: fsSeq++,
        isdir: node.isdir,
        content: Buffer.from(node.content),
        ctime: 1_700_000_200,
        mtime: 1_700_000_200,
      };
      put(copy);
      created.push(copy);
    }
    return created;
  };

  /** Move a node (and, for folders, its whole subtree) to a new path. */
  const moveTree = (source: string, destination: string): void => {
    const node = nodes.get(source);
    if (!node) return;
    const subtree: FakeNode[] = [node];
    for (const child of [...nodes.values()]) {
      if (child.path.startsWith(`${source}/`)) subtree.push(child);
    }
    removeTree(source);
    for (const entry of subtree) {
      const target = normalizePath(destination + entry.path.slice(source.length));
      put({ ...entry, path: target });
    }
  };

  let origin = 'http://127.0.0.1:0';
  const dlinkFor = (node: FakeNode): string => `${origin}/dl/${node.fsId}`;

  const authorized = (req: IncomingMessage): boolean => {
    const cookie = req.headers.cookie ?? '';
    return cookie.includes(`ndus=${expectedCookie}`);
  };

  const json = (res: ServerResponse, payload: unknown): void => sendJson(res, payload);

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', origin);
      const pathname = url.pathname;
      const method = req.method ?? 'GET';
      requests.push(`${method} ${pathname}`);

      const queuedKey = [...failures.keys()].find((endpoint) => pathname.includes(endpoint));
      if (queuedKey !== undefined) {
        const queue = failures.get(queuedKey) ?? [];
        const spec = queue.shift();
        if (queue.length === 0) failures.delete(queuedKey);
        if (spec) {
          const status = spec.status ?? 200;
          const payload = spec.errno !== undefined ? { errno: spec.errno } : {};
          if (status >= 400) {
            const body = JSON.stringify(payload);
            res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
            res.end(body);
            return;
          }
          json(res, payload);
          return;
        }
      }

      const gated = pathname.startsWith('/api/') || pathname.startsWith('/rest/') || pathname.startsWith('/share/');
      if (gated && !authorized(req)) {
        json(res, { errno: 104 });
        return;
      }

      // SPA shell carrying the jsToken: production serves it at `/main` and
      // bounces `/` through the login flow (`shellRedirects` opts into both).
      if (method === 'GET' && (pathname === '/' || pathname === '/main')) {
        if (shellRedirects.has(pathname)) {
          res.writeHead(302, { location: '/login', 'content-length': 0 });
          res.end();
          return;
        }
        const body = '<html><head><script>function%20fn%28a%29%7Bwindow.jsToken%20%3D%20a%7D%3Bfn%28%22TEST-JS-TOKEN%22%29</script></head></html>';
        res.writeHead(200, { 'content-type': 'text/html', 'content-length': Buffer.byteLength(body) });
        res.end(body);
        return;
      }

      if (url.searchParams.has('jsToken')) tokenRequests.push(`${method} ${pathname}`);

      if (pathname === '/api/check/login') {
        json(res, options.omitUk ? { errno: 0 } : { errno: 0, uk: 987654321 });
        return;
      }

      if (pathname === '/api/user/getinfo') {
        json(res, { errno: 0, records: [{ uk: 987654321, uname: 'TeraBox Tester' }] });
        return;
      }

      if (pathname === '/api/quota') {
        json(res, {
          errno: 0,
          total: quota.total,
          used: quota.used,
          free: Math.max(0, quota.total - quota.used),
          expire: false,
          sbox_used: 0,
          server_time: 1_700_000_000,
        });
        return;
      }

      if (pathname === '/rest/2.0/membership/proxy/user') {
        json(res, { errno: 0, data: { member_info: { is_vip: isVip ? 1 : 0, vip_left_time: 86_400 } } });
        return;
      }

      if (pathname === '/rest/2.0/pcs/file') {
        json(res, { errno: 0, host: origin.replace(/^https?:\/\//, ''), expire: 0 });
        return;
      }

      if (pathname === '/api/list') {
        const dir = normalizePath(url.searchParams.get('dir'));
        const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
        const num = Math.max(1, Number(url.searchParams.get('num') ?? '100') || 100);
        const all = childrenOf(dir);
        const slice = all.slice((page - 1) * num, page * num);
        json(res, { errno: 0, list: slice.map((node) => toMeta(node, null)) });
        return;
      }

      if (pathname === '/api/search') {
        const key = url.searchParams.get('key') ?? '';
        const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
        const num = Math.max(1, Number(url.searchParams.get('num') ?? '100') || 100);
        const matches = [...nodes.values()]
          .filter((node) => node.path !== '/' && baseName(node.path).toLowerCase().includes(key.toLowerCase()))
          .sort((a, b) => baseName(a.path).localeCompare(baseName(b.path)));
        json(res, { errno: 0, list: matches.slice((page - 1) * num, page * num).map((node) => toMeta(node, null)) });
        return;
      }

      if (pathname === '/api/filemetas') {
        const rawTarget = url.searchParams.get('target') ?? '[]';
        let targets: string[] = [];
        try {
          const parsed = JSON.parse(rawTarget) as unknown;
          if (Array.isArray(parsed)) targets = parsed.map((entry) => String(entry));
        } catch {
          targets = [];
        }
        const wantDlink = url.searchParams.get('dlink') === '1';
        const target = normalizePath(targets[0]);
        const node = nodes.get(target);
        if (!node) {
          // Documented envelope: per-item code wins over the top-level one.
          json(res, { errno: 12, info: [{ errno: -9 }] });
          return;
        }
        json(res, {
          errno: 0,
          info: [
            {
              errno: 0,
              ...toMeta(node, wantDlink && !node.isdir && !noDlink.has(target) ? dlinkFor(node) : null),
            },
          ],
        });
        return;
      }

      if (pathname === '/api/home/info') {
        json(res, { errno: 0, data: { sign1: 'sign-one', sign3: 'sign-three', timestamp: 1_700_000_000 } });
        return;
      }

      if (pathname === '/api/download') {
        const rawList = url.searchParams.get('fidlist') ?? '[]';
        let ids: number[] = [];
        try {
          const parsed = JSON.parse(rawList) as unknown;
          if (Array.isArray(parsed)) ids = parsed.map((entry) => Number(entry));
        } catch {
          ids = [];
        }
        const found = ids.map((id) => byId.get(id)).find((path) => path !== undefined && nodes.has(path));
        const node = found ? nodes.get(found) : undefined;
        if (!node) {
          json(res, { errno: -9 });
          return;
        }
        json(res, {
          errno: 0,
          dlink: [{ fs_id: String(node.fsId), dlink: dlinkFor(node) }],
          file_info: { size: node.content.byteLength, filename: baseName(node.path) },
        });
        return;
      }

      if (pathname === '/api/precreate' && method === 'POST') {
        const fields = formFields(await readRaw(req));
        uploadSeq += 1;
        const id = `upload-${uploadSeq}`;
        uploads.set(id, { id, chunks: new Map() });
        json(res, { errno: 0, uploadid: id, path: fields.path ?? '', return_type: 0, block_list: [] });
        return;
      }

      if (pathname.startsWith('/rest/2.0/pcs/superfile2')) {
        uploadChunkCalls += 1;
        const upload = uploads.get(url.searchParams.get('uploadid') ?? '');
        const raw = await readRaw(req);
        const chunk = multipartFile(raw, req.headers['content-type']);
        if (!upload) {
          json(res, { error_code: 2, md5: '' });
          return;
        }
        const partseq = Number(url.searchParams.get('partseq') ?? '0');
        upload.chunks.set(Number.isFinite(partseq) ? partseq : 0, chunk);
        const md5 = createHash('md5').update(chunk).digest('hex');
        if (corruptNextChunk) {
          corruptNextChunk = false;
          json(res, { error_code: 0, md5: 'ffffffffffffffffffffffffffffffff' });
          return;
        }
        json(res, { error_code: 0, md5, uploadid: upload.id, partseq });
        return;
      }

      if (pathname === '/api/create' && method === 'POST') {
        const fields = formFields(await readRaw(req));
        const path = normalizePath(fields.path);
        if (fields.isdir === '1') {
          if (nodes.has(path)) {
            json(res, { errno: -8 });
            return;
          }
          if (!nodes.has(parentOf(path))) {
            json(res, { errno: -11 });
            return;
          }
          seedFolder(path);
          json(res, { errno: 0, path });
          return;
        }

        const upload = uploads.get(fields.uploadid ?? '');
        if (!upload) {
          json(res, { errno: 2 });
          return;
        }
        const parts = [...upload.chunks.entries()].sort((a, b) => a[0] - b[0]).map(([, buffer]) => buffer);
        const content = Buffer.concat(parts);
        const declared = Number(fields.size ?? '0');
        if (content.byteLength !== declared) {
          json(res, { errno: 2 });
          return;
        }
        let blockList: string[] = [];
        try {
          const parsed = JSON.parse(fields.block_list ?? '[]') as unknown;
          if (Array.isArray(parsed)) blockList = parsed.map((entry) => String(entry));
        } catch {
          blockList = [];
        }
        // The commit must carry the real md5 of every chunk it just stored.
        if (blockList.length !== parts.length) {
          json(res, { errno: 2 });
          return;
        }
        for (let i = 0; i < parts.length; i++) {
          if (blockList[i] !== createHash('md5').update(parts[i] as Buffer).digest('hex')) {
            json(res, { errno: 2 });
            return;
          }
        }
        if (!nodes.has(parentOf(path))) {
          json(res, { errno: -11 });
          return;
        }
        seedFile(path, content);
        const control =
          blockList.length === 1
            ? (blockList[0] as string)
            : createHash('md5').update(JSON.stringify(blockList)).digest('hex');
        lastControlMd5 = control;
        json(res, {
          errno: 0,
          md5: encodeMd5(control),
          size: content.byteLength,
          filename: baseName(path),
        });
        uploads.delete(upload.id);
        return;
      }

      if (pathname === '/api/filemanager' && method === 'POST') {
        const opera = url.searchParams.get('opera') ?? '';
        const fields = formFields(await readRaw(req));
        let filelist: unknown = [];
        try {
          filelist = JSON.parse(fields.filelist ?? '[]');
        } catch {
          filelist = [];
        }
        const items = Array.isArray(filelist) ? filelist : [];
        const isCopy = opera === 'copy';

        if (opera === 'delete') {
          const missing: Array<{ errno: number; path: string }> = [];
          for (const entry of items) {
            const path = normalizePath(typeof entry === 'string' ? entry : String((entry as { path?: string }).path ?? ''));
            if (path === '/') continue;
            if (!nodes.has(path)) {
              missing.push({ errno: -9, path });
              continue;
            }
            removeTree(path);
          }
          json(res, { errno: 0, taskid: 0, info: missing });
          return;
        }

        if (opera !== 'rename' && opera !== 'move' && !isCopy) {
          json(res, { errno: 15 });
          return;
        }

        // `onnest=fail`: every bad entry is reported per item, nothing runs.
        const errors: Array<{ errno: number; path: string }> = [];
        const pending: Array<{ source: string; target: string }> = [];
        for (const raw of items) {
          const entry = (raw ?? {}) as { path?: string; dest?: string; newname?: string };
          const source = normalizePath(entry.path);
          const node = nodes.get(source);
          if (!node) {
            errors.push({ errno: -9, path: source });
            continue;
          }
          const dest = normalizePath(entry.dest ?? parentOf(source));
          const destNode = nodes.get(dest);
          if (!destNode || !destNode.isdir) {
            errors.push({ errno: -11, path: dest });
            continue;
          }
          const name = entry.newname && entry.newname !== '' ? entry.newname : baseName(source);
          const target = normalizePath(`${dest === '/' ? '' : dest}/${name}`);
          if (target !== source && nodes.has(target)) {
            errors.push({ errno: -8, path: target });
            continue;
          }
          pending.push({ source, target });
        }
        if (errors.length > 0) {
          json(res, { errno: 0, taskid: 0, info: errors });
          return;
        }
        for (const { source, target } of pending) {
          if (isCopy) copyTree(source, target);
          else moveTree(source, target);
        }

        json(res, isCopy ? { errno: 0, taskid: 7, info: [] } : { errno: 0, taskid: 0, info: [] });
        return;
      }

      if (pathname === '/share/taskquery') {
        json(res, { errno: 0, status: 'success', list: [{ error_code: 0 }] });
        return;
      }

      const downloadMatch = /^\/dl\/(\d+)$/.exec(pathname);
      if (downloadMatch) {
        downloadCalls += 1;
        downloadCookies.push(req.headers.cookie ?? null);
        const node = nodes.get(byId.get(Number(downloadMatch[1])) ?? '');
        if (!node) {
          res.writeHead(404, { 'content-length': 0 });
          res.end();
          return;
        }
        const content = node.content;
        const rangeHeader = req.headers.range;
        if (typeof rangeHeader === 'string') {
          const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
          if (match) {
            const start = Number(match[1]);
            const end = match[2] === '' ? content.byteLength - 1 : Math.min(Number(match[2]), content.byteLength - 1);
            if (start >= content.byteLength) {
              res.writeHead(416, { 'content-range': `bytes */${content.byteLength}`, 'content-length': 0 });
              res.end();
              return;
            }
            const slice = content.subarray(start, end + 1);
            res.writeHead(206, {
              'content-type': 'application/octet-stream',
              'content-length': slice.byteLength,
              'content-range': `bytes ${start}-${end}/${content.byteLength}`,
              'accept-ranges': 'bytes',
            });
            res.end(slice);
            return;
          }
        }
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': content.byteLength,
          'accept-ranges': 'bytes',
        });
        res.end(content);
        return;
      }

      json(res, { errno: 15 });
    })().catch(() => {
      if (!res.headersSent) sendJson(res, { errno: 15 });
      else res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  origin = `http://127.0.0.1:${port}`;

  return {
    origin,
    requests,
    tokenRequests,
    downloadCookies,
    get uploadChunkCalls() {
      return uploadChunkCalls;
    },
    get downloadCalls() {
      return downloadCalls;
    },
    get lastControlMd5() {
      return lastControlMd5;
    },
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
    seedFolder,
    seedFile,
    readFile: (path: string) => {
      const node = nodes.get(normalizePath(path));
      if (!node) throw new Error(`fake TeraBox has no node at ${path}`);
      return node.content;
    },
    has: (path: string) => nodes.has(normalizePath(path)),
    nodeCount: () => nodes.size,
    failNext: (endpoint: string, spec: number | FakeTeraBoxFailure) => {
      const entry = typeof spec === 'number' ? { errno: spec } : spec;
      const queue = failures.get(endpoint) ?? [];
      queue.push(entry);
      failures.set(endpoint, queue);
    },
    corruptNextChunkMd5: () => {
      corruptNextChunk = true;
    },
    omitDlink: (path: string) => {
      noDlink.add(normalizePath(path));
    },
  };
}

export interface FakeContextOverrides extends FakeTeraBoxOptions {
  apiKey?: string;
  signal?: AbortSignal;
  config?: Record<string, unknown>;
  logger?: ProviderContext['logger'];
}

export function makeContext(overrides: FakeContextOverrides = {}): ProviderContext {
  return {
    credentials: {
      kind: 'api_key',
      apiKey: overrides.apiKey ?? 'ndus=valid-cookie',
    },
    account: {
      id: 'account-terabox-1',
      userId: 'user-1',
      provider: 'terabox',
      providerAccountId: '987654321',
      displayName: null,
      config: overrides.config ?? {},
    },
    signal: overrides.signal,
    logger: overrides.logger ?? (() => undefined),
  };
}

export async function withFakeTeraBox(
  options: FakeContextOverrides = {},
  run: (server: FakeTeraBoxServer, ctx: ProviderContext) => Promise<void>,
): Promise<void> {
  enableLocalEndpoint();
  const server = await startFakeTeraBox(options);
  setTeraBoxTransport({ baseUrl: server.origin, uploadHost: server.origin });
  try {
    await run(server, makeContext(options));
  } finally {
    await server.close();
    resetTeraBoxTransport();
    restoreEndpointEnv();
  }
}

export async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
  }
  return Buffer.concat(chunks);
}

export function textStream(content: string | Buffer): NodeJS.ReadableStream {
  return Readable.from([typeof content === 'string' ? Buffer.from(content, 'utf8') : content]);
}

export async function expectProviderCode(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.then(
    () => {
      throw new Error(`expected the operation to reject with ${code}, but it resolved`);
    },
    (err: unknown) => err,
  );
  if (!ProviderError.is(error)) {
    throw new Error(`expected a ProviderError, received: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (error.code !== code) {
    throw new Error(`expected provider code ${code}, received ${error.code}: ${error.message}`);
  }
}
