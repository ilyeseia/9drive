import { randomUUID } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import { runWithRequestId } from '../utils/request-context.js'

const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/

/**
 * Correlation id per request: a well-formed inbound `X-Request-Id` is honoured, anything else is replaced, so a
 * client can never inject arbitrary text into log lines. The id is echoed in the response header.
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const inbound = req.header('x-request-id')
  const requestId = inbound && SAFE_REQUEST_ID.test(inbound) ? inbound : randomUUID()
  res.setHeader('X-Request-Id', requestId)
  runWithRequestId(requestId, next)
}
