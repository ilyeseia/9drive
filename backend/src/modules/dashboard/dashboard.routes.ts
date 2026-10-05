/**
 * Dashboard summary — api-contract.md §4.2.
 * Counters come from `Job`, capacity/accounts from `ConnectedAccount` +
 * `StorageAccount`, recent activity from `StorageOperation`. BigInt -> string.
 */

import { Router } from 'express'
import { prisma } from '../../config/prisma.js'
import { type AuthRequest } from '../../middleware/auth.middleware.js'
import { serializeBigInt } from '../../utils/serialize.js'
import { requireSessionOrScope } from '../jobs/shared.js'

export const dashboardRouter = Router()
dashboardRouter.use(requireSessionOrScope('providers:read'))

const RECENT_OPERATIONS = 10

dashboardRouter.get('/summary', async (req: AuthRequest, res, next) => {
  try {
    const userId = req.user!.id
    const accounts = await prisma.connectedAccount.findMany({
      where: { userId },
      include: { storageAccount: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    const ownedIds = accounts.map((account) => account.id)
    const [healthRows, fileAggregates, jobGroups, operations] = await Promise.all([
      ownedIds.length > 0
        ? prisma.providerHealth.findMany({
            where: { connectedAccountId: { in: ownedIds } },
            select: { connectedAccountId: true, state: true },
          })
        : Promise.resolve([]),
      prisma.file.aggregate({
        where: { userId, status: 'active' },
        _count: { _all: true },
        _sum: { sizeBytes: true },
      }),
      prisma.job.groupBy({ by: ['status'], where: { userId }, _count: { _all: true } }),
      prisma.storageOperation.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: RECENT_OPERATIONS,
        select: { operation: true, status: true, createdAt: true },
      }),
    ])

    const ownedSet = new Set(ownedIds)
    const healthByAccount = new Map<string, string>()
    for (const row of healthRows) {
      if (row.connectedAccountId && ownedSet.has(row.connectedAccountId)) {
        healthByAccount.set(row.connectedAccountId, row.state)
      }
    }

    let totalBytes = 0n
    let usedBytes = 0n
    let availableBytes = 0n
    const byProviderMap = new Map<
      string,
      { provider: string; accounts: number; usedBytes: bigint; totalBytes: bigint }
    >()
    for (const account of accounts) {
      if (account.status !== 'connected') continue
      const storage = account.storageAccount
      totalBytes += storage?.totalBytes ?? 0n
      usedBytes += storage?.usedBytes ?? 0n
      availableBytes += storage?.availableBytes ?? 0n
      const entry = byProviderMap.get(account.provider) ?? {
        provider: account.provider,
        accounts: 0,
        usedBytes: 0n,
        totalBytes: 0n,
      }
      entry.accounts += 1
      entry.usedBytes += storage?.usedBytes ?? 0n
      entry.totalBytes += storage?.totalBytes ?? 0n
      byProviderMap.set(account.provider, entry)
    }

    const jobCounts = { queued: 0, active: 0, failed: 0, completed: 0 }
    for (const group of jobGroups) {
      if (group.status in jobCounts) {
        jobCounts[group.status as keyof typeof jobCounts] = group._count._all
      }
    }

    const summary = {
      capacity: {
        totalBytes: totalBytes.toString(),
        usedBytes: usedBytes.toString(),
        availableBytes: availableBytes.toString(),
      },
      accounts: {
        total: accounts.length,
        connected: accounts.filter((account) => account.status === 'connected').length,
        degraded: accounts.filter((account) => healthByAccount.get(account.id) === 'degraded').length,
        unauthorized: accounts.filter(
          (account) => account.status === 'unauthorized' || healthByAccount.get(account.id) === 'unauthorized',
        ).length,
      },
      byProvider: [...byProviderMap.values()]
        .sort((a, b) => (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0))
        .map((entry) => ({
          provider: entry.provider,
          accounts: entry.accounts,
          usedBytes: entry.usedBytes.toString(),
          totalBytes: entry.totalBytes.toString(),
        })),
      files: {
        count: fileAggregates._count._all,
        bytes: (fileAggregates._sum.sizeBytes ?? 0n).toString(),
      },
      health: accounts.map((account) => ({
        accountId: account.id,
        provider: account.provider,
        state: healthByAccount.get(account.id) ?? 'unknown',
      })),
      jobs: jobCounts,
      recentOperations: operations.map((operation) => ({
        operation: operation.operation,
        status: operation.status,
        createdAt: operation.createdAt.toISOString(),
      })),
    }

    return res.json(serializeBigInt(summary))
  } catch (error) {
    return next(error)
  }
})
