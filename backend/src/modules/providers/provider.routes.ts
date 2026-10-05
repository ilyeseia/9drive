/**
 * Providers API — docs/architecture/contracts/api-contract.md §4.1.
 * Mounted at /providers by app.ts (mount line owned by the coordinator).
 */

import type { NextFunction, Request, Response } from 'express'
import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../config/prisma.js'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { catalog, checkAccount } from '../../providers/index.js'
import { jsonSafe } from '../../utils/serialize.js'
import {
  apiKeyConnectSchema,
  capabilitiesFor,
  createApiKeyAccount,
  createS3Account,
  disconnectOwnedAccount,
  findOwnedAccount,
  listProviderAccountViews,
  s3ConnectSchema,
  toProviderAccountView,
} from './account-service.js'
import { connectUrlInputSchema, connectRedirectUrl, createConnectUrl, handleConnectCallback } from './connect-flow.js'
import { resolveRouteError, RequestError } from './http-error.js'

export const providerRouter = Router()

function replyError(res: Response, next: NextFunction, error: unknown) {
  const payload = resolveRouteError(error)
  if (payload) return res.status(payload.status).json({ code: payload.code, message: payload.message })
  return next(error)
}

async function ownedAccountOr404(req: AuthRequest) {
  const account = await findOwnedAccount(req.user!.id, String(req.params.accountId))
  if (!account) throw new RequestError(404, 'NOT_FOUND', 'Connected account not found.')
  return account
}

providerRouter.get('/catalog', (_req: Request, res: Response) => res.json(catalog.list()))

providerRouter.get('/', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    return res.json(jsonSafe(await listProviderAccountViews(req.user!.id)))
  } catch (error) {
    return replyError(res, next, error)
  }
})

providerRouter.get('/accounts/:accountId/capabilities', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const account = await ownedAccountOr404(req)
    return res.json({ capabilities: capabilitiesFor(account.provider) })
  } catch (error) {
    return replyError(res, next, error)
  }
})

providerRouter.post('/accounts/:accountId/health', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const account = await ownedAccountOr404(req)
    const health = await checkAccount(account.id)
    return res.json(jsonSafe({
      state: health.state,
      latencyMs: health.latencyMs,
      message: health.message,
      checkedAt: health.checkedAt,
    }))
  } catch (error) {
    return replyError(res, next, error)
  }
})

providerRouter.delete('/accounts/:accountId', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const removed = await disconnectOwnedAccount(req.user!.id, String(req.params.accountId))
    if (!removed) throw new RequestError(404, 'ACCOUNT_NOT_FOUND', 'Connected account not found.')
    return res.json({ status: 'ok' })
  } catch (error) {
    return replyError(res, next, error)
  }
})

providerRouter.post('/:provider/connect-url', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const provider = String(req.params.provider)
    const input = connectUrlInputSchema.parse(req.body ?? {})
    return res.json(await createConnectUrl(req.user!.id, provider, input))
  } catch (error) {
    return replyError(res, next, error)
  }
})

providerRouter.get('/:provider/callback', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const provider = String(req.params.provider)
    const outcome = await handleConnectCallback(provider, req.query as Record<string, unknown>)
    return res.redirect(302, connectRedirectUrl(provider, outcome))
  } catch (error) {
    return replyError(res, next, error)
  }
})

providerRouter.post('/:provider/accounts', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const provider = String(req.params.provider)
    const entry = catalog.get(provider)
    if (!entry) throw new RequestError(404, 'PROVIDER_NOT_FOUND', 'Unknown provider.')
    if (entry.authMode === 'oauth2') {
      throw new RequestError(400, 'AUTH_MODE_UNSUPPORTED', 'This provider connects through OAuth2. Use POST /providers/:provider/connect-url instead.')
    }
    if (entry.status !== 'SUPPORTED' && entry.status !== 'VIA_S3') {
      throw new RequestError(409, 'PROVIDER_NOT_AVAILABLE', 'This provider is not available yet.')
    }

    if (entry.authMode === 'access_key') {
      const body = s3ConnectSchema.parse(req.body)
      const { account, quota } = await createS3Account(req.user!.id, body)
      const health = await prisma.providerHealth.findUnique({ where: { connectedAccountId: account.id } })
      return res.status(201).json(jsonSafe({ account: toProviderAccountView(account, quota, health) }))
    }

    const body = apiKeyConnectSchema.parse(req.body)
    const account = await createApiKeyAccount(req.user!.id, provider, body)
    const health = await prisma.providerHealth.findUnique({ where: { connectedAccountId: account.id } })
    return res.status(201).json(jsonSafe({ account: toProviderAccountView(account, null, health) }))
  } catch (error) {
    return replyError(res, next, error)
  }
})
