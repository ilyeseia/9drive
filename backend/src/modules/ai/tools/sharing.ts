/**
 * 9Drive public share links (the `FileShare` model). A share URL is a bearer capability, so it is
 * handed to the USER only (`userOutput`) and is never placed in the model's context or stored in
 * the conversation transcript.
 */

import { z } from 'zod';
import { env } from '../../../config/env.js';
import { prisma } from '../../../config/prisma.js';
import { createAuditLog } from '../../../utils/audit.js';
import { hashToken, randomToken } from '../../../utils/crypto.js';
import { cleanText } from '../sanitize.js';
import { uuid } from './common.js';
import { defineTool, ToolError, type AnyTool } from './types.js';

const SHARE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const listShareLinks = defineTool({
  name: 'list_share_links',
  domain: 'sharing',
  description: 'List the user\'s active 9Drive public share links (file, expiry). URLs are not retrievable after creation.',
  input: z.object({ fileId: uuid.optional(), limit: z.number().int().min(1).max(100).optional() }),
  output: z.object({ shares: z.array(z.object({ id: z.string() }).passthrough()) }).passthrough(),
  risk: 'low',
  timeoutMs: 10_000,
  audit: false,
  async execute(args, ctx) {
    const limit = Math.min(args.limit ?? 25, ctx.config.maxResults);
    const shares = await prisma.fileShare.findMany({
      where: { userId: ctx.userId, enabled: true, expiresAt: { gt: ctx.now() }, ...(args.fileId ? { fileId: args.fileId } : {}) },
      include: { file: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return {
      data: { shares: shares.map((s) => ({ id: s.id, fileId: s.fileId, fileName: cleanText(s.file.name, 120), expiresAt: s.expiresAt.toISOString(), createdAt: s.createdAt.toISOString() })) },
      summary: `Found ${shares.length} active share link(s).`,
    };
  },
});

const createShareLink = defineTool({
  name: 'create_share_link',
  domain: 'sharing',
  description: 'Create a public 9Drive share link for one file (anyone with the link can view/download it for 30 days). The URL is shown to the user only. Requires confirmation.',
  input: z.object({ fileId: uuid }),
  output: z.object({ shareId: z.string() }).passthrough(),
  risk: 'medium',
  needsConfirmation: () => true,
  timeoutMs: 10_000,
  audit: true,
  async preview(args, ctx) {
    const file = await prisma.file.findFirst({ where: { id: args.fileId, userId: ctx.userId, status: 'active' } });
    if (!file) throw new ToolError('NOT_FOUND', 'The file was not found.');
    return {
      summary: `Create a PUBLIC link to "${cleanText(file.name, 80)}" that anyone can open for 30 days`,
      affectedCount: 1,
      sample: [cleanText(file.name, 80)],
      warnings: ['Anyone who has the link can view and download this file until it expires or you revoke it.'],
    };
  },
  async execute(args, ctx) {
    const file = await prisma.file.findFirst({ where: { id: args.fileId, userId: ctx.userId, status: 'active' } });
    if (!file) throw new ToolError('NOT_FOUND', 'The file was not found.');
    const token = randomToken(32);
    const share = await prisma.fileShare.create({
      data: { fileId: file.id, userId: ctx.userId, tokenHash: hashToken(token), expiresAt: new Date(ctx.now().getTime() + SHARE_TTL_MS) },
    });
    const check = await prisma.fileShare.findFirst({ where: { id: share.id, userId: ctx.userId, enabled: true } });
    await createAuditLog(ctx.userId, 'AI_CREATE_SHARE', 'file', file.id, { shareId: share.id });
    return {
      data: { shareId: share.id, fileName: cleanText(file.name, 120), expiresAt: share.expiresAt.toISOString(), urlDeliveredToUserOnly: true },
      summary: `Created a public share link for "${cleanText(file.name, 60)}" (expires ${share.expiresAt.toISOString().slice(0, 10)}).`,
      verification: check ? 'Re-read the share: it is enabled.' : 'Could not re-read the new share.',
      userOutput: { url: `${env.FRONTEND_URL}/public/files/${token}`, expiresAt: share.expiresAt.toISOString() },
    };
  },
});

const revokeShareLinks = defineTool({
  name: 'revoke_share_links',
  domain: 'sharing',
  description: 'Revoke every active 9Drive public share link for one file. (Provider-side public permissions, e.g. Google Drive "anyone" links, are managed separately and are not changed here.) Requires confirmation.',
  input: z.object({ fileId: uuid }),
  output: z.object({ revoked: z.number() }).passthrough(),
  risk: 'high',
  timeoutMs: 10_000,
  audit: true,
  async preview(args, ctx) {
    const file = await prisma.file.findFirst({ where: { id: args.fileId, userId: ctx.userId } });
    if (!file) throw new ToolError('NOT_FOUND', 'The file was not found.');
    const active = await prisma.fileShare.count({ where: { fileId: file.id, userId: ctx.userId, enabled: true } });
    return { summary: `Revoke ${active} public link(s) to "${cleanText(file.name, 80)}"`, affectedCount: active, sample: [cleanText(file.name, 80)], warnings: ['People using these links will lose access immediately.'] };
  },
  async execute(args, ctx) {
    const file = await prisma.file.findFirst({ where: { id: args.fileId, userId: ctx.userId } });
    if (!file) throw new ToolError('NOT_FOUND', 'The file was not found.');
    const result = await prisma.fileShare.updateMany({ where: { fileId: file.id, userId: ctx.userId, enabled: true }, data: { enabled: false } });
    const stillActive = await prisma.fileShare.count({ where: { fileId: file.id, userId: ctx.userId, enabled: true } });
    await createAuditLog(ctx.userId, 'AI_REVOKE_SHARE', 'file', file.id, { revoked: result.count });
    return {
      data: { revoked: result.count },
      summary: `Revoked ${result.count} share link(s).`,
      verification: stillActive === 0 ? 'Re-read: no active share links remain for this file.' : `${stillActive} share link(s) are still active.`,
      partial: stillActive > 0,
    };
  },
});

export const sharingTools: AnyTool[] = [listShareLinks, createShareLink, revokeShareLinks];
