import { prisma } from '../config/prisma.js'
import { encryptText } from '../utils/crypto.js'
import { DROPBOX_SCOPES } from '../providers/dropbox/oauth2.js'

function isConfigured(value: string | undefined, placeholders: string[]) {
  if (!value?.trim()) return false
  return !placeholders.includes(value.trim())
}

async function main() {
  const clientId = process.env.DROPBOX_CLIENT_ID?.trim()
  const clientSecret = process.env.DROPBOX_CLIENT_SECRET?.trim()
  const redirectUri =
    process.env.DROPBOX_REDIRECT_URI?.trim() ||
    `${process.env.PUBLIC_BASE_URL ?? process.env.FRONTEND_URL ?? 'http://localhost:5173'}/api/connected-accounts/dropbox/callback`

  const hasClientId = isConfigured(clientId, ['your-dropbox-client-id', 'your-client-id'])
  const hasClientSecret = isConfigured(clientSecret, ['your-dropbox-client-secret', 'your-client-secret'])

  if (!hasClientId || !hasClientSecret) {
    console.warn('Skipping Dropbox config seed: DROPBOX_CLIENT_ID/DROPBOX_CLIENT_SECRET not configured. Set them in .env and run docker compose up -d.')
    return
  }

  const data = {
    clientIdEncrypted: encryptText(clientId!),
    clientSecretEncrypted: encryptText(clientSecret!),
    redirectUri,
    scopes: DROPBOX_SCOPES,
  }

  const existing = await prisma.providerConfig.findFirst({
    where: { userId: null, provider: 'dropbox', status: 'active' },
    orderBy: { createdAt: 'desc' },
  })

  if (existing) {
    await prisma.providerConfig.update({ where: { id: existing.id }, data })
    console.log(`Updated global Dropbox config: ${existing.id}`)
    return
  }

  await prisma.providerConfig.updateMany({
    where: { userId: null, provider: 'dropbox' },
    data: { status: 'disabled' },
  })

  const config = await prisma.providerConfig.create({
    data: { userId: null, provider: 'dropbox', ...data, status: 'active' },
  })

  console.log(`Seeded global Dropbox config: ${config.id}`)
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
