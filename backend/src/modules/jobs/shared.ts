/**
 * Shared helpers for the jobs / dashboard / routing / webhooks routers
 * (api-contract.md §4.2-§4.7, security-contract.md §4).
 * Session-or-API-key guard, cursor pagination and secret-shaped scrubbing.
 */

import type { NextFunction, Request, Response } from 'express'
import { requireApiKey } from '../../middleware/api-key.middleware.js'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { apiKeyRateLimiter } from '../../middleware/security.middleware.js'

const API_KEY_PREFIX = 'Bearer 9d_live_'

const SECRET_KEY_PATTERN =
  /(password|passphrase|secret|token|authorization|credential|api[-_]?key|private[-_]?key|access[-_]?key|client[-_]?secret|signature|cookie|bearer)/i

export const REDACTED = '[redacted]'

export function requireSessionOrScope(scope: string) {
  const apiKeyGuard = requireApiKey(scope)
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.header('Authorization')?.startsWith(API_KEY_PREFIX)) {
      return apiKeyGuard(req, res, (error?: unknown) => {
        if (error) return next(error)
        return apiKeyRateLimiter(req, res, next)
      })
    }
    return requireAuth(req as AuthRequest, res, next)
  }
}

export type Cursor = { createdAt: Date; id: string }

export function encodeCursor(value: Cursor): string {
  return Buffer.from(JSON.stringify({ t: value.createdAt.toISOString(), i: value.id }), 'utf8').toString('base64url')
}

export function decodeCursor(raw: string): Cursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    const { t, i } = parsed as { t?: unknown; i?: unknown }
    const createdAt = new Date(String(t))
    if (Number.isNaN(createdAt.getTime()) || typeof i !== 'string' || i === '') return null
    return { createdAt, id: i }
  } catch {
    return null
  }
}

export function sanitizeSecrets(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => sanitizeSecrets(item))
  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    result[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : sanitizeSecrets(entry)
  }
  return result
}

export function sanitizeErrorMessage(message: string | null): string | null {
  if (!message) return null
  let text = message
  if (text.length > 2000) text = `${text.slice(0, 2000)}...`
  text = text.replace(/(bearer\s+)[^\s'"]+/gi, `$1${REDACTED}`)
  text = text.replace(/9d_live_[A-Za-z0-9_-]+/g, `9d_live_${REDACTED}`)
  text = text.replace(
    /([?&](?:access_token|token|apikey|api_key|key|signature|sig|password|secret)=)[^&\s"']+/gi,
    `$1${REDACTED}`,
  )
  return text
}
