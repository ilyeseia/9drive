# Security Contract

**Status:** NORMATIVE — non-negotiable security requirements.
**Owner:** Coordinator. Findings source: Wave 0 security audit (file:line refs below).
**Rule:** no agent may weaken a control in this document. Strengthening requires only a
note in the PR description.

---

## 1. Secrets & defaults (audit 1.1, 11.1 — CRITICAL)

1. `JWT_ACCESS_SECRET` and `TOKEN_ENCRYPTION_KEY` MUST be ≥ 32 chars and MUST NOT equal
   any value appearing in `.env.docker.example`, `setup.ps1`, `setup.sh`, or
   `docker-compose.yml`.
2. `backend/src/config/env.ts` FAILS STARTUP when either secret matches a known
   placeholder (`change-this-`, `replace-with-`, `changeme`, empty, or <32 chars).
3. `docker-compose.yml` MUST NOT use `:-` fallbacks for `JWT_ACCESS_SECRET`,
   `TOKEN_ENCRYPTION_KEY`, `POSTGRES_PASSWORD`, `REDIS_PASSWORD`. Missing `.env` =
   loud failure, not an insecure boot.
4. `setup.ps1` / `setup.sh` generate random secrets (they already do — preserve) and
   must generate `POSTGRES_PASSWORD` too.
5. No secret is ever committed, logged, or returned by an API.

---

## 2. Transport & headers

- `helmet` applied globally with:
  - `X-Content-Type-Options: nosniff`
  - `Content-Security-Policy` appropriate to the SPA (`default-src 'self'`;
    media/img `'self' data: blob:`; `frame-ancestors 'self'` — public embed route is
    same-origin only; `object-src 'none'`; `base-uri 'self'`)
  - `Referrer-Policy: no-referrer`
  - `X-Frame-Options` derived from CSP (embed route documented as exception)
  - HSTS only when `TRUSTED_PROXY_TLS=true`
- nginx adds the same headers on the edge and sets
  `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, and
  `Cache-Control: public, max-age=31536000, immutable` for `/assets/*`.
- `Cache-Control: no-store` on all authenticated API responses and all token-bearing
  responses (`/public/files/:token*`, `/files/preview/:token`).
- TLS terminates at the edge (Tailscale serve or reverse proxy); the backend stays
  plain HTTP on an internal network.

---

## 3. Authorization (audit 2.2 — CRITICAL)

### 3.1 Roles
- `User.role`: `user` (default) | `admin`.
- `backend/src/middleware/role.middleware.ts` exports `requireRole('admin')`.
- **Only** these routes require `admin`:
  `POST /system/update`, `GET /system/update-log`, `GET /system/backup`,
  `POST /system/restore`, `GET|POST /system/google-config`.
- No other route may be admin-gated without a Coordinator proposal (availability risk).

### 3.2 Route protection matrix
| Class | Middleware | Notes |
|---|---|---|
| Session routes | `requireAuth` | JWT + DB session validation |
| Admin routes | `requireAuth` + `requireRole('admin')` | §3.1 |
| API-key routes | `requireApiKey(scope)` | §4 |
| Public token routes | `requirePublicToken` | hash lookup + expiry + `enabled` |
| Health | none | `/health`, `/health/ready` only |

### 3.3 Tenant isolation (MANDATORY pattern)
Every `:id` lookup uses `findFirst({ where: { id, userId: req.user.id } })` and 404s.
The Wave 0 audit confirmed current resource CRUD is correctly scoped — **preserve that
exactly**. Any new route MUST follow the same pattern; a route that queries by `id`
alone is a release blocker.

### 3.4 SSO/OAuth config lookup
`connected-account.routes.ts:85` currently picks a `ProviderConfig` with no `userId`
filter (cross-tenant association). After refactor: S3/access-key accounts MUST NOT
depend on a Google `ProviderConfig` at all — make `providerConfigId` genuinely optional
or scope it `userId: req.user.id OR userId: null`.

### 3.5 Invites (audit 2.2.6)
`WorkspaceInvite` roles are currently unenforced. Decision: **enforce them**.
- `viewer` → read/download/preview of the target file only.
- `editor` → additionally rename/move/delete of that file.
- Auto-accept on invitee-has-account is **removed**; acceptance requires an explicit
  `POST /invites/:id/accept`.
- File access checks consult `WorkspaceInvite` (`status='accepted'`, not revoked).

### 3.6 `trust proxy`
`app.set('trust proxy', ...)` MUST be configurable: `TRUST_PROXY_HOPS` (default `1`
behind nginx, `0` when directly exposed). Unconditional `true` with a published port
makes `req.ip` spoofable (audit 8.3).

---

## 4. API keys (audit 3.x)

- Format `9d_live_<32 random bytes base64url>`; stored SHA-256; display prefix only.
- Scopes (final): `files:upload`, `files:read`, `files:delete`, `jobs:read`,
  `providers:read`, `webhooks:manage`. Enforced by `requireApiKey` — a route without a
  declared scope is rejected.
- `lastUsedAt` updated at most once per 60 s per key (write amplification, audit 3.4).
- Per-key rate limit: `120 req/min` (Redis), configurable per key.
- Key creation limited to **50 active keys per user**.
- Revocation is immediate: middleware checks DB row, not a cached claim.

---

## 5. Google Drive public-permission removal (audit 6.3 — CRITICAL, data exposure)

Current behaviour grants `type:'anyone', role:'writer'` after every upload
(`upload.routes.ts:228-240`, `:505-516`) and again on `GET /files/:id/view-url`
(`file.routes.ts:358-369`).

**Required behaviour:**
1. Automatic `anyone/writer` grants are **deleted entirely**.
2. Public sharing is explicit and opt-in via `POST /files/:id/share` (already exists)
   and grants **`reader` only**.
3. `POST /files/:id/public-permission` is either removed or changed to grant
   `reader`, never `writer`, and requires `files:share` intent in the body.
4. `GET /files/:id/view-url` returns a URL **without mutating permissions**.
5. "Make Public & Copy Link" in the UI is gated on
   `file.accountProvider === 'google_drive'` (fixes the dead branch at
   `AllFilesPage.tsx:788` where a display label is compared to a provider id).
6. `revokeShare` is implemented for Google (`permissions.delete`) and wired to
   `DELETE /files/:id/share`.

---

## 6. Upload safety (audit 6.1, 6.2, 6.5, 6.7)

1. **No whole-file buffering.** Path: stream request → provider. If the provider cannot
   accept an unbounded stream, spool to disk (`UPLOAD_SPOOL_DIR`) with a hard cap
   (`UPLOAD_SPOOL_MAX_BYTES`). `Buffer.concat` of a user file is forbidden.
   `MAX_UPLOAD_BYTES` default lowered to **1 GiB** (was 5 GiB) with override.
2. **Parser hardening:** every `busboy.on('field')` callback wraps `BigInt()` /
   `JSON.parse` in try/catch → 400 `VALIDATION_FAILED`. Never an uncaught throw.
3. **Process safety:** `process.on('uncaughtException')` / `('unhandledRejection')`
   in `server.ts` and `worker.ts` → log + graceful shutdown. Fix
   `archive.on('error', err => { throw err })` (`file.routes.ts:413`) → reject the
   response instead.
4. **Filename sanitisation** for anything used as a path/zip entry:
   strip path separators, `..`, control chars, leading dots; cap length at 255 bytes;
   preserve the display name separately from the safe name. Zip entries use the safe
   name (fixes zip-slip, audit 6.5).
5. **MIME handling:** client-declared `mimeType` is stored as a *hint* only.
   On inline streaming, responses for `text/html`, `image/svg+xml`,
   `application/xhtml+xml`, `application/xml` are forced to
   `Content-Disposition: attachment` + `text/plain` content type, and
   `X-Content-Type-Options: nosniff` is always set. Optional server-side sniffing
   (first 4 KB) recorded on `File.sniffedMimeType`.
6. **Content-Disposition** sanitised: CR/LF stripped, RFC 5987 `filename*` encoding for
   non-ASCII, never raw user bytes in a header (fixes audit 6.6).
7. Per-user daily upload byte quota (`USER_DAILY_UPLOAD_BYTES`, default 50 GiB) tracked
   in Redis; exceeded → 429/507.

---

## 7. SSRF (audit 5.1 — HIGH) — `backend/src/utils/ssrf.ts`

Applies to **every** server-side request whose destination is influenced by user input:
S3/MinIO/R2/B2 custom `endpoint`, webhook `url`, provider token endpoints (fixed),
any `fetch` of a stored URL.

Gate (all must pass):
1. Scheme ∈ {`https`} (`http` allowed only if `ALLOW_INSECURE_ENDPOINTS=true`).
2. No credentials in URL, no `#`, port restricted to 80/443/9000/9001 unless allow-listed.
3. Resolve DNS **and reject** if any resolved address is:
   loopback (`127/8`, `::1`), link-local (`169.254/16`, `fe80::/10`),
   private (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`),
   metadata (`169.254.169.254`), CGNAT (`100.64/10`), broadcast, unspecified.
4. Re-validate the address used for the actual connection (no DNS rebinding): connect to
   the pinned IP with `Host` preserved, or re-check after resolution.
5. Redirects: `redirect: 'manual'` — follow only after re-passing the gate, max 3 hops.
6. Failure → `ProviderError('ERR_SSRF_BLOCKED')` + `security.suspicious_request` event;
   never echo the resolved address to the client.

Optional `SSRF_ALLOWLIST` (comma-separated hostnames) for homelab endpoints; when set,
non-listed hosts are rejected outright.

---

## 8. Rate limiting (audit 1.3 — HIGH)

`express-rate-limit` backed by Redis (`backend/src/middleware/rate-limit.middleware.ts`),
applied **before** routers:

| Scope | Key | Limit |
|---|---|---|
| `auth:login` `/auth/login` | IP + email | 10 / 15 min |
| `auth:register` `/auth/register` | IP | 5 / hour |
| `auth:refresh` `/auth/refresh` | IP + session | 30 / 15 min |
| `auth:google` `/auth/google/exchange` | IP | 20 / 15 min |
| `public:token` `/public/**`, `/files/preview/**` | IP | 60 / min |
| `api:key` `/v1/**`, `/api/v1/**` | API key | 120 / min |
| `upload` `/uploads*` | user | 30 / min + daily byte quota |
| `default` everything else | IP | 300 / min |
| `admin:system` `/system/*` | user | 20 / min |

Headers `RateLimit-*` on every limited response. Exceeding → 429 `RATE_LIMITED`.
`TRUST_PROXY_HOPS` (§3.6) MUST be correct before this is effective.

Login lockout: after 10 consecutive failures for an email within 15 min, add a 15-min
Redis lock; respond 429 regardless of credentials (no user enumeration via timing).

---

## 9. Error & logging hygiene (audit 7.5, 5.1 exfil)

- `error.middleware.ts` returns `{code, message}` where `message` for 5xx is generic
  (`"Internal server error"`); details go to server logs with the request id.
- `ConnectedAccount.lastError` / `ProviderHealth.message`: truncated to 500 chars and
  **scrubbed** of URLs' query strings and any `token|secret|key|authorization` values.
- Remove the hardcoded VPS IP `103.65.237.136` from `system.routes.ts:22`.
- Git/command output (`system.routes.ts:58-73`) is never returned to clients.
- Never log access/refresh tokens, OAuth client secrets, JWT/encryption keys, raw share
  or preview tokens (already a rule — keep).

---

## 10. Token handling

### 10.1 Sessions
- Access token: HS256, `algorithms: ['HS256']` pinned at verification
  (`utils/jwt.ts`), TTL `ACCESS_TOKEN_TTL_SECONDS`.
- `requireAuth` MUST assert `payload.sub === session.userId` and set
  `req.user.id = session.userId` (token `sub` is never trusted alone) — fixes audit 1.2.
- **Refresh rotation**: each `/auth/refresh` issues a new refresh token, moves the
  current hash to `prevRefreshTokenHash`, and returns the new one. Presenting a
  token equal to `prevRefreshTokenHash` = **reuse** → revoke the whole session, emit
  `auth.refresh_reuse_detected`, 401.
- Shorten `REFRESH_TOKEN_TTL_DAYS` default to **14**, with sliding extension on
  legitimate refresh (max 90 d absolute).
- `User.status !== 'active'` → 403 on `requireAuth` (audit 1.8).
- Session list + revoke-all endpoints:
  `GET /auth/sessions`, `DELETE /auth/sessions/:id`, `DELETE /auth/sessions`.

### 10.2 Public tokens
- Share / preview / handoff / OAuth-state tokens: 256-bit random, stored **hash-only**.
- `FileShare.token` plaintext column **dropped**; lookup uses `tokenHash` only
  (fixes audit 4.2). Legacy plaintext rows are hashed during the baseline migration.
- Share links get a **default 30-day expiry**, settable at creation, renewable.
- Unknown/expired/disabled tokens → **404 `NOT_FOUND`** (not 500).

### 10.3 Handoff tokens
Google auth handoff still travels in the URL query (preserved for compatibility) but:
single-use, 5-minute TTL, and `Referrer-Policy: no-referrer` + `no-store` on the
landing page prevent leakage. Consideration of a fragment-based handoff is a v2 item.

---

## 11. Crypto (audit 9.1)

`backend/src/utils/crypto.ts`:
- Keep AES-256-GCM, random 12-byte IV, auth tag verification.
- Key derivation: `HKDF-SHA256(TOKEN_ENCRYPTION_KEY, salt='9drive:v1', info='field')`
  instead of bare `sha256`.
- **AAD binding**: `aad = <table>.<column>` passed to `sealBox`/`openBox` so ciphertext
  cannot be swapped between columns.
- **Version prefix** `v1:` on ciphertext; `decrypt` accepts `v1` (and legacy un-prefixed
  during a transition window), `encrypt` always writes `v1:`.
- `hashToken` → HMAC-SHA256 with a key derived from `TOKEN_ENCRYPTION_KEY` (peppered),
  so a DB-only leak cannot be brute-forced offline against a known list. Existing
  SHA-256 rows remain verifiable during the transition (dual check), then re-hash on
  next use.
- JWT: pin `algorithms`, include `iat`/`exp`/`iss` (`iss: '9drive'`) and verify `iss`.

---

## 12. Multi-tenant isolation tests (MANDATORY)

A security test file MUST exist and pass:
`backend/src/__tests__/security/tenant-isolation.test.ts`
covering: file read/rename/move/delete/share, folder rename/delete, connected-account
delete/sync-quota, api-key revoke, audit-log list, invite accept — each performed by
user B against user A's resource id, asserting **404** (never 200/500).

Plus:
- `ssrf.test.ts` — private/metadata/loopback endpoints rejected for S3 endpoint + webhook URL.
- `auth.test.ts` — forged JWT (`sub` ≠ session user) rejected; alg:none rejected;
  expired/revoked session rejected; refresh reuse revokes session.
- `rate-limit.test.ts` — login and public-token limits trip.
- `upload.test.ts` — oversized body rejected; malformed `sizeBytes` → 400 not crash;
  filename with `../../` neutralised in zip entries.
- `headers.test.ts` — `nosniff`, CSP, `no-store` present; error responses leak no internals.

---

## 13. Docker / deployment hardening

- Backend and frontend images: multi-stage, `USER node` (non-root),
  `NODE_ENV=production`, no devDependencies in the runtime image,
  `HEALTHCHECK` using `/health` (backend) and `/` (frontend).
- Compose: `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]` on app services;
  `read_only: true` with explicit tmpfs for `/tmp` where feasible.
- **Networks:** `public` (frontend + backend) and `internal` (`backend`, `worker`,
  `postgres`, `redis`) with `internal: true` (no egress). Postgres/redis attached only
  to `internal`.
- Publish **only** the frontend port. Backend port removed (or bound `127.0.0.1:4000`
  for debugging). Postgres/redis never published.
- Migrations run as a one-shot `migrate` service, not inside the API container.
- Images pinned by digest where practical; otherwise by minor version tag.
- `RECAPTCHA_SECRET_KEY` actually passed to the backend container (currently missing).

---

## 14. Frontend

- Access/refresh tokens: keep `localStorage` **for now** (changing to httpOnly cookies is
  a v2 decision), BUT add a CSP via nginx (§2) so XSS has no execution path, and set
  `Referrer-Policy: no-referrer`.
- `window.location.href = data.url` MUST validate the URL host against
  `VITE_ALLOWED_REDIRECT_HOSTS` (default `accounts.google.com`) — open-redirect fix.
- Stop sending preview URLs containing tokens to third parties: `officeViewerUrl`
  (`lib/preview.ts:27-29`) is disabled unless `VITE_ENABLE_OFFICE_PREVIEW=true`.
- Gravatar/DiceBear: hash with MD5 (correct algorithm) or, preferred, drop the network
  call and use local initials avatars (privacy; works offline/Tailscale).
- Dead scaffold `src/counter.ts` (raw `innerHTML`) removed.

---

## 15. Definition of done

Security work is complete only when:
1. All §12 tests exist and pass.
2. `npm audit --audit-level=high` reports no high/critical findings.
3. No `role`-less privileged route, no `userId`-less `:id` lookup, no raw
   `error.message` to clients, no unbounded in-memory upload, no unvalidated
   server-side URL fetch.
4. `docker compose config` shows no placeholder secrets.
5. A security agent has re-read this document against the final code and signed off in
   `docs/architecture/agent-status.md`.
