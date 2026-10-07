# Provider Contract

**Status:** NORMATIVE — source of truth for all storage-provider code.
**Owner:** Coordinator. Changes require a proposal (see `docs/architecture/contracts/README.md` process).
**Applies to:** `backend/src/providers/**` and every route/service that touches remote storage.

---

## 1. Hard rules

1. **No provider-specific code outside `backend/src/providers/<provider-id>/`.**
   `if (provider === 'google_drive')` / `if (provider === 's3')` is forbidden in
   `backend/src/modules/**`. The only permitted provider knowledge in modules is:
   - `registry.get(providerId)` / `registry.supportedIds()`
   - `catalog.get(providerId).status`
   - capability checks: `registry.capabilities(providerId).has('createShare')`
2. **The core application is provider-independent.** Adding a provider must not require
   editing `upload.routes.ts`, `file.routes.ts`, `folder.routes.ts`, `storage.routes.ts`,
   or any frontend page beyond the provider catalog display.
3. **Only legitimate official APIs.** No reverse engineering, no cookie/session extraction,
   no CAPTCHA bypass, no private undocumented endpoints. If an official API is unavailable
   the provider is registered with status `UNSUPPORTED` or `RESEARCH_REQUIRED` in the
   catalog and **no adapter is written**.
4. **Adapters never log credentials, tokens, or raw signed URLs.**

---

## 2. Provider ID vocabulary

Stable, lowercase, snake_case. Never renamed once shipped.

| id | display name | status |
|---|---|---|
| `google_drive` | Google Drive | `SUPPORTED` |
| `s3` | S3-compatible (AWS, MinIO, R2, B2, Wasabi, IDrive e2, Internxt, …) | `SUPPORTED` |
| `dropbox` | Dropbox | `SUPPORTED` |
| `onedrive` | OneDrive | `SUPPORTED` |
| `pcloud` | pCloud | `SUPPORTED` |
| `box` | Box | `PLANNED` |
| `yandex_disk` | Yandex Disk | `PLANNED` |
| `koofr` | Koofr | `PLANNED` |
| `mega` | MEGA | `RESEARCH_REQUIRED` |
| `mediafx` → `mediafire` | MediaFire | `PLANNED` |
| `terabox` | TeraBox | `SUPPORTED` |
| `proton_drive` | Proton Drive | `RESEARCH_REQUIRED` |
| `icedrive` | Icedrive | `UNSUPPORTED` |
| `sync` | Sync.com | `UNSUPPORTED` |
| `idrive` | IDrive (consumer) | `UNSUPPORTED` |
| `internxt` | Internxt (via `s3`) | `VIA_S3` |
| `idrive_e2` | IDrive e2 (via `s3`) | `VIA_S3` |
| `backblaze_b2` | Backblaze B2 (via `s3`) | `VIA_S3` |
| `cloudflare_r2` | Cloudflare R2 (via `s3`) | `VIA_S3` |
| `minio` | MinIO (via `s3`) | `VIA_S3` |
| `wasabi` | Wasabi (via `s3`) | `VIA_S3` |

`VIA_S3` entries are **presets** in the catalog: they pre-fill `endpoint`/`forcePathStyle`
defaults in the S3 adapter and are not separate adapters.

---

## 3. Capability flags

Declared per provider, static (from the adapter) and optionally narrowed per account
(e.g. a plan that forbids public links).

```ts
type Capability =
  | 'authenticate' | 'getAccountInfo' | 'getQuota'
  | 'upload' | 'uploadResumable' | 'download' | 'downloadRange'
  | 'list' | 'getMetadata' | 'search'
  | 'createFolder' | 'rename' | 'move' | 'copy' | 'delete'
  | 'createShare' | 'revokeShare'
  | 'healthCheck'
```

A provider MUST declare every capability it can honour. The core MUST check
`capabilities.has(...)` before invoking an operation and return
`ERR_CAPABILITY_UNSUPPORTED` when absent. Never call an unimplemented method.

---

## 4. `StorageProvider` interface (normative)

Located at `backend/src/providers/types.ts`.

```ts
export type ProviderId = string;

export interface ProviderContext {
  /** Fully-resolved, already-decrypted credential material. Never persisted. */
  credentials: ProviderCredentials;
  /** Neutral account descriptor derived from ConnectedAccount + provider config. */
  account: {
    id: string;                  // ConnectedAccount.id
    userId: string;
    provider: ProviderId;
    providerAccountId: string;   // remote subject (email / account id / bucket)
    displayName?: string | null;
    config: Record<string, unknown>; // provider-specific JSONB (endpoint, region, prefix…)
  };
  signal?: AbortSignal;
  logger: (msg: string, meta?: Record<string, unknown>) => void;
}

export type ProviderCredentials =
  | { kind: 'oauth2'; accessToken: string; refreshToken?: string; expiresAt?: number | null; clientId?: string; clientSecret?: string; redirectUri?: string }
  | { kind: 'access_key'; accessKeyId: string; secretAccessKey: string; endpoint?: string; region?: string; forcePathStyle?: boolean }
  | { kind: 'api_key'; apiKey: string; apiSecret?: string };

export interface QuotaInfo {
  totalBytes: bigint | null;      // null = provider does not report
  usedBytes: bigint;
  availableBytes: bigint | null;
  trashBytes?: bigint | null;
  raw?: Record<string, unknown>;
}

export interface RemoteFileMeta {
  remoteId: string;
  name: string;
  mimeType: string;
  sizeBytes: bigint;
  parentId: string | null;
  isFolder: boolean;
  createdAt?: string | null;
  modifiedAt?: string | null;
  checksum?: string | null;
  webUrl?: string | null;         // provider UI link, nullable
}

export interface UploadInput {
  stream: NodeJS.ReadableStream;
  fileName: string;
  mimeType: string;
  sizeBytes: bigint;
  parentId: string | null;
  /** Optional opaque resume token returned by a previous uploadResumable attempt. */
  resumeToken?: string | null;
}

export interface UploadResult {
  remoteId: string;
  sizeBytes: bigint;
  resumeToken?: string | null;
}

export interface DownloadResult {
  stream: NodeJS.ReadableStream;
  sizeBytes?: bigint | null;
  mimeType?: string | null;
  /** Byte range actually served, when `range` was requested. */
  range?: { start: number; end: number; total: number | null };
}

export interface ListResult {
  entries: RemoteFileMeta[];
  nextCursor?: string | null;
}

export type ShareVisibility = 'public_read' | 'private';

export interface ShareResult {
  url: string;
  visibility: ShareVisibility;
  expiresAt?: string | null;
}

export type HealthState = 'healthy' | 'degraded' | 'unauthorized' | 'unreachable' | 'unknown';

export interface HealthResult {
  state: HealthState;
  latencyMs: number;
  message?: string | null;
  checkedAt: string;
}

export interface StorageProvider {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly authMode: 'oauth2' | 'access_key' | 'api_key';
  readonly capabilities: ReadonlySet<Capability>;

  getCapabilities(): ReadonlySet<Capability>;

  getAccountInfo(ctx: ProviderContext): Promise<{
    providerAccountId: string;
    email?: string | null;
    displayName?: string | null;
    avatarUrl?: string | null;
  }>;

  getQuota(ctx: ProviderContext): Promise<QuotaInfo>;

  upload(ctx: ProviderContext, input: UploadInput): Promise<UploadResult>;
  download(ctx: ProviderContext, input: { remoteId: string; range?: { start: number; end?: number } }): Promise<DownloadResult>;
  list(ctx: ProviderContext, input: { parentId: string | null; cursor?: string | null; limit?: number }): Promise<ListResult>;
  getMetadata(ctx: ProviderContext, input: { remoteId: string }): Promise<RemoteFileMeta>;
  createFolder(ctx: ProviderContext, input: { name: string; parentId: string | null }): Promise<RemoteFileMeta>;
  rename(ctx: ProviderContext, input: { remoteId: string; newName: string }): Promise<RemoteFileMeta>;
  move(ctx: ProviderContext, input: { remoteId: string; newParentId: string | null }): Promise<RemoteFileMeta>;
  copy(ctx: ProviderContext, input: { remoteId: string; newParentId: string | null; newName?: string }): Promise<RemoteFileMeta>;
  delete(ctx: ProviderContext, input: { remoteId: string; permanent?: boolean }): Promise<void>;
  createShare(ctx: ProviderContext, input: { remoteId: string; visibility: ShareVisibility; expiresAt?: string | null }): Promise<ShareResult>;
  revokeShare?(ctx: ProviderContext, input: { remoteId: string }): Promise<void>;
  healthCheck(ctx: ProviderContext): Promise<HealthResult>;
}
```

Methods for capabilities the provider does not declare MUST throw
`ProviderError('ERR_CAPABILITY_UNSUPPORTED')`. They must never be reached because callers
check first.

### 4.1 Streaming is mandatory
`upload` MUST consume the provided stream without buffering the whole body in memory.
`download` MUST return a stream. `Buffer.concat` of a full file is a contract violation
(see `security-contract.md` §6).

### 4.2 BigInt
All byte counts crossing this boundary are `bigint`. Adapters convert provider-specific
types (`Decimal`, `number`, `string`) explicitly. Never use `number` for byte totals.

---

## 5. Error taxonomy

`backend/src/providers/errors.ts`:

```ts
class ProviderError extends Error {
  code: ProviderErrorCode;
  retryable: boolean;
  status?: number;      // upstream HTTP status when relevant
  detail?: unknown;     // never returned to clients verbatim
}
```

| code | retryable | HTTP mapping |
|---|---|---|
| `ERR_AUTH_EXPIRED` | no (after one refresh attempt) | 401 |
| `ERR_AUTH_REVOKED` | no | 401 |
| `ERR_CAPABILITY_UNSUPPORTED` | no | 400 |
| `ERR_NOT_FOUND` | no | 404 |
| `ERR_QUOTA_EXCEEDED` | no | 507 |
| `ERR_RATE_LIMITED` | yes | 429 |
| `ERR_UPSTREAM_UNAVAILABLE` | yes | 503 |
| `ERR_TIMEOUT` | yes | 504 |
| `ERR_INVALID_INPUT` | no | 400 |
| `ERR_SSRF_BLOCKED` | no | 400 |
| `ERR_INTERNAL` | no | 500 |

Rules:
- Adapters MUST map upstream failures into this taxonomy. Never let a raw fetch/SDK error
  escape into `error.middleware.ts` (which currently leaks `error.message` → see
  `security-contract.md` §9).
- `retryable` drives job retries (`job-contract.md` §4).
- Upstream messages are stored on `ProviderHealth.lastError` / `ConnectedAccount.lastError`
  **truncated to 500 chars** and never returned in API responses verbatim.

---

## 6. Registry

`backend/src/providers/registry.ts`:

```ts
class ProviderRegistry {
  register(provider: StorageProvider): void;
  get(id: ProviderId): StorageProvider;              // throws if unknown/unregistered
  tryGet(id: ProviderId): StorageProvider | null;
  supportedIds(): ProviderId[];
  capabilities(id: ProviderId): ReadonlySet<Capability>;
  all(): StorageProvider[];
}
export const registry: ProviderRegistry;
```

Registration happens in `backend/src/providers/index.ts` (side-effect import). The registry
is the ONLY way modules obtain a provider.

### 6.1 Context builder
`backend/src/providers/context.ts` exports:

```ts
buildContext(accountId: string, opts?: { signal?: AbortSignal }): Promise<ProviderContext>
```

It loads `ConnectedAccount`, decrypts credentials (`utils/crypto.ts`), merges provider
`config` JSONB, auto-refreshes OAuth tokens when within 120 s of expiry (persisting the
new access token + `tokenExpiresAt`), and throws `ERR_AUTH_EXPIRED` if refresh fails.

`buildContext` is the single choke point for credential decryption.

---

## 7. Catalog

`backend/src/providers/catalog.ts` — static metadata used by API + UI:

```ts
interface ProviderCatalogEntry {
  id: ProviderId;
  displayName: string;
  status: 'SUPPORTED' | 'PLANNED' | 'RESEARCH_REQUIRED' | 'UNSUPPORTED' | 'VIA_S3';
  authMode: 'oauth2' | 'access_key' | 'api_key';
  capabilities: Capability[];
  docsUrl?: string;
  notes?: string;          // for UNSUPPORTED/RESEARCH_REQUIRED: why, and what would unblock it
  s3Preset?: { endpoint: string; forcePathStyle: boolean; region: string };
}
```

`GET /providers/catalog` returns this verbatim. **Every provider listed in §2 must appear
in the catalog with an accurate `status` and, for non-supported ones, a `notes` string
explaining why** (e.g. "No official public API; community integrations require browser
cookies and CAPTCHA bypass, which 9Drive does not perform.").

---

## 8. OAuth2 shared helper

`backend/src/providers/oauth2.ts` — used by every `authMode: 'oauth2'` provider:

```ts
buildAuthorizationUrl(opts): string
exchangeCode(opts): Promise<{ accessToken; refreshToken?; expiresAt? }>
refreshAccessToken(opts): Promise<{ accessToken; refreshToken?; expiresAt? }>
```

Provider-specific token endpoints/scopes/extra params are supplied by the adapter.
Refresh-token rotation: if the upstream returns a new refresh token, it MUST be persisted
over the old one.

Connect flow (owned by `connected-account.routes.ts`, provider-neutral):
`GET /connected-accounts/:provider/connect-url` → `GET /connected-accounts/:provider/callback`
replaces the Google-only pair while keeping `GET /connected-accounts/google/connect-url`
as a backward-compatible alias.

---

## 9. Routing integration

`backend/src/providers/routing.ts` exports the account selector used by uploads:

```ts
selectAccount(input: {
  userId: string;
  requiredBytes: bigint;
  requiredCapabilities: Capability[];
  targetAccountId?: string | null;
  folderId?: string | null;
}): Promise<{ account: ConnectedAccount; provider: StorageProvider } | null>
```

Implements `UploadRoutingPolicy.mode` (see `api-contract.md` §6) over **all** connected
accounts whose provider is `SUPPORTED` and whose capabilities satisfy
`requiredCapabilities`. Provider preference comes from the policy, never from an
`in: ['google_drive','s3']` filter.

Routing inputs, in evaluation order:
1. `account.status === 'connected'`
2. provider `SUPPORTED`
3. required capabilities present
4. quota headroom (`availableBytes - reserved >= requiredBytes`, `null` = unlimited)
5. policy mode: `most_available` | `least_used` | `round_robin` | `priority` |
   `provider_preference` | `file_size` | `file_type` | `health_aware` | `user_policy`
6. health: accounts in `unauthorized`/`unreachable` are excluded unless the policy is
   explicitly `health_aware`-tolerant.

---

## 10. Health & quota

- `backend/src/providers/health.ts` — `checkAccount(accountId)` runs `healthCheck` and
  upserts `ProviderHealth` (`state`, `latencyMs`, `message`, `checkedAt`).
- Quota refresh writes `StorageAccount` (`totalBytes`, `usedBytes`, `availableBytes`,
  `trashBytes`, `lastSyncedAt`).
- Scheduled by `HEALTH_CHECK` and `QUOTA_REFRESH` jobs (`job-contract.md` §2).
- `ConnectedAccount.lastSyncedAt` staleness threshold for upload-time refresh: 5 minutes
  (preserved from current behaviour).

---

## 11. Per-provider adapter checklist

For each `SUPPORTED` provider, the adapter directory MUST contain:
- `index.ts` exporting a `StorageProvider` (registered in `providers/index.ts`)
- `oauth2.ts` (if `authMode === 'oauth2'`) with scopes, auth URL, token URL, refresh logic
- documented `docs/architecture/providers/<id>.md` covering: auth setup, required console
  steps, scopes, quirks, rate limits, and anything NOT supported by the official API

Capability-specific notes that already exist in the codebase and MUST be preserved:
- **Google Drive**: root folder `9drive` per account; export MIME conversion for
  Google Docs types on download; resumable upload sessions; **public sharing is opt-in and
  reader-only** (see `security-contract.md` §5 — the current auto-`anyone/writer` behaviour
  is removed).
- **S3**: object key layout `prefix/userId/fileId/fileName`; quota via `ListObjectsV2`
  aggregation; custom `endpoint` must pass the SSRF gate (`security-contract.md` §7).
- **Dropbox**: 150 MB simple upload limit → upload sessions above it; `download` returns a
  temporary link; `list` uses `list_folder` with cursor pagination.
- **OneDrive**: 4 MB simple upload limit → upload sessions above it; quota from
  `/me/drive?$select=quota`; shares via `createLink`.
- **pCloud**: access tokens do not expire; quota from `userinfo` (`quota`, `usedquota`);
  folder upload via `writefile`/`savefile` streams.

---

## 12. Contract change process

```
Agent → proposal (docs/architecture/contracts/CHANGE-proposal-<n>.md)
      → Coordinator impact analysis
      → Coordinator updates this file
      → Coordinator notifies dependent agents
      → dependent agents re-read before continuing
```
Agents MUST NOT edit this file.
