export function serializeBigInt<T>(value: T, seen?: WeakSet<object>): unknown {
  const visited = seen ?? new WeakSet<object>()
  if (typeof value === 'bigint') return value.toString()
  if (value === null || typeof value !== 'object') return value
  if (value instanceof Date) return value
  if (visited.has(value)) return '[Circular]'
  visited.add(value)
  if (Array.isArray(value)) return value.map((item) => serializeBigInt(item, visited))
  if (value instanceof Map) {
    const result: Record<string, unknown> = {}
    for (const [key, entry] of value) result[String(key)] = serializeBigInt(entry, visited)
    return result
  }
  if (value instanceof Set) return [...value].map((item) => serializeBigInt(item, visited))
  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    result[key] = serializeBigInt(entry, visited)
  }
  return result
}

export function jsonSafe(value: unknown): unknown {
  const serialized = serializeBigInt(value)
  if (serialized === undefined || serialized === null) return null
  return JSON.parse(JSON.stringify(serialized))
}
