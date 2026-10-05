import type { RequestHandler } from 'express'
import helmet from 'helmet'
import { defaultRateLimiter } from './rate-limit.middleware.js'

const trustedProxyTls = (process.env.TRUSTED_PROXY_TLS ?? '').toLowerCase() === 'true'

export const securityHeaders: RequestHandler = helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      'default-src': ["'self'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
      'frame-ancestors': ["'self'"],
      'object-src': ["'none'"],
      'script-src': ["'self'"],
      'style-src': ["'self'", "'unsafe-inline'"],
      'img-src': ["'self'", 'data:', 'blob:'],
      'media-src': ["'self'", 'data:', 'blob:'],
      'font-src': ["'self'", 'data:'],
      'connect-src': ["'self'"],
      'worker-src': ["'self'", 'blob:'],
    },
  },
  referrerPolicy: { policy: 'no-referrer' },
  frameguard: { action: 'sameorigin' },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  hsts: trustedProxyTls ? { maxAge: 15552000, includeSubDomains: true } : false,
})

export const noStoreHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store')
  next()
}

export const securityStack: RequestHandler[] = [securityHeaders, defaultRateLimiter]

export { defaultRateLimiter as globalRateLimiter }
export * from './rate-limit.middleware.js'
