# 9Drive — Agent Status Board

**Coordinator:** OpenCode (Lead Engineering Orchestrator)
**Project root:** `C:\Users\seia\Desktop\esp-claw\9drive`
**Target:** production-grade Multi-Cloud Storage Operating Layer

Contracts: [`contracts/`](contracts/README.md)

---

## Wave plan

| Wave | Scope | State |
|---|---|---|
| 0 | Repository discovery: backend audit, provider research, security audit, frontend/infra audit | **DONE** |
| 1 | Architecture contracts | **DONE** |
| 2 | Core platform: PostgreSQL, provider abstraction + registry, Redis/workers, security hardening, frontend shell | **DONE** (integration wiring complete: build ✅ 151 tests ✅) |
| 3 | Providers: Google Drive, S3 family, Dropbox, OneDrive, pCloud + catalog of documented-unsupported | **DONE** (5/5 adapters + platform + docs; 620 tests) |
| 4 | Advanced: routing engine, replication, migration, automation/webhooks, QA, performance, docs | **completed** (replication/migration workers + routes built; files §4.8 wired; build ✅ 620 tests) |
| 5 | Integration: merge, migrations, tests, conflict resolution | **completed** (all /providers, /dashboard, /jobs, /routing, /webhooks, /replication, /migration, /files/* mounted; build ✅ 620 tests) |
| 6 | Hardening (Docker E2E, lint, types) | pending |
| 6 | Production hardening: typecheck, lint, tests, security, Docker, E2E | pending |

---

## Wave 0 — agent reports (read-only, complete)

### AGENT: Repository Auditor (backend)
- **STATUS:** COMPLETE
- **TASK:** structural audit of `backend/`
- **COMPLETED:** module inventory (16 mounts), provider coupling map (30+ inline branches in `uploads`, `files`, `folders`, `connected-accounts`), DB access inventory, upload pipeline trace, auth model, crypto inventory, MySQL-specific usage (16 non-replayable migrations, `@db.Char(36)` ×46, case-sensitivity regressions), env inventory, top-10 refactor risks
- **FILES_CHANGED:** none
- **TESTS:** n/a (read-only)
- **DEPENDENCIES:** none
- **BLOCKERS:** none
- **RISKS:** no test net exists beyond `tsc`; migration history must be squashed
- **NEXT_STEP:** inputs consumed by database + provider agents

### AGENT: Cloud Provider Research
- **STATUS:** COMPLETE
- **TASK:** verify official API availability for 19 providers
- **COMPLETED:** per-provider auth/quota/ops/rate-limit/SDK/server-side verdict with citations; recommendation table (P0: S3 family; P1: Google/Dropbox/OneDrive/B2; P2: pCloud/Yandex/Koofr/Box/Internxt/e2/MEGA/Wasabi; P3: MediaFire/TeraBox/Proton; UNSUPPORTED: Icedrive, Sync.com, consumer IDrive)
- **FILES_CHANGED:** none
- **TESTS:** n/a
- **DEPENDENCIES:** none
- **BLOCKERS:** TeraBox has no public API (partner onboarding only); Proton SDK is preview
- **RISKS:** none
- **NEXT_STEP:** codified into `contracts/provider-contract.md` §2/§7 catalog

### AGENT: Security Auditor
- **STATUS:** COMPLETE
- **TASK:** vulnerability audit of backend, frontend, Docker
- **COMPLETED:** 4 CRITICAL (default JWT secrets in compose; `/system/update` RCE for any authenticated user; `/system/restore` arbitrary DB overwrite; every Google Drive upload granted `anyone/writer`), HIGH (SSRF via S3 endpoint, 5 GB RAM buffering, no rate limiting, unguarded `/system/backup`, frontend tokens in localStorage), full remediation backlog (15 items) with file:line
- **FILES_CHANGED:** none
- **TESTS:** n/a
- **DEPENDENCIES:** none
- **BLOCKERS:** none
- **RISKS:** must be fixed before any public deployment
- **NEXT_STEP:** codified into `contracts/security-contract.md`; executed by Security Agent

### AGENT: Frontend & Infrastructure Auditor
- **STATUS:** COMPLETE
- **TASK:** frontend route/API/perf audit + Docker/installer audit
- **COMPLETED:** route map (18 routes), API surface (0 missing endpoints), state patterns, upload flow, UI composition rules (nav registration point `DriveLayout.tsx:37-46`), gaps vs Dashboard/Provider Manager/File Manager, compose topology, Dockerfile/nginx/installer gaps, Tailscale deployment requirements
- **FILES_CHANGED:** none
- **TESTS:** n/a
- **DEPENDENCIES:** none
- **BLOCKERS:** `node_modules` absent → builds not executed
- **RISKS:** dead provider-conditional share UI (`AllFilesPage.tsx:788`), no pagination/virtualization, mock pages for recent/starred/archived
- **NEXT_STEP:** inputs consumed by frontend agent

---

## Wave 1 — contract reports

### AGENT: Coordinator (contracts)
- **STATUS:** COMPLETE
- **TASK:** author shared architecture contracts
- **COMPLETED:** `provider-contract.md`, `database-contract.md`, `api-contract.md`, `job-contract.md`, `event-contract.md`, `security-contract.md`, contracts `README.md` (change process + shared-file ownership)
- **FILES_CHANGED:** `docs/architecture/contracts/*.md` (7 files)
- **TESTS:** n/a
- **DEPENDENCIES:** Wave 0 reports
- **BLOCKERS:** none
- **RISKS:** contracts must be re-validated after Wave 2 integration
- **NEXT_STEP:** launch Wave 2 agents

---

## Wave 2+ — agent reports

*(appended by each agent — see contracts/README.md for the required block format)*

### AGENT: Queue & Worker
- **STATUS:** COMPLETE
- **TASK:** implement `backend/src/queues/**`, `backend/src/worker/**`, `backend/src/worker.ts`, tests in `backend/src/__tests__/queues/**` per `job-contract.md`, `event-contract.md`, `database-contract.md`
- **COMPLETED:** Redis connection factory with tracked shutdown (`queues/connection.ts`); structured JSON logger; job/queue type registry with zod payload schemas, 11 `JOB_DEFINITIONS` (priority, lock duration, backoff, concurrency env key, schedules), 7 `QUEUE_DEFINITIONS`; `enqueueJob` (row-first, then BullMQ, `jobIdStrategy: 'mirror-row-id'`, emits `job.queued`); state mirror via worker events with `prisma.$transaction` transitions and mandated `{jobId,type,userId,attempt,durationMs,status}` logs; soft EventBus bridge (`job.*` via dynamic import); cancellation = durable marker `9drive:job:{id}:cancel` + pub/sub `9drive:job:cancel` (`requestJobCancel` removes queued/delayed jobs, `worker.cancelJob` aborts active); distributed locks `9drive:lock:{name}` (SET NX PX + Lua release/renew + `withLock` renewal loop); cache helpers `9drive:cache:{name}:{hash}`; Redis metrics hash with periodic flush; worker runtime (`startWorkerRuntime`) with per-queue Workers (env concurrency, per-type `lockDuration`, `workerBackoffStrategy` incl. `webhook-delivery` ladder, `maxStalledCount: 1`), 3-arg processor with AbortSignal + payload validation + non-retryable `ProviderError → PermanentJobError`, throttled `reportProgress` (500 ms), full `CLEANUP` (expired tokens/stale sessions/old operations), full signed `WEBHOOK_DELIVERY` (HMAC-SHA256 `v1=`, `dlv_`/`evt_` ids, 10 s timeout, SSRF `safeFetch`, per-attempt delivery-row bookkeeping), `RETRY` kind-registry with `NOT_IMPLEMENTED` default, 8 NOT_IMPLEMENTED stubs; 5 BullMQ job schedulers from `JOB_DEFINITIONS.schedules`; health endpoint `GET /health/ready` on `WORKER_HEALTH_PORT` (default 4001); graceful shutdown (pause → close, 30 s timeout, flush mirror writes, close Redis, exit codes) with SIGTERM/SIGINT/unhandledRejection/uncaughtException handling in `backend/src/worker.ts`
- **FILES_CHANGED:** `backend/src/queues/{logger,connection,job-types,queues,events,mirror,cancel,locks,cache,metrics,index}.ts`; `backend/src/worker.ts`; `backend/src/worker/{types,errors,progress,processor,registry,schedules,runtime}.ts`; `backend/src/worker/processors/{upload,download,sync,metadata-indexing,quota-refresh,health-check,cleanup,replication,migration,webhook-delivery,retry}.ts`; `backend/src/__tests__/queues/{queue-definitions,worker-lifecycle}.test.ts`; this status file
- **TESTS:** `npm run build` exit 0; `npm test` → **15 files / 149 tests passed**, including 13 unit tests (`queue-definitions`) and 12 integration tests (`worker-lifecycle` against live Redis `127.0.0.1:16379` + PostgreSQL `127.0.0.1:15432`: enqueue→completed mirror, permanent vs retryable failure states, progress persistence, stub `NOT_IMPLEMENTED` fail-fast, cancel/remove, `CLEANUP` prune, locks, signed webhook delivery + HTTP-500 retry bookkeeping, health endpoint, graceful shutdown)
- **DEPENDENCIES:** contracts, `config/env.ts`, `config/prisma.ts`, `utils/serialize|crypto|ssrf`, `providers/errors.ts` (all read-only consumers)
- **BLOCKERS:** none
- **RISKS:** webhook ladder `30 s → 2 → 10 → 60 → 300` interpreted as 30 s/2 m/10 m/60 m/300 m (`WEBHOOK_BACKOFF_DELAYS_MS`); Redis runs `allkeys-lru` (BullMQ warns) — contract §7 wants `volatile-lru`/`noeviction`, infra-owned
- **REQUESTS_TO_COORDINATOR:** (1) `api-contract` cancel endpoint must call `requestJobCancel(jobId)` from `backend/src/queues/cancel.ts` (API side currently does not exist); (2) `METADATA_INDEXING` 6 h schedule (job-contract §5) omitted — system payload needs `accountId` fan-out over accounts with changes; (3) `CLEANUP` spool sweep (`UPLOAD_SPOOL_DIR` files) omitted — `uploads` agent owns spool write path; (4) job-contract §2.2 places handlers in `backend/src/jobs/handlers/<type>.ts` + `jobs/registry.ts`, but this agent's boundary was `backend/src/worker/**` — handlers live in `backend/src/worker/processors/*` + `backend/src/worker/registry.ts`; if §2.2 is authoritative, coordinator must re-home or amend the contract
- **NEXT_STEP:** Wave 2 integration — API agent wires enqueue/cancel, jobs agents replace NOT_IMPLEMENTED stubs with real handlers

### AGENT: Provider Core
- **STATUS:** COMPLETE
- **TASK:** implement the provider core layer (types, catalog, registry with DB-backed capabilities/health, deterministic fake provider, barrel) per `provider-contract.md`
- **COMPLETED:** `providers/types.ts` (capability vocabulary 18 flags + `ALL_CAPABILITIES`/`isCapability`, credentials/context/quota/meta/account types, named input types, `Page<T>` + offset-cursor encode/decode, `StorageProvider` interface per §4); `providers/catalog.ts` (static `PROVIDER_CATALOG` — all 22 contract §2 ids, statuses, notes for every non-`SUPPORTED` entry, `s3Preset` for the 6 VIA_S3 presets, per-entry capability arrays, frozen entries); `providers/registry.ts` (`ProviderRegistry` + singleton, `seedProviderCapabilities()` idempotent bulk-diff seed that never clobbers `notes`, `loadProviderCapabilityRows`/`loadSupportedCapabilities`, `recordProviderHealth()` upsert per-account + per-provider fallback with 500-char message truncation); `providers/fake.ts` (`FakeProvider` — deterministic ids/timestamps/cursors, streaming upload/download with byte ranges, quota accounting `ERR_QUOTA_EXCEEDED`, deep folder copy/move/delete-subtree, idempotent createFolder/revokeShare, capability gating `ERR_CAPABILITY_UNSUPPORTED`, injectable latency/failures, call log); `providers/index.ts` barrel; `errors.ts` left untouched (contract §5 taxonomy already complete)
- **FILES_CHANGED:** `backend/src/providers/{types,catalog,registry,fake,index}.ts`; `backend/src/__tests__/providers/{catalog,fake,registry}.test.ts`
- **TESTS:** `npm run build` exit 0; `npm test` green (46 provider tests incl. 4 live PostgreSQL `provider_capabilities`/`provider_health` tests)
- **DEPENDENCIES:** none
- **BLOCKERS:** none
- **RISKS:** per-provider capability flags for the 5 SUPPORTED providers are contract-guided estimates — Wave 3 adapter authors must confirm them; VIA_S3 preset endpoints/regions need per-deployment verification; fake materialises content in memory (test data only)
- **REQUESTS_TO_COORDINATOR:** call `seedProviderCapabilities()` at boot — **done** (see Wave 2 integration); read capabilities via catalog/registry, not raw Prisma
- **NEXT_STEP:** Wave 3 adapter agents implement `providers/<id>/` against `types.ts` + `registry.ts`

### AGENT: Security Hardening
- **STATUS:** COMPLETE (backend scope)
- **TASK:** close the CRITICAL/HIGH findings from the Wave 0 security audit per `security-contract.md`
- **COMPLETED:** §1 secrets — startup rejects `<32`/placeholder secrets; §2 — `middleware/security.middleware.ts` (`securityHeaders` helmet CSP/nosniff/frameguard/no-referrer/no-HSTS-unless-TLS, `noStoreHeaders`, `securityStack`) + `middleware/rate-limit.middleware.ts` (Redis `CounterStore`, all 9 §8 scopes, login lockout, `closeRateLimitStore`); §3 — `role.middleware.ts` `requireRole('admin')`, hardened `requireAuth` (session ownership + `status !== 'active'` → 403), system routes gated `requireAuth → adminSystemLimiter → requireRole('admin') → noStoreHeaders` with `confirm: 'UPDATE'/'RESTORE'`, `BACKUP_UNSUPPORTED`/`RESTORE_UNSUPPORTED`, removed VPS IP + raw command output; §3.4 SSO config scoped `userId: {in:[user,null]}`; §3.5 auto-accept removed + `POST /invites/:id/accept` (invitee-email scoped → 404); §4 `requireApiKey(scope)` + `apiKeyRateLimiter`; §5 auto `anyone/writer` grants removed (multipart + resumable), `public-permission` now `reader` + `{intent:'files:share'}`, `view-url` no longer mutates, share revoke ownership-scoped; §6 busboy spool-to-disk (50 GB cap, 413/400 paths, zip traversal neutralisation, SSRF guard on init `Location`), upload limiter; §7 `assertUrlAllowed`/`assertFetchAllowed` consumed everywhere incl. async `createS3Client`; §9 Zod→400 `VALIDATION_FAILED`, P2025→404, generic 500; §10.2/§10.3 hash-only share/preview/handoff lookups, 30-day share TTL, 5-min single-use handoff; §12 six mandated test files pass
- **FILES_CHANGED:** `backend/src/middleware/{rate-limit,security,auth,role,error}.middleware.ts`; `backend/src/utils/jwt.ts`; `backend/src/modules/{system,auth,invites,public,public-api,uploads,files,connected-accounts,api-keys}/*.routes.ts`; `backend/src/modules/s3/s3.service.ts`; `backend/src/__tests__/security/{system-admin,rate-limit,headers,auth,ssrf,upload,tenant-isolation,case-insensitivity}.test.ts`
- **TESTS:** `npm run build` exit 0; `npm test` **15 files / 151 tests passed**
- **DEPENDENCIES:** contracts, `config/env.ts`, `config/prisma.ts`, `utils/{ssrf,serialize,crypto}`, `providers/errors.ts`
- **BLOCKERS:** none remaining after Wave 2 integration
- **RISKS:** `uploadLimiter` intentionally not mounted on resumable chunk/status routes (5 MB chunks vs 30/min); §11 crypto (HKDF/AAD/`v1:` prefix, peppered `hashToken`) still open; §14 frontend items open
- **REQUESTS_TO_COORDINATOR:** (1) `app.ts` wiring — **done**; (2) SettingsPage confirm payloads — **done**; (3) AllFilesPage `intent` — **done**; (4) store rotated `refreshToken` — **done**; (5) `npm audit fix` — **done** (8 → 3 high); (6) `docker compose config` needs a populated `.env` — **open**
- **NEXT_STEP:** §11 crypto as a dedicated work item; §14 frontend token-storage review

### AGENT: Coordinator (Wave 2 integration)
- **STATUS:** COMPLETE
- **TASK:** apply every REQUESTS_TO_COORDINATOR raised by the Wave 2b agents and re-verify
- **COMPLETED:** `app.ts` — `trust proxy` now `env.TRUST_PROXY_HOPS`, mounted `securityStack` + `noStoreHeaders` before the routers; `server.ts` — boots with `seedProviderCapabilities()`, SIGTERM/SIGINT → `closeRateLimitStore()` + `prisma.$disconnect()`; `package.json` — added `test`, `test:watch`, `worker`, `worker:dev` scripts; `vitest.config.ts` — `testTimeout`/`hookTimeout` 60 s (Postgres/Redis sit behind an SSH tunnel at ~66 ms per round trip, so the 61-request limiter burst exceeded the 5 s default); `auth.routes.ts` — refresh tokens now rotate (`prevRefreshTokenHash` swap) and reuse revokes the session (`AUTH_SESSION_COMPROMISED`); frontend — `api.ts` persists the rotated `refreshToken`, `SettingsPage.tsx` sends `{confirm:'UPDATE'}` and `confirm=RESTORE`, `AllFilesPage.tsx` sends `{intent:'files:share'}` (provider gate already present at line 923); `npm audit fix` — 8 vulns (5 high) → 3 high, all `deepmerge-ts` inside `prisma`/`@prisma/config` whose only fix is a breaking downgrade, therefore **accepted**
- **FILES_CHANGED:** `backend/src/app.ts`, `backend/src/server.ts`, `backend/package.json`, `backend/vitest.config.ts`, `backend/src/modules/auth/auth.routes.ts`, `frontend/src/lib/api.ts`, `frontend/src/pages/SettingsPage.tsx`, `frontend/src/pages/AllFilesPage.tsx`, `backend/package-lock.json`
- **TESTS:** `npm run build` exit 0 (backend), `npm run build` exit 0 (frontend), `npm test` **15 files / 151 tests passed**, `npm audit --audit-level=high` → 3 high (accepted)
- **DEPENDENCIES:** Wave 2b agents
- **BLOCKERS:** none
- **RISKS:** dev latency — every Prisma/Redis round trip costs ~66 ms through the tunnel; the LAN IP `10.7.71.20` is not directly reachable from this machine, only the Tailscale address is
- **REQUESTS_TO_COORDINATOR:** n/a (coordinator)
- **NEXT_STEP:** Wave 3 — concrete provider adapters

### AGENT: Provider Platform
- **STATUS:** COMPLETE
- **TASK:** the three shared provider choke points — `context.ts`, `health.ts`, `routing.ts`
- **COMPLETED:** `providers/context.ts` (`buildContext` — credential decrypt, S3 preset merge, 120 s OAuth refresh window with persistence, redacting logger); `providers/health.ts` (`checkAccount`, `refreshQuota`, `mapErrorToHealthState`); `providers/routing.ts` (`selectAccount` — contract §9 evaluation order, round-robin cursor, Redis reservations); `providers/oauth2.ts` was written by the coordinator before this agent (shared `buildAuthorizationUrl`/`exchangeCode`/`refreshAccessToken` + `registerOAuth2Client`)
- **FILES_CHANGED:** `backend/src/providers/{context,health,routing}.ts`; `backend/src/__tests__/providers/platform/{context,health,routing,helpers}.ts`
- **TESTS:** 39 platform tests; suite green
- **DEPENDENCIES:** contracts, `config/prisma.ts`, `utils/{crypto,ssrf,serialize}`, `providers/{types,errors,registry,catalog,oauth2}`
- **BLOCKERS:** none
- **RISKS:** refresh failure marks the account `unauthorized`; `lastError` truncated to 500 chars
- **REQUESTS_TO_COORDINATOR:** none
- **NEXT_STEP:** consumed by Wave 5 route/health integration

### AGENT: Google Drive Adapter
- **STATUS:** COMPLETE
- **TASK:** `providers/google-drive/**` per provider-contract §4/§11 and security-contract §5
- **COMPLETED:** full `StorageProvider` (18 capabilities) with self-registering `oauth2.ts`, undici `DriveApiClient` (30 s JSON / 15 min transfer timeouts), `9drive` root folder per account with cache/invalidation, multipart <5 MiB / resumable ≥5 MiB (8 MiB chunks, 308/stall handling, session-URI SSRF allowlist), export MIME conversion on download, reader-only opt-in sharing with downgrade of existing `anyone` perms, Google→§5 error mapping, BigInt quota, health, single 401→refresh retry; 69 tests against a fake Drive server; `docs/architecture/providers/google_drive.md`
- **FILES_CHANGED:** `backend/src/providers/google-drive/{index,client,oauth2,errors,mime,transport}.ts`; `backend/src/__tests__/providers/google-drive/{helpers,google-drive.auth,google-drive.files,google-drive.transfer}.ts`; `docs/architecture/providers/google_drive.md`
- **TESTS:** 69 tests; suite green
- **DEPENDENCIES:** providers shared layer, `config/prisma.ts`
- **BLOCKERS:** none
- **RISKS:** shared drives out of scope (`corpora=user`); `search()` is account-wide (Drive has no subtree search) — both documented
- **REQUESTS_TO_COORDINATOR:** wire `registerGoogleDriveProvider` — **done**
- **NEXT_STEP:** Wave 5 connect-flow wiring

### AGENT: S3 Adapter (completion)
- **STATUS:** COMPLETE
- **TASK:** audit `providers/s3/**`, author its test suite, write `docs/architecture/providers/s3.md`
- **COMPLETED:** adapter fixes — `parseResumeToken` rejects malformed tokens, non-`ProviderError` failures never leak a resume token, `StreamCursor` failures wrapped as `ERR_UPSTREAM_UNAVAILABLE`, pull-based size guard with `AbortController` replaces the Transform deadlock, per-command `AbortSignal` merged with `ctx.signal`; 8 test files / 80 tests (upload incl. multipart + resume round trip, key layout, presets incl. 10 SSRF rejections, object ops + ranged download, quota namespace scoping, 13-case error table, health states, presign SigV4 verification); `docs/architecture/providers/s3.md`
- **FILES_CHANGED:** `backend/src/providers/s3/{index,client}.ts`; `backend/src/__tests__/providers/s3/{helpers,s3.upload,s3.keys,s3.presets,s3.objects,s3.quota,s3.errors,s3.health,s3.share}.ts`; `docs/architecture/providers/s3.md`
- **TESTS:** 80 S3 tests; suite green
- **DEPENDENCIES:** contracts §4/§5/§11, `providers/{types,catalog,registry,errors,health,context}`, `utils/{ssrf,serialize}`
- **BLOCKERS:** none
- **RISKS:** S3 delete is always permanent (no trash); `getQuota` lists the whole namespace; folder copy/rename/delete is non-atomic
- **REQUESTS_TO_COORDINATOR:** (1) declare `@smithy/signature-v4` — **done**; (2) `cloudflare_r2` placeholder endpoint — **done** (`resolveS3Target` now throws `ERR_INVALID_INPUT` instead of failing the SSRF gate); (3) catalog S3 capability parity — **verified by test**
- **NEXT_STEP:** Wave 5 upload/routing wiring

### AGENT: Dropbox / OneDrive / pCloud Adapters (completion)
- **STATUS:** COMPLETE
- **TASK:** finish Dropbox, implement OneDrive and pCloud, plus tests and docs
- **COMPLETED:** **Dropbox** — completed, 3 test files, `docs/architecture/providers/dropbox.md`; **OneDrive** — full adapter (`onedrive/index.ts`, `oauth2.ts`) with 4 MB simple-upload threshold + upload sessions, quota from `/me/drive?$select=quota`, `createLink` shares, 3 test files, `docs/architecture/providers/onedrive.md`; **pCloud** — full adapter (`pcloud/{oauth2,transport,errors,client,index}.ts`), tokens do not expire, quota from `userinfo`, `PUT uploadfile` streaming, SSRF-gated configurable host, fake pCloud + CDN server with Range support, 72 tests, `docs/architecture/providers/pcloud.md`
- **FILES_CHANGED:** `backend/src/providers/{dropbox,onedrive,pcloud}/**`; `backend/src/__tests__/providers/{dropbox,onedrive,pcloud}/**`; `docs/architecture/providers/{dropbox,onedrive,pcloud}.md`
- **TESTS:** 108 tests for these three providers; suite green
- **DEPENDENCIES:** providers shared layer, `utils/{ssrf,serialize}`
- **BLOCKERS:** none
- **RISKS:** pCloud EU `hostname` from the OAuth callback is not persisted by the shared callback handler yet
- **REQUESTS_TO_COORDINATOR:** (1) wire `registerOnedriveProvider`/`registerPcloudProvider` — **done**; (2) catalog pCloud capability/notes correction — **done** (`PCLOUD_CAPABILITIES`, no `uploadResumable`); (3) `platform/context.test.ts` assumed pCloud had no OAuth client — **done** (moved to `box`); (4) persist the pCloud callback `hostname` → `account.config.apiBaseUrl` — **open, Wave 5**
- **NEXT_STEP:** Wave 5 connect-flow wiring

### AGENT: Coordinator (Wave 3 integration)
- **STATUS:** COMPLETE
- **TASK:** wire all five adapters, apply every agent request, re-verify
- **COMPLETED:** `providers/index.ts` now exports and side-effect-registers `s3`, `dropbox`, `onedrive`, `pcloud`, `google_drive` and re-exports `oauth2`/`context`/`health`/`routing`; `@smithy/signature-v4` declared in `package.json` (+ lockfile sync); `resolveS3Target` rejects placeholder endpoints (Cloudflare R2 template) with `ERR_INVALID_INPUT` rather than leaking into the SSRF gate; catalog pCloud corrected to 17 capabilities and accurate notes; `context.test.ts` no-OAuth-client case moved from `pcloud` to `box`
- **FILES_CHANGED:** `backend/src/providers/index.ts`, `backend/src/providers/catalog.ts`, `backend/src/providers/s3/presets.ts`, `backend/src/__tests__/providers/platform/context.test.ts`, `backend/package.json`, `backend/package-lock.json`
- **TESTS:** `npm run build` exit 0; `npm test` → **38 files / 620 tests passed**
- **DEPENDENCIES:** all four Wave 3 agents
- **BLOCKERS:** none
- **RISKS:** catalog vs registered-provider capability parity is only asserted for S3 and pCloud
- **REQUESTS_TO_COORDINATOR:** n/a (coordinator)
- **NEXT_STEP:** Wave 4/5 — route wiring (`/providers/catalog`, provider-neutral connect flow, `selectAccount` in uploads), replication, migration
