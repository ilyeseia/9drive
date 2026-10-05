import { z } from 'zod'

export const JOB_TYPES = [
  'UPLOAD',
  'DOWNLOAD',
  'SYNC',
  'METADATA_INDEXING',
  'QUOTA_REFRESH',
  'HEALTH_CHECK',
  'CLEANUP',
  'REPLICATION',
  'MIGRATION',
  'WEBHOOK_DELIVERY',
  'RETRY',
] as const
export type JobType = (typeof JOB_TYPES)[number]

export const QUEUE_NAMES = [
  'transfer',
  'sync',
  'maintenance',
  'replication',
  'migration',
  'webhook',
  'retry',
] as const
export type QueueName = (typeof QUEUE_NAMES)[number]

export const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000'

const correlation = {
  userId: z.string().min(1),
  requestId: z.string().min(1).max(128).optional(),
}

export const uploadPayloadSchema = z.object({
  ...correlation,
  accountId: z.string().min(1).nullish(),
  folderId: z.string().min(1).nullish(),
  spoolKey: z.string().min(1),
  fileName: z.string().min(1).max(1024),
  mimeType: z.string().min(1).max(191),
  sizeBytes: z.string().regex(/^\d+$/),
})

export const downloadPayloadSchema = z.object({
  ...correlation,
  fileId: z.string().min(1),
  target: z.enum(['preview', 'download']).optional(),
})

export const syncPayloadSchema = z.object({
  ...correlation,
  accountId: z.string().min(1),
  scope: z.enum(['folder', 'full']).optional(),
})

export const metadataIndexingPayloadSchema = z.object({
  ...correlation,
  accountId: z.string().min(1),
  cursor: z.string().nullish(),
})

export const quotaRefreshPayloadSchema = z.object({
  ...correlation,
  accountId: z.string().min(1).optional(),
})

export const healthCheckPayloadSchema = z.object({
  ...correlation,
  accountId: z.string().min(1).optional(),
})

export const cleanupPayloadSchema = z.object({
  ...correlation,
  scope: z.enum(['expired_tokens', 'stale_sessions', 'old_operations', 'all']),
})

export const replicationPayloadSchema = z.object({
  ...correlation,
  replicationJobId: z.string().min(1),
})

export const migrationPayloadSchema = z.object({
  ...correlation,
  migrationJobId: z.string().min(1),
  scope: z.object({
    folderIds: z.array(z.string().min(1)).max(500).optional(),
    fileIds: z.array(z.string().min(1)).max(5000).optional(),
  }).optional(),
})

export const webhookDeliveryPayloadSchema = z.object({
  ...correlation,
  deliveryId: z.string().min(1),
})

export const retryPayloadSchema = z.object({
  ...correlation,
  kind: z.string().min(1).max(64),
  refId: z.string().min(1),
})

export const jobPayloadSchemas = {
  UPLOAD: uploadPayloadSchema,
  DOWNLOAD: downloadPayloadSchema,
  SYNC: syncPayloadSchema,
  METADATA_INDEXING: metadataIndexingPayloadSchema,
  QUOTA_REFRESH: quotaRefreshPayloadSchema,
  HEALTH_CHECK: healthCheckPayloadSchema,
  CLEANUP: cleanupPayloadSchema,
  REPLICATION: replicationPayloadSchema,
  MIGRATION: migrationPayloadSchema,
  WEBHOOK_DELIVERY: webhookDeliveryPayloadSchema,
  RETRY: retryPayloadSchema,
} as const satisfies Record<JobType, z.ZodType>

export type JobPayloadInput<T extends JobType> = z.output<(typeof jobPayloadSchemas)[T]>
export type JobPayloads = { [K in JobType]: JobPayloadInput<K> & { jobId: string } }
export type EnqueueInput<T extends JobType> = JobPayloadInput<T>

export function isJobType(value: unknown): value is JobType {
  return typeof value === 'string' && (JOB_TYPES as readonly string[]).includes(value)
}
