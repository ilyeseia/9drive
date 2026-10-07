import type { ConnectedAccount, File } from '@prisma/client'
import type { Response } from 'express'
import { streamGoogleFile } from './stream-google-file.js'
import { streamProviderFileNeutral } from './provider-file.js'

type FileWithAccount = File & { connectedAccount: ConnectedAccount }
type StreamOptions = { disposition?: 'inline' | 'attachment' }

export function streamProviderFile(file: FileWithAccount, range: string | undefined, res: Response, options: StreamOptions = {}) {
  if (file.provider === 'google_drive') return streamGoogleFile(file, range, res, options)
  return streamProviderFileNeutral(file, range, res, options)
}
