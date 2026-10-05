import { jsonSafe } from '../utils/serialize.js'
import { getAppConnection } from './connection.js'

export function cacheKey(name: string, hash: string): string {
  return `9drive:cache:${name}:${hash}`
}

export async function cacheGet<T>(name: string, hash: string): Promise<T | null> {
  const raw = await getAppConnection().get(cacheKey(name, hash))
  if (raw === null) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export async function cacheSet(name: string, hash: string, value: unknown, ttlSeconds: number): Promise<void> {
  await getAppConnection().set(cacheKey(name, hash), JSON.stringify(jsonSafe(value)), 'EX', ttlSeconds)
}

export async function cacheDelete(name: string, hash: string): Promise<void> {
  await getAppConnection().del(cacheKey(name, hash))
}

export async function cacheGetOrLoad<T>(
  name: string,
  hash: string,
  ttlSeconds: number,
  loader: () => Promise<T>,
): Promise<T> {
  const cached = await cacheGet<T>(name, hash)
  if (cached !== null) return cached
  const value = await loader()
  await cacheSet(name, hash, value, ttlSeconds)
  return value
}
