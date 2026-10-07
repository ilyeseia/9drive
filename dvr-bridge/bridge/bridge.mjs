import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'

const API_URL = (process.env.API_URL || 'http://backend:4000').replace(/\/+$/, '')
const API_KEY = process.env.API_KEY || ''
const ROOT = '/srv'
const INBOX = path.join(ROOT, 'inbox')
const ARCHIVE = path.join(ROOT, 'archive')
const FAILED = path.join(ROOT, 'failed')
const RETENTION_HOURS = Number(process.env.RETENTION_HOURS || 48)
const FAILED_RETENTION_HOURS = Number(process.env.FAILED_RETENTION_HOURS || 168)
const SCAN_SECONDS = Math.max(5, Number(process.env.SCAN_SECONDS || 30))
const MIN_AGE_MS = Number(process.env.MIN_AGE_MS || 20000)
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS || 3)
const MIN_FREE_MB = Number(process.env.MIN_FREE_MB || 2048)
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 900)
const TARGET_ACCOUNT_ID = process.env.TARGET_ACCOUNT_ID || ''
const FOLDER_ID = process.env.FOLDER_ID || ''

const MIME = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.flv': 'video/x-flv',
  '.wmv': 'video/x-ms-wmv',
  '.ts': 'video/mp2t',
  '.m2ts': 'video/mp2t',
  '.dav': 'video/mp4',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.log': 'text/plain',
}

function log(...args) {
  console.log(new Date().toISOString(), ...args)
}

for (const dir of [INBOX, ARCHIVE, FAILED]) fs.mkdirSync(dir, { recursive: true })

const attempts = new Map()
const inFlight = new Set()

async function walk(dir) {
  const out = []
  const entries = await fsp.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(abs)))
    else if (entry.isFile()) out.push(abs)
  }
  return out
}

async function waitReady(abs) {
  const first = await fsp.stat(abs)
  if (first.size === 0) return null
  if (Date.now() - first.mtimeMs < MIN_AGE_MS) return null
  await new Promise((resolve) => setTimeout(resolve, 1500))
  const second = await fsp.stat(abs)
  if (second.size !== first.size) return null
  if (second.size > MAX_UPLOAD_MB * 1024 * 1024) return { tooLarge: true }
  return second
}

async function upload(abs, stat) {
  const rel = path.relative(INBOX, abs).split(path.sep).join('/')
  const base = path.basename(abs)
  const ext = path.extname(base).toLowerCase()
  const mime = MIME[ext] || 'application/octet-stream'
  const meta = {
    fieldName: 'file-0',
    fileName: rel.replaceAll('/', '__'),
    mimeType: mime,
    sizeBytes: String(stat.size),
  }
  if (FOLDER_ID) meta.folderId = FOLDER_ID

  const boundary = '----dvr' + Date.now().toString(16) + Math.random().toString(16).slice(2, 8)
  let head = `--${boundary}\r\nContent-Disposition: form-data; name="filesMeta"\r\n\r\n${JSON.stringify([meta])}\r\n`
  if (TARGET_ACCOUNT_ID) {
    head += `--${boundary}\r\nContent-Disposition: form-data; name="targetAccountId"\r\n\r\n${TARGET_ACCOUNT_ID}\r\n`
  }
  head += `--${boundary}\r\nContent-Disposition: form-data; name="file-0"; filename="${base}"\r\nContent-Type: ${mime}\r\n\r\n`
  const tail = `\r\n--${boundary}--\r\n`
  const source = fs.createReadStream(abs)
  const nodeBody = Readable.from(
    (async function* () {
      yield Buffer.from(head)
      for await (const chunk of source) yield chunk
      yield Buffer.from(tail)
    })(),
  )
  const body = Readable.toWeb(nodeBody)

  const response = await fetch(API_URL + '/api/v1/uploads', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + API_KEY,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
    duplex: 'half',
    signal: AbortSignal.timeout(Number(process.env.UPLOAD_TIMEOUT_MS || 30 * 60 * 1000)),
  })
  const text = await response.text().catch(() => '')
  if (!response.ok) throw new Error(`HTTP ${response.status} ${text.slice(0, 300)}`)
  log('uploaded', rel, '->', text.slice(0, 200))
}

async function freeMb(dir) {
  const stats = await fsp.statfs(dir)
  return Math.floor((stats.bavail * stats.bsize) / (1024 * 1024))
}

async function uniqueDest(dir, name) {
  const ext = path.extname(name)
  const stem = name.slice(0, name.length - ext.length)
  let dest = path.join(dir, name)
  let counter = 1
  while (fs.existsSync(dest)) {
    dest = path.join(dir, `${stem}-${counter}${ext}`)
    counter += 1
  }
  return dest
}

async function moveAside(abs, targetDir, label) {
  await fsp.mkdir(targetDir, { recursive: true })
  const dest = await uniqueDest(targetDir, path.basename(abs))
  await fsp.rename(abs, dest)
  log(label, dest)
  return dest
}

async function onUploaded(abs) {
  const rel = path.relative(INBOX, abs)
  const free = await freeMb(ROOT).catch(() => 0)
  if (free < MIN_FREE_MB) {
    log('low disk (' + free + 'MB), skipping local archive for', rel)
    await fsp.unlink(abs).catch(() => undefined)
    return
  }
  const day = new Date().toISOString().slice(0, 10)
  const destDir = path.join(ARCHIVE, day)
  await fsp.mkdir(destDir, { recursive: true })
  const dest = await uniqueDest(destDir, path.basename(abs))
  try {
    await fsp.rename(abs, dest)
    log('archived', dest, `(free ${free}MB)`)
  } catch {
    await fsp.unlink(abs).catch(() => undefined)
    log('archive rename failed, removed', rel)
  }
}

async function sweep(dir, hours) {
  const cutoff = Date.now() - hours * 3600 * 1000
  for (const abs of await walk(dir)) {
    try {
      const stat = await fsp.stat(abs)
      if (stat.mtimeMs < cutoff) {
        await fsp.unlink(abs)
        log('swept', abs)
      }
    } catch {
      // ignore races with concurrent moves
    }
  }
}

async function tick() {
  await sweep(ARCHIVE, RETENTION_HOURS)
  await sweep(FAILED, FAILED_RETENTION_HOURS)
  const files = await walk(INBOX)
  for (const abs of files.sort()) {
    if (inFlight.has(abs)) continue
    inFlight.add(abs)
    try {
      const ready = await waitReady(abs)
      if (!ready) continue
      if (ready.tooLarge) {
        await moveAside(abs, FAILED, 'too large for API, moved to failed:')
        attempts.delete(abs)
        continue
      }
      await upload(abs, ready)
      attempts.delete(abs)
      await onUploaded(abs)
    } catch (error) {
      const count = (attempts.get(abs) || 0) + 1
      attempts.set(abs, count)
      log(`attempt ${count}/${MAX_ATTEMPTS} failed for`, abs, String(error).slice(0, 300))
      if (count >= MAX_ATTEMPTS) {
        attempts.delete(abs)
        await moveAside(abs, FAILED, 'giving up, moved to failed:').catch(() => undefined)
      }
    } finally {
      inFlight.delete(abs)
    }
  }
}

async function main() {
  if (!API_KEY) {
    log('API_KEY is required')
    process.exit(1)
  }
  log(
    'watching',
    INBOX,
    `scan=${SCAN_SECONDS}s minAge=${MIN_AGE_MS}ms retention=${RETENTION_HOURS}h`,
    `target=${TARGET_ACCOUNT_ID || 'auto-routing'}`,
    `folder=${FOLDER_ID || '-'}`,
  )
  for (;;) {
    try {
      await tick()
    } catch (error) {
      log('tick error', String(error).slice(0, 300))
    }
    await new Promise((resolve) => setTimeout(resolve, SCAN_SECONDS * 1000))
  }
}

main()
