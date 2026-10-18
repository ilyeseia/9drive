# 9Drive Mobile — repository audit and implementation plan

Status: Phase 1 (audit). Every statement below was read from the repository, with the file it comes from.
Nothing here is assumed; where something does **not** exist it is listed under "Not supported".

## 1. What 9Drive is today

- `backend/` — Express 5 + TypeScript, Prisma/PostgreSQL, Redis (BullMQ), Zod validation. Modules under
  `backend/src/modules/*`, mounted in `backend/src/app.ts`.
- `frontend/` — React + Vite web app (the reference client for every API below).
- Storage is provider-neutral (`backend/src/providers/*`, 22 provider entries in the catalog). Google Drive and
  S3-compatible are the long-standing ones; `terabox_open` (official Open Platform, device-code login) is
  implemented per `docs/terabox-integration.md`. The backend, not the client, decides where bytes go.

## 2. Authentication model (what the mobile app must follow)

Source: `backend/src/modules/auth/auth.routes.ts`, `backend/src/middleware/auth.middleware.ts`.

| Endpoint | Body | Response |
|---|---|---|
| `POST /auth/login` | `{ email, password }` | `{ accessToken, refreshToken, user: { id, name, email } }` |
| `POST /auth/register` | `{ name, email, password(min 8), captchaToken? }` | 201, same shape. `captchaToken` is required only when the server has `RECAPTCHA_SECRET_KEY` set |
| `POST /auth/refresh` | `{ refreshToken }` | `{ accessToken, refreshToken }` — **rotating**: the old refresh token stops working |
| `POST /auth/logout` | Bearer | revokes the session |
| `GET /auth/me` | Bearer | `{ user: { id, name, email, status } }` |
| `GET /auth/google/url`, `/google/callback`, `POST /auth/google/exchange` | | Google sign-in, **browser-redirect based** (see §7) |

Facts that shape the client design:

- **Refresh-token reuse detection**: presenting a previous refresh token revokes the whole session and returns
  `AUTH_SESSION_COMPROMISED`. The app must therefore refresh **single-flight** (one refresh at a time, shared by all
  callers) and persist the new refresh token **before** using the new access token.
- Error body is always `{ code, message }` (`backend/src/middleware/error.middleware.ts`); validation errors are
  `400 VALIDATION_FAILED`. Rate limits answer `429`.
- Roles are `user | admin`, enforced server-side by `requireRole`.
- There is **no** password-recovery or e-mail-verification endpoint → not implemented on mobile.
- Account suspension: a non-`active` user gets `403 AUTH_ACCOUNT_DISABLED` on every authenticated call; an expired or revoked
  session gets `401 AUTH_SESSION_EXPIRED` / `AUTH_INVALID_TOKEN`. The app maps these to distinct screens; the server stays authoritative.

## 3. Verified API surface used by the mobile app

All paths are relative to the API base URL. Auth is `Authorization: Bearer <accessToken>`.
BigInt values are serialised as **strings** (`backend/src/utils/serialize.ts`) — the client must parse sizes as strings.

**Files** (`backend/src/modules/files/file.routes.ts`)
- `GET /files?folderId&q&kind(image|video|pdf|doc|archive)&accountId&provider&minSize&maxSize&startDate&endDate&sort(name|size|createdAt)&order&cursor&limit(≤200)` → `{ files: File[], nextCursor? }`.
  File carries `connectedAccount { id,email,provider }` and `folder { id,name }`.
  Quirk found: the cursor encodes `[createdAt, id]` only, so **cursor paging is correct only with `sort=createdAt`**.
  The app uses cursor paging only for that sort and loads sorted-by-name/size lists in a single bounded request.
- `GET /files/:id`, `PATCH /files/:id` `{ name?, folderId? }`, `DELETE /files/:id` (soft delete → trash),
  `POST /files/:id/copy` `{ folderId? }`, `PATCH|DELETE /files/batch`, `GET /files/trash`, `POST /files/batch/restore`,
  `DELETE /files/batch/permanent`, `GET /files/stats`.
- Download: `GET /files/:id/download` streams with **HTTP Range** support and Bearer auth
  (`streamProviderFileNeutral`). Preview/download tokens: `POST /files/:id/preview-token`, `/download-token` (10 min).
- Sharing: `POST /files/:id/share` → `201 { url, shareId }` (fixed 30-day expiry, URL on `FRONTEND_URL`),
  `DELETE /files/:id/share`, `GET /files/shared-links`. `POST /files/:id/public-permission` is **Google Drive only**.

**Folders** (`folders/folder.routes.ts`): `GET /folders?parentId|all=1` → `{ folders }`, `POST`, `PATCH /:id`, `DELETE /:id`.

**Uploads** (`uploads/upload.routes.ts`)
- Multipart `POST /uploads` and a **provider-neutral resumable protocol**:
  `POST /uploads/resumable/init { fileName, mimeType, sizeBytes(string), folderId?, targetAccountId?, clientUploadId? }`
  → `{ sessionId, provider, chunkSize (5 MiB), offset }`; `PUT /uploads/resumable/chunk/:id` with
  `Content-Range: bytes a-b/total` → `{ status: 'uploading'|'completed', offset, file? }`;
  `GET /uploads/resumable/status/:id` → `{ status, offset }`.
  `clientUploadId` makes init/finalise **idempotent** (a replay returns the already-created file).
  The server spools chunks, truncates on a rewound offset, and rejects a gap (`INVALID_OFFSET`).
  This is the contract the mobile uploader uses; resume is real and server-supported.

**Provider accounts** (`providers/provider.routes.ts`, `connected-accounts/*`)
- `GET /providers` → account views `{ id, provider, displayName, email, status, lastError, authMode, capabilities[], quota{totalBytes,usedBytes,availableBytes}|null, health{state,latencyMs,checkedAt}|null, lastSyncedAt, routingEnabled, experimental, quotaPolicy }`.
- `GET /providers/catalog`, `PATCH /providers/accounts/:id/routing { enabled }`, `GET /providers/accounts/:id/capabilities`,
  `POST /providers/accounts/:id/health`, `DELETE /providers/accounts/:id`, `POST /connected-accounts/:id/sync-quota`.
- Connecting: Google is a browser OAuth redirect; S3 is `POST /connected-accounts/s3` (credentials sent once over TLS);
  TeraBox Open is device-code (`/providers/terabox_open/device/start|poll`).

**Routing** (`routing/routing.routes.ts`): `GET|PATCH /routing/policies`
(`mode`, `priorityAccountIds`, `fileTypeRules`, `min/maxFileSizeBytes`), `POST /routing/preview` (dry run + explanation).
The server is authoritative; the client only displays/edits the policy and never places files itself.

**Jobs** (`jobs/jobs.routes.ts`): list/get/retry/cancel/delete. **Dashboard**: `GET /dashboard/summary`.

**AI assistant** (`modules/ai/ai.routes.ts`, documented in `docs/ai-assistant.md`): status, conversations, messages,
task polling, cancel, confirmation approve/reject, read-only direct tool runs. The mobile app is a client of this
existing orchestrator; it implements no second agent. Server-side allowlisted tools, risk policy and hash-bound,
single-use confirmations already exist.

## 4. Not supported by the backend (so not faked on mobile)

- Password recovery, e-mail verification, MFA.
- Per-share restrictions (password, custom expiry, download limit): `POST /files/:id/share` takes no options.
- Server-pushed progress/notifications (no push-token endpoint exists) → no push notifications.
- Google sign-in **inside** the app: the OAuth callback redirects to the web `FRONTEND_URL`, not to an app scheme (§7).
- Mobile-specific API versioning: not needed so far; the existing endpoints are enough.

## 5. Risks and limitations found in the existing system (recorded, not silently "fixed")

1. File-list cursor is only valid for `sort=createdAt` (see §3).
2. `GET /folders` has side effects (`ensureProviderFolderIds` creates Google folders on read).
3. Share link expiry is fixed (30 days) and not configurable.
4. `GET /files/:id/view-url` returns a provider web link (Google `webViewLink`) — not appropriate to embed; the app
   previews through the authenticated `/files/:id/download` stream instead.
5. The refresh endpoint is intentionally strict (reuse ⇒ revoke); a naive client that refreshes concurrently
   would log users out. Handled by design (§2).
6. `accessToken` lifetime is `ACCESS_TOKEN_TTL_SECONDS` (server-configured); the client must not assume a value.

## 6. Technology decision

**React Native + TypeScript (strict) on Expo (SDK 58, current), development builds, Expo Router not required.**

Why: one strongly typed codebase for Android and iOS; the team already works in TypeScript and Zod (shared mental
model with `backend`); everything required has maintained first-party modules — `expo-secure-store`
(Keychain / Keystore-backed), `expo-local-authentication`, `expo-document-picker`, `expo-image-picker`,
`expo-file-system` (streamed up/download with progress), `expo-sharing`, `expo-clipboard`, `expo-localization`.
Chunked resumable upload needs file reads at an offset, which `expo-file-system` provides, so **no custom native
module is required** and Expo's managed workflow stays viable.

Rejected: Flutter (second language and a second set of contracts for no demonstrated need), native Swift/Kotlin
(two codebases; no requirement outweighs that cost), WebView wrapper (explicitly disallowed).

Known constraint: background transfers that survive the app being killed are **not** promised. iOS/Android restrict
this; resumable upload (above) is how an interrupted transfer is recovered when the app is reopened.

## 7. Backend changes

Required for the MVP: **none**. Recommended, out of scope for the mobile MVP and not done:
- A native-app Google sign-in flow (custom-scheme or universal-link redirect + PKCE-style handoff). Until then the
  app offers e-mail/password only and says so.
- A device-session list/revoke endpoint.

## 8. Security risks specific to mobile (mitigations are built in Phase 3/7)

- Token theft at rest → Keychain/Keystore-backed secure storage only; nothing sensitive in AsyncStorage/logs.
- Refresh-token race → single-flight refresh, persist-before-use.
- Cleartext/MITM → HTTPS required in release builds; no certificate-validation bypass; debug-only exception for
  local HTTP development, compiled out of release.
- Deep-link abuse → strict allowlisted scheme and route parsing; links never carry credentials.
- Log/crash leakage → a redacting logger; no tokens, signed URLs, or Authorization headers.
- Prompt injection in the AI view → the app renders assistant output as text/safe Markdown only and never executes
  anything itself; confirmation cards use the server-provided `argsHash` approve flow.
- Offline queue → never silently queues destructive operations.

## 9. Phases and acceptance criteria

| Phase | Deliverable | Acceptance |
|---|---|---|
| 1 | this audit | pushed |
| 2 | `mobile/` Expo app: strict TS, ESLint/Prettier, navigation, design tokens, i18n (ar/en/fr, RTL), env config, typed + validated API client | `tsc`, lint, unit tests green |
| 3 | secure storage, single-flight refresh, session restore, logout wipe, biometric lock, inactivity lock | session/refresh tests incl. reuse and race |
| 4 | file browsing/search/sort/filter/pagination, details, folder CRUD, rename/move/copy/trash, chunked resumable upload, ranged download, preview | transfer state-machine tests; fake-server integration tests |
| 5 | provider accounts, health/quota (null-safe), routing policy view/edit + preview | honest unknown/unsupported states |
| 6 | sharing, offline metadata cache, AI assistant client | confirmation/cancel/error flows tested |
| 7 | verification, dependency audit, security review document | results reported as run |
| 8 | docs, CI, release checklist, signing guide | iOS/Android builds explicitly marked verified or blocked |

Environment constraints discovered now (affect what can be *verified*): Node 22 / npm 10 available; **no Android SDK
and no Xcode** on this machine, so native binaries cannot be built here. The app will be verified by type-checking,
lint, unit and integration tests (a fake 9Drive server), and Expo's bundler export; device builds are documented as
blocked-by-environment with exact commands.
