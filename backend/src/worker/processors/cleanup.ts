import { prisma } from '../../config/prisma.js'
import type { JobPayloads } from '../../queues/job-types.js'
import type { JobHandler } from '../types.js'

const STALE_SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000
const OPERATIONS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000

async function cleanupExpiredTokens(): Promise<number> {
  const now = new Date()
  const [oauthState, authHandoff, filePreviewToken] = await prisma.$transaction([
    prisma.oauthState.deleteMany({ where: { expiresAt: { lt: now } } }),
    prisma.authHandoff.deleteMany({ where: { expiresAt: { lt: now } } }),
    prisma.filePreviewToken.deleteMany({ where: { expiresAt: { lt: now } } }),
  ])
  return oauthState.count + authHandoff.count + filePreviewToken.count
}

async function cleanupStaleSessions(): Promise<number> {
  const now = new Date()
  const revokedCutoff = new Date(now.getTime() - STALE_SESSION_MAX_AGE_MS)
  const result = await prisma.userSession.deleteMany({
    where: {
      OR: [{ expiresAt: { lt: now } }, { revokedAt: { lt: revokedCutoff } }],
    },
  })
  return result.count
}

async function cleanupOldOperations(): Promise<number> {
  const cutoff = new Date(Date.now() - OPERATIONS_MAX_AGE_MS)
  const result = await prisma.storageOperation.deleteMany({ where: { createdAt: { lt: cutoff } } })
  return result.count
}

export const cleanupHandler: JobHandler<JobPayloads['CLEANUP']> = async (ctx) => {
  const { scope } = ctx.payload
  const removed: Record<string, number> = {}
  let step = 0
  const totalSteps = scope === 'all' ? 3 : 1
  if (scope === 'expired_tokens' || scope === 'all') {
    removed.expired_tokens = await cleanupExpiredTokens()
    step += 1
    ctx.reportProgress(Math.round((step / totalSteps) * 100))
  }
  if (scope === 'stale_sessions' || scope === 'all') {
    removed.stale_sessions = await cleanupStaleSessions()
    step += 1
    ctx.reportProgress(Math.round((step / totalSteps) * 100))
  }
  if (scope === 'old_operations' || scope === 'all') {
    removed.old_operations = await cleanupOldOperations()
    step += 1
    ctx.reportProgress(Math.round((step / totalSteps) * 100))
  }
  const total = Object.values(removed).reduce((sum, count) => sum + count, 0)
  ctx.logger.info('cleanup completed', { scope, removed, total })
  return { scope, removed, total }
}
