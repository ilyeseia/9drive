/**
 * Runs `worker` over `items` with at most `limit` calls in flight. Never rejects: each item's outcome is returned in
 * input order, so one slow or failing provider cannot fail (or fan out unboundedly across) the whole batch.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  const results: Array<PromiseSettledResult<R>> = new Array(items.length)
  let next = 0
  const size = Math.max(1, Math.min(Math.trunc(limit) || 1, items.length || 1))
  const runners = Array.from({ length: size }, async () => {
    while (next < items.length) {
      const index = next++
      try {
        results[index] = { status: 'fulfilled', value: await worker(items[index] as T, index) }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  })
  await Promise.all(runners)
  return results
}
