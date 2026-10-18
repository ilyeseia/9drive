import { z } from 'zod';
import { prisma } from '../../../config/prisma.js';
import { cleanText } from '../sanitize.js';
import { ToolError, type ToolContext } from './types.js';

/** Same shape check the account routes use; stricter RFC-variant checks would reject valid ids. */
export const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Expected a UUID.');

export const big = (value: bigint | null | undefined): string | null => (value === null || value === undefined ? null : value.toString());

/** Applies the requested page size within the configured hard cap. */
export function limitOf(requested: number | undefined, ctx: ToolContext, fallback = 25): number {
  return Math.min(Math.max(requested ?? fallback, 1), ctx.config.maxResults);
}

export function encodeOffset(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), 'utf8').toString('base64url');
}

export function decodeOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { o?: unknown };
    if (typeof parsed.o === 'number' && Number.isSafeInteger(parsed.o) && parsed.o >= 0 && parsed.o < 10_000_000) return parsed.o;
  } catch {
    /* fall through */
  }
  throw new ToolError('INVALID_ARGUMENTS', 'The pagination cursor is invalid.');
}

/**
 * Loads the user's own files for the given ids. Ids that do not exist OR belong to someone else are
 * indistinguishable ("not found"), so a model cannot probe for other users' resources.
 */
export async function loadOwnedFiles(userId: string, ids: string[], status: 'active' | 'deleted') {
  const unique = [...new Set(ids)];
  const files = await prisma.file.findMany({
    where: { id: { in: unique }, userId, status },
    include: { connectedAccount: true },
  });
  if (files.length !== unique.length) {
    throw new ToolError(
      'NOT_FOUND',
      status === 'deleted'
        ? `${unique.length - files.length} of ${unique.length} file(s) were not found in the trash (only trashed files can be permanently deleted).`
        : `${unique.length - files.length} of ${unique.length} file(s) were not found.`,
    );
  }
  return files;
}

export async function requireOwnedFolder(userId: string, folderId: string) {
  const folder = await prisma.folder.findFirst({ where: { id: folderId, userId, deletedAt: null } });
  if (!folder) throw new ToolError('NOT_FOUND', 'The folder was not found.');
  return folder;
}

export function fileBrief(file: { id: string; name: string; sizeBytes: bigint; mimeType: string; provider: string; connectedAccountId: string; folderId: string | null; createdAt: Date; checksum?: string | null }) {
  return {
    id: file.id,
    name: cleanText(file.name, 255),
    sizeBytes: file.sizeBytes.toString(),
    mimeType: cleanText(file.mimeType, 100),
    provider: file.provider,
    accountId: file.connectedAccountId,
    folderId: file.folderId,
    createdAt: file.createdAt.toISOString(),
    hasChecksum: Boolean(file.checksum),
  };
}

export function sampleNames(files: Array<{ name: string }>, max = 5): string[] {
  return files.slice(0, max).map((file) => cleanText(file.name, 80));
}

export function formatBytes(bytes: bigint): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = Number(bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
