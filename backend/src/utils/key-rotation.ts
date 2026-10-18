/**
 * Credential re-encryption for `TOKEN_ENCRYPTION_KEY` rotation (docs/provider-audit/01-operations.md).
 *
 * Same scheme as `utils/crypto.ts` (AES-256-GCM, key = sha256(secret), `iv:tag:data` in base64, optional `v1:` prefix
 * that is preserved). Safe by construction: dry-run is the default, every value is verified to decrypt with the old
 * key before anything is written, every rewritten value is verified to decrypt with the new key, already-migrated
 * values are skipped (idempotent, resumable), and nothing secret is ever returned or logged.
 */

import crypto from 'node:crypto'
import type { PrismaClient } from '@prisma/client'

function deriveKey(secret: string): Buffer {
  return crypto.createHash('sha256').update(secret).digest()
}

function decryptWith(key: Buffer, value: string): string {
  const body = value.startsWith('v1:') ? value.slice(3) : value
  const [ivRaw, tagRaw, encryptedRaw] = body.split(':')
  if (!ivRaw || !tagRaw || !encryptedRaw) throw new Error('invalid payload')
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivRaw, 'base64'))
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(encryptedRaw, 'base64')), decipher.final()]).toString('utf8')
}

function encryptWith(key: Buffer, value: string, prefix: string): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return `${prefix}${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${encrypted.toString('base64')}`
}

export type ValueOutcome = 'migrated' | 'already_migrated' | 'undecryptable'

/** Classifies one stored value and returns its re-encrypted form when it must be rewritten. */
export function reencryptValue(
  value: string,
  oldSecret: string,
  newSecret: string,
): { outcome: ValueOutcome; next?: string } {
  const oldKey = deriveKey(oldSecret)
  const newKey = deriveKey(newSecret)
  const prefix = value.startsWith('v1:') ? 'v1:' : ''
  let plain: string
  try {
    plain = decryptWith(oldKey, value)
  } catch {
    try {
      decryptWith(newKey, value)
      return { outcome: 'already_migrated' }
    } catch {
      return { outcome: 'undecryptable' }
    }
  }
  const next = encryptWith(newKey, plain, prefix)
  if (decryptWith(newKey, next) !== plain) return { outcome: 'undecryptable' }
  return { outcome: 'migrated', next }
}

interface ColumnSpec {
  label: string
  delegate: 'providerConfig' | 'connectedAccount' | 's3StorageConfig' | 'webhookSubscription'
  fields: string[]
}

export const ENCRYPTED_COLUMNS: ColumnSpec[] = [
  { label: 'provider_configs', delegate: 'providerConfig', fields: ['clientIdEncrypted', 'clientSecretEncrypted'] },
  { label: 'connected_accounts', delegate: 'connectedAccount', fields: ['accessTokenEncrypted', 'refreshTokenEncrypted'] },
  { label: 's3_storage_configs', delegate: 's3StorageConfig', fields: ['accessKeyIdEncrypted', 'secretAccessKeyEncrypted'] },
  { label: 'webhook_subscriptions', delegate: 'webhookSubscription', fields: ['secretEncrypted'] },
]

export interface RotationReport {
  mode: 'dry-run' | 'apply'
  tables: Record<string, { rows: number; migrated: number; alreadyMigrated: number; undecryptable: number }>
  totalUndecryptable: number
}

interface Row {
  id: string
  [field: string]: unknown
}

export async function rotateEncryptionKey(
  db: PrismaClient,
  options: { oldSecret: string; newSecret: string; apply: boolean; batchSize?: number },
): Promise<RotationReport> {
  if (!options.oldSecret || !options.newSecret) throw new Error('both the old and the new key are required')
  if (options.oldSecret === options.newSecret) throw new Error('old and new keys are identical')
  const batchSize = options.batchSize ?? 200
  const report: RotationReport = { mode: options.apply ? 'apply' : 'dry-run', tables: {}, totalUndecryptable: 0 }

  for (const spec of ENCRYPTED_COLUMNS) {
    const stats = { rows: 0, migrated: 0, alreadyMigrated: 0, undecryptable: 0 }
    report.tables[spec.label] = stats
    const delegate = db[spec.delegate] as unknown as {
      findMany(args: unknown): Promise<Row[]>
      update(args: unknown): Promise<unknown>
    }
    let cursor: string | undefined
    for (;;) {
      const rows = await delegate.findMany({
        take: batchSize,
        orderBy: { id: 'asc' },
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        select: { id: true, ...Object.fromEntries(spec.fields.map((field) => [field, true])) },
      })
      if (rows.length === 0) break
      for (const row of rows) {
        stats.rows += 1
        const data: Record<string, string> = {}
        for (const field of spec.fields) {
          const value = row[field]
          if (typeof value !== 'string' || value === '') continue
          const result = reencryptValue(value, options.oldSecret, options.newSecret)
          if (result.outcome === 'migrated' && result.next) {
            data[field] = result.next
            stats.migrated += 1
          } else if (result.outcome === 'already_migrated') stats.alreadyMigrated += 1
          else stats.undecryptable += 1
        }
        if (options.apply && Object.keys(data).length > 0) await delegate.update({ where: { id: row.id }, data })
      }
      cursor = rows[rows.length - 1]!.id
    }
    report.totalUndecryptable += stats.undecryptable
  }
  return report
}
