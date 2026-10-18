/**
 * File and folder tools. Every query is `userId`-scoped; ids that are not the user's behave as
 * "not found". "Move" is the app's virtual-folder move; provider-to-provider transfer is only
 * available through `start_migration` (a job). File bytes never reach the model.
 */

import { z } from 'zod';
import { prisma } from '../../../config/prisma.js';
import { catalog, registry, buildContext, refreshQuota } from '../../../providers/index.js';
import { enqueueJob } from '../../../queues/queues.js';
import { createAuditLog } from '../../../utils/audit.js';
import { deleteS3Object } from '../../s3/s3.service.js';
import { findOwnedAccount } from '../../providers/account-service.js';
import { cleanText } from '../sanitize.js';
import {
  decodeOffset,
  encodeOffset,
  fileBrief,
  formatBytes,
  limitOf,
  loadOwnedFiles,
  requireOwnedFolder,
  sampleNames,
  uuid,
} from './common.js';
import { defineTool, ToolError, type AnyTool } from './types.js';

const KIND_MIME: Record<string, string[]> = {
  image: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'],
  video: ['video/mp4', 'video/mpeg', 'video/ogg', 'video/quicktime', 'video/webm'],
  pdf: ['application/pdf'],
  doc: ['application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain'],
  archive: ['application/zip', 'application/x-rar-compressed', 'application/x-tar', 'application/x-7z-compressed'],
};

const fileFilters = {
  query: z.string().trim().max(200).optional(),
  kind: z.enum(['image', 'video', 'pdf', 'doc', 'archive']).optional(),
  provider: z.string().trim().max(32).optional(),
  accountId: uuid.optional(),
  folderId: uuid.optional(),
  minSizeBytes: z.number().int().min(0).optional(),
  maxSizeBytes: z.number().int().min(0).optional(),
  createdAfter: z.string().datetime().optional(),
  createdBefore: z.string().datetime().optional(),
};

function whereFromFilters(userId: string, f: { query?: string; kind?: string; provider?: string; accountId?: string; folderId?: string; minSizeBytes?: number; maxSizeBytes?: number; createdAfter?: string; createdBefore?: string }) {
  return {
    userId,
    status: 'active',
    ...(f.folderId ? { folderId: f.folderId } : {}),
    ...(f.query ? { name: { contains: f.query, mode: 'insensitive' as const } } : {}),
    ...(f.accountId ? { connectedAccountId: f.accountId } : {}),
    ...(f.provider ? { provider: f.provider } : {}),
    ...(f.kind ? { mimeType: { in: KIND_MIME[f.kind] ?? [] } } : {}),
    ...(f.minSizeBytes !== undefined || f.maxSizeBytes !== undefined
      ? { sizeBytes: { ...(f.minSizeBytes !== undefined ? { gte: BigInt(f.minSizeBytes) } : {}), ...(f.maxSizeBytes !== undefined ? { lte: BigInt(f.maxSizeBytes) } : {}) } }
      : {}),
    ...(f.createdAfter || f.createdBefore
      ? { createdAt: { ...(f.createdAfter ? { gte: new Date(f.createdAfter) } : {}), ...(f.createdBefore ? { lte: new Date(f.createdBefore) } : {}) } }
      : {}),
  };
}

const searchFiles = defineTool({
  name: 'search_files',
  domain: 'files',
  description:
    'Search the user\'s active files by name, kind, provider, account, folder, size and creation date, with sorting and cursor pagination. The result states whether it is complete; if nextCursor is present there are more matches.',
  input: z.object({
    ...fileFilters,
    sort: z.enum(['createdAt', 'name', 'size']).default('createdAt'),
    order: z.enum(['asc', 'desc']).default('desc'),
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.string().max(200).optional(),
  }),
  output: z.object({ files: z.array(z.object({ id: z.string() }).passthrough()), complete: z.boolean() }).passthrough(),
  risk: 'low',
  timeoutMs: 20_000,
  audit: false,
  async execute(args, ctx) {
    const limit = limitOf(args.limit, ctx);
    const offset = decodeOffset(args.cursor);
    const where = whereFromFilters(ctx.userId, args);
    const sortField = args.sort === 'size' ? 'sizeBytes' : args.sort;
    const [rows, total] = await Promise.all([
      prisma.file.findMany({ where, orderBy: [{ [sortField]: args.order }, { id: args.order }], skip: offset, take: limit + 1 }),
      prisma.file.count({ where }),
    ]);
    const page = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    return {
      data: {
        files: page.map(fileBrief),
        totalMatches: total,
        returned: page.length,
        complete: !hasMore,
        ...(hasMore ? { nextCursor: encodeOffset(offset + limit) } : {}),
      },
      summary: `Found ${total} matching file(s); returned ${page.length}${hasMore ? ' (more available)' : ''}.`,
    };
  },
});

const getFileDetails = defineTool({
  name: 'get_file_details',
  domain: 'files',
  description: 'Metadata for one file (never its contents): size, type, provider, account, folder, checksum presence, status, active share links.',
  input: z.object({ fileId: uuid }),
  output: z.object({ file: z.object({ id: z.string() }).passthrough() }).passthrough(),
  risk: 'low',
  timeoutMs: 10_000,
  audit: false,
  async execute(args, ctx) {
    const file = await prisma.file.findFirst({
      where: { id: args.fileId, userId: ctx.userId },
      include: { folder: { select: { id: true, name: true } }, connectedAccount: { select: { id: true, provider: true, displayName: true } } },
    });
    if (!file) throw new ToolError('NOT_FOUND', 'The file was not found.');
    const shares = await prisma.fileShare.count({ where: { fileId: file.id, userId: ctx.userId, enabled: true, expiresAt: { gt: ctx.now() } } });
    return {
      data: {
        file: { ...fileBrief(file), status: file.status, folderName: file.folder ? cleanText(file.folder.name, 100) : null, accountName: cleanText(file.connectedAccount.displayName ?? file.connectedAccount.provider, 100), updatedAt: file.updatedAt.toISOString(), trashedAt: file.deletedAt?.toISOString() ?? null, activeShareLinks: shares },
      },
      summary: `Retrieved metadata for ${cleanText(file.name, 80)}.`,
    };
  },
});

const listFolders = defineTool({
  name: 'list_folders',
  domain: 'files',
  description: 'List the user\'s virtual folders under a parent (root when parentId is omitted), with active file counts.',
  input: z.object({ parentId: uuid.nullable().optional(), limit: z.number().int().min(1).max(200).optional() }),
  output: z.object({ folders: z.array(z.object({ id: z.string() }).passthrough()) }).passthrough(),
  risk: 'low',
  timeoutMs: 10_000,
  audit: false,
  async execute(args, ctx) {
    if (args.parentId) await requireOwnedFolder(ctx.userId, args.parentId);
    const limit = limitOf(args.limit, ctx, 100);
    const folders = await prisma.folder.findMany({
      where: { userId: ctx.userId, deletedAt: null, parentId: args.parentId ?? null },
      orderBy: { name: 'asc' },
      take: limit + 1,
    });
    const page = folders.slice(0, limit);
    const counts = page.length
      ? await prisma.file.groupBy({ by: ['folderId'], where: { userId: ctx.userId, status: 'active', folderId: { in: page.map((f) => f.id) } }, _count: { _all: true } })
      : [];
    const countById = new Map(counts.map((row) => [row.folderId, row._count._all]));
    return {
      data: {
        folders: page.map((f) => ({ id: f.id, name: cleanText(f.name, 120), parentId: f.parentId, fileCount: countById.get(f.id) ?? 0 })),
        complete: folders.length <= limit,
      },
      summary: `Listed ${page.length} folder(s).`,
    };
  },
});

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,6}$/i, '')
    .replace(/\(\d+\)$/g, '')
    .replace(/[-_ ]*(copy|copie|نسخة)( \d+)?$/giu, '')
    .replace(/[-_ ]+v\d+$/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const SCAN_DEFAULT = 2000;
const SCAN_MAX = 5000;

const findDuplicateCandidates = defineTool({
  name: 'find_duplicate_candidates',
  domain: 'files',
  description:
    'Find duplicate candidates among active files. "confirmed_checksum": same provider, size and non-empty checksum. "probable_cross_provider_checksum": same size and checksum on different providers (hash algorithms can differ). "possible_name_and_size": same normalised name and size with no checksum evidence. A name match alone is never proof of identical content. Read-only; suggests which copy to keep but deletes nothing.',
  input: z.object({ provider: z.string().max(32).optional(), accountId: uuid.optional(), folderId: uuid.optional(), minSizeBytes: z.number().int().min(1).optional(), scanLimit: z.number().int().min(100).max(SCAN_MAX).optional() }),
  output: z.object({ groups: z.array(z.object({ evidence: z.string() }).passthrough()) }).passthrough(),
  risk: 'low',
  timeoutMs: 30_000,
  audit: false,
  async execute(args, ctx) {
    const where = whereFromFilters(ctx.userId, { provider: args.provider, accountId: args.accountId, folderId: args.folderId, minSizeBytes: args.minSizeBytes ?? 1 });
    const scanLimit = args.scanLimit ?? SCAN_DEFAULT;
    const [files, total] = await Promise.all([
      prisma.file.findMany({
        where,
        orderBy: [{ sizeBytes: 'desc' }, { id: 'asc' }],
        take: scanLimit,
        select: { id: true, name: true, sizeBytes: true, checksum: true, provider: true, connectedAccountId: true, folderId: true, mimeType: true, createdAt: true },
      }),
      prisma.file.count({ where }),
    ]);

    const used = new Set<string>();
    const groups: Array<{ evidence: string; sizeBytes: string; files: ReturnType<typeof fileBrief>[]; suggestedKeep: { fileId: string; reason: string } }> = [];
    const push = (evidence: string, members: typeof files) => {
      const sorted = [...members].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
      sorted.forEach((m) => used.add(m.id));
      groups.push({
        evidence,
        sizeBytes: sorted[0].sizeBytes.toString(),
        files: sorted.slice(0, 10).map(fileBrief),
        suggestedKeep: { fileId: sorted[0].id, reason: 'The earliest-created copy is treated as the original; this is a suggestion only.' },
      });
    };

    const byChecksum = new Map<string, typeof files>();
    for (const file of files) {
      if (!file.checksum) continue;
      const key = `${file.sizeBytes}:${file.checksum}`;
      byChecksum.set(key, [...(byChecksum.get(key) ?? []), file]);
    }
    for (const members of byChecksum.values()) {
      if (members.length < 2) continue;
      const sameProvider = members.filter((m) => m.provider === members[0].provider);
      if (sameProvider.length === members.length) push('confirmed_checksum', members);
      else push('probable_cross_provider_checksum', members);
    }

    const byName = new Map<string, typeof files>();
    for (const file of files) {
      if (used.has(file.id)) continue;
      const key = `${file.sizeBytes}:${file.name.trim().toLowerCase()}`;
      byName.set(key, [...(byName.get(key) ?? []), file]);
    }
    for (const members of byName.values()) if (members.length >= 2) push('possible_name_and_size', members);

    const MAX_GROUPS = 25;
    const wasteBytes = groups.reduce((sum, g) => sum + BigInt(g.sizeBytes) * BigInt(Math.max(0, g.files.length - 1)), 0n);
    return {
      data: {
        groups: groups.slice(0, MAX_GROUPS),
        groupsFound: groups.length,
        groupsShown: Math.min(groups.length, MAX_GROUPS),
        scanned: files.length,
        totalFilesInScope: total,
        scanComplete: files.length >= total,
        possibleReclaimableBytes: wasteBytes.toString(),
        note: 'Only "confirmed_checksum" groups are strong evidence. Review every group before deleting anything.',
      },
      summary: `Scanned ${files.length} of ${total} file(s); found ${groups.length} duplicate group(s)${files.length < total ? ' (scan incomplete)' : ''}.`,
      partial: files.length < total,
    };
  },
});

const findSimilarNames = defineTool({
  name: 'find_similar_names',
  domain: 'files',
  description: 'Cluster files whose normalised names are alike (ignoring extension, "(1)", "copy", version suffixes). Similar names are NOT evidence of identical content; use this to prepare a cleanup plan.',
  input: z.object({ ...fileFilters, scanLimit: z.number().int().min(100).max(SCAN_MAX).optional() }),
  output: z.object({ clusters: z.array(z.object({ normalizedName: z.string() }).passthrough()) }).passthrough(),
  risk: 'low',
  timeoutMs: 30_000,
  audit: false,
  async execute(args, ctx) {
    const where = whereFromFilters(ctx.userId, args);
    const scanLimit = args.scanLimit ?? SCAN_DEFAULT;
    const [files, total] = await Promise.all([
      prisma.file.findMany({ where, orderBy: [{ name: 'asc' }, { id: 'asc' }], take: scanLimit, select: { id: true, name: true, sizeBytes: true, mimeType: true, provider: true, connectedAccountId: true, folderId: true, createdAt: true, checksum: true } }),
      prisma.file.count({ where }),
    ]);
    const clusters = new Map<string, typeof files>();
    for (const file of files) {
      const key = normalizeName(file.name);
      if (key.length < 3) continue;
      clusters.set(key, [...(clusters.get(key) ?? []), file]);
    }
    const out = [...clusters.entries()]
      .filter(([, members]) => members.length >= 2)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 25)
      .map(([key, members]) => ({ normalizedName: cleanText(key, 80), evidence: 'name_similarity_only', files: members.slice(0, 10).map(fileBrief), memberCount: members.length }));
    return {
      data: { clusters: out, scanned: files.length, totalFilesInScope: total, scanComplete: files.length >= total },
      summary: `Found ${out.length} cluster(s) of similarly named files among ${files.length} scanned.`,
      partial: files.length < total,
    };
  },
});

const planOrganizeByYear = defineTool({
  name: 'plan_organize_by_year',
  domain: 'files',
  description: 'Read-only plan to organise matching files into one folder per creation year. Returns, per year, the folder name and the file ids to move. Executing the plan uses create_folder and move_files.',
  input: z.object({ ...fileFilters }),
  output: z.object({ plan: z.array(z.object({ year: z.number() }).passthrough()) }).passthrough(),
  risk: 'low',
  timeoutMs: 30_000,
  audit: false,
  async execute(args, ctx) {
    const where = whereFromFilters(ctx.userId, args);
    const cap = 5000;
    const [files, total, folders] = await Promise.all([
      prisma.file.findMany({ where, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: cap, select: { id: true, sizeBytes: true, createdAt: true } }),
      prisma.file.count({ where }),
      prisma.folder.findMany({ where: { userId: ctx.userId, deletedAt: null, parentId: null }, select: { id: true, name: true } }),
    ]);
    const byYear = new Map<number, typeof files>();
    for (const file of files) {
      const year = file.createdAt.getUTCFullYear();
      byYear.set(year, [...(byYear.get(year) ?? []), file]);
    }
    const plan = [...byYear.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([year, members]) => ({
        year,
        folderName: String(year),
        existingFolderId: folders.find((f) => f.name === String(year))?.id ?? null,
        fileCount: members.length,
        totalBytes: members.reduce((sum, m) => sum + m.sizeBytes, 0n).toString(),
        fileIds: members.slice(0, ctx.config.maxBatch).map((m) => m.id),
        moreFilesInThisYear: Math.max(0, members.length - ctx.config.maxBatch),
      }));
    return {
      data: { plan, filesPlanned: files.length, totalFilesInScope: total, planComplete: files.length >= total, maxFilesPerMove: ctx.config.maxBatch },
      summary: `Prepared a plan for ${files.length} file(s) across ${plan.length} year(s); nothing was changed.`,
      partial: files.length < total,
    };
  },
});

const createFolder = defineTool({
  name: 'create_folder',
  domain: 'files',
  description: 'Create a virtual folder (optionally inside another). If a folder with that name already exists there, it is returned instead (idempotent).',
  input: z.object({ name: z.string().trim().min(1).max(120).refine((n) => !/[\\/\u0000-\u001f]/.test(n), 'Folder names cannot contain slashes or control characters.'), parentId: uuid.nullable().optional() }),
  output: z.object({ folder: z.object({ id: z.string() }).passthrough() }).passthrough(),
  risk: 'medium',
  needsConfirmation: () => false,
  timeoutMs: 10_000,
  audit: true,
  async execute(args, ctx) {
    if (args.parentId) await requireOwnedFolder(ctx.userId, args.parentId);
    const existing = await prisma.folder.findFirst({ where: { userId: ctx.userId, deletedAt: null, parentId: args.parentId ?? null, name: args.name } });
    if (existing) return { data: { folder: { id: existing.id, name: cleanText(existing.name, 120), parentId: existing.parentId }, created: false }, summary: `The folder "${cleanText(existing.name, 60)}" already exists.` };
    const folder = await prisma.folder.create({
      data: { userId: ctx.userId, name: args.name, parentId: args.parentId ?? null, color: '#3b82f6', iconUrl: 'https://api.iconify.design/lucide:folder.svg' },
    });
    const check = await prisma.folder.findFirst({ where: { id: folder.id, userId: ctx.userId, deletedAt: null } });
    await createAuditLog(ctx.userId, 'CREATE_FOLDER', 'folder', folder.id, { name: folder.name, via: 'ai' });
    return {
      data: { folder: { id: folder.id, name: cleanText(folder.name, 120), parentId: folder.parentId }, created: true },
      summary: `Created the folder "${cleanText(folder.name, 60)}".`,
      verification: check ? 'Re-read the folder: it exists.' : 'Could not re-read the new folder.',
    };
  },
});

const renameFile = defineTool({
  name: 'rename_file',
  domain: 'files',
  description: 'Rename one file in 9Drive and, where the provider supports it, at the provider. Reports whether the provider was renamed too.',
  input: z.object({ fileId: uuid, newName: z.string().trim().min(1).max(255).refine((n) => !/[\\/\u0000-\u001f]/.test(n), 'File names cannot contain slashes or control characters.') }),
  output: z.object({ file: z.object({ id: z.string() }).passthrough() }).passthrough(),
  risk: 'medium',
  needsConfirmation: () => false,
  timeoutMs: 45_000,
  audit: true,
  async execute(args, ctx) {
    const file = await prisma.file.findFirst({ where: { id: args.fileId, userId: ctx.userId, status: 'active' }, include: { connectedAccount: true } });
    if (!file) throw new ToolError('NOT_FOUND', 'The file was not found.');
    if (file.name === args.newName) return { data: { file: fileBrief(file), providerRenamed: false }, summary: 'The file already has that name.' };

    let providerRenamed = false;
    let remoteId = file.providerFileId;
    const adapter = registry.tryGet(file.provider);
    // S3 keys embed the stored name layout, so (like the existing route) S3 is renamed in 9Drive only.
    if (adapter && file.provider !== 's3' && adapter.capabilities.has('rename') && file.connectedAccount.status === 'connected') {
      const provider = await buildContext(file.connectedAccountId);
      const renamed = await adapter.rename(provider, { remoteId: file.providerFileId, newName: args.newName });
      providerRenamed = true;
      remoteId = renamed.remoteId;
    }
    const updated = await prisma.file.update({ where: { id: file.id }, data: { name: args.newName, providerFileId: remoteId } });
    const check = await prisma.file.findFirst({ where: { id: file.id, userId: ctx.userId }, select: { name: true } });
    await createAuditLog(ctx.userId, 'UPDATE_FILE', 'file', file.id, { name: updated.name, via: 'ai', providerRenamed });
    return {
      data: { file: fileBrief(updated), providerRenamed },
      summary: providerRenamed ? 'Renamed in 9Drive and at the provider.' : 'Renamed in 9Drive only (the provider was not renamed).',
      verification: check?.name === args.newName ? 'Re-read the file: the name matches.' : 'The stored name did not match after the update.',
    };
  },
});

const moveFiles = defineTool({
  name: 'move_files',
  domain: 'files',
  description: 'Move files to another virtual folder (or to the root with folderId null). This changes only the folder organisation in 9Drive, not the storage provider. More than 5 files require confirmation.',
  input: z.object({ fileIds: z.array(uuid).min(1).max(500), folderId: uuid.nullable() }),
  output: z.object({ moved: z.number() }).passthrough(),
  risk: 'medium',
  needsConfirmation: (args) => args.fileIds.length > 5,
  timeoutMs: 30_000,
  audit: true,
  async preview(args, ctx) {
    if (args.fileIds.length > ctx.config.maxBatch) throw new ToolError('LIMIT_EXCEEDED', `At most ${ctx.config.maxBatch} files can be moved at once.`);
    const files = await loadOwnedFiles(ctx.userId, args.fileIds, 'active');
    const target = args.folderId ? await requireOwnedFolder(ctx.userId, args.folderId) : null;
    return {
      summary: `Move ${files.length} file(s) to ${target ? `the folder "${cleanText(target.name, 60)}"` : 'the root'}`,
      affectedCount: files.length,
      sample: sampleNames(files),
      warnings: ['Only the folder organisation in 9Drive changes; files stay on their storage accounts.'],
    };
  },
  async execute(args, ctx) {
    if (args.fileIds.length > ctx.config.maxBatch) throw new ToolError('LIMIT_EXCEEDED', `At most ${ctx.config.maxBatch} files can be moved at once.`);
    const files = await loadOwnedFiles(ctx.userId, args.fileIds, 'active');
    if (args.folderId) await requireOwnedFolder(ctx.userId, args.folderId);
    const ids = files.map((f) => f.id);
    const result = await prisma.file.updateMany({ where: { id: { in: ids }, userId: ctx.userId, status: 'active' }, data: { folderId: args.folderId } });
    const inPlace = await prisma.file.count({ where: { id: { in: ids }, userId: ctx.userId, folderId: args.folderId } });
    await createAuditLog(ctx.userId, 'MOVE_FILES', 'file', undefined, { count: result.count, folderId: args.folderId, via: 'ai' });
    return {
      data: { moved: result.count, requested: ids.length },
      summary: `Moved ${result.count} file(s).`,
      verification: `Re-read: ${inPlace} of ${ids.length} file(s) are now in the target folder.`,
      partial: inPlace !== ids.length,
    };
  },
});

const trashFiles = defineTool({
  name: 'trash_files',
  domain: 'files',
  description: 'Move files to the Recycle Bin (reversible; the files are not removed from storage). Always requires user confirmation.',
  input: z.object({ fileIds: z.array(uuid).min(1).max(500) }),
  output: z.object({ trashed: z.number() }).passthrough(),
  risk: 'medium',
  needsConfirmation: () => true,
  timeoutMs: 30_000,
  audit: true,
  async preview(args, ctx) {
    if (args.fileIds.length > ctx.config.maxBatch) throw new ToolError('LIMIT_EXCEEDED', `At most ${ctx.config.maxBatch} files can be trashed at once.`);
    const files = await loadOwnedFiles(ctx.userId, args.fileIds, 'active');
    const bytes = files.reduce((sum, f) => sum + f.sizeBytes, 0n);
    return {
      summary: `Move ${files.length} file(s) (${formatBytes(bytes)}) to the Recycle Bin`,
      affectedCount: files.length,
      sample: sampleNames(files),
      warnings: ['Files stay recoverable from the Recycle Bin until they are permanently deleted.'],
    };
  },
  async execute(args, ctx) {
    if (args.fileIds.length > ctx.config.maxBatch) throw new ToolError('LIMIT_EXCEEDED', `At most ${ctx.config.maxBatch} files can be trashed at once.`);
    const files = await loadOwnedFiles(ctx.userId, args.fileIds, 'active');
    const ids = files.map((f) => f.id);
    const result = await prisma.file.updateMany({ where: { id: { in: ids }, userId: ctx.userId, status: 'active' }, data: { status: 'deleted', deletedAt: ctx.now() } });
    const confirmed = await prisma.file.count({ where: { id: { in: ids }, userId: ctx.userId, status: 'deleted' } });
    for (const file of files.slice(0, 100)) await createAuditLog(ctx.userId, 'TRASH_FILE', 'file', file.id, { name: file.name, via: 'ai' });
    return {
      data: { trashed: result.count, requested: ids.length },
      summary: `Moved ${result.count} file(s) to the Recycle Bin.`,
      verification: `Re-read: ${confirmed} of ${ids.length} file(s) are now in the Recycle Bin.`,
      partial: confirmed !== ids.length,
    };
  },
});

const purgeFiles = defineTool({
  name: 'purge_files',
  domain: 'files',
  description: 'PERMANENTLY delete files that are already in the Recycle Bin, at the storage provider and in 9Drive. Irreversible. Always requires confirmation; at most 25 per call.',
  input: z.object({ fileIds: z.array(uuid).min(1).max(25) }),
  output: z.object({ purged: z.number() }).passthrough(),
  risk: 'high',
  timeoutMs: 120_000,
  audit: true,
  async preview(args, ctx) {
    const files = await loadOwnedFiles(ctx.userId, args.fileIds, 'deleted');
    const bytes = files.reduce((sum, f) => sum + f.sizeBytes, 0n);
    const unsupported = files.filter((f) => !(f.provider === 's3' || registry.tryGet(f.provider)?.capabilities.has('delete')));
    if (unsupported.length > 0) throw new ToolError('UNSUPPORTED', `${unsupported.length} file(s) are on a provider that does not support deletion from here.`);
    return {
      summary: `PERMANENTLY delete ${files.length} file(s) (${formatBytes(bytes)}) from their storage providers`,
      affectedCount: files.length,
      sample: sampleNames(files),
      warnings: ['This cannot be undone.', `Providers involved: ${[...new Set(files.map((f) => f.provider))].join(', ')}.`],
    };
  },
  async execute(args, ctx) {
    const files = await loadOwnedFiles(ctx.userId, args.fileIds, 'deleted');
    const purged: string[] = [];
    const failures: Array<{ fileId: string; message: string }> = [];
    for (const file of files) {
      if (ctx.signal?.aborted) break;
      try {
        if (file.provider === 's3') {
          await deleteS3Object(file);
        } else {
          const adapter = registry.tryGet(file.provider);
          if (!adapter || !adapter.capabilities.has('delete')) throw new ToolError('UNSUPPORTED', 'The provider does not support deletion.');
          await adapter.delete(await buildContext(file.connectedAccountId), { remoteId: file.providerFileId, permanent: true });
        }
        await prisma.file.deleteMany({ where: { id: file.id, userId: ctx.userId } });
        purged.push(file.id);
        await createAuditLog(ctx.userId, 'PERMANENT_DELETE_FILE', 'file', file.id, { name: file.name, via: 'ai' });
      } catch (error) {
        failures.push({ fileId: file.id, message: error instanceof ToolError ? error.message : 'The provider could not delete this file.' });
      }
    }
    for (const accountId of new Set(files.filter((f) => purged.includes(f.id)).map((f) => f.connectedAccountId))) await refreshQuota(accountId).catch(() => undefined);
    const remaining = await prisma.file.count({ where: { id: { in: files.map((f) => f.id) }, userId: ctx.userId } });
    return {
      data: { purged: purged.length, failed: failures.length, failures: failures.slice(0, 25), requested: files.length },
      summary: `Permanently deleted ${purged.length} of ${files.length} file(s)${failures.length ? `; ${failures.length} failed` : ''}.`,
      verification: `Re-read: ${remaining} of the ${files.length} file record(s) still exist (expected ${failures.length}).`,
      partial: failures.length > 0 && purged.length > 0,
    };
  },
});

const MIGRATION_CAPS = ['download', 'upload', 'list'] as const;

async function checkMigrationAccounts(userId: string, sourceId: string, targetId: string) {
  if (sourceId === targetId) throw new ToolError('INVALID_ARGUMENTS', 'The source and target accounts must differ.');
  const [source, target] = await Promise.all([findOwnedAccount(userId, sourceId), findOwnedAccount(userId, targetId)]);
  if (!source || !target) throw new ToolError('NOT_FOUND', 'One of the storage accounts was not found.');
  for (const account of [source, target]) {
    const entry = catalog.get(account.provider);
    const adapter = registry.tryGet(account.provider);
    if (!entry || entry.status !== 'SUPPORTED' || !adapter) throw new ToolError('UNSUPPORTED', `Provider ${account.provider} is not available for migration.`);
    for (const capability of MIGRATION_CAPS) {
      if (!adapter.capabilities.has(capability)) throw new ToolError('UNSUPPORTED', `Provider ${account.provider} does not support "${capability}", which migration needs.`);
    }
    if (account.status !== 'connected') throw new ToolError('CONFLICT', `The ${account.provider} account is not connected (status: ${account.status}).`);
  }
  return { source, target };
}

const startMigration = defineTool({
  name: 'start_migration',
  domain: 'files',
  description:
    'Start a background job that copies (or moves) files from one of the user\'s accounts to another provider/account. "move" deletes each source file only after its copy is verified. Returns a job id to track with get_job_status. Always requires confirmation.',
  input: z.object({
    sourceAccountId: uuid,
    targetAccountId: uuid,
    mode: z.enum(['copy', 'move']).default('copy'),
    fileIds: z.array(uuid).max(500).optional(),
    folderIds: z.array(uuid).max(100).optional(),
  }),
  output: z.object({ migrationJobId: z.string() }).passthrough(),
  risk: 'high',
  timeoutMs: 30_000,
  audit: true,
  async preview(args, ctx) {
    const { source, target } = await checkMigrationAccounts(ctx.userId, args.sourceAccountId, args.targetAccountId);
    if (args.fileIds?.length) await loadOwnedFiles(ctx.userId, args.fileIds, 'active');
    const scoped = args.fileIds?.length ? args.fileIds.length : await prisma.file.count({ where: { userId: ctx.userId, connectedAccountId: source.id, status: 'active', ...(args.folderIds?.length ? { folderId: { in: args.folderIds } } : {}) } });
    return {
      summary: `${args.mode === 'move' ? 'MOVE' : 'Copy'} ${scoped} file(s) from the ${source.provider} account to the ${target.provider} account`,
      affectedCount: scoped,
      sample: [source.id, target.id],
      warnings: args.mode === 'move' ? ['Each source file is deleted after its copy is verified.', 'This can take a long time and runs in the background.'] : ['This runs in the background and uses storage on the target account.'],
    };
  },
  async execute(args, ctx) {
    const { source, target } = await checkMigrationAccounts(ctx.userId, args.sourceAccountId, args.targetAccountId);
    if (args.fileIds?.length) await loadOwnedFiles(ctx.userId, args.fileIds, 'active');
    const row = await prisma.migrationJob.create({ data: { userId: ctx.userId, sourceAccountId: source.id, targetAccountId: target.id, mode: args.mode, status: 'pending' } });
    const jobId = await enqueueJob('MIGRATION', { userId: ctx.userId, migrationJobId: row.id, scope: { fileIds: args.fileIds, folderIds: args.folderIds } }, { relatedId: row.id });
    await prisma.migrationJob.update({ where: { id: row.id }, data: { status: 'queued' } });
    await createAuditLog(ctx.userId, 'CREATE_MIGRATION', 'migration', row.id, { sourceAccountId: source.id, targetAccountId: target.id, mode: args.mode, jobId, via: 'ai' });
    const check = await prisma.migrationJob.findFirst({ where: { id: row.id, userId: ctx.userId }, select: { status: true } });
    return {
      data: { migrationJobId: row.id, jobId, mode: args.mode, status: check?.status ?? 'unknown' },
      summary: `Started a ${args.mode} migration job. It runs in the background; check its progress with get_job_status.`,
      verification: check?.status === 'queued' ? 'Re-read the migration job: it is queued.' : `Migration job status is ${check?.status ?? 'unknown'}.`,
    };
  },
});

export const fileTools: AnyTool[] = [
  searchFiles,
  getFileDetails,
  listFolders,
  findDuplicateCandidates,
  findSimilarNames,
  planOrganizeByYear,
  createFolder,
  renameFile,
  moveFiles,
  trashFiles,
  purgeFiles,
  startMigration,
];
