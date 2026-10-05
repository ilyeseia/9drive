/**
 * In-process fake of the pCloud HTTP JSON API used by the adapter tests.
 *
 * It speaks the same protocol as the real service (GET method endpoints with
 * `access_token` in the query string, `{ result: <code> }` envelopes even on
 * HTTP 200, PUT `uploadfile` with a raw body, `getfilelink` host+path pairs
 * served over a separate CDN-style origin with Range support) so the tests
 * exercise the adapter's real request building.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { ProviderError } from '../../../providers/errors.js';
import { resetPcloudTransport, setPcloudTransport } from '../../../providers/pcloud/transport.js';
import type { ProviderContext } from '../../../providers/types.js';

export interface FakeFailure {
  /** pCloud result code answered with HTTP 200. */
  result?: number;
  /** Raw HTTP status answered with `body` (defaults to `{}`). */
  status?: number;
  body?: unknown;
  /** Keep the connection open instead of answering (timeout/abort scenarios). */
  hang?: boolean;
}

interface FakeNode {
  id: string;
  name: string;
  parentId: number;
  isFolder: boolean;
  content: Buffer;
  mimeType: string;
  createdAt: string;
  modifiedAt: string;
  deleted: boolean;
}

interface FakePubLink {
  linkid: number;
  code: string;
  link: string;
  nodeId: string;
  expires: string | null;
}

export interface FakePcloudServer {
  origin: string;
  apiUrl: string;
  tokenUrl: string;
  requests: string[];
  auths: string[];
  tokenRequests: Record<string, unknown>[];
  close(): Promise<void>;
  seedFolder(name: string, parentFolderId?: number): string;
  seedFile(name: string, parentFolderId: number, content: Buffer | string, mimeType?: string): string;
  readFile(id: string): Buffer;
  nodeCount(): number;
  shareCount(): number;
  failNext(endpoint: string, spec: FakeFailure): void;
  ignoreRange(id: string): void;
}

const ROOT_CREATED = 'Thu, 19 Sep 2013 07:31:46 +0000';

function rfc2822(date: Date = new Date()): string {
  return date.toUTCString().replace('GMT', '+0000');
}

async function readRaw(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload ?? {});
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

export async function startFakePcloud(
  options: { token?: string; quota?: number | string | null; usedquota?: number | string } = {},
): Promise<FakePcloudServer> {
  const token = options.token ?? 'test-token';
  const acceptedTokens = new Set([token, 'test-token-2']);
  const quota = options.quota === undefined ? 2_199_023_255_552 : options.quota;
  const usedquota = options.usedquota ?? 1_099_511_627_776;
  const nodes = new Map<string, FakeNode>();
  const publinks = new Map<number, FakePubLink>();
  const failures: { endpoint: string; spec: FakeFailure }[] = [];
  const requests: string[] = [];
  const auths: string[] = [];
  const tokenRequests: Record<string, unknown>[] = [];
  const noRange = new Set<string>();
  let idSeq = 0;
  let linkSeq = 0;

  const numericId = (id: string): number => Number(id.slice(1));

  const pathOf = (node: FakeNode): string => {
    const parts: string[] = [node.name];
    let cursor = node.parentId;
    while (cursor !== 0) {
      const parent = nodes.get(`d${cursor}`);
      if (!parent) break;
      parts.unshift(parent.name);
      cursor = parent.parentId;
    }
    return `/${parts.join('/')}`;
  };

  const childrenOf = (folderId: number): FakeNode[] =>
    [...nodes.values()]
      .filter((node) => node.parentId === folderId && !node.deleted)
      .sort((a, b) => {
        const left = a.name.toLowerCase();
        const right = b.name.toLowerCase();
        return left < right ? -1 : left > right ? 1 : 0;
      });

  const metaOf = (node: FakeNode): Record<string, unknown> => {
    const base: Record<string, unknown> = {
      id: node.id,
      parentfolderid: node.parentId,
      isfolder: node.isFolder,
      ismine: true,
      isshared: false,
      name: node.name,
      path: pathOf(node),
      created: node.createdAt,
      modified: node.modifiedAt,
    };
    if (node.deleted) base.isdeleted = true;
    if (node.isFolder) return { ...base, folderid: numericId(node.id) };
    return {
      ...base,
      fileid: numericId(node.id),
      size: node.content.byteLength,
      contenttype: node.mimeType,
      // Exceeds 2^53 on purpose: the adapter must never expose this field.
      hash: 10681749967730527559,
    };
  };

  const rootMeta = (contents?: Record<string, unknown>[]): Record<string, unknown> => ({
    id: 'd0',
    folderid: 0,
    isfolder: true,
    ismine: true,
    isshared: false,
    name: '/',
    path: '/',
    created: ROOT_CREATED,
    modified: ROOT_CREATED,
    ...(contents ? { contents } : {}),
  });

  const createNode = (input: {
    name: string;
    parentId: number;
    isFolder: boolean;
    content?: Buffer;
    mimeType?: string;
  }): FakeNode => {
    idSeq += 1;
    const stamp = rfc2822();
    const node: FakeNode = {
      id: `${input.isFolder ? 'd' : 'f'}${idSeq}`,
      name: input.name,
      parentId: input.parentId,
      isFolder: input.isFolder,
      content: input.content ?? Buffer.alloc(0),
      mimeType: input.mimeType ?? 'application/octet-stream',
      createdAt: stamp,
      modifiedAt: stamp,
      deleted: false,
    };
    nodes.set(node.id, node);
    return node;
  };

  const removeSubtree = (node: FakeNode): void => {
    for (const child of [...nodes.values()].filter((candidate) => candidate.parentId === numericId(node.id))) {
      removeSubtree(child);
    }
    nodes.delete(node.id);
  };

  const findChild = (parentId: number, name: string): FakeNode | undefined =>
    [...nodes.values()].find(
      (node) => node.parentId === parentId && !node.deleted && node.name.toLowerCase() === name.toLowerCase(),
    );

  const isDescendant = (candidateFolderId: number, ancestorId: number): boolean => {
    let cursor: number | null = candidateFolderId;
    while (cursor !== null && cursor !== 0) {
      if (cursor === ancestorId) return true;
      cursor = nodes.get(`d${cursor}`)?.parentId ?? null;
    }
    return ancestorId === 0;
  };

  const getNode = (id: string): FakeNode | undefined => nodes.get(id);

  const resolveFolder = (raw: string | null): FakeNode | 'root' | null => {
    if (raw === null || raw.trim() === '') return null;
    const id = Number(raw);
    if (!Number.isInteger(id) || id < 0) return null;
    if (id === 0) return 'root';
    const node = nodes.get(`d${id}`);
    return node && !node.deleted ? node : null;
  };

  const resolveFile = (raw: string | null): FakeNode | null => {
    if (raw === null || raw.trim() === '') return null;
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) return null;
    return nodes.get(`f${id}`) ?? null;
  };

  const contentsOf = (folderId: number, recursive: boolean): Record<string, unknown>[] =>
    childrenOf(folderId).map((child) => {
      const meta = metaOf(child);
      if (recursive && child.isFolder) {
        meta.contents = contentsOf(numericId(child.id), true);
      }
      return meta;
    });

  const takeFailure = (path: string): FakeFailure | null => {
    const index = failures.findIndex(
      (entry) => entry.endpoint === 'download' ? path.startsWith('/dl/') : path === `/${entry.endpoint}`,
    );
    if (index === -1) return null;
    const [failure] = failures.splice(index, 1);
    return failure.spec;
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://placeholder');
    const path = url.pathname;
    requests.push(path);

    void (async () => {
      const failure = takeFailure(path);
      if (failure) {
        if (failure.hang) return;
        if (failure.status !== undefined) {
          sendJson(res, failure.status, failure.body ?? {});
          return;
        }
        sendJson(res, 200, { result: failure.result ?? 9999 });
        return;
      }

      if (req.method === 'POST' && path === '/oauth2/token') {
        const raw = await readRaw(req);
        const params = new URLSearchParams(raw.toString('utf8'));
        tokenRequests.push(Object.fromEntries(params));
        sendJson(res, 200, { result: 0, access_token: 'test-token-2', token_type: 'bearer', uid: 4242 });
        return;
      }

      if (path.startsWith('/dl/')) {
        handleDownload(req, res, path);
        return;
      }

      const accessToken = url.searchParams.get('access_token');
      auths.push(accessToken ?? '');
      if (accessToken === null || !acceptedTokens.has(accessToken)) {
        // Real pCloud answers HTTP 200 with `result: 1000` for missing/invalid logins.
        sendJson(res, 200, { result: 1000 });
        return;
      }

      const params = url.searchParams;
      const method = path.slice(1);

      switch (method) {
        case 'userinfo': {
          const payload: Record<string, unknown> = {
            result: 0,
            userid: 4242,
            email: 'fake@pcloud.example',
            emailverified: true,
            premium: true,
            language: 'en',
            usedquota,
          };
          if (quota !== null) payload.quota = quota;
          sendJson(res, 200, payload);
          return;
        }
        case 'listfolder': {
          const folder = resolveFolder(params.get('folderid'));
          if (folder === null) {
            sendJson(res, 200, { result: params.get('folderid') === null ? 1002 : 2005 });
            return;
          }
          const recursive = params.get('recursive') === '1';
          const contents =
            folder === 'root' ? contentsOf(0, recursive) : contentsOf(numericId(folder.id), recursive);
          sendJson(res, 200, {
            result: 0,
            metadata: folder === 'root' ? rootMeta(contents) : { ...metaOf(folder), contents },
          });
          return;
        }
        case 'stat': {
          const file = resolveFile(params.get('fileid'));
          if (params.get('fileid') === null) {
            sendJson(res, 200, { result: 1004 });
            return;
          }
          if (!file) {
            sendJson(res, 200, { result: 2009 });
            return;
          }
          sendJson(res, 200, { result: 0, metadata: metaOf(file) });
          return;
        }
        case 'createfolder': {
          const rawFolderid = params.get('folderid');
          const name = params.get('name') ?? '';
          if (rawFolderid === null || name === '') {
            sendJson(res, 200, { result: 1001 });
            return;
          }
          if (name.includes('/')) {
            sendJson(res, 200, { result: 2001 });
            return;
          }
          const folder = resolveFolder(rawFolderid);
          if (folder === null) {
            sendJson(res, 200, { result: 2002 });
            return;
          }
          const parentFolderId = folder === 'root' ? 0 : numericId(folder.id);
          if (findChild(parentFolderId, name)) {
            sendJson(res, 200, { result: 2004 });
            return;
          }
          const created = createNode({ name, parentId: parentFolderId, isFolder: true });
          sendJson(res, 200, { result: 0, metadata: metaOf(created) });
          return;
        }
        case 'uploadfile': {
          const raw = await readRaw(req);
          const rawFolderid = params.get('folderid');
          const filename = params.get('filename') ?? '';
          if (filename === '' || filename.includes('/')) {
            sendJson(res, 200, { result: 2001 });
            return;
          }
          const folder = resolveFolder(rawFolderid === null ? '0' : rawFolderid);
          if (folder === null) {
            sendJson(res, 200, { result: 2005 });
            return;
          }
          const parentFolderId = folder === 'root' ? 0 : numericId(folder.id);
          const existing = findChild(parentFolderId, filename);
          const mimeType = headerContentType(req) ?? 'application/octet-stream';
          let stored: FakeNode;
          if (existing && existing.isFolder) {
            sendJson(res, 200, { result: 2004 });
            return;
          }
          if (existing) {
            existing.content = raw;
            existing.mimeType = mimeType;
            existing.modifiedAt = rfc2822();
            stored = existing;
          } else {
            stored = createNode({ name: filename, parentId: parentFolderId, isFolder: false, content: raw, mimeType });
          }
          sendJson(res, 200, { result: 0, fileids: [numericId(stored.id)], metadata: [metaOf(stored)] });
          return;
        }
        case 'getfilelink': {
          const file = resolveFile(params.get('fileid'));
          if (params.get('fileid') === null) {
            sendJson(res, 200, { result: 1004 });
            return;
          }
          if (!file) {
            sendJson(res, 200, { result: 2009 });
            return;
          }
          const host = origin.replace(/^http:\/\//, '');
          sendJson(res, 200, {
            result: 0,
            path: `/dl/${file.id}/${encodeURIComponent(file.name)}`,
            expires: rfc2822(new Date(Date.now() + 5 * 60_000)),
            hosts: [host, 'unreachable.invalid'],
          });
          return;
        }
        case 'renamefile':
        case 'renamefolder': {
          const isFolder = method === 'renamefolder';
          const idParam = isFolder ? params.get('folderid') : params.get('fileid');
          if (idParam === null) {
            sendJson(res, 200, { result: isFolder ? 1002 : 1004 });
            return;
          }
          const node = getNode(`${isFolder ? 'd' : 'f'}${Number(idParam)}`);
          if (!node || node.deleted) {
            sendJson(res, 200, { result: isFolder ? 2005 : 2009 });
            return;
          }
          if (isFolder && numericId(node.id) === 0) {
            sendJson(res, 200, { result: 2042 });
            return;
          }
          const toname = params.get('toname');
          if (toname !== null && (toname.trim() === '' || toname.includes('/'))) {
            sendJson(res, 200, { result: 2001 });
            return;
          }
          let destinationFolderId = node.parentId;
          const rawTofolderid = params.get('tofolderid');
          if (rawTofolderid !== null) {
            const destination = resolveFolder(rawTofolderid);
            if (destination === null) {
              sendJson(res, 200, { result: 2005 });
              return;
            }
            destinationFolderId = destination === 'root' ? 0 : numericId(destination.id);
          }
          if (isFolder && destinationFolderId !== 0 && isDescendant(destinationFolderId, numericId(node.id))) {
            sendJson(res, 200, { result: 2043 });
            return;
          }
          const finalName = toname !== null ? toname : node.name;
          const replaced = findChild(destinationFolderId, finalName);
          let deletedfileid: number | undefined;
          if (replaced && replaced.id !== node.id) {
            if (isFolder) {
              // Folders never merge: `renamefolder` reports the conflict (2004).
              sendJson(res, 200, { result: 2004 });
              return;
            }
            if (replaced.isFolder) {
              removeSubtree(replaced);
            } else {
              deletedfileid = numericId(replaced.id);
              nodes.delete(replaced.id);
            }
          }
          node.name = finalName;
          node.parentId = destinationFolderId;
          node.modifiedAt = rfc2822();
          const metadata = metaOf(node);
          if (deletedfileid !== undefined) metadata.deletedfileid = deletedfileid;
          sendJson(res, 200, { result: 0, metadata });
          return;
        }
        case 'copyfile':
        case 'copyfolder': {
          const isFolder = method === 'copyfolder';
          const idParam = isFolder ? params.get('folderid') : params.get('fileid');
          if (idParam === null) {
            sendJson(res, 200, { result: isFolder ? 1002 : 1004 });
            return;
          }
          const source = getNode(`${isFolder ? 'd' : 'f'}${Number(idParam)}`);
          if (!source || source.deleted) {
            sendJson(res, 200, { result: isFolder ? 2005 : 2009 });
            return;
          }
          const rawTofolderid = params.get('tofolderid');
          const destination = resolveFolder(rawTofolderid);
          if (rawTofolderid === null || destination === null) {
            sendJson(res, 200, { result: rawTofolderid === null ? 1016 : isFolder ? 2208 : 2002 });
            return;
          }
          const destinationFolderId = destination === 'root' ? 0 : numericId(destination.id);
          if (isFolder) {
            if (destinationFolderId === numericId(source.id)) {
              sendJson(res, 200, { result: 2206 });
              return;
            }
            if (destinationFolderId !== 0 && isDescendant(destinationFolderId, numericId(source.id))) {
              sendJson(res, 200, { result: 2207 });
              return;
            }
          }
          const name = params.get('toname') ?? source.name;
          if (name.includes('/')) {
            sendJson(res, 200, { result: 2001 });
            return;
          }
          const existing = findChild(destinationFolderId, name);
          if (existing && params.get('noover') === '1') {
            sendJson(res, 200, { result: 2004 });
            return;
          }
          if (existing && !isFolder) nodes.delete(existing.id);
          const copyInto = (original: FakeNode, parentId: number, copyName: string): FakeNode => {
            const clone = createNode({
              name: copyName,
              parentId,
              isFolder: original.isFolder,
              content: Buffer.from(original.content),
              mimeType: original.mimeType,
            });
            for (const child of childrenOf(numericId(original.id))) copyInto(child, numericId(clone.id), child.name);
            return clone;
          };
          const clone = copyInto(source, destinationFolderId, name);
          sendJson(res, 200, { result: 0, metadata: metaOf(clone) });
          return;
        }
        case 'deletefile': {
          const file = resolveFile(params.get('fileid'));
          if (params.get('fileid') === null) {
            sendJson(res, 200, { result: 1004 });
            return;
          }
          if (!file) {
            sendJson(res, 200, { result: 2009 });
            return;
          }
          file.deleted = true;
          sendJson(res, 200, { result: 0, metadata: metaOf(file) });
          return;
        }
        case 'deletefolder':
        case 'deletefolderrecursive': {
          const folder = resolveFolder(params.get('folderid'));
          if (params.get('folderid') === null) {
            sendJson(res, 200, { result: 1002 });
            return;
          }
          if (folder === null) {
            sendJson(res, 200, { result: 2005 });
            return;
          }
          if (folder === 'root') {
            sendJson(res, 200, { result: 2007 });
            return;
          }
          const folderId = numericId(folder.id);
          const children = childrenOf(folderId);
          if (method === 'deletefolder') {
            if (children.length > 0) {
              sendJson(res, 200, { result: 2006 });
              return;
            }
            folder.deleted = true;
            sendJson(res, 200, { result: 0, metadata: metaOf(folder) });
            return;
          }
          const countSubtree = (node: FakeNode): { files: number; folders: number } => {
            let files = 0;
            let folders = 0;
            for (const child of childrenOf(numericId(node.id))) {
              if (child.isFolder) {
                const nested = countSubtree(child);
                files += nested.files;
                folders += 1 + nested.folders;
              } else {
                files += 1;
              }
            }
            return { files, folders };
          };
          const totals = countSubtree(folder);
          removeSubtree(folder);
          sendJson(res, 200, { result: 0, deletedfiles: totals.files, deletedfolders: totals.folders });
          return;
        }
        case 'getfilepublink':
        case 'getfolderpublink': {
          const isFolder = method === 'getfolderpublink';
          const idParam = isFolder ? params.get('folderid') : params.get('fileid');
          if (idParam === null) {
            sendJson(res, 200, { result: isFolder ? 1002 : 1004 });
            return;
          }
          const target = isFolder ? resolveFolder(idParam) : resolveFile(idParam);
          if (target === null) {
            sendJson(res, 200, { result: isFolder ? 2005 : 2009 });
            return;
          }
          if (target === 'root') {
            sendJson(res, 200, { result: 2015 });
            return;
          }
          const expire = params.get('expire');
          if (expire !== null && Number.isNaN(Date.parse(expire))) {
            sendJson(res, 200, { result: 1013 });
            return;
          }
          linkSeq += 1;
          const link: FakePubLink = {
            linkid: linkSeq,
            code: `code${linkSeq}`,
            link: `https://my.pcloud.com/#page=publink&code=code${linkSeq}`,
            nodeId: target.id,
            expires: expire,
          };
          publinks.set(link.linkid, link);
          sendJson(res, 200, { result: 0, linkid: link.linkid, link: link.link, code: link.code });
          return;
        }
        case 'listpublinks': {
          const publinksList = [...publinks.values()].map((link) => {
            const node = getNode(link.nodeId);
            return {
              linkid: link.linkid,
              code: link.code,
              link: link.link,
              created: rfc2822(),
              modified: rfc2822(),
              expires: link.expires,
              downloads: 0,
              traffic: 0,
              ...(node ? { metadata: metaOf(node) } : {}),
            };
          });
          sendJson(res, 200, { result: 0, publinks: publinksList });
          return;
        }
        case 'deletepublink': {
          const rawLinkid = params.get('linkid');
          const linkid = rawLinkid === null ? Number.NaN : Number(rawLinkid);
          if (rawLinkid === null) {
            sendJson(res, 200, { result: 1030 });
            return;
          }
          if (!publinks.has(linkid)) {
            sendJson(res, 200, { result: 2027 });
            return;
          }
          publinks.delete(linkid);
          sendJson(res, 200, { result: 0 });
          return;
        }
        default:
          sendJson(res, 200, { result: 9999, error: `unknown method '${method}'` });
      }
    })().catch(() => {
      if (!res.headersSent) sendJson(res, 500, { result: 5000 });
      else res.end();
    });
  });

  function headerContentType(req: IncomingMessage): string | null {
    const value = req.headers['content-type'];
    if (value === undefined) return null;
    return Array.isArray(value) ? (value[0] ?? null) : value;
  }

  function handleDownload(req: IncomingMessage, res: ServerResponse, path: string): void {
    const idMatch = /^\/dl\/([^/]+)\//.exec(path);
    const node = idMatch ? getNode(decodeURIComponent(idMatch[1])) : undefined;
    if (!node || node.isFolder || node.deleted) {
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

  await new Promise<void>((resolveListen) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      origin = `http://127.0.0.1:${port}`;
      resolveListen();
    });
  });

  setPcloudTransport({ apiUrl: origin, tokenUrl: `${origin}/oauth2/token`, cdnScheme: 'http' });

  return {
    origin,
    apiUrl: origin,
    tokenUrl: `${origin}/oauth2/token`,
    requests,
    auths,
    tokenRequests,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.closeAllConnections();
        server.close(() => resolveClose());
      }),
    seedFolder: (name, parentFolderId = 0) => createNode({ name, parentId: parentFolderId, isFolder: true }).id,
    seedFile: (name, parentFolderId, content, mimeType = 'application/octet-stream') =>
      createNode({
        name,
        parentId: parentFolderId,
        isFolder: false,
        content: Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'),
        mimeType,
      }).id,
    readFile: (id) => nodes.get(id)?.content ?? Buffer.alloc(0),
    nodeCount: () => nodes.size,
    shareCount: () => publinks.size,
    failNext: (endpoint, spec) => {
      failures.push({ endpoint, spec });
    },
    ignoreRange: (id) => {
      noRange.add(id);
    },
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
      // pCloud issues permanent tokens: no refresh material, no expiry.
      expiresAt: null,
    },
    account: {
      id: `account-${contextSeq}`,
      userId: 'user-1',
      provider: 'pcloud',
      providerAccountId: overrides.providerAccountId ?? '4242',
      displayName: null,
      config: overrides.config ?? {},
    },
    signal: overrides.signal,
    logger: () => undefined,
  };
}

const SAVED_ENV: Record<string, string | undefined> = {};

/** CDN download links are gated: loopback http needs an explicit opt-in. */
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

export async function withFakePcloud(
  options: { token?: string; quota?: number | string | null; usedquota?: number | string } = {},
  run: (server: FakePcloudServer) => Promise<void>,
): Promise<void> {
  enableLocalEndpoint();
  const server = await startFakePcloud(options);
  try {
    await run(server);
  } finally {
    await server.close();
    resetPcloudTransport();
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
