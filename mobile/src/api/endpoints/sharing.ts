/**
 * Share links. Contract: backend/src/modules/files/file.routes.ts.
 *  - `POST /files/:id/share` → 201 { url, shareId }. The URL contains the secret token and is returned ONLY here;
 *    it can never be fetched again (the list endpoint returns `url: null`). The app therefore shows it once.
 *  - Expiry is fixed by the server (30 days) and is not part of the creation response; it is read from the list.
 *  - `DELETE /files/:id/share` revokes EVERY active link of that file (there is no per-link revoke).
 *  - There are no per-link options (password, custom expiry, download limit) — none is offered.
 */

import { z } from 'zod';
import type { ApiClient } from '../client';
import { isoDate } from '../schemas';
import { fileSchema } from './files';

export const createdShareSchema = z.object({ url: z.string().url(), shareId: z.string().min(1) });
export type CreatedShare = z.infer<typeof createdShareSchema>;

export const shareSchema = z.object({
  id: z.string().min(1),
  createdAt: isoDate,
  expiresAt: isoDate,
  file: fileSchema,
});
export type ShareItem = z.infer<typeof shareSchema>;

export const sharingApi = {
  create: (client: ApiClient, fileId: string) =>
    client.request({ method: 'POST', path: `/files/${encodeURIComponent(fileId)}/share`, body: {}, schema: createdShareSchema }),

  list: (client: ApiClient, signal?: AbortSignal) =>
    client.request({ path: '/files/shared-links', schema: z.object({ shares: z.array(shareSchema) }), signal }).then((r) => r.shares),

  /** Revokes all active links of the file. */
  revokeAll: (client: ApiClient, fileId: string) =>
    client.requestVoid({ method: 'DELETE', path: `/files/${encodeURIComponent(fileId)}/share` }),
};

/**
 * The link is only ever shown to the user who created it. Before it is displayed or copied it must look like a
 * link to this deployment's public page — never an arbitrary string a compromised server could inject (e.g. a
 * `javascript:` or a phishing URL).
 */
export function isTrustedShareUrl(url: string, apiBaseUrl: string): boolean {
  try {
    const link = new URL(url);
    if (link.protocol !== 'https:' && link.protocol !== 'http:') return false;
    if (link.username || link.password) return false;
    if (!/^\/public\/files\/[A-Za-z0-9_-]{20,}$/.test(link.pathname)) return false;
    // The public page is served by the web frontend, which normally shares the API's registrable domain; a different
    // host is allowed only over https so a downgrade cannot be forced.
    return link.protocol === 'https:' || new URL(apiBaseUrl).protocol === 'http:';
  } catch {
    return false;
  }
}
