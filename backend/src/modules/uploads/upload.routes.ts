import Busboy from 'busboy'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { File as FileRecord, UploadSession } from '@prisma/client'
import type { NextFunction, Response } from 'express'
import { Router } from 'express'
import { z } from 'zod'
import { env } from '../../config/env.js'
import { prisma } from '../../config/prisma.js'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { noStoreHeaders, uploadLimiter } from '../../middleware/security.middleware.js'
import { buildContext } from '../../providers/context.js'
import { ProviderError } from '../../providers/errors.js'
import { refreshQuota } from '../../providers/health.js'
import { registry } from '../../providers/registry.js'
import { selectAccount } from '../../providers/routing.js'
import type { Capability, ProviderContext, StorageProvider } from '../../providers/types.js'
import { getAppConnection } from '../../queues/connection.js'
import { resolveRouteError } from '../providers/http-error.js'
import { createAuditLog } from '../../utils/audit.js'
import { serializeBigInt } from '../../utils/serialize.js'
import '../../providers/index.js'

export const uploadRouter = Router()

/** Provider-neutral resumable chunk size advertised by POST /uploads/resumable/init. */
const RESUMABLE_CHUNK_SIZE = 5 * 1024 * 1024
const RESERVED_KEY_PREFIX = '9drive:acct:'
const RESERVED_KEY_SUFFIX = ':reserved'
const RESERVATION_TTL_SECONDS = 3600
const MAX_FOLDER_DEPTH = 32

type UploadMeta = {
  fieldName: string
  fileName: string
  mimeType: string
  sizeBytes: bigint
  folderId?: string
  clientUploadId?: string
}

type FailureEntry = { fieldName: string; fileName: string; code: string; message: string }

function logUpload(message: string, metadata?: Record<string, unknown>) {
  console.info('[upload]', message, metadata ?? '')
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function routeFailure(error: unknown): { status: number; code: string; message: string } {
  const payload = resolveRouteError(error)
  if (payload && payload.code === 'UNAUTHENTICATED') {
    return { status: 503, code: 'PROVIDER_UNAVAILABLE', message: 'The storage account is unavailable. Reconnect it and try again.' }
  }
  if (payload) return payload
  return { status: 400, code: 'UPLOAD_FAILED', message: 'Upload failed.' }
}

function failureStatus(code: string): number {
  if (code === 'QUOTA_EXCEEDED') return 507
  if (code === 'RATE_LIMITED') return 429
  if (code === 'PROVIDER_UNAVAILABLE') return 503
  if (code === 'NOT_FOUND') return 404
  if (code === 'INTERNAL_SERVER_ERROR') return 500
  return 400
}

export async function spoolToFile(fileStream: NodeJS.ReadableStream): Promise<{ path: string; bytes: bigint }> {
  await fs.promises.mkdir(env.UPLOAD_SPOOL_DIR, { recursive: true })
  const spoolPath = path.join(env.UPLOAD_SPOOL_DIR, `upload-${randomUUID()}.part`)
  try {
    const writeStream = fs.createWriteStream(spoolPath, { flags: 'wx' })
    await new Promise<void>((resolve, reject) => {
      writeStream.on('close', () => resolve())
      writeStream.on('error', reject)
      fileStream.on('error', reject)
      fileStream.pipe(writeStream)
    })
    return { path: spoolPath, bytes: BigInt(writeStream.bytesWritten) }
  } catch (error) {
    await fs.promises.unlink(spoolPath).catch(() => undefined)
    throw error
  }
}

async function appendStreamToFile(fileStream: NodeJS.ReadableStream, filePath: string): Promise<bigint> {
  const writeStream = fs.createWriteStream(filePath, { flags: 'a' })
  await new Promise<void>((resolve, reject) => {
    writeStream.on('finish', () => resolve())
    writeStream.on('error', reject)
    fileStream.on('error', reject)
    fileStream.pipe(writeStream)
  })
  return BigInt(writeStream.bytesWritten)
}

function reservationKey(accountId: string) {
  return `${RESERVED_KEY_PREFIX}${accountId}${RESERVED_KEY_SUFFIX}`
}

async function reserveBytes(accountId: string, bytes: bigint) {
  if (bytes <= 0n) return
  try {
    const key = reservationKey(accountId)
    await getAppConnection().multi().incrby(key, Number(bytes)).expire(key, RESERVATION_TTL_SECONDS).exec()
  } catch (error) {
    logUpload('reservation increment failed', { accountId, message: errorText(error) })
  }
}

async function releaseBytes(accountId: string, bytes: bigint) {
  if (bytes <= 0n) return
  try {
    await getAppConnection().decrby(reservationKey(accountId), Number(bytes))
  } catch (error) {
    logUpload('reservation decrement failed', { accountId, message: errorText(error) })
  }
}

async function refreshStaleQuotas(userId: string) {
  try {
    const accounts = await prisma.connectedAccount.findMany({
      where: { userId, status: 'connected' },
      include: { storageAccount: true },
    })
    const stale = accounts.filter(
      (account) =>
        registry.has(account.provider) &&
        (!account.storageAccount?.lastSyncedAt || account.storageAccount.lastSyncedAt.getTime() < Date.now() - 5 * 60_000),
    )
    if (stale.length === 0) return
    await Promise.allSettled(
      stale.map(async (account) => {
        try {
          await refreshQuota(account.id)
        } catch (error) {
          logUpload('quota refresh failed', { accountId: account.id, message: errorText(error) })
        }
      }),
    )
  } catch (error) {
    logUpload('quota refresh skipped', { userId, message: errorText(error) })
  }
}

async function resolveParentRemoteId(
  userId: string,
  folderId: string,
  ctx: ProviderContext,
  provider: StorageProvider,
  accountId: string,
  depth = 0,
): Promise<string | null> {
  const folder = await prisma.folder.findFirst({ where: { id: folderId, userId, deletedAt: null } })
  if (!folder) return null
  if (folder.providerFolderId) return folder.providerFolderId
  if (depth >= MAX_FOLDER_DEPTH) return null
  const parentRemoteId = folder.parentId
    ? await resolveParentRemoteId(userId, folder.parentId, ctx, provider, accountId, depth + 1)
    : null
  if (!provider.capabilities.has('createFolder')) return parentRemoteId
  const created = await provider.createFolder(ctx, { name: folder.name, parentId: parentRemoteId })
  await prisma.folder.update({
    where: { id: folder.id },
    data: {
      providerFolderId: created.remoteId,
      provider: provider.id,
      ...(folder.connectedAccountId ? {} : { connectedAccountId: accountId }),
    },
  })
  logUpload('folder materialised', { folderId: folder.id, remoteId: created.remoteId, accountId })
  return created.remoteId
}

async function findSucceededUploadFile(userId: string, clientUploadId: string, sizeBytes?: bigint): Promise<FileRecord | null> {
  const operations = await prisma.storageOperation.findMany({
    where: {
      userId,
      operation: 'upload',
      status: 'succeeded',
      fileId: { not: null },
      ...(sizeBytes === undefined ? {} : { bytes: sizeBytes }),
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
    select: { fileId: true, metadata: true },
  })
  const match = operations.find((row) => {
    const metadata = row.metadata as { clientUploadId?: unknown } | null
    return metadata?.clientUploadId === clientUploadId
  })
  if (!match?.fileId) return null
  return prisma.file.findFirst({ where: { id: match.fileId, userId, status: 'active' } })
}

function replayPayload(file: FileRecord): Record<string, unknown> {
  return (serializeBigInt({ file }) as { file: Record<string, unknown> }).file
}

async function findSessionClientUploadId(sessionId: string): Promise<string | null> {
  const operation = await prisma.storageOperation.findFirst({
    where: { operation: 'upload', status: 'started', metadata: { path: ['sessionId'], equals: sessionId } },
    orderBy: { createdAt: 'desc' },
    select: { metadata: true },
  })
  const clientUploadId = (operation?.metadata as { clientUploadId?: unknown } | null)?.clientUploadId
  return typeof clientUploadId === 'string' && clientUploadId !== '' ? clientUploadId : null
}

const resumableLocks = new Map<string, Promise<void>>()

function withSessionLock<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
  const previous = resumableLocks.get(sessionId) ?? Promise.resolve()
  const next = previous.then(run)
  const tail = next.then(
    () => undefined,
    () => undefined,
  )
  resumableLocks.set(sessionId, tail)
  void tail.then(() => {
    if (resumableLocks.get(sessionId) === tail) resumableLocks.delete(sessionId)
  })
  return next
}

function resumableSpoolPath(sessionId: string) {
  return path.join(env.UPLOAD_SPOOL_DIR, `resumable-${sessionId}.part`)
}

async function resumableSpoolBytes(sessionId: string): Promise<bigint> {
  try {
    return BigInt((await fs.promises.stat(resumableSpoolPath(sessionId))).size)
  } catch {
    return 0n
  }
}

async function failResumableSession(sessionId: string, message: string) {
  await prisma.uploadSession
    .update({ where: { id: sessionId }, data: { status: 'failed', errorMessage: message.slice(0, 500) } })
    .catch(() => undefined)
}

export async function handleUpload(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    logUpload('request started', { userId: req.user!.id, contentLength: req.headers['content-length'] })
    const contentType = req.headers['content-type']
    if (!contentType?.includes('multipart/form-data')) return res.status(400).json({ code: 'UPLOAD_INVALID_CONTENT_TYPE', message: 'multipart/form-data required.' })

    const busboy = Busboy({ headers: req.headers, limits: { files: 25, fileSize: env.MAX_UPLOAD_BYTES } })
    const fields: { sizeBytes?: bigint; fileName?: string; mimeType?: string; folderId?: string; targetAccountId?: string; clientUploadId?: string } = {}
    let batchMeta: UploadMeta[] | null = null
    let responded = false
    let fileSeen = false
    let quotaRefresh: Promise<void> | null = null
    const refreshQuotasOnce = () => (quotaRefresh ??= refreshStaleQuotas(req.user!.id))
    const completed: Array<Record<string, unknown>> = []
    const failed: FailureEntry[] = []
    const pendingUploads: Array<Promise<void>> = []

    const fail = async (status: number, code: string, message: string) => {
      if (responded) return
      responded = true
      req.unpipe(busboy)
      req.resume()
      return res.status(status).json({ code, message })
    }

    const parseBatchMeta = (value: string) => JSON.parse(value).map((item: { fieldName: string; fileName: string; mimeType: string; sizeBytes: string | number; folderId?: string; clientUploadId?: string }) => ({
      fieldName: item.fieldName,
      fileName: item.fileName,
      mimeType: item.mimeType,
      sizeBytes: BigInt(item.sizeBytes),
      folderId: item.folderId,
      clientUploadId: item.clientUploadId,
    })) as UploadMeta[]

    const metaForFile = (fieldName: string, info: { filename: string; mimeType: string }) => {
      if (batchMeta) return batchMeta.find((item) => item.fieldName === fieldName)
      const sizeBytes = fields.sizeBytes
      if (!sizeBytes) return null
      return { fieldName, sizeBytes, fileName: fields.fileName || info.filename, mimeType: fields.mimeType || info.mimeType || 'application/octet-stream', folderId: fields.folderId, clientUploadId: fields.clientUploadId }
    }

    const uploadOne = async (fieldName: string, fileStream: NodeJS.ReadableStream, info: { filename: string; mimeType: string }) => {
      const meta = metaForFile(fieldName, info)
      const fileName = meta?.fileName || info.filename
      let spoolPath: string | null = null
      let reservedAccountId: string | null = null
      try {
        if (responded) {
          fileStream.resume()
          return
        }
        fileStream.on('limit', () => {
          logUpload('file stream size limit reached', { fileName })
          fileStream.resume()
          void fail(413, 'UPLOAD_TOO_LARGE', 'File exceeds max upload size.')
        })
        if (!meta?.sizeBytes || meta.sizeBytes <= 0n) {
          fileStream.resume()
          failed.push({ fieldName, fileName, code: 'UPLOAD_SIZE_REQUIRED', message: 'sizeBytes field must be sent before file field.' })
          return
        }
        if (meta.sizeBytes > BigInt(env.MAX_UPLOAD_BYTES)) {
          fileStream.resume()
          failed.push({ fieldName, fileName, code: 'UPLOAD_TOO_LARGE', message: 'File exceeds max upload size.' })
          return
        }

        const clientUploadId = meta.clientUploadId || fields.clientUploadId || undefined
        if (clientUploadId) {
          const replay = await findSucceededUploadFile(req.user!.id, clientUploadId, meta.sizeBytes)
          if (replay) {
            fileStream.resume()
            completed.push(replayPayload(replay))
            logUpload('duplicate upload replayed', { fileName, clientUploadId })
            return
          }
        }

        const folderId = meta.folderId || null
        const folderRecord = folderId ? await prisma.folder.findFirst({ where: { id: folderId, userId: req.user!.id, deletedAt: null } }) : null
        if (folderId && !folderRecord) {
          fileStream.resume()
          failed.push({ fieldName, fileName, code: 'UPLOAD_FAILED', message: 'Upload folder not found.' })
          return
        }
        const targetAccountId = folderRecord?.connectedAccountId ?? fields.targetAccountId ?? null
        const requiredCapabilities: Capability[] = ['upload']
        if (folderId && !folderRecord?.providerFolderId) requiredCapabilities.push('createFolder')

        await refreshQuotasOnce()
        const selection = await selectAccount({
          userId: req.user!.id,
          requiredBytes: meta.sizeBytes,
          requiredCapabilities,
          targetAccountId,
          folderId,
        })
        if (!selection) {
          fileStream.resume()
          failed.push({ fieldName, fileName, code: 'NO_ACCOUNT_WITH_ENOUGH_SPACE', message: 'No connected storage account has enough space for this upload.' })
          return
        }
        const { account, provider } = selection
        reservedAccountId = account.id
        await reserveBytes(account.id, meta.sizeBytes)

        if (responded) {
          fileStream.resume()
          return
        }

        const session = await prisma.uploadSession.create({ data: { userId: req.user!.id, targetConnectedAccountId: account.id, folderId, fileName, mimeType: meta.mimeType, sizeBytes: meta.sizeBytes, status: 'uploading' } })
        logUpload('file upload started', { sessionId: session.id, accountId: account.id, fileName, sizeBytes: meta.sizeBytes.toString() })

        const spool = await spoolToFile(fileStream)
        spoolPath = spool.path
        const streamedBytes = spool.bytes

        if (streamedBytes > BigInt(env.UPLOAD_SPOOL_MAX_BYTES)) {
          await prisma.uploadSession.update({ where: { id: session.id }, data: { status: 'failed', errorMessage: 'Upload exceeds the spool size limit.' } })
          failed.push({ fieldName, fileName, code: 'UPLOAD_TOO_LARGE', message: 'File exceeds max upload size.' })
          return
        }

        if (streamedBytes !== meta.sizeBytes) {
          await prisma.uploadSession.update({ where: { id: session.id }, data: { status: 'failed', errorMessage: 'Streamed byte count did not match declared size.' } })
          failed.push({ fieldName, fileName, code: 'UPLOAD_SIZE_MISMATCH', message: 'Streamed byte count did not match declared size.' })
          return
        }

        const ctx = await buildContext(account.id)
        const parentId = folderId ? await resolveParentRemoteId(req.user!.id, folderId, ctx, provider, account.id) : null
        const startedAt = Date.now()
        const uploaded = await provider.upload(ctx, { stream: fs.createReadStream(spoolPath), fileName, mimeType: meta.mimeType, sizeBytes: meta.sizeBytes, parentId })
        const file = await prisma.$transaction(async (tx) => {
          const created = await tx.file.create({ data: { userId: req.user!.id, connectedAccountId: account.id, folderId, provider: provider.id, providerFileId: uploaded.remoteId, name: fileName, mimeType: meta.mimeType, sizeBytes: meta.sizeBytes, remoteParentId: parentId } })
          await tx.uploadSession.update({ where: { id: session.id }, data: { status: 'completed', completedAt: new Date() } })
          await tx.storageOperation.create({
            data: {
              userId: req.user!.id,
              accountId: account.id,
              provider: provider.id,
              operation: 'upload',
              fileId: created.id,
              status: 'succeeded',
              latencyMs: Date.now() - startedAt,
              bytes: meta.sizeBytes,
              metadata: { fileName, remoteId: uploaded.remoteId, clientUploadId: clientUploadId ?? null },
            },
          })
          return created
        })
        completed.push(replayPayload(file))
        await createAuditLog(req.user!.id, 'UPLOAD_FILE', 'file', file.id, { name: file.name, size: file.sizeBytes.toString() })
        logUpload('database file created', { sessionId: session.id, fileId: file.id, accountId: account.id })
        void refreshQuota(account.id).catch((error) => logUpload('quota refresh failed', { accountId: account.id, message: errorText(error) }))
      } catch (error) {
        fileStream.resume()
        const payload = routeFailure(error)
        logUpload('file upload failed', { fileName, code: payload.code, message: errorText(error) })
        failed.push({ fieldName, fileName, code: payload.code, message: payload.message })
      } finally {
        if (reservedAccountId) await releaseBytes(reservedAccountId, meta?.sizeBytes ?? 0n)
        if (spoolPath) await fs.promises.unlink(spoolPath).catch(() => undefined)
      }
    }

    busboy.on('field', (name, value) => {
      try {
        if (name === 'sizeBytes') fields.sizeBytes = BigInt(value)
        if (name === 'fileName') fields.fileName = value
        if (name === 'mimeType') fields.mimeType = value
        if (name === 'folderId') fields.folderId = value
        if (name === 'targetAccountId') fields.targetAccountId = value
        if (name === 'clientUploadId') fields.clientUploadId = value
        if (name === 'filesMeta') batchMeta = parseBatchMeta(value)
      } catch {
        void fail(400, 'VALIDATION_FAILED', 'Invalid multipart field payload.')
      }
    })

    busboy.on('file', (name, fileStream, info) => {
      fileSeen = true
      if (responded) {
        fileStream.resume()
        return
      }
      pendingUploads.push(uploadOne(name, fileStream, info))
    })

    busboy.on('error', (error) => {
      logUpload('multipart parser failed', { message: error instanceof Error ? error.message : 'Unknown error' })
      if (!responded) {
        responded = true
        next(error)
      }
    })

    busboy.on('finish', () => {
      if (!responded && !fileSeen) return fail(400, 'UPLOAD_FILE_REQUIRED', 'file field required.')
      Promise.all(pendingUploads).then(() => {
        if (responded) return
        responded = true
        logUpload('response sent', { completed: completed.length, failed: failed.length })
        if (completed.length === 0) {
          const first = failed[0]
          const code = first?.code ?? 'UPLOAD_FAILED'
          return res.status(failureStatus(code)).json({ code, message: first?.message ?? 'Upload failed.', failed })
        }
        if (!batchMeta && completed.length === 1 && failed.length === 0) return res.status(201).json({ file: completed[0] })
        return res.status(201).json({ files: completed, failed })
      }).catch(next)
    })

    req.pipe(busboy)
  } catch (error) {
    return next(error)
  }
}

uploadRouter.use(noStoreHeaders)
uploadRouter.post('/', requireAuth, uploadLimiter, handleUpload)

uploadRouter.post('/resumable/init', requireAuth, uploadLimiter, async (req: AuthRequest, res, next) => {
  try {
    const body = z.object({
      fileName: z.string().min(1),
      mimeType: z.string().min(1),
      sizeBytes: z.string().regex(/^\d{1,19}$/),
      folderId: z.string().nullable().optional(),
      targetAccountId: z.string().nullable().optional(),
      clientUploadId: z.string().min(1).max(191).optional()
    }).parse(req.body)

    const sizeBytes = BigInt(body.sizeBytes)
    if (sizeBytes <= 0n) return res.status(400).json({ code: 'UPLOAD_SIZE_REQUIRED', message: 'Valid sizeBytes required.' })
    if (sizeBytes > BigInt(env.MAX_UPLOAD_BYTES)) return res.status(400).json({ code: 'UPLOAD_TOO_LARGE', message: 'File exceeds max upload size.' })

    const folderId = body.folderId || null
    const folderRecord = folderId ? await prisma.folder.findFirst({ where: { id: folderId, userId: req.user!.id, deletedAt: null } }) : null
    if (folderId && !folderRecord) return res.status(400).json({ code: 'UPLOAD_FAILED', message: 'Upload folder not found.' })
    const targetAccountId = folderRecord?.connectedAccountId ?? body.targetAccountId ?? null
    const requiredCapabilities: Capability[] = ['upload']
    if (folderId && !folderRecord?.providerFolderId) requiredCapabilities.push('createFolder')

    if (body.clientUploadId) {
      const replay = await findSucceededUploadFile(req.user!.id, body.clientUploadId, sizeBytes)
      if (replay) {
        const session = await prisma.uploadSession.create({
          data: { userId: req.user!.id, targetConnectedAccountId: replay.connectedAccountId, folderId: replay.folderId, fileName: replay.name, mimeType: replay.mimeType, sizeBytes: replay.sizeBytes, status: 'completed', completedAt: new Date() }
        })
        return res.status(201).json({ sessionId: session.id, provider: replay.provider, chunkSize: RESUMABLE_CHUNK_SIZE, offset: replay.sizeBytes.toString(), status: 'completed', file: replayPayload(replay) })
      }
    }

    await refreshStaleQuotas(req.user!.id)
    const selection = await selectAccount({ userId: req.user!.id, requiredBytes: sizeBytes, requiredCapabilities, targetAccountId, folderId })
    if (!selection) return res.status(400).json({ code: 'NO_ACCOUNT_WITH_ENOUGH_SPACE', message: 'No connected storage account has enough space.' })

    const session = await prisma.uploadSession.create({
      data: { userId: req.user!.id, targetConnectedAccountId: selection.account.id, folderId, fileName: body.fileName, mimeType: body.mimeType, sizeBytes, status: 'uploading' }
    })
    if (body.clientUploadId) {
      await prisma.storageOperation.create({
        data: {
          userId: req.user!.id,
          accountId: selection.account.id,
          provider: selection.account.provider,
          operation: 'upload',
          status: 'started',
          bytes: sizeBytes,
          metadata: { sessionId: session.id, clientUploadId: body.clientUploadId, fileName: body.fileName }
        }
      })
    }

    return res.status(201).json({ sessionId: session.id, provider: selection.account.provider, chunkSize: RESUMABLE_CHUNK_SIZE, offset: '0' })
  } catch (error) {
    const payload = routeFailure(error)
    if (error instanceof z.ZodError) return next(error)
    if (ProviderError.is(error)) return res.status(payload.status).json({ code: payload.code, message: payload.message })
    return next(error)
  }
})

uploadRouter.get('/resumable/status/:id', requireAuth, async (req: AuthRequest, res) => {
  try {
    const session = await prisma.uploadSession.findFirstOrThrow({
      where: { id: String(req.params.id), userId: req.user!.id }
    })
    if (session.status === 'completed') return res.json({ status: 'completed', offset: session.sizeBytes.toString() })
    if (session.status === 'failed') return res.json({ status: 'failed', offset: '0' })
    return res.json({ status: 'uploading', offset: (await resumableSpoolBytes(session.id)).toString() })
  } catch {
    return res.json({ status: 'failed', offset: '0' })
  }
})

uploadRouter.put('/resumable/chunk/:id', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const session = await prisma.uploadSession.findFirstOrThrow({
      where: { id: String(req.params.id), userId: req.user!.id }
    })

    const rangeHeader = req.headers['content-range']
    if (!rangeHeader || typeof rangeHeader !== 'string') {
      return res.status(400).json({ code: 'MISSING_CONTENT_RANGE', message: 'Content-Range header is required.' })
    }
    const match = rangeHeader.match(/bytes\s+(\d+)-(\d+)\/(\d+)/)
    if (!match) return res.status(400).json({ code: 'INVALID_CONTENT_RANGE', message: 'Invalid Content-Range format.' })

    const startByte = BigInt(match[1])
    const endByte = BigInt(match[2])
    const totalBytes = BigInt(match[3])
    if (endByte < startByte || endByte >= totalBytes || totalBytes !== session.sizeBytes) {
      return res.status(400).json({ code: 'INVALID_CONTENT_RANGE', message: 'Content-Range does not match the upload session.' })
    }

    if (session.status === 'completed') return res.json({ status: 'completed', offset: session.sizeBytes.toString() })
    if (session.status === 'failed' && startByte !== 0n) {
      return res.status(400).json({ code: 'UPLOAD_SESSION_FAILED', message: 'Upload session failed. Start a new upload.' })
    }

    return await withSessionLock(session.id, async () => {
      const spoolPath = resumableSpoolPath(session.id)
      await fs.promises.mkdir(env.UPLOAD_SPOOL_DIR, { recursive: true })
      const spooled = await resumableSpoolBytes(session.id)
      if (startByte > spooled) {
        return res.status(400).json({ code: 'INVALID_OFFSET', message: 'Chunk starts beyond the bytes already received.' })
      }
      if (startByte < spooled) await fs.promises.truncate(spoolPath, Number(startByte))
      if (session.status === 'failed') {
        await prisma.uploadSession.update({ where: { id: session.id }, data: { status: 'uploading', errorMessage: null } })
      }

      const written = await appendStreamToFile(req, spoolPath)
      const received = startByte + written
      if (received > session.sizeBytes || received > BigInt(env.UPLOAD_SPOOL_MAX_BYTES)) {
        await failResumableSession(session.id, 'Received bytes exceed the declared upload size.')
        await fs.promises.unlink(spoolPath).catch(() => undefined)
        return res.status(400).json({ code: 'UPLOAD_TOO_LARGE', message: 'File exceeds max upload size.' })
      }
      if (received < session.sizeBytes) {
        return res.json({ status: 'uploading', offset: received.toString() })
      }

      try {
        const file = await finalizeResumable(req.user!.id, session, spoolPath)
        await fs.promises.unlink(spoolPath).catch(() => undefined)
        return res.status(201).json({ status: 'completed', offset: received.toString(), file })
      } catch (error) {
        const payload = routeFailure(error)
        logUpload('resumable finalize failed', { sessionId: session.id, code: payload.code, message: errorText(error) })
        await failResumableSession(session.id, payload.message)
        await fs.promises.unlink(spoolPath).catch(() => undefined)
        return res.status(payload.status).json({ code: payload.code, message: payload.message })
      }
    })
  } catch (error) {
    if (error instanceof z.ZodError) return next(error)
    const payload = routeFailure(error)
    if (ProviderError.is(error)) return res.status(payload.status).json({ code: payload.code, message: payload.message })
    return next(error)
  }
})

async function finalizeResumable(userId: string, session: UploadSession, spoolPath: string): Promise<Record<string, unknown>> {
  if (!session.targetConnectedAccountId) throw new ProviderError('ERR_NOT_FOUND', 'upload session has no target account')
  const account = await prisma.connectedAccount.findFirst({ where: { id: session.targetConnectedAccountId, userId } })
  if (!account) throw new ProviderError('ERR_NOT_FOUND', 'connected account not found')
  const provider = registry.tryGet(account.provider)
  if (!provider) throw new ProviderError('ERR_NOT_FOUND', `provider '${account.provider}' is not registered`)
  if (!provider.capabilities.has('upload')) {
    throw new ProviderError('ERR_CAPABILITY_UNSUPPORTED', `provider '${account.provider}' does not declare capability 'upload'`)
  }

  const clientUploadId = await findSessionClientUploadId(session.id)
  if (clientUploadId) {
    const replay = await findSucceededUploadFile(userId, clientUploadId, session.sizeBytes)
    if (replay) {
      await prisma.uploadSession.update({ where: { id: session.id }, data: { status: 'completed', completedAt: new Date() } })
      return replayPayload(replay)
    }
  }

  const ctx = await buildContext(account.id)
  const parentId = session.folderId ? await resolveParentRemoteId(userId, session.folderId, ctx, provider, account.id) : null
  const startedAt = Date.now()
  const uploaded = await provider.upload(ctx, { stream: fs.createReadStream(spoolPath), fileName: session.fileName, mimeType: session.mimeType, sizeBytes: session.sizeBytes, parentId })
  const file = await prisma.$transaction(async (tx) => {
    const created = await tx.file.create({
      data: {
        userId,
        connectedAccountId: account.id,
        folderId: session.folderId,
        provider: provider.id,
        providerFileId: uploaded.remoteId,
        name: session.fileName,
        mimeType: session.mimeType,
        sizeBytes: session.sizeBytes,
        remoteParentId: parentId
      }
    })
    await tx.uploadSession.update({ where: { id: session.id }, data: { status: 'completed', completedAt: new Date() } })
    await tx.storageOperation.create({
      data: {
        userId,
        accountId: account.id,
        provider: provider.id,
        operation: 'upload',
        fileId: created.id,
        status: 'succeeded',
        latencyMs: Date.now() - startedAt,
        bytes: session.sizeBytes,
        metadata: { fileName: session.fileName, remoteId: uploaded.remoteId, clientUploadId: clientUploadId ?? null, sessionId: session.id }
      }
    })
    return created
  })
  await createAuditLog(userId, 'UPLOAD_FILE', 'file', file.id, { name: file.name, size: file.sizeBytes.toString() })
  logUpload('resumable upload completed', { sessionId: session.id, fileId: file.id, accountId: account.id })
  void refreshQuota(account.id).catch((error) => logUpload('quota refresh failed', { accountId: account.id, message: errorText(error) }))
  return replayPayload(file)
}
