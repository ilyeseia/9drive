/**
 * Transfer core tests — job-contract.md, api-contract §4.5/§4.6.
 *
 * Uses two FakeProvider instances as source and target so the streaming copy,
 * folder recreation, per-file failure collection and move-mode deletion are all
 * exercised offline without a real provider.
 */

import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createFakeProvider } from '../../providers/fake.js'
import { registry } from '../../providers/registry.js'
import type { Capability } from '../../providers/types.js'
import {
  assertTransferCapabilities,
  runTransfer,
  TransferAbortedError,
  walkSourceTree,
  type TransferPlan,
} from '../../worker/processors/transfer-core.js'

function makeContext(accountId: string) {
  return {
    credentials: {},
    account: {
      id: accountId,
      userId: 'user-1',
      provider: 'fake',
      providerAccountId: accountId,
      config: {},
    },
  } as never
}

async function makePlan(options: {
  sourceCapabilities?: Capability[]
  targetCapabilities?: Capability[]
  deleteSourceAfterCopy?: boolean
  sourceFailures?: Parameters<ReturnType<typeof createFakeProvider>['injectFailure']>[0][]
}): Promise<{ plan: TransferPlan; source: ReturnType<typeof createFakeProvider>; target: ReturnType<typeof createFakeProvider> }> {
  const source = createFakeProvider({
    id: 'fake',
    authMode: 'api_key',
    capabilities: options.sourceCapabilities ?? ['download', 'upload', 'list', 'createFolder', 'delete', 'copy', 'getMetadata'],
  })
  const target = createFakeProvider({
    id: 'fake',
    authMode: 'api_key',
    capabilities: options.targetCapabilities ?? ['download', 'upload', 'list', 'createFolder', 'delete', 'copy', 'getMetadata'],
  })
  for (const failure of options.sourceFailures ?? []) source.injectFailure(failure)
  const plan: TransferPlan = {
    source: { provider: source, context: makeContext('source-account'), rootRemoteId: null },
    target: { provider: target, context: makeContext('target-account'), rootRemoteId: null },
    skipRemoteIds: new Set(),
    deleteSourceAfterCopy: options.deleteSourceAfterCopy ?? false,
  }
  return { plan, source, target }
}

const ctx = {
  signal: new AbortController().signal,
  reportProgress: () => undefined,
} as never

describe('assertTransferCapabilities', () => {
  it('rejects a provider missing a required capability', async () => {
    const { plan } = await makePlan({ targetCapabilities: ['upload', 'list'] })
    expect(() => assertTransferCapabilities(plan)).toThrow(/does not declare capability/)
  })

  it('accepts two accounts of the same provider', async () => {
    const { plan } = await makePlan({})
    expect(() => assertTransferCapabilities(plan)).not.toThrow()
  })
})

describe('walkSourceTree', () => {
  it('yields folders before their contents and paginates', async () => {
    const { plan, source } = await makePlan({})
    source.seedFolder({ name: 'root' })
    const root = source.listSeed().find((entry) => entry.name === 'root')!
    source.seedFolder({ name: 'child', parentId: root.remoteId })
    const child = source.listSeed().find((entry) => entry.name === 'child')!
    source.seedFile({ name: 'a.txt', parentId: root.remoteId, content: 'a' })
    source.seedFile({ name: 'b.txt', parentId: child.remoteId, content: 'b' })

    const entries = []
    for await (const entry of walkSourceTree(plan)) entries.push(entry)
    const names = entries.map((entry) => entry.name)
    expect(names).toEqual(['root', 'a.txt', 'child', 'b.txt'])
  })

  it('walks only the scoped subtree when folderIds are given', async () => {
    const { plan, source } = await makePlan({})
    source.seedFolder({ name: 'root' })
    const root = source.listSeed().find((entry) => entry.name === 'root')!
    source.seedFolder({ name: 'child', parentId: root.remoteId })
    const child = source.listSeed().find((entry) => entry.name === 'child')!
    source.seedFile({ name: 'inside.txt', parentId: child.remoteId, content: 'x' })
    source.seedFile({ name: 'outside.txt', parentId: root.remoteId, content: 'y' })

    const entries = []
    for await (const entry of walkSourceTree(plan, [child.remoteId])) entries.push(entry)
    expect(entries.map((entry) => entry.name)).toEqual(['child', 'inside.txt'])
  })
})

describe('runTransfer', () => {
  it('copies files and recreates the folder structure', async () => {
    const { plan, source, target } = await makePlan({})
    source.seedFolder({ name: 'root' })
    const root = source.listSeed().find((entry) => entry.name === 'root')!
    source.seedFolder({ name: 'child', parentId: root.remoteId })
    const child = source.listSeed().find((entry) => entry.name === 'child')!
    source.seedFile({ name: 'a.txt', parentId: root.remoteId, content: 'aaa' })
    source.seedFile({ name: 'b.txt', parentId: child.remoteId, content: 'bb' })

    const progress: Array<{ filesTotal: number; filesDone: number }> = []
    const result = await runTransfer(plan, undefined, ctx, (p) => progress.push({ filesTotal: p.filesTotal, filesDone: p.filesDone }))

    expect(result.filesTotal).toBe(4)
    expect(result.filesFailed).toBe(0)
    expect(result.bytes).toBe(5n)
    expect(progress.at(-1)).toEqual({ filesTotal: 4, filesDone: 4 })

    const copied = target.listSeed().map((entry) => entry.name).sort()
    expect(copied).toEqual(['a.txt', 'b.txt', 'child', 'root'])
    const copiedChild = target.listSeed().find((entry) => entry.name === 'child')!
    const nested = target.listSeed().filter((entry) => entry.parentId === copiedChild.remoteId)
    expect(nested.map((entry) => entry.name)).toEqual(['b.txt'])
  })

  it('streams content intact', async () => {
    const { plan, source, target } = await makePlan({})
    const payload = 'x'.repeat(5000)
    source.seedFile({ name: 'big.bin', content: payload })
    const result = await runTransfer(plan, undefined, ctx, () => undefined)
    expect(result.filesFailed).toBe(0)
    const copied = target.listSeed().find((entry) => entry.name === 'big.bin')!
    expect(target.getContent(copied.remoteId)?.toString('utf8')).toBe(payload)
  })

  it('collects per-file failures instead of aborting', async () => {
    const { plan, source, target } = await makePlan({
      sourceFailures: [{ operation: 'download', code: 'ERR_UPSTREAM_UNAVAILABLE', times: 1 }],
    })
    source.seedFile({ name: 'good.txt', content: 'ok' })
    source.seedFile({ name: 'bad.txt', content: 'nope' })

    const result = await runTransfer(plan, undefined, ctx, () => undefined)
    expect(result.filesTotal).toBe(2)
    expect(result.filesFailed).toBe(1)
    expect(result.filesDone).toBe(1)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]!.name).toBe('bad.txt')
    expect(target.listSeed().map((entry) => entry.name)).toEqual(['good.txt'])
  })

  it('skips remote ids listed in skipRemoteIds', async () => {
    const { plan, source, target } = await makePlan({})
    source.seedFile({ name: 'a.txt', content: 'a' })
    source.seedFile({ name: 'b.txt', content: 'b' })
    const entries = source.listSeed()
    plan.skipRemoteIds = new Set([entries[0]!.remoteId])

    const result = await runTransfer(plan, undefined, ctx, () => undefined)
    expect(result.filesTotal).toBe(2)
    expect(result.filesDone).toBe(2)
    expect(target.listSeed().map((entry) => entry.name)).toEqual(['b.txt'])
  })

  it('deletes the source object after a verified copy in move mode', async () => {
    const { plan, source, target } = await makePlan({ deleteSourceAfterCopy: true })
    source.seedFile({ name: 'a.txt', content: 'a' })
    source.seedFile({ name: 'b.txt', content: 'b' })

    const result = await runTransfer(plan, undefined, ctx, () => undefined)
    expect(result.filesFailed).toBe(0)
    expect(source.listSeed()).toHaveLength(0)
    expect(target.listSeed().map((entry) => entry.name).sort()).toEqual(['a.txt', 'b.txt'])
  })

  it('keeps the source when a move-mode copy fails', async () => {
    const { plan, source, target } = await makePlan({
      deleteSourceAfterCopy: true,
      sourceFailures: [{ operation: 'download', code: 'ERR_UPSTREAM_UNAVAILABLE', times: 1 }],
    })
    source.seedFile({ name: 'good.txt', content: 'ok' })
    source.seedFile({ name: 'bad.txt', content: 'nope' })

    const result = await runTransfer(plan, undefined, ctx, () => undefined)
    expect(result.filesFailed).toBe(1)
    expect(target.listSeed().map((entry) => entry.name)).toEqual(['good.txt'])
    expect(source.listSeed().map((entry) => entry.name)).toEqual(['bad.txt'])
  })

  it('throws TransferAbortedError when the signal is already aborted', async () => {
    const { plan, source } = await makePlan({})
    source.seedFile({ name: 'a.txt', content: 'a' })
    const controller = new AbortController()
    controller.abort()
    await expect(
      runTransfer(plan, undefined, { signal: controller.signal, reportProgress: () => undefined } as never, () => undefined),
    ).rejects.toBeInstanceOf(TransferAbortedError)
  })

  it('reports progress that never decreases', async () => {
    const { plan, source } = await makePlan({})
    for (let index = 0; index < 5; index += 1) source.seedFile({ name: `f${index}.txt`, content: `${index}` })
    const seen: number[] = []
    await runTransfer(plan, undefined, ctx, (p) => seen.push(p.filesDone))
    for (let index = 1; index < seen.length; index += 1) {
      expect(seen[index]).toBeGreaterThanOrEqual(seen[index - 1])
    }
    expect(seen.at(-1)).toBe(5)
  })
})

describe('stream integrity', () => {
  it('pipes a provider stream without loading it into memory', async () => {
    const source = createFakeProvider({})
    const payload = 'z'.repeat(100)
    source.seedFile({ name: 'f.txt', content: payload })
    const entry = source.listSeed()[0]!
    const downloaded = await source.download(makeContext('a') as never, { remoteId: entry.remoteId })
    const chunks: Buffer[] = []
    for await (const chunk of downloaded.stream as AsyncIterable<Buffer>) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    }
    expect(Buffer.concat(chunks).toString('utf8')).toBe(payload)
    expect(Readable.fromWeb).toBeDefined()
  })
})
