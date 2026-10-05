import type { NextFunction, Request, Response } from 'express'
import { prisma } from '../config/prisma.js'
import { verifyAccessToken } from '../utils/jwt.js'

export type AuthUser = { id: string; sessionId: string; role?: string }

export type AuthRequest = Request & {
  user?: AuthUser
}

const ROLE_RANK: Record<string, number> = { user: 0, admin: 1 }

export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const header = req.header('Authorization')
    if (!header?.startsWith('Bearer ')) return res.status(401).json({ code: 'AUTH_REQUIRED', message: 'Bearer token required.' })
    const payload = verifyAccessToken(header.slice(7))
    const session = await prisma.userSession.findUnique({
      where: { id: payload.sid },
      include: { user: { select: { id: true, role: true, status: true } } },
    })
    if (!session || session.revokedAt || session.expiresAt < new Date()) return res.status(401).json({ code: 'AUTH_SESSION_EXPIRED', message: 'Session expired.' })
    if (!payload.sub || payload.sub !== session.userId) return res.status(401).json({ code: 'AUTH_INVALID_TOKEN', message: 'Invalid token.' })
    if (session.user.status !== 'active') return res.status(403).json({ code: 'AUTH_ACCOUNT_DISABLED', message: 'Account is not active.' })
    req.user = { id: session.userId, sessionId: session.id, role: session.user.role }
    return next()
  } catch {
    return res.status(401).json({ code: 'AUTH_INVALID_TOKEN', message: 'Invalid token.' })
  }
}

export function requireRole(role: string) {
  const requiredRank = ROLE_RANK[role] ?? Number.MAX_SAFE_INTEGER
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.user) return res.status(401).json({ code: 'AUTH_REQUIRED', message: 'Bearer token required.' })
      let currentRole = req.user.role
      if (!currentRole) {
        const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { role: true } })
        currentRole = user?.role ?? 'user'
      }
      if ((ROLE_RANK[currentRole] ?? -1) < requiredRank) return res.status(403).json({ code: 'FORBIDDEN', message: 'Insufficient permissions.' })
      return next()
    } catch {
      return res.status(403).json({ code: 'FORBIDDEN', message: 'Insufficient permissions.' })
    }
  }
}
