/**
 * Upload routing policy persistence — api-contract.md §4.4/§6 (superset body of
 * PATCH /storage/routing-policy) and database-contract.md §3.3.
 */

import { Prisma, type UploadRoutingPolicy } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../../config/prisma.js'
import { ROUTING_MODES } from '../../providers/routing.js'
import { createAuditLog } from '../../utils/audit.js'

const fileTypeRuleSchema = z.object({
  match: z.string().trim().min(1).max(191),
  preferProvider: z.string().trim().min(1).max(32).optional(),
})

const byteAmount = z.union([z.number().int().min(0), z.string().regex(/^\d+$/)])

export const routingPolicyUpdateSchema = z
  .object({
    mode: z.enum(ROUTING_MODES).optional(),
    priorityAccountIds: z.array(z.string().min(1)).max(100).optional(),
    fileTypeRules: z.array(fileTypeRuleSchema).max(50).nullable().optional(),
    minFileSizeBytes: byteAmount.nullable().optional(),
    maxFileSizeBytes: byteAmount.nullable().optional(),
  })
  .refine(
    (body) => {
      if (body.minFileSizeBytes === null || body.maxFileSizeBytes === null) return true
      if (body.minFileSizeBytes === undefined || body.maxFileSizeBytes === undefined) return true
      return BigInt(body.maxFileSizeBytes) >= BigInt(body.minFileSizeBytes)
    },
    { message: 'maxFileSizeBytes must be greater than or equal to minFileSizeBytes' },
  )

export type RoutingPolicyUpdate = z.output<typeof routingPolicyUpdateSchema>

export async function getOrCreateRoutingPolicy(userId: string) {
  return prisma.uploadRoutingPolicy.upsert({
    where: { userId },
    create: { userId, mode: 'most_available', priorityAccountIds: [] },
    update: {},
  })
}

async function filterPriorityAccounts(userId: string, accountIds: string[]): Promise<string[]> {
  const unique = [...new Set(accountIds)]
  if (unique.length === 0) return []
  const rows = await prisma.connectedAccount.findMany({
    where: { id: { in: unique }, userId, status: 'connected' },
    select: { id: true },
  })
  const valid = new Set(rows.map((row) => row.id))
  return unique.filter((id) => valid.has(id))
}

export async function updateRoutingPolicy(userId: string, body: RoutingPolicyUpdate) {
  const priority = body.priorityAccountIds ? await filterPriorityAccounts(userId, body.priorityAccountIds) : undefined
  const create: Prisma.UploadRoutingPolicyUncheckedCreateInput = {
    userId,
    mode: body.mode ?? 'most_available',
    priorityAccountIds: priority ?? [],
    roundRobinCursor: 0,
    ...(body.fileTypeRules && Array.isArray(body.fileTypeRules) ? { fileTypeRules: body.fileTypeRules } : {}),
    ...(body.minFileSizeBytes !== null && body.minFileSizeBytes !== undefined
      ? { minFileSizeBytes: BigInt(body.minFileSizeBytes) }
      : {}),
    ...(body.maxFileSizeBytes !== null && body.maxFileSizeBytes !== undefined
      ? { maxFileSizeBytes: BigInt(body.maxFileSizeBytes) }
      : {}),
  }
  const update: Prisma.UploadRoutingPolicyUpdateInput = {
    ...(body.mode !== undefined ? { mode: body.mode } : {}),
    ...(priority !== undefined ? { priorityAccountIds: priority } : {}),
    ...(body.fileTypeRules !== undefined
      ? { fileTypeRules: body.fileTypeRules === null ? Prisma.DbNull : body.fileTypeRules }
      : {}),
    ...(body.minFileSizeBytes !== undefined
      ? { minFileSizeBytes: body.minFileSizeBytes === null ? null : BigInt(body.minFileSizeBytes) }
      : {}),
    ...(body.maxFileSizeBytes !== undefined
      ? { maxFileSizeBytes: body.maxFileSizeBytes === null ? null : BigInt(body.maxFileSizeBytes) }
      : {}),
    ...(body.mode !== undefined && body.mode !== 'round_robin' ? { roundRobinCursor: 0 } : {}),
  }
  const policy = await prisma.uploadRoutingPolicy.upsert({
    where: { userId },
    create,
    update,
  })
  await createAuditLog(userId, 'UPDATE_ROUTING_POLICY', 'routing_policy', policy.id, { mode: policy.mode })
  return policy
}

export function serializeRoutingPolicy(policy: UploadRoutingPolicy) {
  const rules = policy.fileTypeRules
  const priority = Array.isArray(policy.priorityAccountIds) ? policy.priorityAccountIds : []
  return {
    id: policy.id,
    mode: policy.mode,
    priorityAccountIds: priority.filter((entry): entry is string => typeof entry === 'string'),
    roundRobinCursor: policy.roundRobinCursor,
    fileTypeRules: Array.isArray(rules) ? rules : [],
    minFileSizeBytes: policy.minFileSizeBytes?.toString() ?? null,
    maxFileSizeBytes: policy.maxFileSizeBytes?.toString() ?? null,
    updatedAt: policy.updatedAt.toISOString(),
  }
}
