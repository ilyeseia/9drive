import { randomUUID } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { ProviderError } from '../../../providers/errors.js';
import { resetGoogleDriveTransport, setGoogleDriveTransport } from '../../../providers/google-drive/transport.js';
import type { ProviderContext } from '../../../providers/types.js';

const FOLDER_MIME = 'application/vnd.google-apps.folder';

export interface FakePermission {
  id: string;
  type: string;
  role: string;
  expirationTime?: string;
}

export interface FakeFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  content: Buffer;
  trashed: boolean;
  permissions: FakePermission[];
  createdTime: string;
  modifiedTime: string;
  webViewLink: string;
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export interface ScriptedResponse {
  method?: string;
  path: string | RegExp;
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  times?: number;
  hang?: boolean;
}

interface ResumableSession {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  declaredLength: number | null;
  bytesReceived: number;
  chunks: Buffer[];
  complete: boolean;
  chunkCount: number;
  fileId: string | null;
}

export interface FakeDriveOptions {
  profile?: { id: string; email: string; name: string; picture: string } | null;
  aboutUser?: { permissionId: string; emailAddress: string; displayName: string; photoLink: string } | null;
  storageQuota?: { limit?: string; usage?: string; usageInDriveTrash?: string } | null;
  tokenResponse?: Record<string, unknown>;
  partialFirstChunk?: boolean;
  sessionLocation?: string;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      finish();
    };
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => settle(() => resolve(Buffer.concat(chunks))));
    req.on('error', () => settle(() => resolve(Buffer.concat(chunks))));
    req.on('close', () => settle(() => resolve(Buffer.concat(chunks))));
  });
}

function send(res: ServerResponse, status: number, payload: Buffer | string, headers: Record<string, string> = {}): void {
  const buffer = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (res.writableEnded || res.destroyed) return;
  try {
    const base = status === 204 || status === 304 ? {} : { 'content-length': String(buffer.byteLength) };
    res.writeHead(status, { ...base, ...headers });
    res.end(buffer);
  } catch {
    res.destroy();
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  send(res, status, JSON.stringify(payload), { 'content-type': 'application/json; charset=UTF-8', ...headers });
}

function googleError(status: number, reason: string, message: string): unknown {
  return { error: { code: status, message, errors: [{ domain: 'global', reason, message }] } };
}

function parseMultipart(body: Buffer, boundary: string): { metadata: Record<string, unknown>; content: Buffer } {
  const marker = Buffer.from(`\r\n--${boundary}\r\n`);
  const jsonHeaderEnd = body.indexOf('\r\n\r\n');
  if (jsonHeaderEnd === -1) throw new Error('multipart payload has no metadata header');
  const jsonStart = jsonHeaderEnd + 4;
  const jsonEnd = body.indexOf(marker, jsonStart);
  if (jsonEnd === -1) throw new Error('multipart payload has no content part');
  const metadata = JSON.parse(body.subarray(jsonStart, jsonEnd).toString('utf8')) as Record<string, unknown>;
  const contentHeaderStart = jsonEnd + marker.byteLength;
  const contentHeaderEnd = body.indexOf('\r\n\r\n', contentHeaderStart);
  if (contentHeaderEnd === -1) throw new Error('multipart payload has no content header');
  const contentStart = contentHeaderEnd + 4;
  const contentEnd = body.indexOf(Buffer.from(`\r\n--${boundary}--`), contentStart);
  if (contentEnd === -1) throw new Error('multipart payload has no closing boundary');
  return { metadata, content: body.subarray(contentStart, contentEnd) };
}

export interface FakeDrive {
  baseUrl: string;
  tokenUrl: string;
  requests: RecordedRequest[];
  files: Map<string, FakeFile>;
  sessions: Map<string, ResumableSession>;
  tokenRequests: Record<string, unknown>[];
  exportRequests: { remoteId: string; mimeType: string }[];
  permissionWrites: { op: 'create' | 'patch' | 'delete'; remoteId: string; body?: Record<string, unknown> }[];
  profile: { id: string; email: string; name: string; picture: string } | null;
  aboutUser: { permissionId: string; emailAddress: string; displayName: string; photoLink: string } | null;
  storageQuota: { limit?: string; usage?: string; usageInDriveTrash?: string } | null;
  tokenResponse: Record<string, unknown>;
  staleTokens: Set<string>;
  partialFirstChunk: boolean;
  sessionLocation: string | null;
  failNext: (response: ScriptedResponse) => void;
  rootFolder(): FakeFile | undefined;
  rootId(): string;
  seedFile(input: {
    id?: string;
    name: string;
    mimeType?: string;
    parents?: string[];
    content?: Buffer | string;
    trashed?: boolean;
    permissions?: FakePermission[];
  }): FakeFile;
  close(): Promise<void>;
}

export async function startFakeDrive(options: FakeDriveOptions = {}): Promise<FakeDrive> {
  const files = new Map<string, FakeFile>();
  const sessions = new Map<string, ResumableSession>();
  const requests: RecordedRequest[] = [];
  const tokenRequests: Record<string, unknown>[] = [];
  const exportRequests: { remoteId: string; mimeType: string }[] = [];
  const permissionWrites: { op: 'create' | 'patch' | 'delete'; remoteId: string; body?: Record<string, unknown> }[] = [];
  const scripted: ScriptedResponse[] = [];
  let idSeq = 0;
  const now = new Date('2026-01-04T10:00:00.000Z').toISOString();

  const drive: FakeDrive = {
    baseUrl: '',
    tokenUrl: '',
    requests,
    files,
    sessions,
    tokenRequests,
    exportRequests,
    permissionWrites,
    profile: options.profile === undefined ? { id: 'profile-sub-001', email: 'drive@example.test', name: 'Drive Tester', picture: 'https://example.test/avatar.png' } : options.profile,
    aboutUser:
      options.aboutUser === undefined
        ? { permissionId: 'profile-sub-001', emailAddress: 'drive@example.test', displayName: 'Drive Tester', photoLink: 'https://example.test/avatar.png' }
        : options.aboutUser,
    storageQuota: options.storageQuota === undefined ? { limit: '15000000000', usage: '2500000000', usageInDriveTrash: '100000000' } : options.storageQuota,
    tokenResponse: options.tokenResponse ?? { access_token: 'refreshed-token-2', expires_in: 3600, refresh_token: 'refreshed-refresh-2' },
    staleTokens: new Set<string>(['stale-token']),
    partialFirstChunk: options.partialFirstChunk ?? false,
    sessionLocation: options.sessionLocation ?? null,
    failNext: (response) => {
      scripted.push({ times: 1, ...response });
    },
    rootFolder: () => [...files.values()].find((file) => file.name === '9drive' && file.mimeType === FOLDER_MIME && !file.trashed),
    rootId: () => {
      const root = drive.rootFolder();
      if (!root) throw new Error('9drive root folder has not been created yet');
      return root.id;
    },
    seedFile: (input) => {
      idSeq += 1;
      const id = input.id ?? `seed-${idSeq}`;
      const file: FakeFile = {
        id,
        name: input.name,
        mimeType: input.mimeType ?? 'application/octet-stream',
        parents: input.parents ?? ['root'],
        content: typeof input.content === 'string' ? Buffer.from(input.content, 'utf8') : (input.content ?? Buffer.alloc(0)),
        trashed: input.trashed ?? false,
        permissions: input.permissions ?? [],
        createdTime: now,
        modifiedTime: now,
        webViewLink: `https://drive.google.com/file/d/${id}/view`,
      };
      files.set(id, file);
      return file;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };

  const createFile = (input: { name: string; mimeType?: string; parents?: string[]; content?: Buffer }): FakeFile => {
    idSeq += 1;
    const id = `file-${idSeq}`;
    const file: FakeFile = {
      id,
      name: input.name,
      mimeType: input.mimeType ?? 'application/octet-stream',
      parents: input.parents ?? ['root'],
      content: input.content ?? Buffer.alloc(0),
      trashed: false,
      permissions: [],
      createdTime: now,
      modifiedTime: now,
      webViewLink: `https://drive.google.com/file/d/${id}/view`,
    };
    files.set(id, file);
    return file;
  };

  const publicFile = (file: FakeFile) => ({
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    size: String(file.content.byteLength),
    parents: file.parents,
    createdTime: file.createdTime,
    modifiedTime: file.modifiedTime,
    md5Checksum: '',
    webViewLink: file.webViewLink,
    trashed: file.trashed,
  });

  const takeScripted = (method: string, path: string): ScriptedResponse | undefined => {
    const index = scripted.findIndex(
      (entry) =>
        entry.times !== 0 &&
        (entry.method === undefined || entry.method === method) &&
        (typeof entry.path === 'string' ? path === entry.path || path.startsWith(`${entry.path}/`) : entry.path.test(path)),
    );
    if (index === -1) return undefined;
    const entry = scripted[index];
    if (entry.times !== undefined) entry.times -= 1;
    if (entry.times === 0) scripted.splice(index, 1);
    return entry;
  };

  const listQuery = (query: URLSearchParams): { entries: FakeFile[]; next: string | null } => {
    const q = query.get('q') ?? '';
    const pageSize = Math.max(1, Number(query.get('pageSize') ?? '100') || 100);
    const offset = Number(Buffer.from(query.get('pageToken') ?? '', 'base64url').toString('utf8') || '0');
    let candidates = [...files.values()].filter((file) => !file.trashed);
    const parentMatch = /'([^']+)' in parents/.exec(q);
    if (q.includes('name = ')) {
      const nameMatch = /name = '([^']+)'/.exec(q);
      const mimeMatch = /mimeType = '([^']+)'/.exec(q);
      candidates = candidates.filter(
        (file) =>
          file.parents.includes('root') &&
          (!nameMatch || file.name === nameMatch[1]) &&
          (!mimeMatch || file.mimeType === mimeMatch[1]),
      );
    } else if (parentMatch) {
      candidates = candidates.filter((file) => file.parents.includes(parentMatch[1]));
    } else if (q.includes('name contains')) {
      const termMatch = /name contains '((?:\\'|[^'])*)'/.exec(q);
      const term = (termMatch?.[1] ?? '').replace(/\\'/g, "'").replace(/\\\\/g, '\\');
      candidates = candidates.filter((file) => file.name.includes(term));
    }
    const slice = candidates.slice(offset, offset + pageSize);
    const next = offset + pageSize < candidates.length ? Buffer.from(String(offset + pageSize), 'utf8').toString('base64url') : null;
    return { entries: slice, next };
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = (req.method ?? 'GET').toUpperCase();
    const path = url.pathname;
    const body = await readBody(req);
    requests.push({ method, path, query: url.searchParams, headers: req.headers, body });

    const scriptedHit = takeScripted(method, path);
    if (scriptedHit) {
      if (scriptedHit.hang) return;
      sendJson(res, scriptedHit.status, scriptedHit.body ?? {}, scriptedHit.headers);
      return;
    }

    const authorization = String(req.headers.authorization ?? '');
    const token = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
    if (path !== '/token' && drive.staleTokens.has(token)) {
      sendJson(res, 401, googleError(401, 'authError', 'Invalid Credentials'));
      return;
    }

    if (path === '/token' && method === 'POST') {
      drive.tokenRequests.push(Object.fromEntries(new URLSearchParams(body.toString('utf8'))));
      sendJson(res, 200, drive.tokenResponse);
      return;
    }

    if (path === '/oauth2/v2/userinfo' && method === 'GET') {
      if (!drive.profile) {
        sendJson(res, 404, googleError(404, 'notFound', 'profile not found'));
        return;
      }
      sendJson(res, 200, drive.profile);
      return;
    }

    if (path === '/drive/v3/about' && method === 'GET') {
      const fields = url.searchParams.get('fields') ?? '';
      if (fields.includes('storageQuota')) {
        sendJson(res, 200, drive.storageQuota ? { storageQuota: drive.storageQuota } : {});
        return;
      }
      sendJson(res, 200, drive.aboutUser ? { user: drive.aboutUser } : {});
      return;
    }

    if (path === '/upload/drive/v3/files' && method === 'POST') {
      const uploadType = url.searchParams.get('uploadType');
      if (uploadType === 'multipart') {
        const contentType = String(req.headers['content-type'] ?? '');
        const boundary = /boundary=([^;]+)/.exec(contentType)?.[1];
        if (!boundary) {
          sendJson(res, 400, googleError(400, 'invalidArgument', 'multipart boundary missing'));
          return;
        }
        const parsed = parseMultipart(body, boundary);
        const metadata = parsed.metadata as { name?: string; mimeType?: string; parents?: string[] };
        const file = createFile({
          name: metadata.name ?? 'untitled',
          mimeType: metadata.mimeType,
          parents: metadata.parents,
          content: parsed.content,
        });
        sendJson(res, 200, publicFile(file));
        return;
      }
      if (uploadType === 'resumable') {
        const metadata = JSON.parse(body.toString('utf8') || '{}') as { name?: string; mimeType?: string; parents?: string[] };
        const declared = req.headers['x-upload-content-length'];
        const sessionId = `session-${randomUUID().slice(0, 8)}`;
        sessions.set(sessionId, {
          id: sessionId,
          name: metadata.name ?? 'untitled',
          mimeType: metadata.mimeType ?? 'application/octet-stream',
          parents: metadata.parents ?? ['root'],
          declaredLength: declared ? Number(declared) : null,
          bytesReceived: 0,
          chunks: [],
          complete: false,
          chunkCount: 0,
          fileId: null,
        });
        const location = drive.sessionLocation ?? `${drive.baseUrl}/upload/resumable/${sessionId}`;
        send(res, 200, '', { location });
        return;
      }
      sendJson(res, 400, googleError(400, 'invalidArgument', 'unsupported uploadType'));
      return;
    }

    const sessionMatch = /^\/upload\/resumable\/([^/]+)$/.exec(path);
    if (sessionMatch && method === 'PUT') {
      const session = sessions.get(sessionMatch[1]);
      if (!session) {
        sendJson(res, 404, googleError(404, 'notFound', 'upload session not found'));
        return;
      }
      const contentRange = String(req.headers['content-range'] ?? '');
      const statusMatch = /^bytes \*\/(\d+|\*)$/.exec(contentRange);
      if (statusMatch) {
        const requested = statusMatch[1];
        const done =
          session.declaredLength !== null
            ? session.bytesReceived >= session.declaredLength
            : requested !== '*' && Number(requested) === session.bytesReceived;
        if (done && session.fileId) {
          const file = files.get(session.fileId);
          sendJson(res, 200, file ? publicFile(file) : {});
          return;
        }
        const range = session.bytesReceived > 0 ? `bytes=0-${session.bytesReceived - 1}` : 'bytes=';
        send(res, 308, '', { range });
        return;
      }
      const chunkMatch = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(contentRange);
      if (!chunkMatch) {
        sendJson(res, 400, googleError(400, 'invalidArgument', `invalid Content-Range: ${contentRange}`));
        return;
      }
      const end = Number(chunkMatch[2]);
      const total = chunkMatch[3];
      session.chunkCount += 1;
      let accepted = body;
      if (drive.partialFirstChunk && session.chunkCount === 1 && body.byteLength > 1) {
        accepted = body.subarray(0, Math.floor(body.byteLength / 2));
      }
      session.bytesReceived += accepted.byteLength;
      session.chunks.push(accepted);
      const finished = total !== '*' && end === Number(total) - 1 && !(drive.partialFirstChunk && session.chunkCount === 1);
      if (finished) {
        session.complete = true;
        if (!session.fileId) {
          const file = createFile({
            name: session.name,
            mimeType: session.mimeType,
            parents: session.parents,
            content: Buffer.concat(session.chunks),
          });
          session.fileId = file.id;
        } else {
          const existing = files.get(session.fileId);
          if (existing) existing.content = Buffer.concat(session.chunks);
        }
        const file = files.get(session.fileId);
        sendJson(res, 200, file ? publicFile(file) : {});
        return;
      }
      const range = session.bytesReceived > 0 ? `bytes=0-${session.bytesReceived - 1}` : 'bytes=';
      send(res, 308, '', { range });
      return;
    }

    const permissionsMatch = /^\/drive\/v3\/files\/([^/]+)\/permissions$/.exec(path);
    if (permissionsMatch) {
      const file = files.get(decodeURIComponent(permissionsMatch[1]));
      if (!file) {
        sendJson(res, 404, googleError(404, 'notFound', 'file not found'));
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, { permissions: file.permissions });
        return;
      }
      if (method === 'POST') {
        const payload = JSON.parse(body.toString('utf8') || '{}') as Record<string, unknown>;
        permissionWrites.push({ op: 'create', remoteId: file.id, body: payload });
        if (payload.type !== 'anyone') {
          sendJson(res, 400, googleError(400, 'invalidArgument', 'only anyone permissions are supported by this fake'));
          return;
        }
        if (payload.role !== 'reader') {
          sendJson(res, 400, googleError(400, 'invalidArgument', 'public sharing must be reader'));
          return;
        }
        if (payload.allowFileDiscovery !== false) {
          sendJson(res, 400, googleError(400, 'invalidArgument', 'allowFileDiscovery must be false'));
          return;
        }
        const permission: FakePermission = {
          id: `perm-${file.id}-${file.permissions.length + 1}`,
          type: String(payload.type),
          role: String(payload.role),
        };
        if (typeof payload.expirationTime === 'string') permission.expirationTime = payload.expirationTime;
        file.permissions.push(permission);
        sendJson(res, 200, permission);
        return;
      }
      sendJson(res, 405, googleError(405, 'methodNotAllowed', 'unsupported'));
      return;
    }

    const permissionMatch = /^\/drive\/v3\/files\/([^/]+)\/permissions\/([^/]+)$/.exec(path);
    if (permissionMatch) {
      const file = files.get(decodeURIComponent(permissionMatch[1]));
      if (!file) {
        sendJson(res, 404, googleError(404, 'notFound', 'file not found'));
        return;
      }
      const permission = file.permissions.find((entry) => entry.id === permissionMatch[2]);
      if (!permission) {
        sendJson(res, 404, googleError(404, 'notFound', 'permission not found'));
        return;
      }
      if (method === 'PATCH') {
        const payload = JSON.parse(body.toString('utf8') || '{}') as Record<string, unknown>;
        permissionWrites.push({ op: 'patch', remoteId: file.id, body: payload });
        if (typeof payload.role === 'string') permission.role = payload.role;
        if (typeof payload.expirationTime === 'string') permission.expirationTime = payload.expirationTime;
        sendJson(res, 200, permission);
        return;
      }
      if (method === 'DELETE') {
        permissionWrites.push({ op: 'delete', remoteId: file.id });
        file.permissions = file.permissions.filter((entry) => entry.id !== permission.id);
        send(res, 204, '');
        return;
      }
      sendJson(res, 405, googleError(405, 'methodNotAllowed', 'unsupported'));
      return;
    }

    const exportMatch = /^\/drive\/v3\/files\/([^/]+)\/export$/.exec(path);
    if (exportMatch && method === 'GET') {
      const file = files.get(decodeURIComponent(exportMatch[1]));
      if (!file) {
        sendJson(res, 404, googleError(404, 'notFound', 'file not found'));
        return;
      }
      const mimeType = url.searchParams.get('mimeType') ?? '';
      exportRequests.push({ remoteId: file.id, mimeType });
      const payload = Buffer.from(`exported:${file.name}`, 'utf8');
      send(res, 200, payload, { 'content-type': mimeType, 'content-disposition': `attachment; filename="${file.name}"` });
      return;
    }

    const copyMatch = /^\/drive\/v3\/files\/([^/]+)\/copy$/.exec(path);
    if (copyMatch && method === 'POST') {
      const source = files.get(decodeURIComponent(copyMatch[1]));
      if (!source) {
        sendJson(res, 404, googleError(404, 'notFound', 'file not found'));
        return;
      }
      const payload = JSON.parse(body.toString('utf8') || '{}') as { name?: string; parents?: string[] };
      const copy = createFile({
        name: payload.name ?? `${source.name} (copy)`,
        mimeType: source.mimeType,
        parents: payload.parents ?? source.parents,
        content: source.content,
      });
      sendJson(res, 200, publicFile(copy));
      return;
    }

    const fileMatch = /^\/drive\/v3\/files\/([^/]+)$/.exec(path);
    if (fileMatch) {
      const remoteId = decodeURIComponent(fileMatch[1]);
      const file = files.get(remoteId);
      if (!file) {
        sendJson(res, 404, googleError(404, 'notFound', 'File not found'));
        return;
      }
      if (method === 'GET' && url.searchParams.get('alt') === 'media') {
        const rangeHeader = String(req.headers.range ?? '');
        const rangeMatch = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
        if (rangeMatch) {
          const start = Number(rangeMatch[1]);
          const end = rangeMatch[2] === '' ? file.content.byteLength - 1 : Math.min(Number(rangeMatch[2]), file.content.byteLength - 1);
          const slice = file.content.subarray(start, end + 1);
          send(res, 206, slice, {
            'content-type': file.mimeType,
            'content-range': `bytes ${start}-${end}/${file.content.byteLength}`,
          });
          return;
        }
        send(res, 200, file.content, { 'content-type': file.mimeType });
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, publicFile(file));
        return;
      }
      if (method === 'PATCH') {
        const payload = JSON.parse(body.toString('utf8') || '{}') as {
          name?: string;
          trashed?: boolean;
          parents?: string[];
        };
        if (typeof payload.name === 'string') file.name = payload.name;
        if (typeof payload.trashed === 'boolean') file.trashed = payload.trashed;
        const addParents = url.searchParams.get('addParents');
        const removeParents = url.searchParams.get('removeParents');
        if (addParents && addParents !== 'root' && !files.has(addParents)) {
          sendJson(res, 404, googleError(404, 'parentNotFound', `Parent ${addParents} was not found`));
          return;
        }
        if (addParents && !file.parents.includes(addParents)) file.parents.push(addParents);
        if (removeParents) {
          const removals = removeParents.split(',').filter(Boolean);
          file.parents = file.parents.filter((parent) => !removals.includes(parent));
        }
        if (payload.parents && !addParents) file.parents = payload.parents;
        sendJson(res, 200, publicFile(file));
        return;
      }
      if (method === 'DELETE') {
        files.delete(file.id);
        send(res, 204, '');
        return;
      }
      sendJson(res, 405, googleError(405, 'methodNotAllowed', 'unsupported'));
      return;
    }

    if (path === '/drive/v3/files' && method === 'GET') {
      const page = listQuery(url.searchParams);
      sendJson(res, 200, {
        files: page.entries.map(publicFile),
        ...(page.next ? { nextPageToken: page.next } : {}),
      });
      return;
    }

    if (path === '/drive/v3/files' && method === 'POST') {
      const payload = JSON.parse(body.toString('utf8') || '{}') as { name?: string; mimeType?: string; parents?: string[] };
      const parents = payload.parents ?? ['root'];
      const missing = parents.find((parent) => parent !== 'root' && !files.has(parent));
      if (missing) {
        sendJson(res, 404, googleError(404, 'parentNotFound', `Parent ${missing} was not found`));
        return;
      }
      const file = createFile({
        name: payload.name ?? 'untitled',
        mimeType: payload.mimeType,
        parents,
      });
      sendJson(res, 200, publicFile(file));
      return;
    }

    sendJson(res, 404, googleError(404, 'notFound', `no fake route for ${method} ${path}`));
  };

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      try {
        if (!res.writableEnded && !res.destroyed) sendJson(res, 500, googleError(500, 'backendError', 'fake server failure'));
      } catch {
        res.destroy();
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  drive.baseUrl = `http://127.0.0.1:${address.port}`;
  drive.tokenUrl = `${drive.baseUrl}/token`;
  setGoogleDriveTransport({ baseUrl: drive.baseUrl, tokenUrl: drive.tokenUrl });
  return drive;
}

let contextSeq = 0;

export function makeContext(
  drive?: FakeDrive | null,
  overrides: {
    accessToken?: string;
    refreshToken?: string;
    accountId?: string;
    signal?: AbortSignal;
    credentials?: ProviderContext['credentials'];
    providerAccountId?: string;
  } = {},
): ProviderContext {
  contextSeq += 1;
  return {
    credentials: overrides.credentials ?? {
      kind: 'oauth2',
      accessToken: overrides.accessToken ?? 'live-token',
      refreshToken: overrides.refreshToken ?? 'refresh-token-1',
      clientId: 'client-id-1',
      clientSecret: 'client-secret-1',
      expiresAt: Date.now() + 3_600_000,
    },
    account: {
      id: overrides.accountId ?? `account-${contextSeq}-${randomUUID().slice(0, 8)}`,
      userId: 'user-1',
      provider: 'google_drive',
      providerAccountId: overrides.providerAccountId ?? 'profile-sub-001',
      config: {},
    },
    signal: overrides.signal,
    logger: () => undefined,
  };
}

export async function withFakeDrive(
  options: FakeDriveOptions,
  run: (drive: FakeDrive) => Promise<void>,
): Promise<void> {
  const drive = await startFakeDrive(options);
  try {
    await run(drive);
  } finally {
    await drive.close();
    resetGoogleDriveTransport();
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
