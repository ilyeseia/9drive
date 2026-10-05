import { env } from './config/env.js'
import { prisma } from './config/prisma.js'
import { closeConnections, getBullConnection } from './queues/connection.js'
import { logger } from './queues/logger.js'
import { startWorkerRuntime } from './worker/runtime.js'

async function verifyDependencies(): Promise<void> {
  await getBullConnection().ping()
  await prisma.$queryRaw`SELECT 1`
}

function installFatalHandlers(shutdown: (reason: string) => Promise<void>): void {
  const fatal = (reason: string) => {
    logger.error('worker fatal error', { reason })
    void shutdown(reason)
      .catch((error: unknown) => {
        logger.error('shutdown after fatal error failed', { error: (error as Error).message })
      })
      .finally(() => {
        void prisma.$disconnect().catch(() => undefined)
        process.exit(1)
      })
  }
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled rejection', { reason: reason instanceof Error ? reason.message : String(reason) })
    fatal('unhandledRejection')
  })
  process.on('uncaughtException', (error) => {
    logger.error('uncaught exception', { error: error.message, stack: error.stack })
    fatal('uncaughtException')
  })
}

async function main(): Promise<void> {
  if (!env.WORKER_ENABLED) {
    logger.warn('WORKER_ENABLED=false, not starting workers')
    await prisma.$disconnect()
    process.exit(0)
  }
  await verifyDependencies()
  logger.info('worker dependencies verified', { redis: new URL(env.REDIS_URL).host })
  const runtime = await startWorkerRuntime()
  installFatalHandlers(runtime.shutdown)
  let signalled = false
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      if (signalled) return
      signalled = true
      void runtime
        .shutdown(signal)
        .catch((error: unknown) => {
          logger.error('shutdown failed', { signal, error: (error as Error).message })
        })
        .finally(() => {
          void prisma
            .$disconnect()
            .catch(() => undefined)
            .finally(() => process.exit(0))
        })
    })
  }
  await runtime.start()
}

void main().catch((error: unknown) => {
  logger.error('worker entrypoint failed', { error: (error as Error).message, stack: (error as Error).stack })
  void Promise.allSettled([closeConnections(), prisma.$disconnect()]).finally(() => process.exit(1))
})
