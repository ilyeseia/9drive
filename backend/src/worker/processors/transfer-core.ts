/**
 * Shared streaming transfer core for REPLICATION and MIGRATION —
 * docs/architecture/contracts/job-contract.md, api-contract §4.5/§4.6.
 *
 * Objects are copied by streaming `download` -> `upload` through a bounded
 * pipeline; nothing is ever buffered in memory. Folder structure is recreated
 * on the target by walking the source tree with cursor-paginated `list`.
 */

import { Readable } from 'node:stream'
import { buildContext } from '../../providers/context.js'
import { registry } from '../../providers/registry.js'

/** Minimal slice of the job context the transfer core needs. */
export interface TransferContext {
  signal: AbortSignal
  reportProgress: (pct: number, meta?: Record<string, unknown>) => void
}

export const TRANSFER_PAGE_SIZE = 100
export const TRANSFER_CONCURRENCY = 4

export interface TransferEntry {
  remoteId: string
  name: string
  mimeType: string
  sizeBytes: bigint
  parentId: string | null
  isFolder: boolean
}

export interface TransferFailure {
  remoteId: string
  name: string
  message: string
}

export interface TransferProgress {
  filesTotal: number
  filesDone: number
  filesFailed: number
  bytes: bigint
}

export interface TransferResult {
  filesTotal: number
  filesDone: number
  filesFailed: number
  bytes: bigint
  failures: TransferFailure[]
}

export interface TransferSide {
  provider: ReturnType<typeof registry.get>
  context: Awaited<ReturnType<typeof buildContext>>
  /** Root remote id that maps to `parentId: null` on this side. */
  rootRemoteId: string | null
}

export interface TransferPlan {
  source: TransferSide
  target: TransferSide
  /** Source remote ids that must not be re-uploaded (already present on target). */
  skipRemoteIds: ReadonlySet<string>
  /** When true a verified source object is deleted after a successful copy. */
  deleteSourceAfterCopy: boolean
}

export class TransferAbortedError extends Error {
  constructor() {
    super('transfer aborted')
    this.name = 'TransferAbortedError'
  }
}

function requireCapability(side: TransferSide, capability: 'download' | 'upload' | 'list' | 'createFolder' | 'delete'): void {
  if (!side.provider.capabilities.has(capability)) {
    throw new Error(`provider '${side.provider.id}' does not declare capability '${capability}'`)
  }
}

export function assertTransferCapabilities(plan: Pick<TransferPlan, 'source' | 'target'>): void {
  requireCapability(plan.source, 'download')
  requireCapability(plan.source, 'list')
  requireCapability(plan.target, 'upload')
  requireCapability(plan.target, 'list')
  requireCapability(plan.target, 'createFolder')
}

async function listPage(side: TransferSide, parentId: string | null, cursor: string | null): Promise<{ entries: TransferEntry[]; nextCursor: string | null }> {
  const result = await side.provider.list(side.context, { parentId, cursor, limit: TRANSFER_PAGE_SIZE })
  return {
    entries: result.entries.map((entry) => ({
      remoteId: entry.remoteId,
      name: entry.name,
      mimeType: entry.mimeType,
      sizeBytes: entry.sizeBytes,
      parentId: entry.parentId,
      isFolder: entry.isFolder,
    })),
    nextCursor: result.nextCursor ?? null,
  }
}

async function* walkFolder(plan: TransferPlan, folderRemoteId: string | null, cursor: string | null): AsyncGenerator<TransferEntry> {
  let pageCursor = cursor
  for (;;) {
    const { entries, nextCursor } = await listPage(plan.source, folderRemoteId, pageCursor)
    for (const entry of entries) {
      yield entry
      if (entry.isFolder) yield* walkFolder(plan, entry.remoteId, null)
    }
    if (!nextCursor) return
    pageCursor = nextCursor
  }
}

/** Depth-first walk of the source tree, descending into each folder before its siblings. */
export async function* walkSourceTree(plan: TransferPlan, scopeFolderIds?: string[]): AsyncGenerator<TransferEntry> {
  if (scopeFolderIds && scopeFolderIds.length > 0) {
    for (const remoteId of scopeFolderIds) {
      const meta = await plan.source.provider.getMetadata(plan.source.context, { remoteId })
      const entry: TransferEntry = {
        remoteId: meta.remoteId,
        name: meta.name,
        mimeType: meta.mimeType,
        sizeBytes: meta.sizeBytes,
        parentId: meta.parentId,
        isFolder: true,
      }
      yield entry
      yield* walkFolder(plan, remoteId, null)
    }
    return
  }
  yield* walkFolder(plan, plan.source.rootRemoteId, null)
}

/** Maps a source parent remote id onto the target, creating missing folders. */
export async function ensureTargetFolder(plan: TransferPlan, sourceParentId: string | null, cache: Map<string, string | null>): Promise<string | null> {
  if (sourceParentId === null) return plan.target.rootRemoteId
  const cached = cache.get(sourceParentId)
  if (cached !== undefined) return cached

  const sourceMeta = await plan.source.provider.getMetadata(plan.source.context, { remoteId: sourceParentId })
  const created = await plan.target.provider.createFolder(plan.target.context, {
    name: sourceMeta.name,
    parentId: await ensureTargetFolder(plan, sourceMeta.parentId, cache),
  })
  cache.set(sourceParentId, created.remoteId)
  return created.remoteId
}

async function copyOne(plan: TransferPlan, entry: TransferEntry, targetParentId: string | null): Promise<bigint> {
  const result = await plan.source.provider.download(plan.source.context, { remoteId: entry.remoteId })
  const stream = result.stream
  const sizeBytes = result.sizeBytes ?? entry.sizeBytes

  const passThrough = new Readable({
    read() {
      stream.resume()
    },
  })
  stream.on('data', (chunk: Buffer | string) => {
    if (!passThrough.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)) stream.pause()
  })
  stream.on('end', () => passThrough.push(null))
  stream.on('error', (error: Error) => passThrough.destroy(error))

  const uploaded = await plan.target.provider.upload(plan.target.context, {
    stream: passThrough,
    fileName: entry.name,
    mimeType: entry.mimeType,
    sizeBytes,
    parentId: targetParentId,
  })

  if (plan.deleteSourceAfterCopy) {
    await plan.source.provider.delete(plan.source.context, { remoteId: entry.remoteId, permanent: true })
  }
  return uploaded.sizeBytes
}

/**
 * Runs the transfer with bounded concurrency. Folder creation is serialised
 * (it defines the parent mapping); object copies run in parallel and individual
 * failures are collected instead of aborting the run.
 */
export async function runTransfer(
  plan: TransferPlan,
  scopeFolderIds: string[] | undefined,
  ctx: TransferContext,
  onProgress: (progress: TransferProgress) => void,
): Promise<TransferResult> {
  const failures: TransferFailure[] = []
  const folderCache = new Map<string, string | null>()
  let filesTotal = 0
  let filesDone = 0
  let filesFailed = 0
  let bytes = 0n

  const emit = () => onProgress({ filesTotal, filesDone, filesFailed, bytes })

  type Pending = { entry: TransferEntry; targetParentId: string | null }
  const queue: Pending[] = []
  const inflight = new Set<Promise<void>>()

  const drain = async (): Promise<void> => {
    while (queue.length > 0 && inflight.size < TRANSFER_CONCURRENCY) {
      const job = queue.shift()!
      if (ctx.signal.aborted) throw new TransferAbortedError()
      const task = (async () => {
        try {
          const copied = await copyOne(plan, job.entry, job.targetParentId)
          filesDone += 1
          bytes += copied
        } catch (error) {
          filesFailed += 1
          failures.push({
            remoteId: job.entry.remoteId,
            name: job.entry.name,
            message: error instanceof Error ? error.message : 'copy failed',
          })
        } finally {
          emit()
        }
      })()
      inflight.add(task)
      void task.finally(() => inflight.delete(task))
    }
  }

  for await (const entry of walkSourceTree(plan, scopeFolderIds)) {
    if (ctx.signal.aborted) throw new TransferAbortedError()
    if (entry.isFolder) {
      const targetParentId = await ensureTargetFolder(plan, entry.parentId, folderCache)
      const created = await plan.target.provider.createFolder(plan.target.context, {
        name: entry.name,
        parentId: targetParentId,
      })
      folderCache.set(entry.remoteId, created.remoteId)
      filesTotal += 1
      filesDone += 1
      emit()
      continue
    }
    if (plan.skipRemoteIds.has(entry.remoteId)) {
      filesTotal += 1
      filesDone += 1
      emit()
      continue
    }
    filesTotal += 1
    emit()
    queue.push({ entry, targetParentId: await ensureTargetFolder(plan, entry.parentId, folderCache) })
    await drain()
  }

  await drain()
  while (inflight.size > 0 || queue.length > 0) {
    await drain()
    if (inflight.size > 0) await Promise.all([...inflight])
  }
  emit()

  return { filesTotal, filesDone, filesFailed, bytes, failures }
}
