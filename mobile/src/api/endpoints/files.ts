/**
 * Files and folders. Contracts read from backend/src/modules/files/file.routes.ts and folders/folder.routes.ts.
 * Quirks worth knowing (see docs/mobile/00-audit-and-plan.md §3):
 *  - `GET /files` without `folderId` returns files from ALL folders (the web "All files" view).
 *  - The page cursor encodes `[createdAt, id]` only, so it is valid only with `sort=createdAt`.
 *  - `PATCH /files/:id` (rename/move) is implemented against the Google API for every non-S3 provider on the
 *    server today; failures for other providers are surfaced as the server reports them, never faked.
 */

import { z } from 'zod';
import type { ApiClient, Query } from '../client';
import { bytesString, isoDate, okStatus } from '../schemas';

export const fileSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  mimeType: z.string(),
  sizeBytes: bytesString,
  provider: z.string(),
  folderId: z.string().nullable().optional(),
  status: z.string().optional(),
  createdAt: isoDate,
  updatedAt: isoDate.optional(),
  connectedAccount: z.object({ id: z.string(), email: z.string(), provider: z.string() }).nullable().optional(),
  folder: z.object({ id: z.string(), name: z.string() }).nullable().optional(),
});
export type FileItem = z.infer<typeof fileSchema>;

export const filesPageSchema = z.object({ files: z.array(fileSchema), nextCursor: z.string().optional() });
export type FilesPage = z.infer<typeof filesPageSchema>;

export const folderSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  color: z.string().optional(),
  parentId: z.string().nullable().optional(),
  createdAt: isoDate.optional(),
  updatedAt: isoDate.optional(),
});
export type FolderItem = z.infer<typeof folderSchema>;

export type FileSort = 'name' | 'size' | 'createdAt';
export type FileKind = 'image' | 'video' | 'pdf' | 'doc' | 'archive';

export interface ListFilesParams {
  folderId?: string | null;
  q?: string;
  kind?: FileKind;
  sort?: FileSort;
  order?: 'asc' | 'desc';
  cursor?: string;
  limit?: number;
}

/** Server-side limits mirrored on the client so a bad request is never sent. */
export const MAX_BATCH = 100;
export const MAX_PAGE = 200;

export const filesApi = {
  list: (client: ApiClient, params: ListFilesParams, signal?: AbortSignal) => {
    const query: Query = {
      folderId: params.folderId ?? undefined,
      q: params.q?.trim() || undefined,
      kind: params.kind,
      sort: params.sort,
      order: params.order,
      cursor: params.cursor,
      limit: Math.min(params.limit ?? 50, MAX_PAGE),
    };
    return client.request({ path: '/files', query, schema: filesPageSchema, signal });
  },

  get: (client: ApiClient, id: string, signal?: AbortSignal) =>
    client.request({ path: `/files/${encodeURIComponent(id)}`, schema: z.object({ file: fileSchema }), signal }).then((r) => r.file),

  rename: (client: ApiClient, id: string, name: string) =>
    client
      .request({ method: 'PATCH', path: `/files/${encodeURIComponent(id)}`, body: { name }, schema: z.object({ file: fileSchema }) })
      .then((r) => r.file),

  /** `folderId: null` moves the file out of any folder. */
  move: (client: ApiClient, id: string, folderId: string | null) =>
    client
      .request({ method: 'PATCH', path: `/files/${encodeURIComponent(id)}`, body: { folderId }, schema: z.object({ file: fileSchema }) })
      .then((r) => r.file),

  moveMany: (client: ApiClient, fileIds: string[], folderId: string | null) =>
    client.request({
      method: 'PATCH',
      path: '/files/batch',
      body: { fileIds: fileIds.slice(0, MAX_BATCH), folderId },
      schema: z.object({ moved: z.number().optional() }).passthrough(),
    }),

  /** Soft delete (moves to trash on the server). */
  trash: (client: ApiClient, id: string) => client.requestVoid({ method: 'DELETE', path: `/files/${encodeURIComponent(id)}` }),

  trashMany: (client: ApiClient, fileIds: string[]) =>
    client.requestVoid({ method: 'DELETE', path: '/files/batch', body: { fileIds: fileIds.slice(0, MAX_BATCH) } }),

  copy: (client: ApiClient, id: string, folderId?: string | null) =>
    client.request({
      method: 'POST',
      path: `/files/${encodeURIComponent(id)}/copy`,
      body: folderId ? { folderId } : {},
      schema: z.unknown(),
    }),

  stats: (client: ApiClient) =>
    client.request({ path: '/files/stats', schema: z.object({ fileCount: z.number(), folderCount: z.number(), bytes: bytesString }) }),
};

export const foldersApi = {
  list: (client: ApiClient, parentId: string | null, signal?: AbortSignal) =>
    client
      .request({
        path: '/folders',
        query: { parentId: parentId ?? undefined },
        schema: z.object({ folders: z.array(folderSchema) }),
        signal,
      })
      .then((r) => r.folders),

  /** All folders, used by the "move to…" picker. */
  listAll: (client: ApiClient, signal?: AbortSignal) =>
    client
      .request({ path: '/folders', query: { all: '1' }, schema: z.object({ folders: z.array(folderSchema) }), signal })
      .then((r) => r.folders),

  create: (client: ApiClient, name: string, parentId: string | null) =>
    client.request({
      method: 'POST',
      path: '/folders',
      body: { name: name.trim(), parentId },
      schema: z.object({ folder: folderSchema }).passthrough(),
    }),

  rename: (client: ApiClient, id: string, name: string) =>
    client.request({
      method: 'PATCH',
      path: `/folders/${encodeURIComponent(id)}`,
      body: { name: name.trim() },
      schema: okStatus.or(z.unknown()),
    }),

  remove: (client: ApiClient, id: string) => client.requestVoid({ method: 'DELETE', path: `/folders/${encodeURIComponent(id)}` }),
};
