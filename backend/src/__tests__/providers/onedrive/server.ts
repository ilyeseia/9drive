/**
 * In-process fake of the Microsoft Graph (OneDrive) HTTP API used by the
 * adapter tests.
 *
 * It speaks the same shapes as the real service (`/v1.0` REST paths,
 * `{"error": {code, message}}` errors, `@odata.nextLink` pagination,
 * `search(q='…')`, createUploadSession chunk streams with `Content-Range`,
 * 302 content redirects with Range support, `createLink` permissions and
 * 202 copy monitors) so the tests exercise the adapter's real request building.
 */

import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { ProviderError } from '../../../providers/errors.js';
import { resetOnedriveTransport, setOnedriveTransport } from '../../../providers/onedrive/transport.js';
import type { ProviderContext } from '../../../providers/types.js';

export interface FakeFailure {
  status: number;
  code: string;
  message?: string;
  /** Keep the connection open instead of answering (timeout/abort scenarios). */
  hang?: boolean;
}

export interface FakeQuota {
  /** `null` omits the field entirely (Graph does that for unlimited drives). */
  total?: number | null;
  used?: number;
  deleted?: number | null;
  remaining?: number | null;
}

interface FakePermission {
  id: string;
  roles: string[];
  link?: { webUrl: string; type: string; scope: string };
  expirationDateTime?: string | null;
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
  permissions: FakePermission[];
}

interface FakeUploadSession {
  parentId: string | null;
  name: string;
  parts: Buffer[];
  offset: number;
}

export interface FakeOnedriveServer {
  origin: string;
  graphUrl: string;
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
  overrideDownloadLink(ref: string, url: string): void;
  ignoreRange(ref: string): void;
  sessionCalls(): { create: number; put: number };
}

export interface FakeOnedriveOptions {
  token?: string;
  quota?: FakeQuota;
  /** 202 polls the copy monitor answers before the final 200 (default 1). */
  copyPolls?: number;
  /** Final 200 has no item body, forcing the adapter's resolve-by-name fallback. */
  copyMonitorBare?: boolean;
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

function sendGraphError(res: ServerResponse, status: number, code: string, message = ''): void {
  sendJson(res, status, { error: { code, message: message || code } });
}

export async function startFakeOnedrive(options: FakeOnedriveOptions = {}): Promise<FakeOnedriveServer> {
  const token = options.token ?? 'test-token';
  const acceptedTokens = new Set([token, 'test-token-2']);
  const quota: { total: number | null; used: number; deleted: number | null; remaining: number | null } = {
    total: options.quota && 'total' in options.quota ? options.quota.total! : 5_368_709_120,
    used: options.quota?.used ?? 1_073_741_824,
    deleted: options.quota && 'deleted' in options.quota ? options.quota.deleted! : 1_024,
    remaining: null,
  };
  quota.remaining =
    options.quota && 'remaining' in options.quota
      ? options.quota.remaining!
      : quota.total !== null && quota.deleted !== null
        ? quota.total - quota.used - quota.deleted
        : null;
  const copyPolls = options.copyPolls ?? 1;
  const copyMonitorBare = options.copyMonitorBare ?? false;

  const nodes = new Map<string, FakeNode>();
  const sessions = new Map<string, FakeUploadSession>();
  const monitors = new Map<string, { nodeId: string; pollsLeft: number }>();
  const overrides = new Map<string, string>();
  const noRange = new Set<string>();
  const failures: { endpoint: string; spec: FakeFailure }[] = [];
  const requests: string[] = [];
  const auths: string[] = [];
  const tokenRequests: Record<string, unknown>[] = [];
  const calls = { create: 0, put: 0 };
  let idSeq = 0;
  let permSeq = 0;
  let sessionSeq = 0;
  let monitorSeq = 0;

  const childrenOf = (parentId: string | null): FakeNode[] =>
    [...nodes.values()]
      .filter((node) => node.parentId === parentId)
      .sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0));

  const findChild = (parentId: string | null, name: string): FakeNode | undefined =>
    childrenOf(parentId).find((node) => node.name.toLowerCase() === name.toLowerCase());

  const removeSubtree = (node: FakeNode): void => {
    for (const child of [...nodes.values()].filter((candidate) => candidate.parentId === node.id)) {
      removeSubtree(child);
    }
    nodes.delete(node.id);
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
      id: `item-${String(idSeq).padStart(4, '0')}`,
      name: input.name,
      parentId: input.parentId,
      isFolder: input.isFolder,
      content: input.content ?? Buffer.alloc(0),
      mimeType: input.mimeType ?? 'application/octet-stream',
      createdAt: stamp,
      modifiedAt: stamp,
      permissions: [],
    };
    nodes.set(node.id, node);
    return node;
  };

  const itemOf = (node: FakeNode): Record<string, unknown> => ({
    id: node.id,
    name: node.name,
    ...(node.isFolder
      ? { folder: { childCount: childrenOf(node.id).length } }
      : { size: node.content.byteLength, file: { mimeType: node.mimeType } }),
    createdDateTime: node.createdAt,
    lastModifiedDateTime: node.modifiedAt,
    ...(node.parentId !== null ? { parentReference: { id: node.parentId } } : {}),
    webUrl: `https://onedrive.example/item/${encodeURIComponent(node.name)}`,
    contentHash: createHash('sha1').update(node.content).digest('base64'),
  });

  const rootItem = (): Record<string, unknown> => ({
    id: 'root',
    name: 'root',
    folder: { childCount: childrenOf(null).length },
    createdDateTime: nodeEpoch,
    lastModifiedDateTime: nodeEpoch,
    webUrl: 'https://onedrive.example/',
  });
  const nodeEpoch = '2020-01-01T00:00:00Z';

  const takeFailure = (path: string): FakeFailure | null => {
    const index = failures.findIndex((entry) => path.includes(entry.endpoint));
    if (index === -1) return null;
    const [failure] = failures.splice(index, 1);
    return failure.spec;
  };

  /** `undefined`/`root` → drive root; missing id → 404; non-folder → 400. */
  const resolveParentId = (
    rawId: string | undefined,
  ): { parentId: string | null } | { status: number; code: string; message: string } => {
    if (rawId === undefined || rawId === 'root') return { parentId: null };
    const node = nodes.get(decodeURIComponent(rawId));
    if (!node) return { status: 404, code: 'itemNotFound', message: 'parent not found' };
    if (!node.isFolder) return { status: 400, code: 'invalidRequest', message: 'parentReference is not a folder' };
    return { parentId: node.id };
  };

  const pageOf = (
    items: Record<string, unknown>[],
    url: URL,
    offset: number,
  ): Record<string, unknown> => {
    const topRaw = url.searchParams.get('$top');
    const top = topRaw !== null && /^\d+$/.test(topRaw) ? Number(topRaw) : 200;
    const skipRaw = url.searchParams.get('$skiptoken');
    const start = skipRaw !== null && /^\d+$/.test(skipRaw) ? Number(skipRaw) : offset;
    const page = items.slice(start, start + top);
    const next = start + page.length;
    const body: Record<string, unknown> = { value: page };
    if (next < items.length) {
      const params = new URLSearchParams(url.searchParams);
      params.set('$skiptoken', String(next));
      body['@odata.nextLink'] = `${url.origin}${url.pathname}?${params.toString()}`;
    }
    return body;
  };

  const handleDownload = (res: ServerResponse, id: string, req: IncomingMessage): void => {
    const node = nodes.get(id);
    if (!node) {
      sendGraphError(res, 404, 'itemNotFound', 'item not found');
      return;
    }
    const content = node.content;
    const total = content.byteLength;
    const contentType = node.mimeType;
    const rangeHeader = typeof req.headers.range === 'string' ? req.headers.range : null;

    if (rangeHeader && !noRange.has(node.id)) {
      const match = /^bytes=(\d+)-(\d+)?$/.exec(rangeHeader);
      if (match) {
        const start = Number(match[1]);
        const end = match[2] !== undefined ? Number(match[2]) : total - 1;
        if (!Number.isInteger(start) || start < 0 || start >= total || end < start) {
          res.writeHead(416, { 'content-range': `bytes */${total}` });
          res.end();
          return;
        }
        const clamped = Math.min(end, total - 1);
        const slice = content.subarray(start, clamped + 1);
        res.writeHead(206, {
          'content-type': contentType,
          'content-length': slice.byteLength,
          'content-range': `bytes ${start}-${clamped}/${total}`,
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
  };

  const server: Server = createServer((req, res) => {
    const rawUrl = req.url ?? '/';
    const url = new URL(rawUrl, origin);
    const pathname = decodeURIComponent(url.pathname);
    requests.push(pathname);

    void (async () => {
      if (req.method === 'POST' && pathname === '/oauth2/v2.0/token') {
        const raw = await readRaw(req);
        const params = new URLSearchParams(raw.toString('utf8'));
        tokenRequests.push(Object.fromEntries(params));
        const body = JSON.stringify({
          access_token: 'test-token-2',
          expires_in: 3600,
          refresh_token: 'refresh-token-2',
          token_type: 'Bearer',
        });
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
        res.end(body);
        return;
      }

      const failure = takeFailure(pathname);
      if (failure) {
        if (failure.hang) return;
        sendGraphError(res, failure.status, failure.code, failure.message);
        return;
      }

      if (req.method === 'GET' && pathname.startsWith('/download/')) {
        const remainder = decodeURIComponent(pathname.slice('/download/'.length));
        handleDownload(res, remainder.split('/').pop() ?? remainder, req);
        return;
      }

      if (pathname.startsWith('/upload-session/')) {
        const sessionId = decodeURIComponent(pathname.slice('/upload-session/'.length));
        const session = sessions.get(sessionId);
        if (req.method !== 'PUT') {
          sendGraphError(res, 405, 'invalidRequest', 'method not allowed');
          return;
        }
        if (!session) {
          sendGraphError(res, 404, 'itemNotFound', 'upload session not found');
          return;
        }
        calls.put += 1;
        const rangeHeader = typeof req.headers['content-range'] === 'string' ? req.headers['content-range'] : '';
        const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(rangeHeader);
        if (!match) {
          sendGraphError(res, 400, 'invalidRange', 'malformed content range');
          return;
        }
        const start = Number(match[1]);
        const end = Number(match[2]);
        const total = Number(match[3]);
        if (start !== session.offset) {
          sendGraphError(res, 400, 'invalidRange', `expected offset ${session.offset}`);
          return;
        }
        const body = await readRaw(req);
        if (body.byteLength !== end - start + 1) {
          sendGraphError(res, 400, 'invalidRange', 'chunk length mismatch');
          return;
        }
        session.parts.push(body);
        session.offset = end + 1;
        if (session.offset === total) {
          const content = Buffer.concat(session.parts);
          const existing = findChild(session.parentId, session.name);
          let node: FakeNode;
          if (existing && !existing.isFolder) {
            existing.content = content;
            existing.modifiedAt = now();
            node = existing;
          } else if (existing) {
            sendGraphError(res, 409, 'nameAlreadyExists', 'a folder exists with that name');
            return;
          } else {
            node = createNode({ name: session.name, parentId: session.parentId, isFolder: false, content });
          }
          sessions.delete(sessionId);
          sendJson(res, 201, itemOf(node));
          return;
        }
        sendJson(res, 202, {
          nextExpectedRanges: [`${session.offset}-${total - 1}`],
          expirationDateTime: new Date(Date.now() + 3_600_000).toISOString(),
        });
        return;
      }

      const authorization = req.headers.authorization ?? '';
      auths.push(authorization);
      if (!acceptedTokens.has(authorization.replace(/^Bearer /, ''))) {
        sendGraphError(res, 401, 'invalidAuthenticationToken', 'access token is empty or expired');
        return;
      }

      if (pathname === '/v1.0/me') {
        sendJson(res, 200, {
          id: 'user-0001',
          displayName: 'Fake OneDrive User',
          mail: 'fake@outlook.example',
          userPrincipalName: 'fake@outlook.example',
        });
        return;
      }
      if (pathname === '/v1.0/me/drive') {
        const body: Record<string, unknown> = { state: 'normal', used: quota.used };
        if (quota.total !== null) body.total = quota.total;
        if (quota.deleted !== null) body.deleted = quota.deleted;
        if (quota.remaining !== null) body.remaining = quota.remaining;
        sendJson(res, 200, { id: 'drive-0001', quota: body });
        return;
      }
      if (pathname === '/v1.0/me/drive/root' && req.method === 'GET') {
        sendJson(res, 200, rootItem());
        return;
      }

      const monitor = /^\/v1\.0\/monitor\/([^/]+)$/.exec(pathname);
      if (monitor && req.method === 'GET') {
        const entry = monitors.get(decodeURIComponent(monitor[1]));
        if (!entry) {
          sendGraphError(res, 404, 'itemNotFound', 'monitor not found');
          return;
        }
        if (entry.pollsLeft > 0) {
          entry.pollsLeft -= 1;
          res.writeHead(202, { 'content-type': 'application/json' });
          res.end('{}');
          return;
        }
        const node = nodes.get(entry.nodeId);
        if (!node) {
          sendGraphError(res, 404, 'itemNotFound', 'copy target not found');
          return;
        }
        sendJson(res, 200, copyMonitorBare ? {} : itemOf(node));
        return;
      }

      const search = /^\/v1\.0\/me\/drive\/root\/search\(q='(.*)'\)$/.exec(pathname);
      if (search && req.method === 'GET') {
        const term = search[1].replace(/''/g, "'").toLowerCase();
        const matches = [...nodes.values()]
          .filter((node) => node.name.toLowerCase().includes(term))
          .map(itemOf);
        sendJson(res, 200, pageOf(matches, url, 0));
        return;
      }

      const itemContent = /^\/v1\.0\/me\/drive\/(?:root|items\/([^/]+))\/content$/.exec(pathname);
      if (itemContent && req.method === 'GET') {
        const node =
          itemContent[1] === undefined ? null : nodes.get(decodeURIComponent(itemContent[1]));
        if (!node) {
          sendGraphError(res, 404, 'itemNotFound', 'item not found');
          return;
        }
        if (node.isFolder) {
          sendGraphError(res, 400, 'invalidRequest', 'content is not available for folders');
          return;
        }
        const target = overrides.get(node.id) ?? `${origin}/download/${encodeURIComponent(node.id)}`;
        res.writeHead(302, { location: target });
        res.end();
        return;
      }

      const itemMatch = /^\/v1\.0\/me\/drive\/items\/([^/]+)$/.exec(pathname);
      if (itemMatch && req.method === 'GET') {
        const node = nodes.get(decodeURIComponent(itemMatch[1]));
        if (!node) {
          sendGraphError(res, 404, 'itemNotFound', 'item not found');
          return;
        }
        sendJson(res, 200, itemOf(node));
        return;
      }
      if (itemMatch && req.method === 'PATCH') {
        const node = nodes.get(decodeURIComponent(itemMatch[1]));
        if (!node) {
          sendGraphError(res, 404, 'itemNotFound', 'item not found');
          return;
        }
        const body = await readJson(req);
        if (typeof body.name === 'string') {
          const name = body.name;
          const sibling = findChild(node.parentId, name);
          if (sibling && sibling.id !== node.id) {
            sendGraphError(res, 409, 'nameAlreadyExists', 'an item with that name exists');
            return;
          }
          node.name = name;
          node.modifiedAt = now();
        }
        const reference = body.parentReference as { id?: unknown } | undefined;
        if (reference && typeof reference.id === 'string') {
          const target = resolveParentId(reference.id);
          if (!('parentId' in target)) {
            sendGraphError(res, target.status, target.code, target.message);
            return;
          }
          const destinationId = target.parentId;
          const sibling = findChild(destinationId, node.name);
          if (sibling && sibling.id !== node.id) {
            sendGraphError(res, 409, 'nameAlreadyExists', 'an item with that name exists at the destination');
            return;
          }
          node.parentId = destinationId;
          node.modifiedAt = now();
        }
        sendJson(res, 200, itemOf(node));
        return;
      }
      if (itemMatch && req.method === 'DELETE') {
        const node = nodes.get(decodeURIComponent(itemMatch[1]));
        if (!node) {
          sendGraphError(res, 404, 'itemNotFound', 'item not found');
          return;
        }
        removeSubtree(node);
        res.writeHead(204);
        res.end();
        return;
      }
      if (itemMatch && req.method === 'POST' && url.pathname.endsWith('/copy')) {
        sendGraphError(res, 404, 'itemNotFound', 'unexpected copy path');
        return;
      }

      const copyMatch = /^\/v1\.0\/me\/drive\/items\/([^/]+)\/copy$/.exec(pathname);
      if (copyMatch && req.method === 'POST') {
        const source = nodes.get(decodeURIComponent(copyMatch[1]));
        if (!source) {
          sendGraphError(res, 404, 'itemNotFound', 'item not found');
          return;
        }
        const body = await readJson(req);
        const reference = body.parentReference as { id?: unknown } | undefined;
        const destination = resolveParentId(reference && typeof reference.id === 'string' ? reference.id : undefined);
        if (!('parentId' in destination)) {
          sendGraphError(res, destination.status, destination.code, destination.message);
          return;
        }
        const destinationId = destination.parentId;
        const name = typeof body.name === 'string' && body.name !== '' ? body.name : source.name;
        const conflict = findChild(destinationId, name);
        if (conflict) {
          sendGraphError(res, 409, 'nameAlreadyExists', 'an item with that name exists at the destination');
          return;
        }
        const copy = createNode({
          name,
          parentId: destinationId,
          isFolder: source.isFolder,
          content: source.content,
          mimeType: source.mimeType,
        });
        if (source.isFolder) {
          for (const child of childrenOf(source.id)) {
            const copyChild = (original: FakeNode): FakeNode => {
              const cloned = createNode({
                name: original.name,
                parentId: copy.id,
                isFolder: original.isFolder,
                content: original.content,
                mimeType: original.mimeType,
              });
              for (const nested of childrenOf(original.id)) copyChild(nested);
              return cloned;
            };
            copyChild(child);
          }
        }
        monitorSeq += 1;
        const monitorId = `monitor-${monitorSeq}`;
        monitors.set(monitorId, { nodeId: copy.id, pollsLeft: copyPolls });
        res.writeHead(202, { location: `${origin}/v1.0/monitor/${monitorId}`, 'content-type': 'application/json' });
        res.end('{}');
        return;
      }

      const createLink = /^\/v1\.0\/me\/drive\/(?:root|items\/([^/]+))\/createLink$/.exec(pathname);
      if (createLink && req.method === 'POST') {
        const node = createLink[1] === undefined ? null : nodes.get(decodeURIComponent(createLink[1]));
        if (createLink[1] !== undefined && !node) {
          sendGraphError(res, 404, 'itemNotFound', 'item not found');
          return;
        }
        const body = await readJson(req);
        const permissions = node ? node.permissions : [];
        const existing = permissions.find((permission) => permission.link);
        if (existing?.link) {
          sendJson(res, 200, existing);
          return;
        }
        permSeq += 1;
        const permission: FakePermission = {
          id: `perm-${String(permSeq).padStart(4, '0')}`,
          roles: ['read'],
          link: {
            webUrl: `https://onedrive.example/s/${permSeq}`,
            type: typeof body.type === 'string' ? body.type : 'view',
            scope: typeof body.scope === 'string' ? body.scope : 'anonymous',
          },
          expirationDateTime: typeof body.expirationDateTime === 'string' ? body.expirationDateTime : null,
        };
        permissions.push(permission);
        sendJson(res, 200, permission);
        return;
      }

      const permissionMatch = /^\/v1\.0\/me\/drive\/(?:root|items\/([^/]+))\/permissions\/([^/]+)$/.exec(pathname);
      if (permissionMatch && req.method === 'DELETE') {
        const node = permissionMatch[1] === undefined ? null : nodes.get(decodeURIComponent(permissionMatch[1]));
        if (!node) {
          sendGraphError(res, 404, 'itemNotFound', 'item not found');
          return;
        }
        const permissionId = decodeURIComponent(permissionMatch[2]);
        const index = node.permissions.findIndex((permission) => permission.id === permissionId);
        if (index === -1) {
          sendGraphError(res, 404, 'itemNotFound', 'permission not found');
          return;
        }
        node.permissions.splice(index, 1);
        res.writeHead(204);
        res.end();
        return;
      }

      const permissionsMatch = /^\/v1\.0\/me\/drive\/(?:root|items\/([^/]+))\/permissions$/.exec(pathname);
      if (permissionsMatch && req.method === 'GET') {
        const node = permissionsMatch[1] === undefined ? null : nodes.get(decodeURIComponent(permissionsMatch[1]));
        if (!node) {
          sendGraphError(res, 404, 'itemNotFound', 'item not found');
          return;
        }
        sendJson(res, 200, { value: node.permissions });
        return;
      }

      const contentMatch =
        /^\/v1\.0\/me\/drive\/(?:root|items\/([^/]+))\/children\/([^/]+)\/content$/.exec(pathname);
      if (contentMatch && req.method === 'PUT') {
        const parent = resolveParentId(contentMatch[1]);
        if (!('parentId' in parent)) {
          sendGraphError(res, parent.status, parent.code, parent.message);
          return;
        }
        const parentId = parent.parentId;
        const name = decodeURIComponent(contentMatch[2]);
        const existing = findChild(parentId, name);
        if (existing && existing.isFolder) {
          sendGraphError(res, 409, 'nameAlreadyExists', 'a folder exists with that name');
          return;
        }
        const body = await readRaw(req);
        const contentType = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : 'application/octet-stream';
        let node: FakeNode;
        if (existing) {
          existing.content = body;
          existing.mimeType = contentType;
          existing.modifiedAt = now();
          node = existing;
        } else {
          node = createNode({ name, parentId, isFolder: false, content: body, mimeType: contentType });
        }
        sendJson(res, existing ? 200 : 201, itemOf(node));
        return;
      }

      const sessionMatch =
        /^\/v1\.0\/me\/drive\/(?:root|items\/([^/]+))\/children\/([^/]+)\/createUploadSession$/.exec(pathname);
      if (sessionMatch && req.method === 'POST') {
        const parent = resolveParentId(sessionMatch[1]);
        if (!('parentId' in parent)) {
          sendGraphError(res, parent.status, parent.code, parent.message);
          return;
        }
        calls.create += 1;
        sessionSeq += 1;
        const sessionId = `session-${sessionSeq}`;
        sessions.set(sessionId, {
          parentId: parent.parentId,
          name: decodeURIComponent(sessionMatch[2]),
          parts: [],
          offset: 0,
        });
        sendJson(res, 200, { uploadUrl: `${origin}/upload-session/${sessionId}` });
        return;
      }

      const childByName = /^\/v1\.0\/me\/drive\/(?:root|items\/([^/]+))\/children\/([^/]+)$/.exec(pathname);
      if (childByName && req.method === 'GET') {
        const parent = resolveParentId(childByName[1]);
        if (!('parentId' in parent)) {
          sendGraphError(res, parent.status, parent.code, parent.message);
          return;
        }
        const node = findChild(parent.parentId, decodeURIComponent(childByName[2]));
        if (!node) {
          sendGraphError(res, 404, 'itemNotFound', 'item not found');
          return;
        }
        sendJson(res, 200, itemOf(node));
        return;
      }

      const children = /^\/v1\.0\/me\/drive\/(?:root|items\/([^/]+))\/children$/.exec(pathname);
      if (children && req.method === 'GET') {
        const parent = resolveParentId(children[1]);
        if (!('parentId' in parent)) {
          sendGraphError(res, parent.status, parent.code, parent.message);
          return;
        }
        const items = childrenOf(parent.parentId).map(itemOf);
        sendJson(res, 200, pageOf(items, url, 0));
        return;
      }
      if (children && req.method === 'POST') {
        const parent = resolveParentId(children[1]);
        if (!('parentId' in parent)) {
          sendGraphError(res, parent.status, parent.code, parent.message);
          return;
        }
        const parentId = parent.parentId;
        const body = await readJson(req);
        const name = typeof body.name === 'string' ? body.name : '';
        if (name === '') {
          sendGraphError(res, 400, 'invalidRequest', 'name is required');
          return;
        }
        const existing = findChild(parentId, name);
        if (existing) {
          sendGraphError(res, 409, 'nameAlreadyExists', 'an item with that name already exists');
          return;
        }
        const node = createNode({ name, parentId, isFolder: true });
        sendJson(res, 201, itemOf(node));
        return;
      }

      sendGraphError(res, 404, 'itemNotFound', `no handler for ${req.method} ${pathname}`);
    })();
  });

  let origin = '';

  await new Promise<void>((resolveListen) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      origin = `http://127.0.0.1:${port}`;
      resolveListen();
    });
  });

  setOnedriveTransport({ graphUrl: `${origin}/v1.0`, tokenUrl: `${origin}/oauth2/v2.0/token` });

  return {
    origin,
    graphUrl: `${origin}/v1.0`,
    tokenUrl: `${origin}/oauth2/v2.0/token`,
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
    shareCount: () => [...nodes.values()].filter((node) => node.permissions.some((p) => p.link)).length,
    failNext: (endpoint, spec) => {
      failures.push({ endpoint, spec });
    },
    overrideDownloadLink: (ref, url) => {
      overrides.set(ref, url);
    },
    ignoreRange: (ref) => {
      noRange.add(ref);
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
      provider: 'onedrive',
      providerAccountId: overrides.providerAccountId ?? 'user-0001',
      displayName: null,
      config: overrides.config ?? {},
    },
    signal: overrides.signal,
    logger: () => undefined,
  };
}

const SAVED_ENV: Record<string, string | undefined> = {};

/** Download redirects and upload-session URLs are gated: loopback http needs an explicit opt-in. */
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

export async function withFakeOnedrive(
  options: FakeOnedriveOptions = {},
  run: (server: FakeOnedriveServer) => Promise<void>,
): Promise<void> {
  enableLocalEndpoint();
  const server = await startFakeOnedrive(options);
  try {
    await run(server);
  } finally {
    await server.close();
    resetOnedriveTransport();
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
