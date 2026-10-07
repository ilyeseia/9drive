import { prisma } from '../../config/prisma.js'
import { checkAccount, registry } from '../../providers/index.js'
import type { JobPayloads } from '../../queues/job-types.js'
import type { JobHandler } from '../types.js'

const STALE_AFTER_MS = 5 * 60_000
const RUN_CAP = 25
const RUN_BUDGET_MS = 40_000

export const healthCheckHandler: JobHandler<JobPayloads['HEALTH_CHECK']> = async (ctx) => {
  const { accountId } = ctx.payload
  const staleCutoff = new Date(Date.now() - STALE_AFTER_MS)
  const candidates = accountId
    ? await prisma.connectedAccount.findMany({
        where: { id: accountId },
        select: { id: true, provider: true },
      })
    : await prisma.connectedAccount.findMany({
        where: { status: { in: ['connected', 'unauthorized'] } },
        orderBy: { updatedAt: 'asc' },
        take: RUN_CAP,
        select: { id: true, provider: true },
      })
  let targets = candidates.filter((account) => registry.has(account.provider))
  if (!accountId && targets.length > 0) {
    const healths = await prisma.providerHealth.findMany({
      where: { connectedAccountId: { in: targets.map((account) => account.id) } },
      select: { connectedAccountId: true, checkedAt: true },
    })
    const checkedAtById = new Map(
      healths
        .filter((row) => row.connectedAccountId)
        .map((row) => [row.connectedAccountId as string, row.checkedAt]),
    )
    targets = targets.filter((account) => {
      const checkedAt = checkedAtById.get(account.id)
      return !checkedAt || checkedAt.getTime() < staleCutoff.getTime()
    })
  }
  const deadline = Date.now() + RUN_BUDGET_MS
  let checked = 0
  let failed = 0
  let step = 0
  for (const account of targets) {
    if (ctx.signal.aborted || Date.now() >= deadline) break
    try {
      await checkAccount(account.id)
      checked += 1
    } catch (error) {
      failed += 1
      ctx.logger.warn('health check failed', {
        accountId: account.id,
        provider: account.provider,
        error: (error as Error).message,
      })
    }
    step += 1
    ctx.reportProgress(Math.round((step / targets.length) * 100))
  }
  ctx.logger.info('health check completed', { total: targets.length, checked, failed })
  return { total: targets.length, checked, failed }
}
