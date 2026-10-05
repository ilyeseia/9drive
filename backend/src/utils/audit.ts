import { Prisma } from '@prisma/client'
import { prisma } from '../config/prisma.js'
import { serializeBigInt } from './serialize.js'

export async function createAuditLog(userId: string, action: string, entityType: string, entityId?: string, metadata?: any) {
  try {
    await prisma.auditLog.create({
      data: {
        userId,
        action,
        entityType,
        entityId,
        metadata: metadata == null ? undefined : (serializeBigInt(metadata) as Prisma.InputJsonValue)
      }
    })
  } catch (error) {
    console.error('Failed to create audit log:', error)
  }
}
