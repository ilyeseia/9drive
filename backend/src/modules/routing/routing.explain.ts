/**
 * Routing dry-run for api-contract.md §4.4: `selectAccount` makes the choice,
 * this module explains it — which candidates each step eliminated and which
 * policy rule matched. Round-robin cursor advances made by the dry run are
 * rolled back so a preview never perturbs real routing.
 */

import type { ConnectedAccount, StorageAccount, UploadRoutingPolicy } from '@prisma/client'
import { prisma } from '../../config/prisma.js'
import { registry } from '../../providers/registry.js'
import { ROUTING_MODES, selectAccount, type RoutingMode } from '../../providers/routing.js'
import type { Capability } from '../../providers/types.js'
import { getOrCreateRoutingPolicy } from './routing.service.js'

export type RoutingStep = { step: string; candidates: number; eliminated: number; detail: string }

type FileTypeRule = { match: string; preferProvider?: string }

type SelectedRow = ConnectedAccount & { storageAccount: StorageAccount | null }

export type RoutingPreview = {
  bytes: string
  fileType: string | null
  folderId: string | null
  mode: string
  account: { id: string; provider: string; displayName: string | null; email: string; status: string } | null
  reason: string
  matchedRule: FileTypeRule | null
  steps: RoutingStep[]
}

const REQUIRED_CAPABILITIES: Capability[] = ['upload']
const DISALLOWED_HEALTH = ['unauthorized', 'unreachable']

function normalizeMode(mode: string): RoutingMode {
  return (ROUTING_MODES as readonly string[]).includes(mode) ? (mode as RoutingMode) : 'most_available'
}

function normalizeIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

function readRules(policy: UploadRoutingPolicy): FileTypeRule[] {
  const rules = policy.fileTypeRules
  if (!Array.isArray(rules)) return []
  const parsed: FileTypeRule[] = []
  for (const entry of rules) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    if (typeof record.match !== 'string') continue
    parsed.push({
      match: record.match,
      ...(typeof record.preferProvider === 'string' ? { preferProvider: record.preferProvider } : {}),
    })
  }
  return parsed
}

function matchesFileType(pattern: string, fileType: string): boolean {
  const rule = pattern.trim().toLowerCase()
  const candidate = fileType.trim().toLowerCase()
  if (rule === '*' || rule === '*/*') return true
  if (rule.endsWith('/*')) return candidate.startsWith(rule.slice(0, -1))
  return rule === candidate
}

function preferredProviders(rules: FileTypeRule[]): string[] {
  const providers: string[] = []
  for (const rule of rules) {
    if (rule.preferProvider && !providers.includes(rule.preferProvider)) providers.push(rule.preferProvider)
  }
  return providers
}

function byteText(value: bigint): string {
  return value.toString()
}

function describeMode(
  mode: RoutingMode,
  ctx: {
    policy: UploadRoutingPolicy
    bytes: bigint
    fileType: string | null
    rules: FileTypeRule[]
    matchedRule: FileTypeRule | null
    selected: SelectedRow | null
    candidates: ConnectedAccount[]
  },
): string {
  const { policy, bytes, fileType, rules, matchedRule, selected, candidates } = ctx
  const available = selected?.storageAccount?.availableBytes ?? null
  switch (mode) {
    case 'least_used': {
      const used = selected?.storageAccount?.usedBytes ?? 0n
      return `least_used orders candidates by used space, smallest first; selected account uses ${byteText(used)} byte(s)`
    }
    case 'priority': {
      const priority = normalizeIds(policy.priorityAccountIds)
      const rank = selected ? priority.indexOf(selected.id) : -1
      return rank >= 0
        ? `priority rule ranks the selected account at position ${rank + 1} of ${priority.length}`
        : `priority rule list ${priority.length > 0 ? priority.join(', ') : '(empty)'} does not include the selected account, so creation order breaks the tie`
    }
    case 'round_robin': {
      const cursor = Number.isFinite(policy.roundRobinCursor) ? policy.roundRobinCursor : 0
      const size = Math.max(candidates.length, 1)
      const position = ((cursor % size) + size) % size + 1
      return `round_robin rule advanced cursor ${cursor} and selected position ${position} of ${size} candidates in priority order`
    }
    case 'provider_preference': {
      const preferred = preferredProviders(rules)
      return `provider_preference rule orders preferred providers [${preferred.join(', ')}] first, then available space`
    }
    case 'file_type': {
      if (!fileType) return 'file_type rule requires a fileType input to match against policy rules'
      if (matchedRule) {
        return `file_type rule '${matchedRule.match}' matched '${fileType}'${matchedRule.preferProvider ? ` and prefers provider ${matchedRule.preferProvider}` : ''}`
      }
      const preferred = preferredProviders(rules)
      return `no file_type rule matched '${fileType}'; rule providers [${preferred.join(', ')}] still order candidates`
    }
    case 'file_size': {
      const min = policy.minFileSizeBytes
      const max = policy.maxFileSizeBytes
      const inside = (min === null || bytes >= min) && (max === null || bytes <= max)
      const window = `[${min === null ? 'any' : byteText(min)}, ${max === null ? 'any' : byteText(max)}]`
      return `file_size rule window ${window}: ${byteText(bytes)} byte(s) ${inside ? 'inside the window, so best-fit ordering applies' : 'outside the window, so ordering falls back to available space'}`
    }
    case 'health_aware':
      return `health_aware rule ranks candidates by health state, then available space${available !== null ? `; selected account has ${byteText(available)} free byte(s)` : ''}`
    case 'user_policy':
      return `user_policy rule combines the priority list, rule provider preferences and available space${available !== null ? `; selected account has ${byteText(available)} free byte(s)` : ''}`
    default:
      return `most_available rule picks the largest available space${available !== null ? `; selected account has ${byteText(available)} free byte(s)` : ''}`
  }
}

function eliminatedIds(before: ConnectedAccount[], after: ConnectedAccount[]): string[] {
  const kept = new Set(after.map((account) => account.id))
  return before.filter((account) => !kept.has(account.id)).map((account) => account.id)
}

function droppedProviders(before: ConnectedAccount[], after: ConnectedAccount[]): string[] {
  const removed = new Set(eliminatedIds(before, after))
  return [...new Set(before.filter((account) => removed.has(account.id)).map((account) => account.provider))]
}

async function rollbackRoundRobinCursor(policy: UploadRoutingPolicy): Promise<void> {
  const fresh = await prisma.uploadRoutingPolicy.findUnique({
    where: { id: policy.id },
    select: { roundRobinCursor: true },
  })
  const after = fresh?.roundRobinCursor
  if (after === undefined || after === policy.roundRobinCursor) return
  await prisma.uploadRoutingPolicy
    .updateMany({
      where: { id: policy.id, roundRobinCursor: after },
      data: { roundRobinCursor: after - 1 },
    })
    .catch(() => undefined)
}

export async function previewRouting(input: {
  userId: string
  bytes: bigint
  fileType?: string
  folderId?: string
  targetAccountId?: string
}): Promise<RoutingPreview> {
  const policy = await getOrCreateRoutingPolicy(input.userId)
  const mode = normalizeMode(policy.mode)

  const chosen = await selectAccount({
    userId: input.userId,
    requiredBytes: input.bytes,
    requiredCapabilities: [...REQUIRED_CAPABILITIES],
    targetAccountId: input.targetAccountId ?? null,
    folderId: input.folderId ?? null,
  })
  if (mode === 'round_robin') await rollbackRoundRobinCursor(policy)
  const selected: SelectedRow | null = chosen
    ? await prisma.connectedAccount.findFirst({
        where: { id: chosen.account.id, userId: input.userId },
        include: { storageAccount: true },
      })
    : null

  const steps: RoutingStep[] = []
  if (input.targetAccountId) {
    steps.push({
      step: 'target',
      candidates: 1,
      eliminated: 0,
      detail: `uploads are pinned to account ${input.targetAccountId}`,
    })
  }

  let candidates = await prisma.connectedAccount.findMany({
    where: {
      userId: input.userId,
      status: 'connected',
      ...(input.targetAccountId ? { id: input.targetAccountId } : {}),
    },
    include: { storageAccount: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  steps.push({
    step: 'connected',
    candidates: candidates.length,
    eliminated: 0,
    detail: `${candidates.length} connected account(s) visible to this user`,
  })

  const supported = new Set(registry.supportedIds())
  let before = candidates
  candidates = candidates.filter((account) => supported.has(account.provider))
  const removedProviders = droppedProviders(before, candidates)
  steps.push({
    step: 'provider_supported',
    candidates: candidates.length,
    eliminated: before.length - candidates.length,
    detail:
      removedProviders.length > 0
        ? `unsupported provider(s) removed: ${removedProviders.join(', ')}`
        : 'every candidate provider is supported by the registry',
  })

  before = candidates
  candidates = candidates.filter((account) =>
    REQUIRED_CAPABILITIES.every((capability) => registry.capabilities(account.provider).has(capability)),
  )
  steps.push({
    step: 'capabilities',
    candidates: candidates.length,
    eliminated: before.length - candidates.length,
    detail:
      before.length === candidates.length
        ? 'all candidates declare the upload capability'
        : 'account(s) without the upload capability removed',
  })

  before = candidates
  candidates = candidates.filter((account) => {
    const available = account.storageAccount?.availableBytes ?? null
    return available === null || available >= input.bytes
  })
  steps.push({
    step: 'quota_headroom',
    candidates: candidates.length,
    eliminated: before.length - candidates.length,
    detail:
      before.length === candidates.length
        ? `all candidates can hold ${byteText(input.bytes)} byte(s)`
        : `account(s) without ${byteText(input.bytes)} free byte(s) removed`,
  })

  const healthRows =
    candidates.length > 0
      ? await prisma.providerHealth.findMany({
          where: { connectedAccountId: { in: candidates.map((account) => account.id) } },
          select: { connectedAccountId: true, state: true },
        })
      : []
  const healthByAccount = new Map<string, string>()
  for (const row of healthRows) {
    if (row.connectedAccountId) healthByAccount.set(row.connectedAccountId, row.state)
  }
  before = candidates
  if (mode === 'health_aware') {
    steps.push({
      step: 'health',
      candidates: candidates.length,
      eliminated: 0,
      detail: 'health_aware ranks candidates by health state instead of removing any',
    })
  } else {
    candidates = candidates.filter(
      (account) => !DISALLOWED_HEALTH.includes(healthByAccount.get(account.id) ?? 'unknown'),
    )
    steps.push({
      step: 'health',
      candidates: candidates.length,
      eliminated: before.length - candidates.length,
      detail:
        before.length === candidates.length
          ? 'no candidate is unreachable or unauthorized'
          : 'unreachable/unauthorized account(s) removed',
    })
  }

  const rules = readRules(policy)
  const matchedRule =
    input.fileType !== undefined ? rules.find((rule) => matchesFileType(rule.match, input.fileType!)) ?? null : null
  const modeDetail = describeMode(mode, { policy, bytes: input.bytes, fileType: input.fileType ?? null, rules, matchedRule, selected, candidates })
  steps.push({ step: 'mode', candidates: candidates.length, eliminated: 0, detail: modeDetail })

  const chosenStillCandidate = selected ? candidates.some((account) => account.id === selected.id) : false
  steps.push({
    step: 'selected',
    candidates: chosenStillCandidate ? candidates.length : 0,
    eliminated: 0,
    detail: selected
      ? `account ${selected.id} (${selected.provider}) chosen${chosenStillCandidate ? '' : ' after live reservation checks'}`
      : 'no eligible account remained after the steps above',
  })

  const reason = selected
    ? `mode=${mode}: ${modeDetail}`
    : `no eligible account: ${steps.filter((step) => step.eliminated > 0).map((step) => step.detail).join('; ') || 'no connected accounts'}`

  return {
    bytes: byteText(input.bytes),
    fileType: input.fileType ?? null,
    folderId: input.folderId ?? null,
    mode,
    account: selected
      ? {
          id: selected.id,
          provider: selected.provider,
          displayName: selected.displayName,
          email: selected.email,
          status: selected.status,
        }
      : null,
    reason,
    matchedRule,
    steps,
  }
}
