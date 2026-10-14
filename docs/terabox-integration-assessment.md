# TeraBox integration assessment

Status: Phase A/B output (inspection + verified API contract), written before any
implementation and updated at the end with the implementation outcome (§7–§9).

## 1. What the actual checkout looks like

The checkout differs materially from the public README/AGENTS.md ("Google Drive
gateway, MySQL"):

| Topic | Reality in this checkout |
|---|---|
| DB | **PostgreSQL** via Prisma 6 (`backend/prisma/migrations/20261001093039_baseline_postgres`). The MySQL migrations are archived in `prisma/mysql-migrations-archive/`. |
| Queue | BullMQ + Redis; worker process (`src/worker.ts`, `src/worker/processors/*`). |
| Providers | A registry-based abstraction already exists: Google Drive, S3 (+ presets), Dropbox, OneDrive, pCloud, plus an uncommitted TeraBox adapter. |
| Tests | Vitest, `backend/src/__tests__/**` (provider fake servers, API, security, queues). |

### Provider abstraction (already present, reused)

- Contract: `backend/src/providers/types.ts` (`StorageProvider`, `Capability`
  vocabulary, `ProviderContext`, `ProviderCredentials`), errors in
  `providers/errors.ts` (`ProviderError` taxonomy), catalog in
  `providers/catalog.ts`, registry in `providers/registry.ts`.
- Credential choke point: `providers/context.ts` `buildContext()` – the only place
  that decrypts tokens and performs OAuth refresh (generic, via `providers/oauth2.ts`).
- Routing: `providers/routing.ts` `selectAccount()` over `UploadRoutingPolicy`
  (modes `most_available`, `least_used`, `round_robin`, `priority`, …), Redis
  reservation keys (`9drive:acct:<id>:reserved`), health filtering.
- Connect flow: `modules/providers/connect-flow.ts` (redirect OAuth with
  `OauthState` CSRF row), `provider.routes.ts`, `account-service.ts`.
- SSRF gate: `utils/ssrf.ts` (`assertFetchAllowed`).
- Encryption: `utils/crypto.ts` (AES-256-GCM, key = sha256(`TOKEN_ENCRYPTION_KEY`)).

### Database
`ConnectedAccount` already models provider, owner (`userId`, cascade delete),
`providerAccountId` (unique per user+provider), encrypted access/refresh tokens,
`tokenExpiresAt`, `status`, `lastError`, `metadata Json`. `StorageAccount` holds
quota + `lastSyncedAt`. `ProviderHealth` holds health. `ProviderConfig` holds
encrypted OAuth client id/secret (global or per-user). **No schema change is
required** for the official TeraBox adapter, so no migration risk is added.

### Uncommitted work found (not authored in this task)
`providers/terabox/**` (~2.6k lines + tests + docs + UI modal): a **cookie-session,
reverse-engineered** adapter, registered as `SUPPORTED` with `authMode: 'api_key'`.
The committed catalog had deliberately kept TeraBox `RESEARCH_REQUIRED` ("9Drive does
not perform undocumented endpoints"). The task forbids a cookie integration as the
default. **Decision (user-confirmed):** leave that WIP untouched and add a separate
official provider `terabox_open`. The cookie adapter is relabelled experimental.

### Baseline (before any change of mine)
- `npx tsc --noEmit`: clean.
- `npx vitest run`: 604 passed, 210 skipped; **15 files fail** – all with
  `Can't reach database server at 127.0.0.1:15432` (no Postgres/Docker engine on this
  machine). These are environmental, pre-existing, and block DB-backed tests and
  live migration checks locally.

## 2. Verified TeraBox Open Platform contract

Source: official page `https://www.terabox.com/integrations/docs?lang=en`
("TeraBox Open Platform Integration Document"), read 2026-10-14 via a rendered
browser (the page is a JS app; plain fetch returns only the title).

### Credentials / approval
- Vendor must **apply** for `client_id` (AppKey), `client_secret` (SecretKey) and a
  `private_secret` used in request signatures. Not self-serve in the docs.
  **External blocker for live verification.**

### Authorization
- *Authorization-code mode*: web = iframe `https://www.terabox.com/wap/outside/login?clientId=…`
  with `postMessage` event `teraboxOauth`; Android/iOS use a custom URL scheme
  `<app>://teraboxOauth?code=…`. The docs document **no `redirect_uri` and no `state`
  parameter**, and do not document the postMessage payload shape. Code lifetime 5 min, single use.
- *Device-code mode*: `GET /oauth/devicecode?client_id=` → `device_code`,
  base64 PNG `qrcode_url`, `expires_in`, `interval`; `user_code`/`verification_url`
  are documented as "currently not available". User scans the QR in the TeraBox app
  (doc note: VPN needed to log in to the app in some regions). Poll
  `POST /oauth/gettoken` (`grant_type=device_code`); errno `400001` = not yet authorized.
- Token endpoint `POST /oauth/gettoken` form fields: `client_id, client_secret,
  grant_type, code, timestamp, sign`; `sign = md5(client_id_timestamp_client_secret_private_secret)`
  (underscore-joined; hex-case not stated → lowercase hex assumed, **unverified**).
- `access_token` valid **2 days**; `refresh_token` valid **30 days** and **single-use**:
  `POST /oauth/refreshtoken` returns a new pair; the old access token dies 15 s later.
  Consequence: concurrent refreshes can destroy the connection (handled, §4).
- `POST /oauth/tokeninfo` → `api_domain`, `upload_domain` (per-user! cache ≤ 1 h),
  `user_id`, `expires_in`, `create_time`, `client_id`.
- OAuth errnos: 2, 100001, 100002, 200001, 200002 (invalid token), 200003 (expired
  token), 200004/200005 (invalid/expired refresh), 300001 (too frequent), 400001
  (pending), 500001.

### Capabilities (all on `api_domain`, token as `access_tokens` query param)
| Capability | Endpoint | Notes |
|---|---|---|
| User info | `GET /openapi/uinfo` | `uname`, `avatar_url`, `vip_type`, `uk` |
| Quota | `GET /openapi/api/quota` | `total`, `used` (bytes) |
| Pre-upload | `POST /openapi/api/precreate` | `path, autoinit=1, block_list` = **md5 of each shard, known up-front** → returns `uploadid`, shards to send, `return_type` (2 = already exists) |
| Shard upload | `POST {upload_domain}/rest/2.0/pcs/superfile2` | `method=upload, app_id=250528, path, uploadid, partseq`; multipart `file`; shards must be > 4 MB except (implicitly) the last |
| Create | `POST /openapi/api/create` | `path,size,uploadid,block_list,rtype` (0 fail on conflict, 1 rename, 2 rename if different, 3 overwrite) |
| Manage | `POST /openapi/api/filemanager` | `opera=copy|move|rename|delete`, `async=0|1|2`; errnos -7/-8/-9 |
| List | `GET /openapi/api/list` | `dir, page, num, order, desc` |
| Metas | `GET /openapi/api/filemetas` | `target`, `dlink` |
| Search | `GET /openapi/api/search` | `key, recursion=1, page, num≤10000` |
| Download | `GET /openapi/api/download` | `fidlist=[fs_id]`, `type=dlink`; append `access_tokens` to the returned dlink |
| Streaming | `GET /openapi/api/streaming` | m3u8 only (not implemented) |
| Shares | `/openapi/share/verify`, `/openapi/api/shorturlinfo`, `/openapi/share/list` | consume **other people's** shares; **no create-share API documented** |

### Namespace restriction (critical)
"all operations related to the file can only be performed within this space":
paths live under an app folder. The doc is internally inconsistent about its name
(`/From: Other Applications/<Application Name>-/` in §3.1, `/From: Other Device/<Application Name - Assigned Application ID>/`
in §3.4), while its curl examples use bare `/` paths. **Unverified** whether bare
paths are rewritten server-side. The adapter therefore keeps `remoteId` relative to
the app root and makes the root prefix configurable (`TERABOX_APP_ROOT`, default empty).
Arbitrary pre-existing files in a user's personal TeraBox are **not** reachable.

### Not documented (and therefore not implemented / not claimed)
create-folder, share creation, resumable upload, range download, rate limits,
per-file/free-tier size limits, recycle-bin vs permanent delete semantics,
change-notification/cursor, errnos for expired tokens on file endpoints, zero-byte
upload behaviour, response `has_more` for `list`.

## 3. Capability matrix for `terabox_open`

| Capability | Declared | Reason |
|---|---|---|
| authenticate, getAccountInfo, getQuota, healthCheck | yes | documented |
| list, getMetadata, search | yes | documented |
| upload | yes | precreate → shards → create (spooled, see §4) |
| download | yes | `/download` dlink |
| rename, move, copy, delete | yes | `filemanager` |
| downloadRange | **no** | not documented |
| createFolder | **no** | not documented |
| uploadResumable | **no** | `uploadid` exists but no resume/abort contract |
| createShare / revokeShare | **no** | no create-share API |

## 4. Design decisions driven by the contract

1. **Device-code connect flow** (QR). The auth-code flow has no documented
   redirect/state, so CSRF protection cannot be delegated to it. For device-code the
   server keeps `device_code` in Redis (AES-GCM encrypted, TTL = `expires_in`),
   hands the browser only an opaque 256-bit handle bound to the authenticated user.
2. **Signed token calls**: `private_secret` lives only in the environment, never in the DB.
3. **Single-use refresh token**: in-process de-duplication of concurrent refreshes per
   refresh token + a generic "reload and reuse tokens refreshed by another process"
   fallback in `context.ts`. Residual risk: a refresh interleaving across two
   *processes* can still burn the token; the account then flips to `unauthorized`
   and must be re-authorized (documented).
4. **Uploads are spooled to a temp file** (mode 0600, removed in `finally`) because
   the official `precreate` needs every shard md5 before the first shard is sent;
   the reverse-engineered "placeholder md5" trick is undocumented and not used.
   Bounded by `TERABOX_UPLOAD_CONCURRENCY` (default 2). Peak memory = one 4 MiB shard.
5. **Duplicate names**: `rtype=1` (rename on conflict); the returned `path` becomes
   the `remoteId`, so nothing is silently overwritten. `create` is never auto-retried.
6. **Hosts**: `api_domain`/`upload_domain`/dlinks must be `terabox.com` or a
   subdomain, https, and still pass `assertFetchAllowed` on every redirect hop.
7. **Routing**: catalog flag `quotaPolicy: 'required'` – unknown or stale (> 30 min)
   quota makes the account ineligible instead of "unlimited". Per-account routing
   switch stored in `ConnectedAccount.metadata.routingEnabled`.

## 5. Known limitations / security notes
- Access token is sent in the URL query by the official API design; the adapter never
  logs URLs and strips queries from error text. Any reverse proxy in front of
  TeraBox would see it (not applicable: direct HTTPS).
- Live behaviour (namespace prefix, sign format, expired-token errno on file APIs,
  CDN redirect hosts, size limits) **cannot be verified without approved credentials.**
- Pre-existing: `routing.ts` treats `availableBytes === null` as unlimited and ranks it
  first in `most_available` for every provider. Left unchanged for Google/S3/etc. (null
  legitimately means "no limit" there); only `quotaPolicy: 'required'` providers opt out.

## 6. Phased plan and acceptance criteria
A inspect ✔ · B verify API ✔ · C design (this doc) ✔ · D adapter + auth ·
E file ops + streaming · F routing/quota · G API + UI · H tests + docs · I regression.
Acceptance: `tsc` clean; all non-DB tests green; new tests cover auth, refresh,
files, upload/download, SSRF, routing eligibility, cross-user device flow; Google/S3
code paths unmodified apart from the generic hooks listed above.

## 7. Security review (focused)

| Area | Finding / control | Evidence |
|---|---|---|
| OAuth state / CSRF | Redirect flow not used (no documented `state`/`redirect_uri`). Device flow: 256-bit handle bound to the authenticated user, device code server-side (AES-GCM, TTL), single use, one active flow per user, other users' handles indistinguishable from unknown ones | `terabox-open.device-flow.test.ts` |
| Redirect URI validation | N/A for device flow; generic redirect route refuses `terabox_open` (`AUTH_MODE_UNSUPPORTED`) | `connect-flow.ts` |
| Token storage/refresh | Encrypted with `TOKEN_ENCRYPTION_KEY`; `private_secret` env-only; single-use refresh handled in-process + cross-process adoption; never returned to the frontend (account views carry no token fields) | `terabox-open.context.test.ts`, `terabox-open.connect.test.ts` |
| Ownership | All account routes use `findOwnedAccount(userId, id)`; device flow keyed by user id; account upsert scoped by `(userId, provider, providerAccountId)` | tests above; DB-backed route tests could not run here |
| SSRF | `api_domain`/`upload_domain`/dlink must be `terabox.com` over https (no ports, credentials or IPs), plus `assertFetchAllowed` per request and per redirect hop (max 3); QR must be an inline PNG | `terabox-open.auth.test.ts` ("upstream-supplied hosts are untrusted") |
| Download handling | Streamed through the adapter after authorization; the dlink and token never reach the browser; the token is attached only to the first hop | `terabox-open.transfer.test.ts` |
| Upload validation | Name/path traversal and control characters rejected; exact byte accounting; bounded concurrency; temp files 0600/0700 and always removed | `terabox-open.transfer.test.ts`, `…files.test.ts` |
| Rate limiting | Device start 10/15 min, poll 240/5 min per user; poll also self-throttled to TeraBox's interval | `rate-limit.middleware.ts` |
| Sensitive logging | Request URLs (which carry `access_tokens`) are never logged or put in error messages; error `detail` redacts token/secret/sign/code/dlink keys; route logging prints fixed codes only | `terabox-open.auth.test.ts` (credential leakage tests) |
| Public sharing | Not offered (no create-share API) | capability matrix |
| CORS / auth | Unchanged; new routes are behind `requireAuth` | `provider.routes.ts` |
| Migration safety | No schema change | — |

Known residual risks: token in URL query is mandated by the official API; cross-process
refresh race can still require reauthorization (§4.3); strict `terabox.com` host policy
may need a one-line extension if the live CDN uses another official domain; live behaviour
is unverified.

## 8. Outcome vs plan

All phases A–I were executed except live verification and DB-backed tests/migration
checks, which need infrastructure/credentials unavailable here (no Postgres, Redis,
Docker engine, or TeraBox approval). See the final report for exact results.

## 9. Deviations from the original brief
- The repository already contained a provider platform (PostgreSQL, Dropbox, OneDrive,
  pCloud, registry, routing) and an uncommitted cookie-based TeraBox adapter; scope was
  therefore "add an official provider beside it" (user-confirmed), not "create the abstraction".
- No migration was written because none is needed; the "test migrations against a
  disposable database" requirement is consequently vacuous but also could not have been
  executed locally.
- Routing diagnostics and the quota-trust rule were added generically (opt-in via catalog
  flags) rather than changing behaviour for existing providers.
- `createFolder`, sharing, resumable upload and range download are intentionally not
  implemented because the official document does not define them.
