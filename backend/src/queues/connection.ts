import { Redis, type RedisOptions } from 'ioredis'
import { env } from '../config/env.js'
import { logger } from './logger.js'

const tracked = new Set<Redis>()

function track(client: Redis): Redis {
  tracked.add(client)
  client.on('error', (error: Error) => {
    logger.error('redis connection error', { error: error.message })
  })
  client.on('end', () => {
    tracked.delete(client)
  })
  return client
}

export function createRedisConnection(label: string, options: RedisOptions = {}): Redis {
  return track(new Redis(env.REDIS_URL, { connectionName: `9drive:${label}`, ...options }))
}

export function createBullConnection(): Redis {
  return createRedisConnection('bullmq', { maxRetriesPerRequest: null })
}

export function createAppConnection(): Redis {
  return createRedisConnection('app')
}

export function trackConnection(client: Redis): Redis {
  return track(client)
}

let bullConnection: Redis | null = null
let appConnection: Redis | null = null

export function getBullConnection(): Redis {
  if (!bullConnection || bullConnection.status === 'end') bullConnection = createBullConnection()
  return bullConnection
}

export function getAppConnection(): Redis {
  if (!appConnection || appConnection.status === 'end') appConnection = createAppConnection()
  return appConnection
}

async function quitClient(client: Redis, timeoutMs: number): Promise<void> {
  if (client.status === 'end' || client.status === 'close') return
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('redis quit timeout')), timeoutMs)
    timer.unref?.()
  })
  try {
    await Promise.race([client.quit(), timeout])
  } catch {
    client.disconnect()
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function closeConnections(timeoutMs = 5_000): Promise<void> {
  const clients = [...tracked]
  await Promise.all(clients.map((client) => quitClient(client, timeoutMs)))
  tracked.clear()
  bullConnection = null
  appConnection = null
}
