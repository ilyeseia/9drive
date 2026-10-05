import { Router } from 'express'
import { exec, spawn } from 'child_process'
import path from 'path'
import fs from 'fs'
import { requireAuth, requireRole } from '../../middleware/auth.middleware.js'
import { adminSystemLimiter, noStoreHeaders } from '../../middleware/security.middleware.js'
import { prisma } from '../../config/prisma.js'
import { env } from '../../config/env.js'
import { decryptText, encryptText } from '../../utils/crypto.js'
import Busboy from 'busboy'

export const systemRouter = Router()

systemRouter.use(requireAuth)
systemRouter.use(adminSystemLimiter)
systemRouter.use(requireRole('admin'))
systemRouter.use(noStoreHeaders)

const SQLITE_MAGIC = 'SQLite format 3'

function isFileDatabase(): boolean {
  return /^(sqlite|file):/i.test(process.env.DATABASE_URL || '')
}

function getDatabaseFilePath(): string | null {
  if (!isFileDatabase()) return null
  const dbUrl = process.env.DATABASE_URL || 'file:./dev.db'
  let cleanPath = dbUrl.replace(/^(sqlite|file):/i, '')

  if (cleanPath.includes('?')) {
    cleanPath = cleanPath.split('?')[0]
  }

  if (!path.isAbsolute(cleanPath)) {
    let baseDir = path.resolve(process.cwd(), 'prisma')
    if (!fs.existsSync(baseDir)) {
      baseDir = path.resolve(process.cwd(), 'backend', 'prisma')
    }
    if (!fs.existsSync(baseDir)) {
      baseDir = path.resolve(process.cwd(), '..', 'backend', 'prisma')
    }
    return path.resolve(baseDir, cleanPath)
  }

  return path.resolve(cleanPath)
}

systemRouter.post('/update', (req, res) => {
  if ((req.body as { confirm?: unknown } | undefined)?.confirm !== 'UPDATE') {
    return res.status(400).json({
      code: 'CONFIRMATION_REQUIRED',
      message: 'Send { "confirm": "UPDATE" } to start a system update.'
    })
  }

  const projectRoot = path.resolve(process.cwd(), '..')
  const updateScript = path.join(projectRoot, 'update.sh')

  exec('git --version', (gitError) => {
    if (gitError) {
      return res.status(503).json({
        code: 'UPDATE_UNAVAILABLE',
        message: 'System update is not available in this environment.'
      })
    }

    if (fs.existsSync(updateScript)) {
      try {
        const logFile = path.join(projectRoot, 'update.log')
        fs.writeFileSync(logFile, 'Initiating update...\n')

        const child = spawn('bash', ['update.sh'], {
          cwd: projectRoot,
          detached: true,
          stdio: 'ignore'
        })
        child.unref()

        return res.json({
          status: 'success',
          message: 'System update initiated. Rebuilding and restarting backend & frontend in the background. Please wait ~1 minute and refresh the page.'
        })
      } catch {
        return res.status(500).json({
          code: 'UPDATE_FAILED',
          message: 'Failed to start update script.'
        })
      }
    }

    exec('git pull', { cwd: projectRoot }, (error) => {
      if (error) {
        console.error('System update failed:', error)
        return res.status(500).json({
          code: 'UPDATE_FAILED',
          message: 'Failed to run the system update.'
        })
      }

      return res.json({
        status: 'success',
        message: 'System code updated successfully. Dev servers will auto-restart.'
      })
    })
  })
})

systemRouter.get('/update-log', (req, res) => {
  const projectRoot = path.resolve(process.cwd(), '..')
  const logFile = path.join(projectRoot, 'update.log')

  if (!fs.existsSync(logFile)) {
    return res.json({
      log: 'No update history found.'
    })
  }

  try {
    const logContent = fs.readFileSync(logFile, 'utf8')
    return res.json({
      log: logContent
    })
  } catch {
    return res.status(500).json({
      code: 'READ_LOG_FAILED',
      message: 'Failed to read update log file.'
    })
  }
})

systemRouter.get('/google-config', async (req, res, next) => {
  try {
    const config = await prisma.providerConfig.findFirst({
      where: { userId: null, provider: 'google_drive', status: 'active' },
      orderBy: { createdAt: 'desc' }
    })

    const defaultRedirect = `${req.protocol}://${req.get('host')}/connected-accounts/google/callback`

    if (!config) {
      return res.json({
        exists: false,
        defaultRedirectUri: defaultRedirect
      })
    }

    let clientId = ''
    try {
      clientId = decryptText(config.clientIdEncrypted)
    } catch {
      clientId = ''
    }

    return res.json({
      exists: true,
      clientId,
      redirectUri: config.redirectUri,
      hasSecret: !!config.clientSecretEncrypted,
      defaultRedirectUri: defaultRedirect
    })
  } catch (error) {
    return next(error)
  }
})

systemRouter.post('/google-config', async (req, res, next) => {
  try {
    const { clientId, clientSecret, redirectUri } = req.body

    if (!clientId) {
      return res.status(400).json({ code: 'BAD_REQUEST', message: 'Client ID is required.' })
    }

    const defaultRedirect = `${req.protocol}://${req.get('host')}/connected-accounts/google/callback`
    const finalRedirectUri = redirectUri || defaultRedirect

    const scopes = [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ]

    await prisma.providerConfig.updateMany({
      where: { userId: null, provider: 'google_drive', status: 'active' },
      data: { status: 'disabled' }
    })

    let finalSecret = clientSecret
    if (!finalSecret) {
      const oldConfig = await prisma.providerConfig.findFirst({
        where: { userId: null, provider: 'google_drive', status: 'disabled' },
        orderBy: { createdAt: 'desc' }
      })
      if (oldConfig) {
        try {
          finalSecret = decryptText(oldConfig.clientSecretEncrypted)
        } catch {
          finalSecret = undefined
        }
      }
    }

    if (!finalSecret) {
      return res.status(400).json({ code: 'BAD_REQUEST', message: 'Client Secret is required for first-time setup.' })
    }

    const config = await prisma.providerConfig.create({
      data: {
        userId: null,
        provider: 'google_drive',
        clientIdEncrypted: encryptText(clientId),
        clientSecretEncrypted: encryptText(finalSecret),
        redirectUri: finalRedirectUri,
        scopes,
        status: 'active'
      }
    })

    return res.status(201).json({
      status: 'success',
      message: 'Global Google OAuth configuration updated successfully.',
      id: config.id
    })
  } catch (error) {
    return next(error)
  }
})

systemRouter.get('/backup', (req, res, next) => {
  try {
    const dbPath = getDatabaseFilePath()
    if (!dbPath) {
      return res.status(400).json({ code: 'BACKUP_UNSUPPORTED', message: 'Backup is only available for file-based databases.' })
    }
    if (!fs.existsSync(dbPath)) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Database file not found.' })
    }
    res.setHeader('Content-Disposition', 'attachment; filename=9drive-backup.db')
    res.setHeader('Content-Type', 'application/octet-stream')
    const fileStream = fs.createReadStream(dbPath)
    fileStream.on('error', (error) => {
      console.error('Backup read failed:', error)
      if (!res.headersSent) res.status(500).json({ code: 'BACKUP_FAILED', message: 'Failed to read database backup.' })
    })
    fileStream.pipe(res)
  } catch (error) {
    return next(error)
  }
})

systemRouter.post('/restore', (req, res, next) => {
  try {
    const dbPath = getDatabaseFilePath()
    if (!dbPath) {
      return res.status(400).json({ code: 'RESTORE_UNSUPPORTED', message: 'Restore is only available for file-based databases.' })
    }

    const contentType = req.headers['content-type']
    if (!contentType?.includes('multipart/form-data')) {
      return res.status(400).json({ code: 'BAD_REQUEST', message: 'multipart/form-data required.' })
    }

    const tempDbPath = dbPath + '.tmp'
    if (fs.existsSync(tempDbPath)) {
      try { fs.unlinkSync(tempDbPath) } catch { return }
    }

    const busboy = Busboy({ headers: req.headers, limits: { files: 1, fileSize: env.MAX_UPLOAD_BYTES, fields: 5 } })
    let fileReceived = false
    let confirmation: unknown
    let fileWrite: Promise<void> = Promise.resolve()
    let failed = false

    const fail = (status: number, code: string, message: string) => {
      if (failed || res.headersSent) return
      failed = true
      req.unpipe(busboy)
      req.resume()
      if (fs.existsSync(tempDbPath)) {
        try { fs.unlinkSync(tempDbPath) } catch { return }
      }
      return res.status(status).json({ code, message })
    }

    busboy.on('field', (name, value) => {
      if (name === 'confirm') confirmation = value
    })

    busboy.on('file', (name, fileStream, info) => {
      if (fileReceived) {
        fileStream.resume()
        return
      }
      fileReceived = true
      const writeStream = fs.createWriteStream(tempDbPath)
      fileStream.on('limit', () => {
        writeStream.destroy()
        fail(413, 'RESTORE_TOO_LARGE', 'Backup file exceeds the maximum allowed size.')
      })
      fileStream.pipe(writeStream)
      fileWrite = new Promise<void>((resolve) => {
        writeStream.on('close', () => resolve())
        writeStream.on('error', (error) => {
          console.error('Write error on temp DB:', error)
          fail(500, 'WRITE_ERROR', 'Failed to write temporary database file.')
          resolve()
        })
      })
    })

    busboy.on('error', (error) => {
      console.error('Busboy error:', error)
      if (!failed && !res.headersSent) {
        failed = true
        next(error)
      }
    })

    busboy.on('finish', async () => {
      await fileWrite
      if (failed || res.headersSent) return
      if (!fileReceived) return fail(400, 'BAD_REQUEST', 'No file uploaded.')
      if (confirmation !== 'RESTORE') {
        return fail(400, 'CONFIRMATION_REQUIRED', 'Send the confirm field with value RESTORE to overwrite the database.')
      }

      try {
        const header = Buffer.alloc(16)
        const fd = fs.openSync(tempDbPath, 'r')
        fs.readSync(fd, header, 0, 16, 0)
        fs.closeSync(fd)
        if (header.toString('latin1', 0, 15) !== SQLITE_MAGIC) {
          return fail(400, 'RESTORE_INVALID_FILE', 'Uploaded file is not a valid database backup.')
        }
      } catch (error) {
        console.error('Failed to inspect restored database:', error)
        return fail(400, 'RESTORE_INVALID_FILE', 'Uploaded file is not a valid database backup.')
      }

      try {
        await prisma.$disconnect()
        fs.renameSync(tempDbPath, dbPath)

        res.json({
          status: 'success',
          message: 'Database restored successfully. Server will restart in 2 seconds.'
        })

        setTimeout(() => {
          console.log('Database restored. Exiting to allow restart.')
          process.exit(0)
        }, 2000)
      } catch (err: any) {
        if (fs.existsSync(tempDbPath)) {
          try { fs.unlinkSync(tempDbPath) } catch {}
        }
        console.error('Failed to restore database:', err)
        return res.status(500).json({
          code: 'RESTORE_FAILED',
          message: 'Failed to restore database.'
        })
      }
    })

    req.pipe(busboy)
  } catch (error) {
    return next(error)
  }
})
