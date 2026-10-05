/**
 * Provider-neutral file operations — api-contract §4.8.
 *
 * Downloads and copies go through the registered adapter for the file's
 * provider instead of branching on a hard-coded provider list, so every
 * SUPPORTED provider behaves the same way.
 */

import type { Response } from 'express'
import { Readable } from 'node:stream'
import { buildContext } from '../../providers/context.js'
import { registry } from '../../providers/registry.js'
import type { ConnectedAccount, File } from '@prisma/client'

type FileWithAccount = File & { connectedAccount: ConnectedAccount }

export class FileDownloadError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'FileDownloadError'
    this.status = status
    this.code = code
  }
}

function requireProvider(file: FileWithAccount) {
  const provider = registry.tryGet(file.provider as never)
  if (!provider) throw new FileDownloadError(409, 'PROVIDER_UNAVAILABLE', `No adapter registered for provider '${file.provider}'.`)
  return provider
}

/**
 * Streams a file through its provider adapter. The adapter is responsible for
 * honouring the requested byte range; `range` is passed through verbatim.
 */
export async function streamProviderFileNeutral(
  file: FileWithAccount,
  range: string | undefined,
  res: Response,
  options: { disposition?: 'inline' | 'attachment' } = {},
): Promise<void> {
  const provider = requireProvider(file)
  if (!provider.capabilities.has('download')) {
    throw new FileDownloadError(409, 'CAPABILITY_UNSUPPORTED', `Provider '${file.provider}' does not support downloads.`)
  }

  const context = await buildContext(file.connectedAccountId)
  const rangeHeader = range?.trim()
  let parsed: { start: number; end?: number } | undefined
  if (rangeHeader) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader)
    if (!match) throw new FileDownloadError(400, 'INVALID_RANGE', 'Malformed Range header.')
    const [, startRaw, endRaw] = match
    if (startRaw === '' && endRaw === '') throw new FileDownloadError(400, 'INVALID_RANGE', 'Malformed Range header.')
    const start = startRaw === '' ? 0 : Number(startRaw)
    const end = endRaw === '' ? undefined : Number(endRaw)
    if (!Number.isInteger(start) || start < 0) throw new FileDownloadError(400, 'INVALID_RANGE', 'Invalid range start.')
    if (end !== undefined && (!Number.isInteger(end) || end < start)) {
      throw new FileDownloadError(400, 'INVALID_RANGE', 'Invalid range end.')
    }
    parsed = { start, end }
  }

  const result = await provider.download(context, { remoteId: file.providerFileId, ...(parsed ? { range: parsed } : {}) })
  const disposition = options.disposition === 'inline' ? 'inline' : 'attachment'
  res.setHeader('Content-Type', result.mimeType ?? file.mimeType)
  res.setHeader('Content-Disposition', `${disposition}; filename="${encodeURIComponent(file.name)}"`)
  res.setHeader('Content-Length', String(result.sizeBytes ?? file.sizeBytes))
  res.setHeader('Accept-Ranges', 'bytes')
  if (result.range) {
    res.status(206)
    res.setHeader('Content-Range', `bytes ${result.range.start}-${result.range.end}/${result.range.total ?? '*'}`)
    res.setHeader('Content-Length', String(result.range.end - result.range.start + 1))
  }

  const source = result.stream
  const passThrough = new Readable({
    read() {
      source.resume()
    },
  })
  source.on('data', (chunk: Buffer | string) => {
    if (!passThrough.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)) source.pause()
  })
  source.on('end', () => passThrough.push(null))
  source.on('error', (error: Error) => passThrough.destroy(error))
  passThrough.pipe(res)
}

export interface CopyResult {
  remoteId: string
  sizeBytes: bigint
}

/**
 * Copies a single object through the provider `copy` capability when available,
 * otherwise by streaming download -> upload. Never buffers the whole object.
 */
export async function copyProviderFile(
  file: FileWithAccount,
  targetFolderId: string | null,
): Promise<CopyResult> {
  const provider = requireProvider(file)
  const context = await buildContext(file.connectedAccountId)

  if (provider.capabilities.has('copy')) {
    const copied = await provider.copy(context, {
      remoteId: file.providerFileId,
      newParentId: targetFolderId,
    })
    return { remoteId: copied.remoteId, sizeBytes: copied.sizeBytes }
  }

  if (!provider.capabilities.has('upload') || !provider.capabilities.has('download')) {
    throw new FileDownloadError(409, 'CAPABILITY_UNSUPPORTED', `Provider '${file.provider}' cannot copy objects.`)
  }

  const downloaded = await provider.download(context, { remoteId: file.providerFileId })
  const passThrough = new Readable({
    read() {
      downloaded.stream.resume()
    },
  })
  downloaded.stream.on('data', (chunk: Buffer | string) => {
    if (!passThrough.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)) downloaded.stream.pause()
  })
  downloaded.stream.on('end', () => passThrough.push(null))
  downloaded.stream.on('error', (error: Error) => passThrough.destroy(error))

  const uploaded = await provider.upload(context, {
    stream: passThrough,
    fileName: file.name,
    mimeType: file.mimeType,
    sizeBytes: downloaded.sizeBytes ?? file.sizeBytes,
    parentId: targetFolderId,
  })
  return { remoteId: uploaded.remoteId, sizeBytes: uploaded.sizeBytes }
}
