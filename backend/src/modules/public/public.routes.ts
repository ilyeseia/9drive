import { Router, type Response } from 'express'
import { prisma } from '../../config/prisma.js'
import { noStoreHeaders, publicTokenLimiter } from '../../middleware/security.middleware.js'
import { hashToken } from '../../utils/crypto.js'
import { streamProviderFile } from '../files/stream-file.js'

export const publicRouter = Router()

publicRouter.use(publicTokenLimiter)
publicRouter.use(noStoreHeaders)

async function findSharedFile(token: string) {
  const share = await prisma.fileShare.findFirst({
    where: { enabled: true, tokenHash: hashToken(token), expiresAt: { gt: new Date() } },
    include: { file: { include: { connectedAccount: true } } },
  })
  if (!share || share.file.status !== 'active') return null
  return share.file
}

function notFound(res: Response) {
  return res.status(404).json({ code: 'NOT_FOUND', message: 'Shared file not found.' })
}

publicRouter.get('/files/:token', async (req, res, next) => {
  try {
    const file = await findSharedFile(String(req.params.token))
    if (!file) return notFound(res)
    return res.json({ file: { id: file.id, name: file.name, mimeType: file.mimeType, sizeBytes: file.sizeBytes.toString(), createdAt: file.createdAt } })
  } catch (error) {
    return next(error)
  }
})

publicRouter.get('/files/:token/download', async (req, res, next) => {
  try {
    const file = await findSharedFile(String(req.params.token))
    if (!file) return notFound(res)
    return streamProviderFile(file, req.headers.range, res, { disposition: 'attachment' })
  } catch (error) {
    return next(error)
  }
})

publicRouter.get('/files/:token/preview', async (req, res, next) => {
  try {
    const file = await findSharedFile(String(req.params.token))
    if (!file) return notFound(res)
    return streamProviderFile(file, req.headers.range, res, { disposition: 'inline' })
  } catch (error) {
    return next(error)
  }
})
