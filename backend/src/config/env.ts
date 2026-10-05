import dotenv from 'dotenv'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'

dotenv.config()

const PLACEHOLDER_SECRET = /(change-this|replace-with|changeme)/i
const TRUTHY = ['true', '1', 'yes', 'on']
const FALSY = ['false', '0', 'no', 'off']

function secretEnv(name: string) {
  return z
    .string()
    .min(32, `${name} must be at least 32 characters`)
    .refine((value) => !PLACEHOLDER_SECRET.test(value), `${name} must not be a placeholder value`)
    .refine(
      (value) => process.env.NODE_ENV !== 'production' || !value.startsWith('dev_'),
      `${name} must not use a dev_ prefixed value in production`
    )
}

function intEnv(defaultValue: number, min = 0) {
  return z.coerce.number().int().min(min).default(defaultValue)
}

function boolEnv(defaultValue: boolean) {
  return z.preprocess((value) => {
    if (value === undefined || value === null || value === '') return defaultValue
    if (typeof value === 'boolean') return value
    const text = String(value).trim().toLowerCase()
    if (TRUTHY.includes(text)) return true
    if (FALSY.includes(text)) return false
    return value
  }, z.boolean())
}

const envSchema = z
  .object({
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    APP_PORT: z.coerce.number().int().min(1).max(65535),
    FRONTEND_URL: z.string().url(),
    PUBLIC_BASE_URL: z.string().url().optional(),
    JWT_ACCESS_SECRET: secretEnv('JWT_ACCESS_SECRET'),
    TOKEN_ENCRYPTION_KEY: secretEnv('TOKEN_ENCRYPTION_KEY'),
    ACCESS_TOKEN_TTL_SECONDS: intEnv(900, 60),
    REFRESH_TOKEN_TTL_DAYS: intEnv(14, 1),
    MAX_UPLOAD_BYTES: intEnv(1073741824, 1),
    UPLOAD_SPOOL_DIR: z.string().min(1).default(path.join(os.tmpdir(), '9drive-spool')),
    UPLOAD_SPOOL_MAX_BYTES: intEnv(53687091200, 1),
    INLINE_UPLOAD_MAX_BYTES: intEnv(8388608, 1),
    USER_DAILY_UPLOAD_BYTES: intEnv(53687091200, 1),
    TRUST_PROXY_HOPS: intEnv(1, 0),
    ALLOW_INSECURE_ENDPOINTS: boolEnv(false),
    SSRF_ALLOWLIST: z.string().default(''),
    WORKER_ENABLED: boolEnv(false),
    WORKER_CONCURRENCY_TRANSFER: intEnv(2, 1),
    WORKER_CONCURRENCY_SYNC: intEnv(2, 1),
    WORKER_CONCURRENCY_MAINTENANCE: intEnv(1, 1),
    WORKER_CONCURRENCY_REPLICATION: intEnv(1, 1),
    WORKER_CONCURRENCY_MIGRATION: intEnv(1, 1),
    WORKER_CONCURRENCY_WEBHOOK: intEnv(2, 1),
    WORKER_CONCURRENCY_RETRY: intEnv(1, 1),
    WORKER_HEALTH_PORT: intEnv(4001, 1),
    RECAPTCHA_SECRET_KEY: z.string().optional(),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    GOOGLE_REDIRECT_URI: z.string().optional(),
    DROPBOX_CLIENT_ID: z.string().optional(),
    DROPBOX_CLIENT_SECRET: z.string().optional(),
    DROPBOX_REDIRECT_URI: z.string().optional(),
  })
  .transform((value) => ({ ...value, PUBLIC_BASE_URL: value.PUBLIC_BASE_URL ?? value.FRONTEND_URL }))

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n')
  console.error(`Invalid environment configuration:\n${details}`)
  process.exit(1)
}

export const env = parsed.data
