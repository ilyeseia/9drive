/**
 * In-process fake of the official TeraBox Open Platform used by the adapter tests.
 *
 * It follows the contract printed in the official document
 * (docs/terabox-integration-assessment.md §2): signed `/oauth/*` calls, single-use
 * refresh tokens, per-user `api_domain`/`upload_domain`, `access_tokens` query
 * parameter, precreate → superfile2 shards → create uploads with `rtype`, the
 * `filemanager` verbs, and a dlink that needs `access_tokens` appended.
 * Nothing here has been verified against the live service.
 */

import Busboy from 'busboy';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { ProviderError } from '../../../providers/errors.js';
import { resetTeraBoxOpenTransport, setTeraBoxOpenTransport } from '../../../providers/terabox-open/transport.js';
import type { ProviderContext } from '../../../providers/types.js';
import { clearTokenInfoCache } from '../../../providers/terabox-open/client.js';

export const TEST_APP = { clientId: 'test-client-id', clientSecret: 'test-client-secret', privateSecret: 'test-private-secret' };

export interface FakeFailure {
  errno?: number;
  status?: number;
  body?: unknown;
  hang?: boolean;
}

interface FakeNode {
  path: string;
  isDir: boolean;
  content: Buffer;
  fsId: number;
  mtime: number;
}

interface UploadSession {
  path: string;
  blockList: string[];
  shards: Map<number, Buffer>;
}

export interface FakeTeraBoxOptions {
  /** Domain strings returned by /oauth/tokeninfo (default: this server). */
  apiDomain?: string;
  uploadDomain?: string | null;
  /** Namespace root enforced on wire paths (e.g. "/From: Other Applications/9drive-250528"). */
  appRoot?: string;
  userId?: number;
  /** precreate answers return_type 2 for paths that already exist. */
  dedupeExisting?: boolean;
}

export interface FakeTeraBoxServer {
  origin: string;
  host: string;
  requests: Array<{ method: string; path: string; query: Record<string, string>; form: Record<string, string> }>;
  tokens: { access: string; refresh: string };
  close(): Promise<void>;
  authorizeDevice(): void;
  seedFile(path: string, content: Buffer | string): number;
  seedDir(path: string): void;
  readFile(path: string): Buffer | null;
  paths(): string[];
  failNext(endpoint: string, spec: FakeFailure): void;
  corruptNextShard(): void;
  expireAccessToken(): void;
  counts: { refresh: number; gettoken: number; tokeninfo: number; shards: number; creates: number };
  setQuota(total: number, used: number): void;
}

function md5(input: Buffer | string): string {
  return createHash('md5').update(input).digest('hex');
}

function expectedSign(timestamp: string, clientId: string, clientSecret: string): string {
  return md5(`${clientId}_${timestamp}_${clientSecret}_${TEST_APP.privateSecret}`);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function parseMultipart(req: IncomingMessage, body: Buffer): Promise<{ fields: Record<string, string>; file: Buffer | null }> {
  return new Promise((resolve, reject) => {
    const fields: Record<string, string> = {};
    let file: Buffer | null = null;
    const bb = Busboy({ headers: req.headers });
    bb.on('field', (name, value) => {
      fields[name] = value;
    });
    bb.on('file', (_name, stream) => {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        file = Buffer.concat(chunks);
      });
    });
    bb.on('close', () => resolve({ fields, file }));
    bb.on('error', reject);
    Readable.from([body]).pipe(bb);
  });
}

export async function startFakeTeraBox(options: FakeTeraBoxOptions = {}): Promise<FakeTeraBoxServer> {
  const files = new Map<string, FakeNode>();
  const sessions = new Map<string, UploadSession>();
  const failures = new Map<string, FakeFailure[]>();
  const requests: FakeTeraBoxServer['requests'] = [];
  const counts = { refresh: 0, gettoken: 0, tokeninfo: 0, shards: 0, creates: 0 };
  let seq = 0;
  let nextFsId = 900_000_000_000_000;
  let deviceAuthorized = false;
  let corruptShard = false;
  let quota = { total: 1_000_000_000, used: 250_000_000 };
  const root = options.appRoot ?? '';
  const userId = options.userId ?? 127813130;

  const tokens = { access: 'access-0', refresh: 'refresh-0' };
  const validAccess = new Set<string>();
  const validRefresh = new Set<string>();
  const issue = () => {
    seq += 1;
    tokens.access = `access-${seq}`;
    tokens.refresh = `refresh-${seq}`;
    validAccess.add(tokens.access);
    validRefresh.add(tokens.refresh);
  };

  let server: Server;
  let origin = '';
  let host = '';

  const rel = (wire: string): string | null => {
    const clean = `/${wire.split('/').filter(Boolean).join('/')}`;
    if (root === '') return clean;
    if (clean === root) return '/';
    if (clean.startsWith(`${root}/`)) return clean.slice(root.length);
    return null;
  };
  const wireOf = (relative: string) => (root === '' ? relative : relative === '/' ? root : `${root}${relative}`);

  const json = (res: ServerResponse, payload: unknown, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  };
  const entryOf = (node: FakeNode) => ({
    category: 6,
    fs_id: node.fsId,
    isdir: node.isDir ? 1 : 0,
    md5: node.isDir ? undefined : md5(node.content),
    path: wireOf(node.path),
    server_filename: node.path.split('/').pop(),
    size: node.isDir ? 0 : node.content.length,
    server_ctime: node.mtime,
    server_mtime: node.mtime,
    local_ctime: node.mtime,
    local_mtime: node.mtime,
  });
  const put = (path: string, content: Buffer, isDir = false): FakeNode => {
    const existing = files.get(path);
    const node: FakeNode = { path, isDir, content, fsId: existing?.fsId ?? nextFsId++, mtime: 1_700_000_000 + seq };
    files.set(path, node);
    return node;
  };
  const uniquePath = (path: string): string => {
    if (!files.has(path)) return path;
    const dot = path.lastIndexOf('.');
    const slash = path.lastIndexOf('/');
    const base = dot > slash ? path.slice(0, dot) : path;
    const ext = dot > slash ? path.slice(dot) : '';
    for (let i = 1; ; i++) {
      const candidate = `${base}(${i})${ext}`;
      if (!files.has(candidate)) return candidate;
    }
  };

  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    const query: Record<string, string> = {};
    url.searchParams.forEach((value, key) => {
      query[key] = value;
    });
    const path = url.pathname;
    const raw = req.method === 'POST' ? await readBody(req) : Buffer.alloc(0);
    const contentType = String(req.headers['content-type'] ?? '');
    let form: Record<string, string> = {};
    let shard: Buffer | null = null;
    if (contentType.startsWith('multipart/form-data')) {
      const parsed = await parseMultipart(req, raw);
      form = parsed.fields;
      shard = parsed.file;
    } else if (raw.length > 0) {
      form = Object.fromEntries(new URLSearchParams(raw.toString('utf8')));
    }
    requests.push({ method: req.method ?? 'GET', path, query, form });

    const injected = failures.get(path)?.shift();
    if (injected) {
      if (injected.hang) return;
      if (injected.status) return json(res, injected.body ?? {}, injected.status);
      return json(res, injected.body ?? { errno: injected.errno ?? 500001 });
    }

    const signOk = () =>
      form.client_id === TEST_APP.clientId &&
      form.client_secret === TEST_APP.clientSecret &&
      form.sign === expectedSign(form.timestamp ?? '', form.client_id ?? '', form.client_secret ?? '');
    const authed = () => validAccess.has(query.access_tokens ?? '');
    const bad = (res2: ServerResponse) => json(res2, { errno: 200003, show_msg: 'token expired' });

    // ---- OAuth -------------------------------------------------------------------------
    if (path === '/oauth/devicecode') {
      if (query.client_id !== TEST_APP.clientId) return json(res, { errno: 100001 });
      return json(res, {
        errno: 0,
        data: {
          device_code: 'device-code-1',
          expires_in: 300,
          interval: 2,
          qrcode_url: `data:image/png;base64,${Buffer.from('fake-png').toString('base64')}`,
          user_code: '',
          verification_url: '',
        },
      });
    }
    if (path === '/oauth/gettoken') {
      counts.gettoken += 1;
      if (!signOk()) return json(res, { errno: 100001 });
      if (form.grant_type === 'device_code') {
        if (form.code !== 'device-code-1') return json(res, { errno: 100002 });
        if (!deviceAuthorized) return json(res, { errno: 400001 });
        deviceAuthorized = false;
        issue();
        return json(res, { errno: 0, data: { access_token: tokens.access, refresh_token: tokens.refresh, expires_in: 172800 } });
      }
      return json(res, { errno: 200001 });
    }
    if (path === '/oauth/refreshtoken') {
      counts.refresh += 1;
      if (!signOk()) return json(res, { errno: 100001 });
      if (!validRefresh.has(form.refresh_token ?? '')) return json(res, { errno: 200004 });
      validRefresh.delete(form.refresh_token ?? '');
      const previous = tokens.access;
      issue();
      // The old access token dies shortly after a successful refresh (doc: 15 s); instant here.
      validAccess.delete(previous);
      return json(res, { errno: 0, data: { access_token: tokens.access, refresh_token: tokens.refresh, expires_in: 172800 } });
    }
    if (path === '/oauth/tokeninfo') {
      counts.tokeninfo += 1;
      if (!validAccess.has(form.access_token ?? '')) return json(res, { errno: 200002 });
      const data: Record<string, unknown> = {
        client_id: TEST_APP.clientId,
        api_domain: options.apiDomain ?? host,
        create_time: 1_700_000_000,
        expires_in: 172800,
        user_id: userId,
      };
      if (options.uploadDomain !== null) data.upload_domain = options.uploadDomain ?? host;
      return json(res, { errno: 0, data });
    }

    // ---- Download (CDN-style link) ---------------------------------------------------
    if (path.startsWith('/dl/')) {
      if (!authed()) return json(res, { errno: 200003 }, 403);
      const node = [...files.values()].find((n) => String(n.fsId) === path.slice(4));
      if (!node) return json(res, {}, 404);
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(node.content.length) });
      return res.end(node.content);
    }

    // ---- Open API ----------------------------------------------------------------------
    if (path.startsWith('/openapi/') || path.startsWith('/rest/2.0/pcs/')) {
      if (!authed()) return bad(res);
    }
    if (path === '/openapi/uinfo') {
      return json(res, { errno: 0, uname: 'tester@example.com', avatar_url: 'https://example.invalid/a.png', vip_type: 0, uk: 4401178462138 });
    }
    if (path === '/openapi/api/quota') return json(res, { errno: 0, total: quota.total, used: quota.used });

    if (path === '/openapi/api/list') {
      const dir = rel(query.dir ?? '/');
      if (dir === null) return json(res, { errno: -7 });
      const prefix = dir === '/' ? '/' : `${dir}/`;
      const children = [...files.values()]
        .filter((n) => n.path.startsWith(prefix) && !n.path.slice(prefix.length).includes('/') && n.path !== dir)
        .sort((a, b) => a.path.localeCompare(b.path));
      const page = Number(query.page ?? 1);
      const num = Number(query.num ?? 100);
      return json(res, { errno: 0, list: children.slice((page - 1) * num, page * num).map(entryOf) });
    }
    if (path === '/openapi/api/search') {
      const hits = [...files.values()].filter((n) => n.path.toLowerCase().includes((query.key ?? '').toLowerCase()));
      const page = Number(query.page ?? 1);
      const num = Number(query.num ?? 100);
      const slice = hits.slice((page - 1) * num, page * num);
      return json(res, { errno: 0, list: slice.map(entryOf), has_more: page * num < hits.length ? 1 : 0 });
    }
    if (path === '/openapi/api/filemetas') {
      const targets = JSON.parse(query.target ?? '[]') as string[];
      const info = targets.map((wire) => {
        const r = rel(wire);
        const node = r === null ? undefined : files.get(r);
        return node ? { errno: 0, ...entryOf(node) } : { errno: -9, path: wire };
      });
      return json(res, { errno: 0, info });
    }
    if (path === '/openapi/api/download') {
      const ids = JSON.parse(query.fidlist ?? '[]') as number[];
      const link = (id: number) => (options.apiDomain === 'evil.example.com' ? `https://evil.example.com/dl/${id}` : `${origin}/dl/${id}`);
      return json(res, { errno: 0, dlink: ids.map((id) => ({ fs_id: String(id), dlink: link(id) })) });
    }

    if (path === '/openapi/api/precreate') {
      const wire = rel(form.path ?? '');
      if (wire === null || form.autoinit !== '1') return json(res, { errno: -7 });
      const blockList = JSON.parse(form.block_list ?? '[]') as string[];
      const existing = files.get(wire);
      if (options.dedupeExisting && existing) {
        return json(res, { errno: 0, return_type: 2, info: { ...entryOf(existing) } });
      }
      seq += 1;
      const uploadid = `upload-${seq}`;
      sessions.set(uploadid, { path: wire, blockList, shards: new Map() });
      return json(res, { errno: 0, return_type: 1, path: form.path, uploadid, block_list: blockList.map((_, i) => i) });
    }
    if (path === '/rest/2.0/pcs/superfile2') {
      const session = sessions.get(query.uploadid ?? '');
      if (!session || query.method !== 'upload' || query.app_id !== '250528' || shard === null) return json(res, { errno: -7 });
      counts.shards += 1;
      const index = Number(query.partseq);
      session.shards.set(index, shard);
      let echoed = md5(shard);
      if (corruptShard) {
        corruptShard = false;
        echoed = 'f'.repeat(32);
      }
      return json(res, { md5: echoed, partseq: index, uploadid: query.uploadid });
    }
    if (path === '/openapi/api/create') {
      const session = sessions.get(form.uploadid ?? '');
      const wire = rel(form.path ?? '');
      if (!session || wire === null) return json(res, { errno: -7 });
      const blockList = JSON.parse(form.block_list ?? '[]') as string[];
      if (JSON.stringify(blockList) !== JSON.stringify(session.blockList)) return json(res, { errno: -7 });
      const ordered: Buffer[] = [];
      for (let i = 0; i < blockList.length; i++) {
        const part = session.shards.get(i);
        if (!part || md5(part) !== blockList[i]) return json(res, { errno: -7 });
        ordered.push(part);
      }
      const content = Buffer.concat(ordered);
      if (content.length !== Number(form.size)) return json(res, { errno: -7 });
      let target = wire;
      if (files.has(wire)) {
        if (form.rtype === '0') return json(res, { errno: -8 });
        if (form.rtype === '1') target = uniquePath(wire);
      }
      counts.creates += 1;
      sessions.delete(form.uploadid ?? '');
      const node = put(target, content);
      return json(res, { errno: 0, ...entryOf(node), name: wireOf(target) });
    }
    if (path === '/openapi/api/filemanager') {
      const list = JSON.parse(form.filelist ?? '[]') as Array<string | { path: string; dest?: string; newname?: string }>;
      const info: Array<{ errno: number; path: string }> = [];
      for (const item of list) {
        const wire = typeof item === 'string' ? item : item.path;
        const source = rel(wire);
        const node = source === null ? undefined : files.get(source);
        if (!node || source === null) {
          info.push({ errno: -9, path: wire });
          continue;
        }
        const affected = [...files.values()].filter((n) => n.path === source || n.path.startsWith(`${source}/`));
        if (query.opera === 'delete') {
          for (const n of affected) files.delete(n.path);
        } else {
          const obj = item as { dest?: string; newname?: string };
          const name = obj.newname ?? source.split('/').pop() ?? '';
          const destDir = query.opera === 'rename' ? source.slice(0, source.lastIndexOf('/')) || '/' : rel(obj.dest ?? '/') ?? '/';
          const target = destDir === '/' ? `/${name}` : `${destDir}/${name}`;
          if (target !== source && files.has(target)) {
            info.push({ errno: -8, path: wire });
            continue;
          }
          for (const n of affected) {
            const moved = target + n.path.slice(source.length);
            if (query.opera === 'copy') put(moved, n.content, n.isDir);
            else {
              files.delete(n.path);
              files.set(moved, { ...n, path: moved });
            }
          }
        }
        info.push({ errno: 0, path: wire });
      }
      return json(res, { errno: 0, info, request_id: 1 });
    }

    return json(res, { errno: -1, show_msg: `unhandled ${path}` }, 404);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake server failed to bind');
  host = `127.0.0.1:${address.port}`;
  origin = `http://${host}`;
  issue();

  return {
    origin,
    host,
    requests,
    tokens,
    counts,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    authorizeDevice() {
      deviceAuthorized = true;
    },
    seedFile(path, content) {
      return put(path, Buffer.isBuffer(content) ? content : Buffer.from(content)).fsId;
    },
    seedDir(path) {
      put(path, Buffer.alloc(0), true);
    },
    readFile: (path) => files.get(path)?.content ?? null,
    paths: () => [...files.keys()].sort(),
    failNext(endpoint, spec) {
      failures.set(endpoint, [...(failures.get(endpoint) ?? []), spec]);
    },
    corruptNextShard() {
      corruptShard = true;
    },
    expireAccessToken() {
      validAccess.delete(tokens.access);
    },
    setQuota(total, used) {
      quota = { total, used };
    },
  };
}

let contextSeq = 0;

export function makeContext(server: FakeTeraBoxServer, overrides: { accessToken?: string; signal?: AbortSignal } = {}): ProviderContext {
  contextSeq += 1;
  return {
    credentials: { kind: 'oauth2', accessToken: overrides.accessToken ?? server.tokens.access, refreshToken: server.tokens.refresh, expiresAt: Date.now() + 3_600_000 },
    account: { id: `account-${contextSeq}`, userId: 'user-1', provider: 'terabox_open', providerAccountId: '127813130', displayName: null, config: {} },
    signal: overrides.signal,
    logger: () => undefined,
  };
}

const SAVED_ENV: Record<string, string | undefined> = {};

export function enableLocalEndpoint(): void {
  for (const name of ['ALLOW_INSECURE_ENDPOINTS', 'SSRF_ALLOWLIST', 'TERABOX_PRIVATE_SECRET', 'TERABOX_APP_ROOT', 'TERABOX_UPLOAD_CONCURRENCY']) {
    SAVED_ENV[name] = process.env[name];
  }
  process.env.ALLOW_INSECURE_ENDPOINTS = 'true';
  process.env.SSRF_ALLOWLIST = '127.0.0.1';
  process.env.TERABOX_PRIVATE_SECRET = TEST_APP.privateSecret;
  delete process.env.TERABOX_APP_ROOT;
}

export function restoreEndpointEnv(): void {
  for (const [name, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

export async function withFakeTeraBox(
  options: FakeTeraBoxOptions,
  run: (server: FakeTeraBoxServer) => Promise<void>,
): Promise<void> {
  enableLocalEndpoint();
  clearTokenInfoCache();
  const server = await startFakeTeraBox(options);
  setTeraBoxOpenTransport({ authBase: server.origin, hostPolicy: 'any', scheme: 'http' });
  try {
    await run(server);
  } finally {
    await server.close();
    resetTeraBoxOpenTransport();
    clearTokenInfoCache();
    restoreEndpointEnv();
  }
}

export function bufferStream(content: Buffer | string): NodeJS.ReadableStream {
  return Readable.from([Buffer.isBuffer(content) ? content : Buffer.from(content)]);
}

export async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
  }
  return Buffer.concat(chunks);
}

export async function expectProviderCode(promise: Promise<unknown>, code: string): Promise<ProviderError> {
  try {
    await promise;
  } catch (error) {
    if (!ProviderError.is(error)) throw error;
    if (error.code !== code) throw new Error(`expected ${code} but got ${error.code}: ${error.message}`);
    return error;
  }
  throw new Error(`expected ${code} but the call succeeded`);
}
