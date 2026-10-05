import { cleanupHandler } from './processors/cleanup.js'
import { downloadHandler } from './processors/download.js'
import { healthCheckHandler } from './processors/health-check.js'
import { metadataIndexingHandler } from './processors/metadata-indexing.js'
import { migrationHandler } from './processors/migration.js'
import { quotaRefreshHandler } from './processors/quota-refresh.js'
import { replicationHandler } from './processors/replication.js'
import { retryHandler } from './processors/retry.js'
import { syncHandler } from './processors/sync.js'
import { uploadHandler } from './processors/upload.js'
import { webhookDeliveryHandler } from './processors/webhook-delivery.js'
import type { HandlerMap, PartialHandlerMap } from './types.js'

export const defaultHandlers: HandlerMap = {
  UPLOAD: uploadHandler,
  DOWNLOAD: downloadHandler,
  SYNC: syncHandler,
  METADATA_INDEXING: metadataIndexingHandler,
  QUOTA_REFRESH: quotaRefreshHandler,
  HEALTH_CHECK: healthCheckHandler,
  CLEANUP: cleanupHandler,
  REPLICATION: replicationHandler,
  MIGRATION: migrationHandler,
  WEBHOOK_DELIVERY: webhookDeliveryHandler,
  RETRY: retryHandler,
}

export function resolveHandlers(overrides: PartialHandlerMap = {}): HandlerMap {
  const resolved = { ...defaultHandlers }
  for (const [type, handler] of Object.entries(overrides)) {
    if (handler) (resolved as PartialHandlerMap)[type as keyof HandlerMap] = handler as never
  }
  return resolved
}
