# API Contract

**Status:** NORMATIVE — HTTP surface conventions and endpoint inventory.
**Owner:** Coordinator. Agents MUST NOT remove or rename an existing endpoint without a
proposal approved by the Coordinator.

---

## 1. Base paths & proxying

The frontend is served by nginx; `location /api/ { proxy_pass http://backend:4000/; }`
**strips the `/api/` prefix**.

| Caller | Requests | Backend route |
|---|---|---|
| Frontend (dev) | `http://localhost:4000/<path>` | `/<path>` |
| Frontend (prod) | `/api/<path>` → stripped | `/<path>` |
| Public API key client (proxied) | `/api/v1/uploads` → stripped | `/v1/uploads` |
| Public API key client (direct) | `http://host:4000/api/v1/uploads` | `/api/v1/uploads` |

**Requirement:** the public API-key router is mounted at BOTH `/v1` and `/api` so both
forms resolve. All internal (session) routes live at the backend root.

Backend mounts (final):

```
GET  /health
/api  + /v1   -> public API-key routes (requireApiKey)
/public       -> anonymous share routes
/auth, /api-keys, /providers, /connected-accounts, /storage, /uploads,
/files, /folders, /invites, /audit-logs, /system, /jobs, /routing,
/replication, /migration, /webhooks, /dashboard
```

---

## 2. General conventions

- **Auth:** `Authorization: Bearer <accessToken>` for session routes;
  `Authorization: Bearer 9d_live_...` for public API-key routes. Cookies are never used.
- **Validation:** every body/query/param validated with zod before use.
- **Errors:** always
  ```json
  { "code": "SNAKE_CASE_CODE", "message": "human readable" }
  ```
  HTTP status is meaningful (`400/401/403/404/409/413/429/500/503/507`).
  Internal/provider messages are NEVER echoed raw (see `security-contract.md` §9).
- **Success:** resource JSON, or `{ items: [...], nextCursor?: string }` for lists.
- **Bigints:** serialized as decimal strings.
- **Pagination:** cursor-based via `?cursor=&limit=` (default 50, max 200) for
  `/files`, `/folders`, `/jobs`, `/audit-logs`, `/storage/operations`.
  `limit`/`offset` retained where already implemented for backward compatibility.
- **Rate limit headers** on every response when limited:
  `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` (see `security-contract.md` §8).
- **Idempotency:** mutating public API endpoints accept `Idempotency-Key` header.
- **Correlation:** `X-Request-Id` accepted/generated and echoed.

### 2.1 Standard error codes
`UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_FAILED`, `CONFLICT`,
`RATE_LIMITED`, `PAYLOAD_TOO_LARGE`, `CAPABILITY_UNSUPPORTED`, `QUOTA_EXCEEDED`,
`PROVIDER_UNAVAILABLE`, `INTERNAL_SERVER_ERROR`.

### 2.2 Express error handling
`error.middleware.ts` maps:
- ZodError → 400 `VALIDATION_FAILED`
- Prisma `P2025` → 404 `NOT_FOUND`
- `ProviderError` → its mapped status/code
- everything else → 500 `INTERNAL_SERVER_ERROR` with a **generic** message
  (raw `error.message` is not sent to clients).

---

## 3. Existing endpoints — MUST keep working

All routes currently mounted in `backend/src/app.ts` and consumed by the frontend remain
byte-compatible in path, method and response shape:

```
GET  /health
POST /auth/register | /auth/login | /auth/refresh | /auth/logout | /auth/google/exchange
GET  /auth/google/url | /auth/google/callback | /auth/me
GET  /api-keys  POST /api-keys  DELETE /api-keys/:id
POST /provider-configs/google  GET /provider-configs  DELETE /provider-configs/:id
GET  /connected-accounts
POST /connected-accounts/s3
GET  /connected-accounts/google/connect-url | /google/connect | /google/callback
POST /connected-accounts/:id/sync-quota      DELETE /connected-accounts/:id
GET  /storage/summary | /storage/breakdown
GET|PATCH /storage/routing-policy
POST /uploads
POST /uploads/resumable/init  GET /uploads/resumable/status/:id  PUT /uploads/resumable/chunk/:id
GET|PATCH /files ... (full list in repo AGENTS.md §API Notes)
GET|POST /folders ...
GET|POST|DELETE /invites ...
GET  /audit-logs
GET|POST /system/...      (re-gated by role, see security-contract.md §3)
GET  /public/files/:token[ /download | /preview ]
POST /api/v1/uploads
```

Backward-compatible aliases that MUST exist after refactoring:
- `GET /connected-accounts/google/connect-url` → delegated to
  `GET /connected-accounts/google/connect-url` generic handler.
- `POST /connected-accounts/s3` → kept as a thin alias of
  `POST /connected-accounts/s3/connect`.

---

## 4. New endpoints

### 4.1 Providers
```
GET    /providers/catalog                 -> ProviderCatalogEntry[]  (public auth)
GET    /providers                         -> configured providers for current user
POST   /providers/:provider/connect-url   -> { url, state }          (OAuth providers)
GET    /providers/:provider/callback      -> redirect (browser)
POST   /providers/:provider/accounts      -> body: provider-specific config (access-key providers)
DELETE /providers/accounts/:accountId     -> alias of DELETE /connected-accounts/:accountId
GET    /providers/accounts/:accountId/capabilities -> { capabilities: Capability[] }
POST   /providers/accounts/:accountId/health       -> HealthResult
```

`GET /providers` returns, per connected account:
```json
{
  "id": "...", "provider": "google_drive", "displayName": "...", "email": "...",
  "status": "connected", "authMode": "oauth2",
  "capabilities": ["upload", "download", "..."],
  "quota": { "totalBytes": "...", "usedBytes": "...", "availableBytes": "..." },
  "health": { "state": "healthy", "latencyMs": 123, "checkedAt": "..." },
  "lastSyncedAt": "..."
}
```

### 4.2 Dashboard
```
GET /dashboard/summary
{
  "capacity": { "totalBytes": "...", "usedBytes": "...", "availableBytes": "..." },
  "accounts": { "total": 8, "connected": 7, "degraded": 1, "unauthorized": 0 },
  "byProvider": [ { "provider": "s3", "accounts": 3, "usedBytes": "...", "totalBytes": "..." } ],
  "files": { "count": 1234, "bytes": "..." },
  "health": [ { "accountId": "...", "provider": "...", "state": "healthy" } ],
  "jobs": { "queued": 2, "active": 1, "failed": 0, "completed": 24 },
  "recentOperations": [ { "operation": "upload", "status": "succeeded", "createdAt": "..." } ]
}
```

### 4.3 Jobs
```
GET    /jobs?status=&type=&cursor=&limit=
GET    /jobs/:id
POST   /jobs/:id/retry
POST   /jobs/:id/cancel
DELETE /jobs/:id                 (purge finished job row)
```
Response item: mirrors the `Job` model plus `provider`, `progress`, `attempts`,
`error` (sanitised), `payload` (sanitised — no secrets).

### 4.4 Routing
```
GET    /routing/policies                 -> all user policies (upload + advanced rules)
PATCH  /routing/policies                 -> update mode/rules (replaces PATCH /storage/routing-policy)
POST   /routing/preview                  -> dry-run: given { bytes, fileType, folderId } return chosen account + reason
```
`POST /routing/preview` is required for UI explainability and for tests.

### 4.5 Replication
```
POST   /replication                     { sourceAccountId, targetAccountId, scope, overwrite }
GET    /replication?status=&cursor=
GET    /replication/:id
POST   /replication/:id/cancel
```
Only between two accounts of `SUPPORTED` providers whose capabilities include
`download` + `upload` + `list`.

### 4.6 Migration
```
POST   /migration                       { sourceAccountId, targetAccountId, mode: 'copy'|'move', scope }
GET    /migration?status=&cursor=
GET    /migration/:id
POST   /migration/:id/cancel
```

### 4.7 Webhooks / automation
```
GET    /webhooks
POST   /webhooks                        { url, events[] }
DELETE /webhooks/:id
POST   /webhooks/:id/test
GET    /webhooks/:id/deliveries?cursor=
```
Plus API-key scopes: `files:upload`, `files:read`, `files:delete`, `jobs:read`,
`providers:read`, `webhooks:manage` (see `security-contract.md` §4).

### 4.8 File manager additions
```
POST   /files/:id/copy                  { folderId? } -> new File (provider copy, falls back to server-side copy)
GET    /files?provider=&accountId=      extended filters
GET    /files?cursor=&limit=            cursor pagination
GET    /stats                           { fileCount, folderCount, bytes }
```
`GET /files` MUST accept the existing query params unchanged and additionally
`provider`, `accountId`, `sort` (`name|size|createdAt`, `order=asc|desc`).

---

## 5. Upload contract (unchanged client protocol)

`POST /uploads` multipart:
- fields **before** the file part: `sizeBytes`, `fileName`, `mimeType`,
  `folderId?`, `targetAccountId?`, or `filesMeta` (JSON array) for batches.
- busboy limits: 25 files/request, `MAX_UPLOAD_BYTES` per file.
- Response: single → `201 {file}`; batch → `201 {files, failed:[{fieldName,code}]}`.
- Byte-count verification against declared `sizeBytes` is preserved.

`POST /uploads/resumable/init` → `{ sessionId, chunkSize }`
`PUT  /uploads/resumable/chunk/:id` with `Content-Range: bytes a-b/total` →
`{ status: 'uploading'|'completed', offset }`
`GET  /uploads/resumable/status/:id` → `{ status, offset }`

**Change:** resumable uploads MUST be supported for every provider declaring
`uploadResumable`. Providers without it fall back to a server-side spooled stream
(`security-contract.md` §6) rather than returning `UNSUPPORTED_PROVIDER`.
Client retry keying changes from file name to an opaque `clientUploadId`
generated by the frontend (fixes filename collision).

---

## 6. Routing modes (API values)

`most_available`, `least_used`, `round_robin`, `priority`, `provider_preference`,
`file_size`, `file_type`, `health_aware`, `user_policy`.

`PATCH /storage/routing-policy` body (superset of current):
```json
{
  "mode": "most_available",
  "priorityAccountIds": ["..."],
  "fileTypeRules": [ { "match": "video/*", "preferProvider": "s3" } ],
  "minFileSizeBytes": null,
  "maxFileSizeBytes": null
}
```
Existing `{ mode, priorityAccountIds }` clients keep working.

---

## 7. Health & readiness

```
GET /health          -> { status: 'ok' }                       (liveness, no deps)
GET /health/ready    -> { status, db, redis, migrations }      (readiness, used by Docker)
```
`/health/ready` returns 503 until Prisma connects, Redis pings, and migrations are
applied. Docker healthchecks use `/health/ready`.

---

## 8. Compatibility rules for agents

1. Never change an existing response field name/type.
2. New fields may be added to existing responses.
3. New endpoints follow §4 layout and are added to this document by the implementing
   agent **only if the Coordinator pre-approved them here** (they are pre-approved for
   §4 as written).
4. Route logic lives in `backend/src/modules/<feature>/<feature>.routes.ts`.
5. Routers are mounted in `backend/src/app.ts` — **only the Coordinator edits `app.ts`**;
   agents export their router and report the mount line they need.
