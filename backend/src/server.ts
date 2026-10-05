import { app } from './app.js'
import { env } from './config/env.js'
import { prisma } from './config/prisma.js'
import { closeRateLimitStore } from './middleware/rate-limit.middleware.js'
import { seedProviderCapabilities } from './providers/registry.js'

let shuttingDown = false

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`Received ${signal}, shutting down`)
  await closeRateLimitStore().catch(() => undefined)
  await prisma.$disconnect().catch(() => undefined)
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

void seedProviderCapabilities()
  .then((result) => {
    console.log(`Provider capability catalog ready (${result.providers} providers, ${result.rows} capability rows)`)
  })
  .catch((error: unknown) => {
    console.error('Provider capability seeding failed', (error as Error).message)
  })

app.listen(env.APP_PORT, () => {
  console.log(`Backend running on http://localhost:${env.APP_PORT}`)
})
