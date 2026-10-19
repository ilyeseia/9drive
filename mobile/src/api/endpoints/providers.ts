/**
 * Storage providers and upload routing.
 * Contracts: backend/src/modules/providers/{account-service,provider.routes}.ts, routing/routing.{routes,service,explain}.ts,
 * providers/catalog.ts. The server is authoritative for every decision; this module only reads and edits settings.
 */

import { z } from 'zod';
import type { ApiClient } from '../client';
import { bytesString, isoDate } from '../schemas';

const nullableBytes = bytesString.nullable();

/**
 * Free space can legitimately be negative on the server (used > configured total, e.g. an S3 bucket over its quota).
 * One such account must not make the whole list unreadable, so a negative value is shown as 0 bytes available.
 */
const availableBytes = z
  .string()
  .regex(/^-?\d{1,19}$/, 'expected a decimal byte count')
  .transform((value) => (value.startsWith('-') ? '0' : value))
  .nullable();

export const accountViewSchema = z.object({
  id: z.string().min(1),
  provider: z.string(),
  displayName: z.string().nullable(),
  email: z.string(),
  status: z.string(),
  lastError: z.string().nullable().optional(),
  capabilities: z.array(z.string()).default([]),
  quota: z.object({ totalBytes: nullableBytes, usedBytes: bytesString, availableBytes }).nullable(),
  health: z.object({ state: z.string(), latencyMs: z.number().nullable(), checkedAt: isoDate }).nullable(),
  lastSyncedAt: isoDate.nullable(),
  routingEnabled: z.boolean().nullable(),
  experimental: z.boolean().default(false),
  quotaPolicy: z.enum(['required', 'optional']).default('optional'),
});
export type AccountView = z.infer<typeof accountViewSchema>;

export const catalogEntrySchema = z.object({
  id: z.string(),
  displayName: z.string(),
  status: z.string(),
  authMode: z.string().nullish(),
  connectMode: z.string().nullish(),
  experimental: z.boolean().nullish(),
  notes: z.string().nullish(),
});
export type CatalogEntry = z.infer<typeof catalogEntrySchema>;

export const healthSchema = z.object({
  state: z.string(),
  latencyMs: z.number().nullable(),
  message: z.string().nullable().optional(),
  checkedAt: isoDate,
});

export const ROUTING_MODES = [
  'most_available',
  'least_used',
  'round_robin',
  'priority',
  'provider_preference',
  'file_size',
  'file_type',
  'health_aware',
  'user_policy',
] as const;
export type RoutingMode = (typeof ROUTING_MODES)[number];

export const routingPolicySchema = z.object({
  id: z.string(),
  mode: z.string(),
  priorityAccountIds: z.array(z.string()),
  fileTypeRules: z.array(z.object({ match: z.string(), preferProvider: z.string().optional() })).default([]),
  minFileSizeBytes: nullableBytes,
  maxFileSizeBytes: nullableBytes,
  updatedAt: isoDate,
});
export type RoutingPolicy = z.infer<typeof routingPolicySchema>;

export const routingPreviewSchema = z.object({
  bytes: z.string(),
  fileType: z.string().nullable(),
  mode: z.string(),
  account: z
    .object({ id: z.string(), provider: z.string(), displayName: z.string().nullable(), email: z.string(), status: z.string() })
    .nullable(),
  reason: z.string(),
  matchedRule: z.object({ match: z.string(), preferProvider: z.string().optional() }).nullable().optional(),
  steps: z.array(z.object({ step: z.string(), candidates: z.number(), eliminated: z.number(), detail: z.string() })),
});
export type RoutingPreview = z.infer<typeof routingPreviewSchema>;

export interface S3ConnectInput {
  name: string;
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
}

export const providersApi = {
  accounts: (client: ApiClient, signal?: AbortSignal) => client.request({ path: '/providers', schema: z.array(accountViewSchema), signal }),

  /** Public endpoint; used for display names and to explain which providers cannot be connected from the app. */
  catalog: (client: ApiClient, signal?: AbortSignal) =>
    client.request({ path: '/providers/catalog', auth: false, schema: z.array(catalogEntrySchema), signal }),

  /**
   * Asks the server for the provider's sign-in page URL. The server holds the OAuth client secret and completes the
   * sign-in on its own callback, so no provider token ever reaches the device.
   */
  connectUrl: (client: ApiClient, provider: string) =>
    client
      .request({
        method: 'POST',
        path: `/providers/${encodeURIComponent(provider)}/connect-url`,
        body: {},
        schema: z.object({ url: z.string().url() }),
      })
      .then((r) => r.url),

  checkHealth: (client: ApiClient, accountId: string) =>
    client.request({ method: 'POST', path: `/providers/accounts/${encodeURIComponent(accountId)}/health`, body: {}, schema: healthSchema }),

  refreshQuota: (client: ApiClient, accountId: string) =>
    client.requestVoid({ method: 'POST', path: `/connected-accounts/${encodeURIComponent(accountId)}/sync-quota`, body: {} }),

  setRoutingEnabled: (client: ApiClient, accountId: string, enabled: boolean) =>
    client.requestVoid({ method: 'PATCH', path: `/providers/accounts/${encodeURIComponent(accountId)}/routing`, body: { enabled } }),

  disconnect: (client: ApiClient, accountId: string) =>
    client.requestVoid({ method: 'DELETE', path: `/providers/accounts/${encodeURIComponent(accountId)}` }),

  /** The secret travels once over TLS to the server and is never stored on the device. */
  connectS3: (client: ApiClient, input: S3ConnectInput) =>
    client.requestVoid({
      method: 'POST',
      path: '/connected-accounts/s3',
      body: {
        ...input,
        endpoint: input.endpoint?.trim() || undefined,
        name: input.name.trim(),
        bucket: input.bucket.trim(),
        region: input.region.trim(),
      },
    }),

  routingPolicy: (client: ApiClient, signal?: AbortSignal) =>
    client.request({ path: '/routing/policies', schema: z.object({ policy: routingPolicySchema }), signal }).then((r) => r.policy),

  updateRoutingPolicy: (client: ApiClient, patch: { mode?: RoutingMode; priorityAccountIds?: string[] }) =>
    client
      .request({ method: 'PATCH', path: '/routing/policies', body: patch, schema: z.object({ policy: routingPolicySchema }) })
      .then((r) => r.policy),

  previewRouting: (client: ApiClient, input: { bytes: number; fileType?: string; folderId?: string }) =>
    client.request({
      method: 'POST',
      path: '/routing/preview',
      body: {
        bytes: String(Math.max(0, Math.floor(input.bytes))),
        ...(input.fileType ? { fileType: input.fileType } : {}),
        ...(input.folderId ? { folderId: input.folderId } : {}),
      },
      // A dry run changes nothing on the server, so repeating it is safe.
      idempotent: true,
      schema: routingPreviewSchema,
    }),
};
