import { Prisma } from '@prisma/client'
import type { NextFunction, Request, Response } from 'express'
import { ZodError } from 'zod'

function isPrismaRequestError(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError
}

export function errorMiddleware(error: unknown, req: Request, res: Response, _next: NextFunction) {
  if (error instanceof ZodError) {
    const issue = error.issues[0]
    const path = issue?.path?.join('.') || 'payload'
    return res.status(400).json({ code: 'VALIDATION_FAILED', message: issue ? `${path}: ${issue.message}` : 'Invalid request payload.' })
  }
  if (isPrismaRequestError(error) && error.code === 'P2025') {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Resource not found.' })
  }
  console.error(`[${req.method} ${req.originalUrl}]`, error)
  return res.status(500).json({ code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' })
}
