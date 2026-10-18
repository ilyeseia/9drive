# Provider integration audit — final report

Branch work pushed in six commits (`a74f661`, `fe63205`, `4a09392`, `d046279`, `8ece86e`, and this report). Detailed evidence
per finding: [00-findings-and-plan.md](00-findings-and-plan.md). Operator notes: [01-operations.md](01-operations.md).

## A. Summary

The provider layer already had a sound base (contract, capability catalog, single credential choke point, AES-GCM,
sound account identity). The audit found and fixed the failures that appear **only with several accounts, concurrency
or provider outages**: outages mislabelled as "re-authorize", unsynchronised token refresh, replayable OAuth state,
orphan token-holding rows, credential-clobbering S3 reconnects, an arbitrary choice between several Google accounts, a
second Google refresh implementation, unknown quota treated as "most free space", racy round-robin, and no lifecycle,
correlation id or diagnostic report. Real Google, TeraBox and S3 endpoints were **not** exercised (no credentials).

## B. System map

See §1 of the findings document: Providers page and legacy `/connected-accounts` routes → `account-service`,
`connect-flow`, `terabox-device-flow` → `providers/context.ts` (the only decrypt/refresh point) → seven adapters
(`google_drive`, `s3`, `dropbox`, `onedrive`, `pcloud`, `terabox` experimental/cookie, `terabox_open` official) →
`health`, `routing`. TeraBox stays split: the official device-code adapter is the supported path; the cookie adapter is
experimental and unofficial. No TeraBox API was invented.

## C. Findings and classification

| # | Finding | Classification |
|---|---|---|
| F1 | Outage/throttle shown as `unauthorized` | **Confirmed and fixed** |
| F2 | Unsynchronised refresh, last-writer-wins | **Confirmed and fixed** in-process + compare-and-set; cross-process double call remains (**Confirmed, not fixed**, bounded) |
| F3 | Non-atomic OAuth state | **Confirmed and fixed** (provider-neutral and legacy Google callback); legacy path not route-tested here |
| F4 | Orphan `pending:` accounts | **Confirmed and fixed** (+ sweeper) |
| F5 | Quota error after connect shown as failure | **Confirmed and fixed** (not route-tested here) |
| F6 | Two Google refresh implementations | **Confirmed and fixed** (legacy client now uses `buildContext`) |
| F7 | Arbitrary Google account for folders | **Confirmed and fixed** |
| F8 | S3 reconnect clobbers/pre-saves credentials | **Confirmed and fixed** (injected tester; real S3 not run) |
| F9 | Cookie-TeraBox duplicate identities | **Fixed for password logins**; cookie-only stays per-cookie (**Confirmed, not fixed**: no verified stable remote id) |
| F10 | Disconnect keeps credentials | **Partially fixed**: local credentials wiped; provider-side revocation **not implemented** |
| F11 | Inline OAuth client overwrote shared config | **Confirmed and fixed** |
| F12 | Unknown quota first; racy round-robin | **Confirmed and fixed** |
| F13 | No lifecycle model | **Fixed** (state machine, API fields, UI); stored `status` strings intentionally unchanged, no failure counters/columns |
| F14 | Decryption failures swallowed | **Confirmed and fixed** |
| F15 | Silent adapter replacement | **Fixed** for production adapters (`registerAdapter`); `register` keeps replace semantics for tests |
| F16 | Unbounded listing | **Partially fixed**: listing bounded; routing still loads every connected account per selection (measured fine to 1000) |
| F17 | Worker/job fan-out, circuit breaking, Retry-After-driven backoff | **Suspected — not investigated**; no circuit breaker was added |
| F18 | Upload failure semantics | **Partially fixed** (failed session recorded); orphaned remote object after DB failure and no cross-account fallback are **Confirmed, not fixed** |
| F19 | Correlation ids / metrics | **Request ids and privacy-safe logs fixed**; no metrics backend (**Confirmed, not fixed**) |
| F20 | Real provider credentials | **Blocked by credentials** |
| F21 | `apiSecret` test mismatch | **Reclassified**: test fixture defect (feature is intentional), fixed |

## D. Root causes (confirmed)

Free-string status compared in ~25 places with no transition rules; credential refresh and OAuth state handled with
read-then-write instead of atomic operations; a second, older Google code path; selection and identity decisions that
assumed one account per provider; errors collapsed into one "auth expired" class.

## E. What changed

Code: `providers/{lifecycle,registry,oauth2,context,routing}.ts`, `modules/providers/{connect-flow,account-service,provider.routes,diagnostics}.ts`,
`modules/google/google.service.ts`, `modules/folders/folder.routes.ts`, `modules/connected-accounts/connected-account.routes.ts`,
`modules/uploads/upload.routes.ts`, request-id middleware/context, logger, Providers page. **No schema change, no migration.**

## F. Tests added

`__tests__/providers/audit/`: `audit-defects` (F1, F2, F14), `identity-lifecycle` (state machine, F3, F4, F8, F9, F10,
F11), `routing-legacy` (F6, F7, F12), `observability` (request ids, view fields, pagination, diagnostics privacy),
`scale-isolation` (10/100/1000 accounts, cross-tenant isolation, 50 concurrent selections). Plus registry,
`context` (apiSecret) and updated mocks. Every fix listed above was first reproduced by a failing test or, for F3, shown
to fail when the fix is removed.

## G. Scale measurements (PGlite, single connection — indicative only)

| Accounts | `selectAccount` | list (page of ≤500) | diagnostics |
|---|---|---|---|
| 10 | 92 ms | 22 ms | 27 ms |
| 100 | 39 ms | 23 ms | 28 ms |
| 1000 | 158 ms | 56 ms | 101 ms |

50 parallel round-robin selections over 100 accounts: 1454 ms total, exactly 50 distinct accounts, cursor advanced by
exactly 50. These numbers come from an embedded database on a development machine; they show that the algorithms do
not degrade badly up to 1000 accounts, **not** that the system is "unlimited" or what production latency will be.
Larger counts, a networked database and real provider latency were not measured.

## H. Security

Verified by tests: tenant isolation of routing, listing and diagnostics (including a hostile `targetAccountId`),
diagnostics and logs contain no tokens/emails, request ids cannot inject log text, undecryptable credentials surface as
internal errors, disconnect wipes credentials. Not done: external penetration test, key-rotation tooling (documented as
absent), provider-side token revocation, PKCE review beyond the existing flow (the existing `state` handling was made
atomic; PKCE was not added).

## I. Migrations and rollback

None required. Rollback is a code revert; stored status values remain readable by the previous version. See
[01-operations.md](01-operations.md) for the read-only SQL to find orphan `pending` rows and possible duplicate TeraBox
accounts (review manually; nothing is auto-deleted).

## J. Verified vs assumed vs blocked

- **Verified here:** everything above marked fixed, against a real PostgreSQL-protocol database (PGlite) and local fake
  token servers; backend and frontend type-checks; 44+ related backend test files (each on a fresh DB) and the frontend
  suite.
- **Not runnable in this environment:** API suites needing the full app/Redis ≥ 5 (`api/files`, `api/routing`,
  `api/migration`, `api/replication`) and the stale `box` expectation in `providers.routes.test.ts` (pre-existing).
  The legacy Google callback and the upload-session cleanup are type-checked but not route-tested.
- **Blocked by credentials:** real Google OAuth, real TeraBox (official and cookie), real S3 behaviour, provider-side
  rate-limit headers and revocation.

## K. Remaining work, in priority order

1. Run the API-level suites against real PostgreSQL + Redis ≥ 5 (CI) and settle the `box` 409/400 expectation.
2. Exercise real Google/S3/TeraBox accounts end to end (including a token revoked at the provider).
3. Investigate F17: worker fan-out limits, per-provider concurrency, circuit breaker and Retry-After-aware backoff.
4. Compensating delete for a remote object whose database write failed; decide on cross-account upload fallback.
5. Key-rotation (re-encryption) tool before anyone rotates `TOKEN_ENCRYPTION_KEY`.
6. Provider-side revocation on disconnect where an endpoint exists; lifecycle counters/last-success timestamps if the
   product needs them (additive migration).
7. Metrics (counters per provider/outcome) on top of the structured logs.
