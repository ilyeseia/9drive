# Provider integration audit — findings and plan (Step 1)

Repository state when the audit started: branch `main` at `5a8850a`, working tree clean except two pre-existing,
untracked files (`docker-compose-backup.yml`, `docker-compose-original.yml`) that are left untouched. No destructive
Git commands are used; no production operation is performed.

Evidence labels: **Confirmed (code)** = read in the source, with file reference; it is reproduced by a failing test in
Step 2 before being fixed. **Suspected** = needs more evidence. Nothing is labelled "fixed" until a test proves it.

## 1. Dependency map (what actually exists)

```
Frontend ProvidersPage ──► /providers (modules/providers/provider.routes.ts)  ─┐
                       └─► /connected-accounts (legacy aliases + legacy Google flow) ─┤
Files/Folders/Uploads UI ► /files, /folders, /uploads                           ─┤
                                                                               ▼
        account-service.ts  connect-flow.ts  terabox-device-flow.ts   ◄── two Google implementations (see F6)
                │                   │
                ▼                   ▼
        providers/context.ts  (buildContext: the ONLY decrypt + OAuth refresh)   modules/google/google.service.ts
                │  uses providers/oauth2.ts, registry.ts, catalog.ts             (legacy, own refresh, 22+ call sites)
                ▼
   providers/{google-drive,s3,dropbox,onedrive,pcloud,terabox,terabox-open}/index.ts  (StorageProvider contract)
                │
   providers/health.ts (checkAccount, refreshQuota) · providers/routing.ts (selectAccount) · worker jobs
                ▼
   Prisma: ConnectedAccount (unique userId+provider+providerAccountId) · StorageAccount · ProviderHealth ·
           ProviderConfig · OauthState · S3StorageConfig · UploadSession · File/Folder (connectedAccountId)
```

Existing strengths (kept): a provider contract with capability sets and a catalog; a single credential choke point;
AES-256-GCM credential encryption; a sound identity rule (`userId + provider + providerAccountId`); an SSRF gate;
`OauthState` rows with TTL; resumable-upload protocol; health + quota persistence; documented TeraBox classification
(`docs/terabox-integration-assessment.md`: official `terabox_open` is separate from the experimental cookie adapter).

## 2. Findings

| # | Sev | Finding | Evidence | Status |
|---|---|---|---|---|
| F1 | High | **Any** token-refresh failure marks the account `unauthorized` and throws `ERR_AUTH_EXPIRED` — including network timeouts, HTTP 429/5xx from the token endpoint. A provider outage therefore looks like "reauthorization required", and `selectAccount` only considers `status='connected'`, so affected accounts silently drop out of routing. | `providers/context.ts` (`resolveOAuthCredentials` catch → `markAuthFailure`), `providers/oauth2.ts` (`requestToken`: every non-OK ⇒ `ERR_AUTH_EXPIRED`), `providers/routing.ts` (`status: 'connected'`) | Confirmed (code) |
| F2 | High | No coordination of concurrent refreshes; token writes are last-writer-wins, so a rotated refresh token can be overwritten by an older one. A peer-refresh heuristic exists only after a *failure*. | `context.ts` (`findPeerRefresh`, unconditional `update`) | Confirmed (code) |
| F3 | High | OAuth `state` single-use is not atomic (`findUnique` then `update usedAt`): two concurrent callbacks both pass. The legacy Google callback marks the state used only at the very end. | `connect-flow.ts` (`handleConnectCallback`), `connected-account.routes.ts` (`/google/callback`) | Confirmed (code) |
| F4 | High | Orphan `pending` accounts: a row with tokens is created before the profile is read; a race on the unique identity, a crash, or any throw after `create` leaves `providerAccountId='pending:…'` rows holding tokens forever (no sweeper). | `connect-flow.ts` (`pending` create → update) | Confirmed (code) |
| F5 | High | Legacy Google *connect* callback awaits `syncGoogleQuota` without catch: a quota failure sends the user to an error page although the account was created/updated and the state consumed. (The login branch does catch.) | `connected-account.routes.ts` line ~210 | Confirmed (code) |
| F6 | High | **Two Google implementations.** 22+ call sites (files, folders, quota sync) use `modules/google/google.service.ts::getAuthedGoogleClient` — its own refresh without failure classification, status updates or locking — beside the provider-neutral adapter. Behaviour diverges between "upload through the adapter" and "rename/move/view through legacy". | `grep getAuthedGoogleClient` | Confirmed (code) |
| F7 | High | Multi-account Google: folder creation and `ensureProviderFolderIds` bind to `findFirst({provider:'google_drive',status:'connected'})` with **no ordering** — with several Google accounts the target account is arbitrary. | `folders/folder.routes.ts` lines ~36, ~125 | Confirmed (code) |
| F8 | High | `createS3Account` overwrites an existing account's credentials and sets `connected` **before** testing them; on failure an existing account keeps the bad credentials. Account row and config row are created non-atomically (orphan account without config on failure between them). | `account-service.ts` (`createS3Account`) | Confirmed (code) |
| F9 | Med | Cookie-TeraBox (`api_key`) identity is `apikey:<hash(cookie)>`: every fresh login yields a new identity ⇒ duplicate accounts for the same TeraBox user; reconnect works only by label match or "sole account". | `account-service.ts` (`createApiKeyAccount`) | Confirmed (code) |
| F10 | Med | Disconnect only flips `status`. Access/refresh tokens, S3 keys and the stored TeraBox password stay encrypted in the DB (only `terabox_open` tokens are cleared); no provider-side revocation where one exists; the legacy `DELETE /connected-accounts/:id` differs from `disconnectOwnedAccount`. | `account-service.ts`, `connected-account.routes.ts` | Confirmed (code) |
| F11 | Med | Supplying inline OAuth client credentials **updates the user's single active `ProviderConfig`**, which every existing account of that provider references — refresh for old accounts then uses the wrong client. | `connect-flow.ts` (`resolveProviderConfig`) | Confirmed (code) |
| F12 | Med | Routing: (a) in `most_available`, an account with **unknown** quota ranks *first* (unknown treated as unlimited); (b) round-robin cursor is read-modify-write, so concurrent uploads can pick the same account; (c) a non-`connected` status removes the account from selection regardless of cause. | `providers/routing.ts` (`byMostAvailable`, `finalizeSelection`) | Confirmed (code) |
| F13 | Med | No lifecycle model: `status` is a free string compared in ~25 places (`connected`, `unauthorized`, `disconnected`, `pending`, `error`); no `degraded`/`temporarily_unavailable`/`reauthorization_required`, no failure counters or last-success timestamps, no transition guard. | grep of `status:` | Confirmed (code) |
| F14 | Med | `decryptOptional` swallows decryption errors, so a wrong/rotated encryption key looks like "no refresh token" ⇒ `unauthorized`. | `context.ts` | Confirmed (code) |
| F15 | Low | `registry.register` silently replaces an existing adapter (duplicate/ambiguous registration not prevented). | `providers/registry.ts` | Confirmed (code) |
| F16 | Med | Account listing is unbounded (`listProviderAccountViews` returns every account); routing loads every connected account of the user for each upload. | `account-service.ts`, `routing.ts` | Confirmed (code); impact to be measured |
| F17 | — | Health/quota job fan-out volume, per-provider concurrency, stale-job recovery, retry/backoff and circuit-breaking for provider calls. | worker/jobs not yet read | Suspected |
| F18 | — | Upload failure/retry semantics (partial uploads, duplicate files, cleanup) and fallback to another account. | upload path not yet traced end to end | Suspected |
| F19 | — | Correlation ids / metrics / diagnostic report are absent or partial. | to verify | Suspected |
| F20 | — | Real Google/TeraBox/S3 provider calls cannot be exercised here (no credentials). | — | Blocked (credentials) |
| F21 | Med | `refreshTokenEncrypted` is reused as `apiSecret` for every `api_key` provider, so credentials carry an unrelated field; the existing test `decrypts stored API keys for api_key accounts` encodes the intended shape. | `providers/context.ts` api_key branch | Confirmed (code) |

## 3. Operator-relevant changes expected

- New nullable columns and indexes on `connected_accounts` (lifecycle/health bookkeeping) — additive migration.
- A one-off, reversible data fix for orphan `pending` rows and (if any) duplicate cookie-TeraBox accounts: **reported
  first, never auto-deleted**.
- No change to the encryption scheme; key handling is documented, not reinvented.

## 4. Implementation plan

1. **Step 2 — reproduce**: stand up the real stack locally (embedded Postgres + Redis, as for the mobile work), run the
   existing provider tests as a baseline, and write failing tests for F1–F12.
2. **Step 3 — identity, duplicates, lifecycle**: atomic state consumption (F3), no orphan pending rows (F4),
   S3 create-then-test in a transaction with no clobbering (F8), cookie-TeraBox identity (F9), explicit lifecycle
   state machine + migration (F13), registry duplicate guard (F15).
3. **Step 4 — OAuth/tokens/credentials**: refresh error classification (F1), per-account refresh lock + compare-and-set
   token writes (F2), decryption errors surfaced (F14), provider-config isolation (F11), credential cleanup on
   disconnect (F10).
4. **Step 5 — transfers, routing, isolation**: route legacy Google call sites through the context (F6, F7), routing
   fixes (F12), upload failure/retry audit (F18).
5. **Step 6 — API/frontend/observability/migration**: lifecycle-aware API fields and UI states, pagination, metrics and
   correlation ids, diagnostic report, migrations and rollback notes.
6. **Step 7 — tests at scale and final report**: concurrency and isolation suites, 10/100/1000-account measurements,
   final report with verified vs assumed.

Each step ends with a summary and a push; every push is gated on green type-check and tests.

## 5. Step 2 results — baseline and reproduction

Environment: embedded PGlite (PostgreSQL protocol, one connection) + local Redis, migrations applied with `prisma migrate deploy`; files run sequentially.

- **Baseline** (`src/__tests__/providers` + `src/__tests__/api/providers`): 647 passed, 65 skipped; `providers.routes.test.ts` cannot run here because the app import opens more than one DB connection and the local PGlite allows one (environment limit, not a code defect). The previously noted `api_key` credentials test is part of finding F21.
- **Reproduced** in `src/__tests__/providers/audit/audit-defects.test.ts` as `it.fails` (suite stays green; a fix flips the test, which must then become a plain `it`):
  - F1 token endpoint 503 → account still ends `unauthorized` / `ERR_AUTH_EXPIRED`.
  - F1 token endpoint 429 → same.
  - F2 four concurrent `buildContext` calls on one expired account → token endpoint is called more than once.
- F3, F4, F8, F9, F11, F12 reproductions are written together with their fixes in Steps 3–5 (they need the connect-flow harness); until then they stay *Confirmed (code)*.

## 6. Step 3 results — identity, duplicates, lifecycle

| Finding | Change | Evidence |
|---|---|---|
| F3 | OAuth state consumed with `updateMany({id, usedAt: null})`; only the winner proceeds (`connect-flow.ts`). | `identity-lifecycle.test.ts` F3: 3 concurrent callbacks → 1 success, 2 `OAUTH_STATE_INVALID`, 1 token exchange; test fails when the guard is removed (verified). **Confirmed-and-fixed** (legacy Google callback still open → Step 5/F6). |
| F4 | Finalisation wrapped; any failure discards the `pending:` row (only while still `pending:`); `sweepOrphanPendingAccounts` (per user, >15 min) runs when a connect URL is created. | tests: failed profile read leaves 0 pending rows; sweeper removes only stale rows. **Confirmed-and-fixed** for the provider-neutral flow. |
| F8 | S3 credentials are tested before any write; account+config written in one transaction with an upsert; a failed attempt never changes a working account. Quota-sync failure after a *new* account is created removes it. | test with injected connection tester. **Confirmed-and-fixed** (real S3 not exercised: Blocked-by-credentials). |
| F9 | Password-mode TeraBox login reconnects the existing row by (case-insensitive) login email before label/sole-account fallbacks. Cookie-only logins still get a per-cookie identity (no stable remote id is available without a verified API). | test: same email twice → one row. **Confirmed-and-fixed for password mode; cookie-only remains a known limitation.** |
| F13 | `providers/lifecycle.ts`: explicit states, legacy mapping, guarded transitions, `isRoutable`. Not yet wired into health/refresh/routing — that is Step 4/5, so F13 stays **Confirmed-not-fixed** until then. | unit tests for transitions. |
| F15 | `registry.registerAdapter` is idempotent for the same instance and throws for a different adapter under the same id; all seven production adapters use it. `register` keeps replace semantics for tests. | registry test. **Confirmed-and-fixed** for production adapters. |

Not changed here: no schema change was needed in this step (the lifecycle uses the existing free-string `status` column).

Verification (each provider-related test file run on a fresh DB, 42 files + routing/files API tests): all pass except three that are **not caused by this step**: `context.test.ts` (F21 `apiSecret` shape, pre-existing), `api/routing` (a PATCH policy UUID error on the local PGlite) and `api/files` (401 from the app-level auth in the local harness; the app-import tests are environment-limited here). They touch code this step did not change.
