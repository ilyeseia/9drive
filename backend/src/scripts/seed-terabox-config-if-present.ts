import { prisma } from '../config/prisma.js'
import { encryptText } from '../utils/crypto.js'

// Stores the global TeraBox Open Platform application credentials (client_id / client_secret)
// encrypted in provider_configs. The signing `private_secret` is NOT stored: it is read from
// TERABOX_PRIVATE_SECRET at runtime only. Skips quietly when TeraBox is not configured so the
// stack keeps starting without it.

const PLACEHOLDERS = ['your-terabox-client-id', 'your-terabox-client-secret', 'your-client-id', 'your-client-secret']

function isConfigured(value: string | undefined) {
  if (!value?.trim()) return false
  return !PLACEHOLDERS.includes(value.trim())
}

async function main() {
  const clientId = process.env.TERABOX_CLIENT_ID?.trim()
  const clientSecret = process.env.TERABOX_CLIENT_SECRET?.trim()
  const privateSecret = process.env.TERABOX_PRIVATE_SECRET?.trim()

  if (!isConfigured(clientId) || !isConfigured(clientSecret)) {
    console.warn('Skipping TeraBox config seed: TERABOX_CLIENT_ID/TERABOX_CLIENT_SECRET not configured.')
    return
  }
  if (!isConfigured(privateSecret)) {
    console.warn('TERABOX_PRIVATE_SECRET is not set: TeraBox accounts cannot be connected or refreshed until it is.')
  }

  const data = {
    clientIdEncrypted: encryptText(clientId!),
    clientSecretEncrypted: encryptText(clientSecret!),
    // Device-code mode has no redirect; the column is required, so store the informational web login URL.
    redirectUri: 'https://www.terabox.com/wap/outside/login',
    scopes: [],
  }

  const existing = await prisma.providerConfig.findFirst({
    where: { userId: null, provider: 'terabox_open', status: 'active' },
    orderBy: { createdAt: 'desc' },
  })

  if (existing) {
    await prisma.providerConfig.update({ where: { id: existing.id }, data })
    console.log(`Updated global TeraBox config: ${existing.id}`)
    return
  }

  await prisma.providerConfig.updateMany({
    where: { userId: null, provider: 'terabox_open' },
    data: { status: 'disabled' },
  })
  const config = await prisma.providerConfig.create({
    data: { userId: null, provider: 'terabox_open', ...data, status: 'active' },
  })
  console.log(`Seeded global TeraBox config: ${config.id}`)
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : 'TeraBox config seed failed')
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
