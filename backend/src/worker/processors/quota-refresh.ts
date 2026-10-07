import { prisma } from '../../config/prisma.js'
import { registry, refreshQuota } from '../../providers/index.js'
import type { JobPayloads } from '../../queues/job-types.js'
import type { JobHandler } from '../types.js'

const STALE_AFTER_MS = 5 * 60_000
const RUN_CAP = 25
const RUN_BUDGET_MS = 40_000

export const quotaRefreshHandler: JobHandler<JobPayloads['QUOTA_REFRESH']> = async (ctx) => {
  const { accountId } = ctx.payload
  const staleCutoff = new Date(Date.now() - STALE_AFTER_MS)
  const accounts = accountId
    ? await prisma.connectedAccount.findMany({
        where: { id: accountId },
        select: { id: true, provider: true },
      })
    : await prisma.connectedAccount.findMany({
        where: {
          status: { in: ['connected', 'unauthorized'] },
          OR: [
            { storageAccount: { is: null } },
            { storageAccount: { lastSyncedAt: { lt: staleCutoff } } },
          ],
        },
        orderBy: { updatedAt: 'asc' },
        take: RUN_CAP,
        select: { id: true, provider: true },
      })
  const targets = accounts.filter(
    (account) => registry.tryGet(account.provider)?.capabilities.has('getQuota') === true,
  )
  const deadline = Date.now() + RUN_BUDGET_MS
  let refreshed = 0
  let failed = 0
  let step = 0
  for (const account of targets) {
    if (ctx.signal.aborted || Date.now() >= deadline) break
    try {
      await refreshQuota(account.id)
      refreshed += 1
    } catch (error) {
      failed += 1
      ctx.logger.warn('quota refresh failed', {
        accountId: account.id,
        provider: account.provider,
        error: (error as Error).message,
      })
    }
    step += 1
    ctx.reportProgress(Math.round((step / targets.length) * 100))
  }
  ctx.logger.info('quota refresh completed', { total: targets.length, refreshed, failed })
  return { total: targets.length, refreshed, failed }
}
