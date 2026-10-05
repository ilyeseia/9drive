import jwt from 'jsonwebtoken'
import { env } from '../config/env.js'

export type AccessTokenPayload = {
  sub: string
  sid: string
}

const JWT_OPTIONS = { algorithm: 'HS256' as const, issuer: '9drive' }

export function signAccessToken(payload: AccessTokenPayload) {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, { ...JWT_OPTIONS, expiresIn: env.ACCESS_TOKEN_TTL_SECONDS })
}

export function verifyAccessToken(token: string) {
  return jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: [JWT_OPTIONS.algorithm], issuer: JWT_OPTIONS.issuer }) as AccessTokenPayload
}
