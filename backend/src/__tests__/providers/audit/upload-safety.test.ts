import { describe, expect, it } from 'vitest'
import { recordWithCompensation } from '../../../modules/uploads/compensation.js'
import { mapWithConcurrency } from '../../../utils/concurrency.js'
import type { ProviderContext } from '../../../providers/types.js'

const ctx = {} as ProviderContext

function fakeProvider(options: { canDelete?: boolean; deleteFails?: boolean } = {}) {
  const deleted: string[] = []
  return {
    deleted,
    provider: {
      capabilities: new Set(options.canDelete === false ? [] : ['delete']),
      delete: async (_ctx: ProviderContext, input: { remoteId: string; permanent?: boolean }) => {
        if (options.deleteFails) throw new Error('provider down')
        deleted.push(`${input.remoteId}:${String(input.permanent)}`)
      },
    } as never,
  }
}

describe('recordWithCompensation', () => {
  it('returns the record result and leaves the remote object alone on success', async () => {
    const { provider, deleted } = fakeProvider()
    await expect(recordWithCompensation(provider, ctx, 'r1', async () => 'row')).resolves.toBe('row')
    expect(deleted).toEqual([])
  })

  it('deletes the remote object when the database write fails and rethrows the original error', async () => {
    const { provider, deleted } = fakeProvider()
    const outcomes: string[] = []
    await expect(
      recordWithCompensation(provider, ctx, 'r2', async () => { throw new Error('db down') }, (o) => outcomes.push(o)),
    ).rejects.toThrow('db down')
    expect(deleted).toEqual(['r2:true'])
    expect(outcomes).toEqual(['deleted'])
  })

  it('reports failure or lack of support without masking the database error', async () => {
    const failing = fakeProvider({ deleteFails: true })
    const outcomes: string[] = []
    await expect(
      recordWithCompensation(failing.provider, ctx, 'r3', async () => { throw new Error('db down') }, (o) => outcomes.push(o)),
    ).rejects.toThrow('db down')
    const unsupported = fakeProvider({ canDelete: false })
    await expect(
      recordWithCompensation(unsupported.provider, ctx, 'r4', async () => { throw new Error('db down 2') }, (o) => outcomes.push(o)),
    ).rejects.toThrow('db down 2')
    expect(outcomes).toEqual(['failed', 'unsupported'])
  })
})

describe('mapWithConcurrency', () => {
  it('never exceeds the limit, keeps order and isolates failures', async () => {
    let inFlight = 0
    let peak = 0
    const results = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8], 3, async (n) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 10))
      inFlight -= 1
      if (n === 4) throw new Error('boom')
      return n * 2
    })
    expect(peak).toBeLessThanOrEqual(3)
    expect(results.map((r) => (r.status === 'fulfilled' ? r.value : 'x'))).toEqual([2, 4, 6, 'x', 10, 12, 14, 16])
  })

  it('handles empty input', async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([])
  })
})
