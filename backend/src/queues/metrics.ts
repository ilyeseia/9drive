import { getAppConnection } from './connection.js'
import type { Logger } from './logger.js'

const METRICS_KEY = '9drive:metrics'
const METRICS_TTL_SECONDS = 3_600

export async function incrementMetric(name: string, by = 1): Promise<void> {
  const connection = getAppConnection()
  await connection.hincrby(METRICS_KEY, name, by)
  await connection.expire(METRICS_KEY, METRICS_TTL_SECONDS)
}

export async function flushMetrics(): Promise<Record<string, number>> {
  const connection = getAppConnection()
  const raw = await connection.hgetall(METRICS_KEY)
  const counts: Record<string, number> = {}
  for (const [key, value] of Object.entries(raw)) counts[key] = Number(value)
  if (Object.keys(counts).length > 0) await connection.del(METRICS_KEY)
  return counts
}

export function startMetricsFlush(log: Logger, intervalMs = 60_000): () => void {
  const timer = setInterval(() => {
    void flushMetrics()
      .then((counts) => {
        if (Object.keys(counts).length > 0) log.info('metrics flush', { counts })
      })
      .catch((error: unknown) => {
        log.error('metrics flush failed', { error: (error as Error).message })
      })
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
