/**
 * In-process fake of the Dropbox HTTP API used by the adapter tests.
 *
 * It speaks the same envelopes as the real service (JSON-RPC under `/2`,
 * `Dropbox-API-Arg` headers on content endpoints, `error.error_summary`
 * errors, upload sessions, cursor pagination, temporary links with Range
 * support) so the tests exercise the adapter's real request building.
 */

import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { ProviderError } from '../../../providers/errors.js';
import { resetDropboxTransport, setDropboxTransport } from '../../../providers/dropbox/transport.js';
import type { ProviderContext } from '../../../providers/types.js';

export interface FakeFailure {
  status: number;
  summary: string;
  /** Keep the connection open instead of answering (timeout/abort scenarios). */
  hang?: boolean;
}

export interface FakeSpaceUsage {
  used?: number | string | null;
  allocated?: number | string | null;
}

interface FakeNode {
  id: string;
  name: string;
  parentId: string | null;
  isFolder: boolean;
  content: Buffer;
  mimeType: string;
  createdAt: string;
  modifiedAt: string;
  share: { url: string; expires: string | null } | null;
}

interface FakeSession {
  data: Buffer[];
  offset: number;
}

export interface FakeDropboxServer {
  origin: string;
  apiUrl: string;
  contentUrl: string;
  tokenUrl: string;
  requests: string[];
  auths: string[];
  tokenRequests: Record<string, unknown>[];
  close(): Promise<void>;
  seedFolder(name: string, parentId?: string | null): string;
  seedFile(name: string, parentId: string | null, content: Buffer | string, mimeType?: string): string;
  readFile(id: string): Buffer;
  nodeCount(): number;
  shareCount(): number;
  failNext(endpoint: string, spec: FakeFailure): void;
  overrideTemporaryLink(ref: string, url: string): void;
  ignoreRange(ref: string): void;
  sessionCalls(): { start: number; append: number; finish: number };
}

interface ResolvedRef {
  kind: 'root' | 'node' | 'missing';
  node?: FakeNode;
}

function now(): string {
  return new Date().toISOString();
}

async function readRaw(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readRaw(req);
  if (raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw.toString('utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload ?? {});
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, summary: string, tag = 'generic'): void {
  sendJson(res, status, { error: { '.tag': tag, error_summary: summary } });
}

export async function startFakeDropbox(
  options: { token?: string; spaceUsage?: FakeSpaceUsage } = {},
): Promise<FakeDropboxServer> {
  const token = options.token ?? 'test-token';
  const spaceUsage = {
    used: options.spaceUsage?.used ?? 1_099_511_627_776,
    allocated:
      options.spaceUsage && 'allocated' in options.spaceUsage ? options.spaceUsage.allocated : 2_199_023_255_552,
  };
  const acceptedTokens = new Set([token, 'test-token-2']);
  const nodes = new Map<string, FakeNode>();
  const sessions = new Map<string, FakeSession>();
  const overrides = new Map<string, string>();
  const noRange = new Set<string>();
  const failures: { endpoint: string; spec: FakeFailure }[] = [];
  const requests: string[] = [];
  const auths: string[] = [];
  const tokenRequests: Record<string, unknown>[] = [];
  const calls = { start: 0, append: 0, finish: 0 };
  let idSeq = 0;
  let sessionSeq = 0;

  const pathOf = (node: FakeNode): string => {
    const parts: string[] = [node.name];
    let cursor = node.parentId;
    while (cursor !== null) {
      const parent = nodes.get(cursor);
      if (!parent) break;
      parts.unshift(parent.name);
      cursor = parent.parentId;
    }
    return `/${parts.join('/')}`;
  };

  const childrenOf = (parentId: string | null): FakeNode[] =>
    [...nodes.values()]
      .filter((node) => node.parentId === parentId)
      .sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0));

  const resolve = (ref: string): ResolvedRef => {
    if (ref === '' || ref === '/') return { kind: 'root' };
    if (ref.startsWith('id:')) {
      const node = nodes.get(ref);
      return node ? { kind: 'node', node } : { kind: 'missing' };
    }
    const parts = ref.split('/').filter((part) => part.length > 0);
    let current: FakeNode | null = null;
    let parentId: string | null = null;
    for (const part of parts) {
      const found: FakeNode | undefined = childrenOf(parentId).find((node) => node.name.toLowerCase() === part.toLowerCase());
      if (!found) return { kind: 'missing' };
      current = found;
      parentId = found.id;
    }
    return current ? { kind: 'node', node: current } : { kind: 'root' };
  };

  const metaOf = (node: FakeNode): Record<string, unknown> => {
    const path = pathOf(node);
    const base: Record<string, unknown> = {
      '.tag': node.isFolder ? 'folder' : 'file',
      name: node.name,
      id: node.id,
      path_lower: path.toLowerCase(),
      path_display: path,
    };
    if (node.isFolder) return base;
    return {
      ...base,
      size: node.content.byteLength,
      rev: `rev-${node.id}`,
      content_hash: createHash('sha256').update(node.content).digest('hex'),
      client_modified: node.createdAt,
      server_modified: node.modifiedAt,
    };
  };

  const createNode = (input: {
    name: string;
    parentId: string | null;
    isFolder: boolean;
    content?: Buffer;
    mimeType?: string;
  }): FakeNode => {
    idSeq += 1;
    const stamp = now();
    const node: FakeNode = {
      id: `id:node${String(idSeq).padStart(4, '0')}`,
      name: input.name,
      parentId: input.parentId,
      isFolder: input.isFolder,
      content: input.content ?? Buffer.alloc(0),
      mimeType: input.mimeType ?? 'application/octet-stream',
      createdAt: stamp,
      modifiedAt: stamp,
      share: null,
    };
    nodes.set(node.id, node);
    return node;
  };

  const removeSubtree = (node: FakeNode): void => {
    for (const child of [...nodes.values()].filter((candidate) => candidate.parentId === node.id)) {
      removeSubtree(child);
    }
    nodes.delete(node.id);
  };

  /** Split '/a/b/c' into parent ref and file name. */
  const splitPath = (path: string): { parent: ResolvedRef; name: string } => {
    const trimmed = path.endsWith('/') && path.length > 1 ? path.slice(0, -1) : path;
    const index = trimmed.lastIndexOf('/');
    if (index < 0) return { parent: { kind: 'root' }, name: trimmed };
    const parentRef = trimmed.slice(0, index);
    return { parent: resolve(parentRef === '' ? '/' : parentRef), name: trimmed.slice(index + 1) };
  };

  const findChild = (parent: FakeNode | null, name: string): FakeNode | undefined =>
    childrenOf(parent ? parent.id : null).find((node) => node.name.toLowerCase() === name.toLowerCase());

  const writeAtPath = (
    path: string,
    content: Buffer,
    mode: string,
    mimeType: string,
  ): FakeNode | { fail: 'conflict' | 'not_found' } => {
    const { parent, name } = splitPath(path);
    if (parent.kind === 'missing') return { fail: 'not_found' };
    const parentNode = parent.kind === 'node' ? (parent.node as FakeNode) : null;
    if (parentNode && !parentNode.isFolder) return { fail: 'not_found' };
    const existing = findChild(parentNode, name);
    if (existing && mode !== 'overwrite') return { fail: 'conflict' };
    if (existing) {
      existing.content = content;
      existing.mimeType = mimeType;
      existing.modifiedAt = now();
      return existing;
    }
    return createNode({ name, parentId: parentNode ? parentNode.id : null, isFolder: false, content, mimeType });
  };

  const takeFailure = (path: string): FakeFailure | null => {
    const index = failures.findIndex((entry) => path.includes(entry.endpoint));
    if (index === -1) return null;
    const [failure] = failures.splice(index, 1);
    return failure.spec;
  };

  const storeUploadBody = (
    req: IncomingMessage,
    raw: Buffer,
    arg: Record<string, unknown>,
  ): Record<string, unknown> | { fail: 'conflict' | 'not_found' } => {
    const path = typeof arg.path === 'string' ? arg.path : '';
    const mode = typeof arg.mode === 'string' ? arg.mode : 'add';
    const stored = writeAtPath(path, raw, mode, req.headers['content-type'] ?? 'application/octet-stream');
    if ('fail' in stored) return stored;
    return metaOf(stored);
  };

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    requests.push(path);

    void (async () => {
      const failure = takeFailure(path);
      if (failure) {
        if (failure.hang) return;
        sendError(res, failure.status, failure.summary);
        return;
      }

      if (req.method === 'GET' && path.startsWith('/download/')) {
        handleDownload(req, res, path);
        return;
      }

      const raw = await readRaw(req);

      if (req.method === 'POST' && path === '/oauth2/token') {
        const params = new URLSearchParams(raw.toString('utf8'));
        tokenRequests.push(Object.fromEntries(params));
        const body = JSON.stringify({ access_token: 'test-token-2', expires_in: 3600, refresh_token: 'refresh-token-2' });
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
        res.end(body);
        return;
      }

      const authorization = req.headers.authorization ?? '';
      auths.push(authorization);
      if (!acceptedTokens.has(authorization.replace(/^Bearer /, ''))) {
        sendError(res, 401, 'expired_access_token/.', 'expired_access_token');
        return;
      }

      const endpoint = path.replace(/^\/2\//, '');

      switch (endpoint) {
        case 'users/get_current_account': {
          sendJson(res, 200, {
            account_id: 'dbid:FAKEACCOUNT',
            name: { display_name: 'Fake Dropbox User', familiar_name: 'Fake', given_name: 'Fake', surname: 'User', abbreviated_name: 'FU' },
            email: 'fake@dropbox.example',
            email_verified: true,
            disabled: false,
            profile_photo_url: 'https://dl-web.dropbox.com/account_photo/fake',
            locale: 'en',
            country: 'US',
            referral_link: 'https://db.tt/fake',
            is_paired: false,
            account_type: { '.tag': 'basic' },
            root_info: { '.tag': 'user', root_namespace_id: '1', home_namespace_id: '1' },
          });
          return;
        }
        case 'users/get_space_usage': {
          sendJson(res, 200, {
            used: spaceUsage.used,
            allocation: { '.tag': 'individual', individual: { allocated: spaceUsage.allocated } },
          });
          return;
        }
        case 'files/get_metadata': {
          const body = JSON.parse(raw.toString('utf8') || '{}') as { path?: string };
          const ref = typeof body.path === 'string' ? body.path : '';
          if (ref === '') {
            // The real API refuses to describe the root folder.
            sendError(res, 400, 'path/malformed_write_arg/.', 'path');
            return;
          }
          const resolved = resolve(ref);
          if (resolved.kind === 'missing') {
            sendError(res, 409, 'path/not_found/.', 'path');
            return;
          }
          sendJson(res, 200, resolved.kind === 'root' ? { '.tag': 'folder', name: '', id: 'id:root' } : metaOf(resolved.node!));
          return;
        }
        case 'files/list_folder':
        case 'files/list_folder/continue': {
          const body = JSON.parse(raw.toString('utf8') || '{}') as { path?: string; cursor?: string; limit?: number };
          let folder: ResolvedRef;
          let offset = 0;
          if (endpoint === 'files/list_folder') {
            folder = resolve(typeof body.path === 'string' ? body.path : '');
          } else {
            try {
              const decoded = JSON.parse(Buffer.from(String(body.cursor ?? ''), 'base64url').toString('utf8')) as {
                id: string;
                o: number;
              };
              folder = decoded.id === '__root__' ? { kind: 'root' } : resolve(`id:${decoded.id}`);
              offset = decoded.o;
            } catch {
              sendError(res, 400, 'path/bad_cursor/.', 'path');
              return;
            }
          }
          if (folder.kind === 'missing') {
            sendError(res, 409, 'path/not_found/.', 'path');
            return;
          }
          if (folder.kind === 'node' && !folder.node!.isFolder) {
            sendError(res, 409, 'path/not_a_folder/.', 'path');
            return;
          }
          const children = childrenOf(folder.kind === 'node' ? folder.node!.id : null);
          const limit = Number.isInteger(body.limit) && (body.limit as number) > 0 ? Math.min(body.limit as number, 1000) : 100;
          const page = children.slice(offset, offset + limit);
          const nextOffset = offset + page.length;
          const hasMore = nextOffset < children.length;
          const folderId = folder.kind === 'node' ? folder.node!.id : '__root__';
          sendJson(res, 200, {
            entries: page.map(metaOf),
            cursor: Buffer.from(JSON.stringify({ id: folderId, o: nextOffset }), 'utf8').toString('base64url'),
            has_more: hasMore,
          });
          return;
        }
        case 'files/search_v2':
        case 'files/search/continue_v2': {
          const body = JSON.parse(raw.toString('utf8') || '{}') as {
            query?: string;
            options?: { max_results?: number };
            cursor?: string;
          };
          let query = '';
          let offset = 0;
          let max = 100;
          if (endpoint === 'files/search_v2') {
            query = typeof body.query === 'string' ? body.query : '';
            const requested = body.options?.max_results;
            max = Number.isInteger(requested) && (requested as number) > 0 ? Math.min(requested as number, 1000) : 100;
          } else {
            try {
              const decoded = JSON.parse(Buffer.from(String(body.cursor ?? ''), 'base64url').toString('utf8')) as {
                q: string;
                o: number;
                m: number;
              };
              query = decoded.q;
              offset = decoded.o;
              max = decoded.m;
            } catch {
              sendError(res, 400, 'path/bad_cursor/.', 'path');
              return;
            }
          }
          const term = query.toLowerCase();
          const matches = [...nodes.values()]
            .filter((node) => node.name.toLowerCase().includes(term))
            .sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0));
          const page = matches.slice(offset, offset + max);
          const nextOffset = offset + page.length;
          const hasMore = nextOffset < matches.length;
          sendJson(res, 200, {
            matches: page.map((node) => ({
              match_type: { '.tag': 'filename' },
              metadata: { metadata: metaOf(node), match_type: { '.tag': 'filename' } },
            })),
            cursor: hasMore
              ? Buffer.from(JSON.stringify({ q: query, o: nextOffset, m: max }), 'utf8').toString('base64url')
              : null,
            has_more: hasMore,
            approximate_total_hits: matches.length,
          });
          return;
        }
        case 'files/upload': {
          const arg = parseArg(req);
          const stored = storeUploadBody(req, raw, arg);
          if ('fail' in stored) {
            sendError(res, 409, stored.fail === 'conflict' ? 'path/conflict/file/.' : 'path/not_found/.', 'path');
            return;
          }
          sendJson(res, 200, stored);
          return;
        }
        case 'upload_session/start': {
          calls.start += 1;
          sessionSeq += 1;
          const sessionId = `sess-${sessionSeq}`;
          sessions.set(sessionId, { data: raw.length > 0 ? [raw] : [], offset: raw.byteLength });
          sendJson(res, 200, { session_id: sessionId, offset: raw.byteLength });
          return;
        }
        case 'upload_session/append_v2':
        case 'upload_session/finish': {
          const arg = parseArg(req);
          const cursor = (arg.cursor ?? {}) as { session_id?: string; offset?: number };
          const session = typeof cursor.session_id === 'string' ? sessions.get(cursor.session_id) : undefined;
          if (!session) {
            sendError(res, 409, 'upload_session/append_v2/not_found/.', 'upload_session');
            return;
          }
          if (cursor.offset !== session.offset) {
            sendError(res, 409, 'upload_session/append_v2/incorrect_offset/.', 'upload_session');
            return;
          }
          if (raw.length > 0) {
            session.data.push(raw);
            session.offset += raw.byteLength;
          }
          if (endpoint === 'upload_session/append_v2') {
            calls.append += 1;
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end('{}');
            return;
          }
          calls.finish += 1;
          const commit = (arg.commit ?? {}) as { path?: string; mode?: string };
          const content = Buffer.concat(session.data);
          const stored = writeAtPath(
            typeof commit.path === 'string' ? commit.path : '',
            content,
            typeof commit.mode === 'string' ? commit.mode : 'add',
            'application/octet-stream',
          );
          if ('fail' in stored) {
            sendError(res, 409, stored.fail === 'conflict' ? 'path/conflict/file/.' : 'path/not_found/.', 'path');
            return;
          }
          sendJson(res, 200, metaOf(stored));
          return;
        }
        case 'files/get_temporary_link': {
          const body = JSON.parse(raw.toString('utf8') || '{}') as { path?: string };
          const ref = typeof body.path === 'string' ? body.path : '';
          const resolved = resolve(ref);
          if (resolved.kind !== 'node') {
            sendError(res, 409, 'path/not_found/.', 'path');
            return;
          }
          const node = resolved.node!;
          if (node.isFolder) {
            sendError(res, 400, 'path/is_a_folder/.', 'path');
            return;
          }
          const override = overrides.get(ref) ?? overrides.get(node.id);
          sendJson(res, 200, { link: override ?? `${serverOrigin()}/download/${node.id}`, metadata: metaOf(node) });
          return;
        }
        case 'files/create_folder_v2': {
          const body = JSON.parse(raw.toString('utf8') || '{}') as { path?: string };
          const { parent, name } = splitPath(typeof body.path === 'string' ? body.path : '');
          if (parent.kind === 'missing' || !name) {
            sendError(res, 409, 'path/not_found/.', 'path');
            return;
          }
          const parentNode = parent.kind === 'node' ? parent.node! : null;
          if (parentNode && !parentNode.isFolder) {
            sendError(res, 409, 'path/not_a_folder/.', 'path');
            return;
          }
          if (findChild(parentNode, name)) {
            sendError(res, 409, 'path/conflict/folder/.', 'path');
            return;
          }
          const created = createNode({ name, parentId: parentNode ? parentNode.id : null, isFolder: true });
          sendJson(res, 200, { metadata: metaOf(created) });
          return;
        }
        case 'files/move_v2':
        case 'files/copy_v2': {
          const body = JSON.parse(raw.toString('utf8') || '{}') as { from_path?: string; to_path?: string };
          const source = resolve(typeof body.from_path === 'string' ? body.from_path : '');
          if (source.kind !== 'node') {
            sendError(res, 409, 'path/not_found/.', 'path');
            return;
          }
          const { parent, name } = splitPath(typeof body.to_path === 'string' ? body.to_path : '');
          if (parent.kind === 'missing' || !name) {
            sendError(res, 409, 'path/not_found/.', 'path');
            return;
          }
          const parentNode = parent.kind === 'node' ? parent.node! : null;
          if (parentNode && !parentNode.isFolder) {
            sendError(res, 409, 'path/not_a_folder/.', 'path');
            return;
          }
          if (findChild(parentNode, name)) {
            sendError(res, 409, 'path/conflict/file/.', 'path');
            return;
          }
          if (endpoint === 'files/move_v2') {
            const node = source.node!;
            node.name = name;
            node.parentId = parentNode ? parentNode.id : null;
            node.modifiedAt = now();
            sendJson(res, 200, { metadata: metaOf(node) });
            return;
          }
          const copyInto = (original: FakeNode, parentId: string | null, copyName: string): FakeNode => {
            const clone = createNode({
              name: copyName,
              parentId,
              isFolder: original.isFolder,
              content: Buffer.from(original.content),
              mimeType: original.mimeType,
            });
            for (const child of childrenOf(original.id)) copyInto(child, clone.id, child.name);
            return clone;
          };
          const copy = copyInto(source.node!, parentNode ? parentNode.id : null, name);
          sendJson(res, 200, { metadata: metaOf(copy) });
          return;
        }
        case 'files/delete_v2': {
          const body = JSON.parse(raw.toString('utf8') || '{}') as { path?: string };
          const resolved = resolve(typeof body.path === 'string' ? body.path : '');
          if (resolved.kind !== 'node') {
            sendError(res, 409, 'path/not_found/.', 'path');
            return;
          }
          const meta = metaOf(resolved.node!);
          removeSubtree(resolved.node!);
          sendJson(res, 200, { metadata: meta });
          return;
        }
        case 'sharing/create_shared_link_with_settings': {
          const body = JSON.parse(raw.toString('utf8') || '{}') as { path?: string; settings?: { expires?: string } };
          const resolved = resolve(typeof body.path === 'string' ? body.path : '');
          if (resolved.kind !== 'node') {
            sendError(res, 409, 'path/not_found/.', 'path');
            return;
          }
          const node = resolved.node!;
          if (node.share) {
            sendError(res, 409, 'shared_link_already_exists/.', 'shared_link_already_exists');
            return;
          }
          const url = `${serverOrigin()}/link/${node.id}`;
          node.share = { url, expires: body.settings?.expires ?? null };
          sendJson(res, 200, { url, id: `link-${node.id}`, name: node.name, expires: node.share.expires });
          return;
        }
        case 'sharing/list_shared_links': {
          const body = JSON.parse(raw.toString('utf8') || '{}') as { path?: string };
          const resolved = resolve(typeof body.path === 'string' ? body.path : '');
          if (resolved.kind !== 'node') {
            sendError(res, 409, 'path/not_found/.', 'path');
            return;
          }
          const node = resolved.node!;
          const links = node.share ? [{ url: node.share.url, id: `link-${node.id}`, name: node.name, expires: node.share.expires }] : [];
          sendJson(res, 200, { links });
          return;
        }
        case 'sharing/revoke_shared_link': {
          const body = JSON.parse(raw.toString('utf8') || '{}') as { url?: string };
          for (const node of nodes.values()) {
            if (node.share && node.share.url === body.url) {
              node.share = null;
              sendJson(res, 200, {});
              return;
            }
          }
          sendError(res, 409, 'revoked_shared_link/.', 'revoked_shared_link');
          return;
        }
        default:
          sendError(res, 400, `unknown_endpoint/${endpoint}/.`, 'endpoint');
      }
    })().catch(() => {
      if (!res.headersSent) sendError(res, 500, 'internal/.', 'generic');
      else res.end();
    });
  });

  function parseArg(req: IncomingMessage): Record<string, unknown> {
    const header = req.headers['dropbox-api-arg'];
    const text = Array.isArray(header) ? (header[0] ?? '{}') : (header ?? '{}');
    try {
      const parsed = JSON.parse(text) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  function handleDownload(req: IncomingMessage, res: ServerResponse, path: string): void {
    const redirectMatch = /^\/download\/redirect\/(.+)$/.exec(path);
    if (redirectMatch) {
      res.writeHead(302, { location: `/download/${redirectMatch[1]}` });
      res.end();
      return;
    }
    const idMatch = /^\/download\/(.+)$/.exec(path);
    const node = idMatch ? nodes.get(decodeURIComponent(idMatch[1])) : undefined;
    if (!node || node.isFolder) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    const content = node.content;
    const total = content.byteLength;
    const contentType = node.mimeType || 'application/octet-stream';
    const rangeHeader = noRange.has(node.id) ? undefined : req.headers.range;
    if (typeof rangeHeader === 'string') {
      const match = /^bytes=(\d+)-(\d+)?$/.exec(rangeHeader.trim());
      if (match) {
        const start = Number(match[1]);
        const end = match[2] !== undefined ? Math.min(Number(match[2]), total - 1) : total - 1;
        if (start >= total || end < start) {
          res.writeHead(416, { 'content-range': `bytes */${total}` });
          res.end();
          return;
        }
        const slice = content.subarray(start, end + 1);
        res.writeHead(206, {
          'content-type': contentType,
          'content-length': slice.byteLength,
          'content-range': `bytes ${start}-${end}/${total}`,
          'accept-ranges': 'bytes',
        });
        res.end(slice);
        return;
      }
    }
    res.writeHead(200, {
      'content-type': contentType,
      'content-length': total,
      'accept-ranges': 'bytes',
    });
    res.end(content);
  }

  let origin = '';
  const serverOrigin = (): string => origin;

  await new Promise<void>((resolveListen) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      origin = `http://127.0.0.1:${port}`;
      resolveListen();
    });
  });

  setDropboxTransport({ apiUrl: `${origin}/2`, contentUrl: `${origin}/2`, tokenUrl: `${origin}/oauth2/token` });

  return {
    origin,
    apiUrl: `${origin}/2`,
    contentUrl: `${origin}/2`,
    tokenUrl: `${origin}/oauth2/token`,
    requests,
    auths,
    tokenRequests,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.closeAllConnections();
        server.close(() => resolveClose());
      }),
    seedFolder: (name, parentId = null) => createNode({ name, parentId, isFolder: true }).id,
    seedFile: (name, parentId, content, mimeType = 'application/octet-stream') =>
      createNode({
        name,
        parentId,
        isFolder: false,
        content: Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'),
        mimeType,
      }).id,
    readFile: (id) => nodes.get(id)?.content ?? Buffer.alloc(0),
    nodeCount: () => nodes.size,
    shareCount: () => [...nodes.values()].filter((node) => node.share !== null).length,
    failNext: (endpoint, spec) => {
      failures.push({ endpoint, spec });
    },
    overrideTemporaryLink: (ref, url) => {
      overrides.set(ref, url);
    },
    ignoreRange: (ref) => {
      const resolved = resolve(ref);
      if (resolved.kind === 'node') noRange.add(resolved.node!.id);
    },
    sessionCalls: () => ({ ...calls }),
  };
}

let contextSeq = 0;

export interface FakeContextOverrides {
  accessToken?: string;
  credentials?: ProviderContext['credentials'];
  config?: Record<string, unknown>;
  signal?: AbortSignal;
  providerAccountId?: string;
}

export function makeContext(overrides: FakeContextOverrides = {}): ProviderContext {
  contextSeq += 1;
  return {
    credentials: overrides.credentials ?? {
      kind: 'oauth2',
      accessToken: overrides.accessToken ?? 'test-token',
      refreshToken: 'refresh-token-1',
      clientId: 'client-id-1',
      clientSecret: 'client-secret-1',
      expiresAt: Date.now() + 3_600_000,
    },
    account: {
      id: `account-${contextSeq}`,
      userId: 'user-1',
      provider: 'dropbox',
      providerAccountId: overrides.providerAccountId ?? 'dbid:FAKEACCOUNT',
      displayName: null,
      config: overrides.config ?? {},
    },
    signal: overrides.signal,
    logger: () => undefined,
  };
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

export async function withFakeDropbox(
  options: { token?: string; spaceUsage?: FakeSpaceUsage } = {},
  run: (server: FakeDropboxServer) => Promise<void>,
): Promise<void> {
  enableLocalEndpoint();
  const server = await startFakeDropbox(options);
  try {
    await run(server);
  } finally {
    await server.close();
    resetDropboxTransport();
    restoreEndpointEnv();
  }
}

export function textStream(content: string): NodeJS.ReadableStream {
  return Readable.from([Buffer.from(content, 'utf8')]);
}

export function bufferStream(content: Buffer): NodeJS.ReadableStream {
  return Readable.from([content]);
}

export async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
  }
  return Buffer.concat(chunks);
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
