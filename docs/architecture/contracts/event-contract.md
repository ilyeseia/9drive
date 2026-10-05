# Event Contract

**Status:** NORMATIVE — domain events and outbound automation events.
**Owner:** Coordinator.

---

## 1. Two event planes

| Plane | Audience | Mechanism | Durability |
|---|---|---|---|
| **Internal domain events** | in-process modules (audit, cache invalidation, UI refresh hints) | `EventBus` (typed EventEmitter) | in-memory, fire-and-forget, never throws into the caller |
| **Outbound webhook events** | n8n, OpenClaw, ESP-Claw, Home Assistant, scripts | `WebhookSubscription` + `WEBHOOK_DELIVERY` job | durable, retried, replayable |

Internal events MUST NOT be used as a transport across processes — the API and worker
communicate through Redis/PostgreSQL only.

---

## 2. Internal EventBus

`backend/src/events/bus.ts`

```ts
type Handler<E extends EventName> = (payload: EventPayloadMap[E]) => void | Promise<void>;

class EventBus {
  on<E extends EventName>(e: E, h: Handler<E>): () => void;
  emit<E extends EventName>(e: E, p: EventPayloadMap[E]): void;  // never throws
}
export const events: EventBus;
```

Rules:
- Handlers are wrapped in try/catch; failures are logged, never propagated.
- Handlers registered by: audit logging, cache invalidation, webhook fan-out.
- Async handlers are queued via microtask; `emit` returns synchronously.
- Emitting an event MUST NOT be load-bearing for correctness of a write (write first,
  then emit).

---

## 3. Event catalog (normative)

Every event has a stable name, a payload schema, and at least one emitter.

| Event | Payload | Emitted when |
|---|---|---|
| `auth.registered` | `{ userId }` | user created |
| `auth.login` | `{ userId, sessionId, method }` | successful login |
| `auth.logout` | `{ userId, sessionId }` | logout |
| `auth.refresh_reuse_detected` | `{ userId, sessionId }` | refresh-token reuse (security) |
| `provider.connected` | `{ userId, accountId, provider }` | account connected |
| `provider.disconnected` | `{ userId, accountId, provider }` | account deleted |
| `provider.health_changed` | `{ accountId, provider, from, to }` | health state transitions |
| `provider.quota_exceeded` | `{ accountId, provider, usedBytes, totalBytes }` | quota ≥ 95% |
| `provider.token_refresh_failed` | `{ accountId, provider }` | refresh rejected |
| `file.uploaded` | `{ userId, fileId, accountId, provider, sizeBytes, folderId }` | upload completed |
| `file.deleted` | `{ userId, fileId, permanent }` | file trashed/purged |
| `file.renamed` | `{ userId, fileId, from, to }` | rename |
| `file.moved` | `{ userId, fileIds, folderId }` | move |
| `file.copied` | `{ userId, sourceFileId, newFileId }` | copy |
| `file.share_created` | `{ userId, fileId, shareId, expiresAt }` | share link created |
| `file.share_revoked` | `{ userId, fileId, shareId }` | share disabled |
| `folder.created` / `folder.deleted` | `{ userId, folderId }` | folder ops |
| `job.queued` / `job.started` / `job.completed` / `job.failed` / `job.cancelled` | `{ jobId, type, userId, attempts, error? }` | job state transitions |
| `replication.started` / `.progress` / `.completed` / `.failed` | `{ replicationJobId, userId, ... }` | replication lifecycle |
| `migration.started` / `.progress` / `.completed` / `.failed` | `{ migrationJobId, userId, ... }` | migration lifecycle |
| `security.rate_limited` | `{ scope, subject, ip }` | rate limiter trips |
| `security.suspicious_request` | `{ route, reason, ip, userId? }` | SSRF block, path traversal, invalid token |
| `system.backup_created` | `{ userId, sizeBytes }` | admin backup |

Payloads are plain JSON, **no secrets**, byte counts as decimal strings.

---

## 4. Outbound webhooks

### 4.1 Subscription
`POST /webhooks { url, events: string[] | ["*"] }`
- `url` must be `https:` (or `http:` only when `WEBHOOK_ALLOW_HTTP=true`).
- URL passes the same SSRF gate as provider endpoints (`security-contract.md` §7).
- `secret` is generated server-side, returned **once**, stored AES-GCM encrypted.
- Delivery signs every request (§4.3).

### 4.2 Envelope
```json
{
  "id": "evt_01J...",              // ULID, unique per delivery attempt group
  "type": "file.uploaded",
  "createdAt": "2026-10-01T12:00:00.000Z",
  "apiVersion": "1",
  "data": { ...event payload... }
}
```
`Content-Type: application/json`, `User-Agent: 9Drive-Webhooks/1`.

### 4.3 Signature
Headers:
```
X-9Drive-Event: file.uploaded
X-9Drive-Delivery: dlv_01J...
X-9Drive-Timestamp: 1759330000
X-9Drive-Signature: v1=<hex hmac-sha256(secret, `${timestamp}.${rawBody}`)>
```
Receivers MUST reject timestamps older than 300 s. Signature computed over
`timestamp + '.' + rawBody`.

### 4.4 Delivery semantics
- At-least-once. Receivers must be idempotent on `id`.
- Success = any 2xx within 10 s timeout.
- Retries: 5 attempts, exponential 30 s → 2 → 10 → 60 → 300 s, then `failed`.
- Failed deliveries are visible via `GET /webhooks/:id/deliveries`.
- `POST /webhooks/:id/test` sends a `system.test` event.

### 4.5 Ordering
No ordering guarantee across events. Within one aggregate (e.g. one file) ordering is
best-effort by enqueue time.

---

## 5. Frontend refresh contract

The SPA does not consume webhooks. It refreshes using the existing custom events, kept
and extended:

| Window event | Dispatched when | Listeners |
|---|---|---|
| `9drive:storage-changed` | quota/account/folder mutations (existing) | `DriveLayout` sidebar |
| `9drive:upload-completed` | upload finished (existing) | `AllFilesPage` |
| `9drive:invites-changed` | invite mutations (existing) | `SharedPage` |
| `9drive:open-move-modal` | context menu (existing) | `AllFilesPage` |
| **`9drive:jobs-changed`** | job queued/finished (new) | `DashboardPage`, `JobsPage` |
| **`9drive:providers-changed`** | account connected/health changed (new) | `ProvidersPage`, `DashboardPage` |

New frontend code MUST reuse these names; do not invent parallel channels.

---

## 6. Automation API surface (summary)

External systems integrate through:
1. **API keys** with scopes (`api-contract.md` §4.7) for REST calls.
2. **Webhooks** (this document) for push notifications.
3. **Job status APIs** (`GET /jobs/:id`) for polling.
4. `GET /health`, `GET /health/ready` for supervision.

No other integration channel (no message bus exposed, no GraphQL, no gRPC in v1).
