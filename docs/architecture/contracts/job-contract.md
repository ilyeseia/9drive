# Job / Worker Contract

**Status:** NORMATIVE — background execution model.
**Owner:** Coordinator.

---

## 1. Infrastructure

- **Redis 7** via `REDIS_URL`. Used for: BullMQ queues, cache, distributed locks,
  rate-limit counters, resumable-upload spool pointers, short-lived state.
- **BullMQ** + `ioredis` are the queue libraries. No hand-rolled queue.
- Redis is **never** the system of record for anything durable — `Job`, `File`,
  `ReplicationJob`, `MigrationJob` rows in PostgreSQL are authoritative; Redis holds
  execution state.
- Two processes share one codebase:
  - `backend/src/server.ts` — HTTP API (enqueues jobs)
  - `backend/src/worker.ts` — worker entrypoint (consumes jobs)

Connection: a dedicated `ioredis` instance for BullMQ (`maxRetriesPerRequest: null`),
plus a separate normal instance for cache/locks.

---

## 2. Queue & job types

One BullMQ queue per family, prefix `9drive:`.

| Queue | Job types | Purpose |
|---|---|---|
| `transfer` | `UPLOAD`, `DOWNLOAD` | large/streamed transfers executed off the request path |
| `sync` | `SYNC`, `METADATA_INDEXING` | provider ↔ DB reconciliation (Drive folder sync, listing reindex) |
| `maintenance` | `QUOTA_REFRESH`, `HEALTH_CHECK`, `CLEANUP` | periodic account/DB maintenance |
| `replication` | `REPLICATION` | copy files account→account |
| `migration` | `MIGRATION` | copy/move files account→account |
| `webhook` | `WEBHOOK_DELIVERY` | outbound event delivery |
| `retry` | `RETRY` | generic deferred retry carrier |

Every job type name is exactly the string above (uppercase, no namespace).

### 2.1 Payload schema (normative)

```ts
interface JobPayloadBase {
  jobId: string;          // Job.id in PostgreSQL (UUID)
  userId: string;         // owner; required for every job
  requestId?: string;     // correlation id
}

UPLOAD           : { accountId?: string|null; folderId?: string|null; spoolKey: string; fileName: string; mimeType: string; sizeBytes: string }
DOWNLOAD         : { fileId: string; target?: 'preview'|'download' }
SYNC             : { accountId: string; scope?: 'folder'|'full' }
METADATA_INDEXING: { accountId: string; cursor?: string|null }
QUOTA_REFRESH    : { accountId?: string }            // omitted = all active accounts
HEALTH_CHECK     : { accountId?: string }
CLEANUP          : { scope: 'expired_tokens'|'stale_sessions'|'old_operations'|'all' }
REPLICATION      : { replicationJobId: string }
MIGRATION        : { migrationJobId: string }
WEBHOOK_DELIVERY : { deliveryId: string }
RETRY            : { kind: string; refId: string }
```

`sizeBytes` and byte totals travel as **decimal strings** (JSON-safe).

### 2.2 Handler signature

```ts
type JobHandler<P> = (ctx: {
  payload: P;
  job: BullMQJob;
  logger: Logger;
  reportProgress: (pct: number, meta?: Record<string, unknown>) => void;
  signal: AbortSignal;          // aborted on cancel/shutdown
}) => Promise<unknown>;         // return value stored in Job.result
```

Handlers live in `backend/src/jobs/handlers/<type>.ts` and are registered in
`backend/src/jobs/registry.ts`. A handler MUST NOT be registered without a matching
`Job` type in §2.1.

---

## 3. Worker lifecycle (`backend/src/worker.ts`)

1. Validate env (`env.ts`), connect Redis, connect Prisma.
2. Register handlers, start workers with configured concurrency.
3. Graceful shutdown on `SIGTERM`/`SIGINT`: stop accepting, wait for in-flight jobs
   (timeout 30 s), close Redis, `$disconnect()` Prisma, `process.exit(0)`.
4. `unhandledRejection` / `uncaughtException` → log + controlled shutdown (never silent).
5. Emits readiness only after queues are connected.

Env:
```
WORKER_CONCURRENCY_TRANSFER=2
WORKER_CONCURRENCY_SYNC=2
WORKER_CONCURRENCY_MAINTENANCE=1
WORKER_CONCURRENCY_REPLICATION=1
WORKER_CONCURRENCY_MIGRATION=1
WORKER_CONCURRENCY_WEBHOOK=2
WORKER_CONCURRENCY_RETRY=1
WORKER_ENABLED=true
```
When `WORKER_ENABLED=false`, the API process runs **without** starting workers
(scaling backend and worker separately).

---

## 4. Execution semantics

| Concern | Rule |
|---|---|
| Attempts | `maxAttempts` default **5**, per-job override allowed |
| Backoff | exponential, `delay: 30_000 * 2^attempt`, `jitter: 0.2` |
| Retry decision | only `ProviderError.retryable === true` (or transient network) is retried; `ERR_INVALID_INPUT`, `ERR_AUTH_REVOKED`, `ERR_CAPABILITY_UNSUPPORTED` fail immediately |
| Progress | `reportProgress` writes `Job.progress` (0-100) at most every 500 ms |
| State mirror | BullMQ state changes are mirrored into the `Job` row (`status`, `attempts`, `startedAt`, `finishedAt`, `error`) via worker events |
| Cancellation | `POST /jobs/:id/cancel` removes the BullMQ job if queued, or aborts the `AbortSignal` if active; job row → `cancelled` |
| Idempotency | handlers must tolerate duplicate execution; use `Job.status` guards + `StorageOperation` records |
| Timeouts | per-type `lockDuration` 60 s (transfer/replication 300 s) with heartbeat renewal |
| Concurrency safety | distributed lock `lock:{scope}:{id}` via `SET NX PX` for quota refresh and account-scoped operations |
| Ordering | none guaranteed across jobs; within a single `MIGRATION`/`REPLICATION` run, files are processed with bounded parallelism (default 4) and progress is aggregated |

### 4.1 Spooled uploads
To stop buffering whole files in RAM (`security-contract.md` §6), uploads that cannot be
streamed end-to-end are spooled to a **disk temp directory** `UPLOAD_SPOOL_DIR`
(default `os.tmpdir()/9drive-spool`), the file is streamed to the provider by the
`UPLOAD` job (or inline when small), then the spool file is deleted. Spool files are
permissioned `0600`, capped by `UPLOAD_SPOOL_MAX_BYTES`, and swept by `CLEANUP`.

Threshold: inline (request path) when `sizeBytes <= INLINE_UPLOAD_MAX_BYTES`
(default 8 MiB); otherwise spooled + job.

---

## 5. Periodic schedules (registered by the worker)

| Job | Interval | Scope |
|---|---|---|
| `QUOTA_REFRESH` | 15 min | all active accounts, staggered |
| `HEALTH_CHECK` | 5 min | all active accounts, staggered |
| `CLEANUP` (expired tokens) | 1 h | global |
| `CLEANUP` (stale sessions) | 6 h | global |
| `CLEANUP` (old operations) | 24 h | prune `StorageOperation` older than 30 d |
| `METADATA_INDEXING` | 6 h | accounts with changes |

Scheduling uses BullMQ `repeat` jobs with stable `jobId` keys so restarts do not
duplicate them.

---

## 6. Job REST API

See `api-contract.md` §4.3. The API process:
- creates the `Job` row (`status: 'queued'`) and enqueues in one logical step
  (row first, then enqueue; a crash leaves an orphan row that `CLEANUP` sweeps)
- reads job state from **PostgreSQL** for list/detail (fast, paginated, index-backed)
- exposes retry/cancel

---

## 7. Locks, cache, rate limiting (Redis)

| Key pattern | Purpose | TTL |
|---|---|---|
| `9drive:rl:{scope}:{subject}` | rate-limit counters (fixed window + ceiling) | window size |
| `9drive:lock:{name}` | distributed mutex (`SET NX PX`) | 30 s, renewed |
| `9drive:cache:{name}:{hash}` | hot read cache (catalog, dashboard summary) | 30-300 s |
| `9drive:acct:{id}:reserved` | in-flight byte reservations during routing | 15 min |
| `9drive:sess:{sid}:revoked` | fast revocation check (DB remains source of truth) | session TTL |

Eviction: `allkeys-lru` is **not** acceptable because queue data must not be evicted —
use `volatile-lru` with all queue keys given a TTL-free existence and app keys TTL'd.

---

## 8. Observability

- Every job logs `{ jobId, type, userId, attempt, durationMs, status }`.
- `StorageOperation` rows are written for provider-touching work.
- Worker exposes `GET /health/ready` on an internal port (`WORKER_HEALTH_PORT`, default
  4001) for Docker healthcheck; not published to the host.
- Metrics counters kept in Redis with periodic flush to logs (no external metrics stack
  required for v1).

---

## 9. Testing requirements for job code

Every handler MUST have:
1. a unit test with a mocked `ProviderContext` asserting success path,
2. a unit test asserting a non-retryable `ProviderError` fails immediately,
3. an integration test (Redis + PostgreSQL via docker compose) proving enqueue →
   process → `Job.status === 'completed'`.

`npm run test` must run without a live provider account (providers mocked).
