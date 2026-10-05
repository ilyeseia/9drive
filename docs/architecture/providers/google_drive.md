# Google Drive adapter

`backend/src/providers/google-drive/**` — the `SUPPORTED` `google_drive` adapter from
`provider-contract.md` §11.

| File | Role |
|---|---|
| `index.ts` | `GoogleDriveProvider implements StorageProvider`, `googleDriveProvider`, `createGoogleDriveProvider()`, `registerGoogleDriveProvider()`, `clearGoogleDriveRootFolderCache()` |
| `oauth2.ts` | `OAuth2ClientConfig` + self-registration on import |
| `client.ts` | `DriveApiClient` — undici `request()` REST calls, auth, 401 refresh retry, JSON/stream timeouts |
| `errors.ts` | Google error payload → security-contract/provider-contract §5 taxonomy |
| `mime.ts` | Folder MIME type, export conversion table, Drive query escaping |
| `transport.ts` | Base/token URL seam (`setGoogleDriveTransport`), resumable session URI allowlist |

The adapter is exported through `providers/index.ts` by the coordinator; this agent owns
only the directory above, its tests (`backend/src/__tests__/providers/google-drive/**`)
and this document.

## Auth setup

1. In Google Cloud Console create (or pick) a project.
2. **APIs & Services → Library**: enable **Google Drive API**.
3. **APIs & Services → OAuth consent screen**: configure the consent screen; add the
   9Drive host to authorised domains; add the `drive`, `userinfo.email`,
   `userinfo.profile` scopes to the sensitive-scopes list; publish or keep test-mode
   with the connecting users added as test users.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   application type **Web application**, authorised redirect URI
   `<9drive origin>/api/auth/google/callback` (the provider-neutral connect flow).
5. Store the client id/secret in the OAuth client config the connect flow reads
   (`seed-google-config.ts` values or the deployment's env-backed config).

`oauth2.ts` registers the config with `registerOAuth2Client()` at import time:

- authorization URL `https://accounts.google.com/o/oauth2/v2/auth`
- token URL `https://oauth2.googleapis.com/token`
- authorization params `access_type=offline`, `prompt=consent`
  (refresh token issuance), `include_granted_scopes=true`
- scopes: `https://www.googleapis.com/auth/drive`,
  `https://www.googleapis.com/auth/userinfo.email`,
  `https://www.googleapis.com/auth/userinfo.profile`

The full `drive` scope (not `drive.file`) is required: the adapter lists, moves, deletes
and re-shares files created through the legacy Google routes as well as its own, and
reads account quota from `/drive/v3/about`.

The connect flow stores the userinfo `sub` as `ConnectedAccount.providerAccountId`;
`getAccountInfo` reads `/oauth2/v2/userinfo` first (same id) and falls back to
`/drive/v3/about` `user.permissionId` when userinfo is unavailable.

## Capabilities

The provider declares all 18 contract capabilities (catalog entry `google_drive` uses
`ALL_CAPABILITIES`); the constructor accepts a `capabilities` override for tests.
`authenticate` is declared but has no runtime method — the connect flow owns it.
Every method gates on its capability first with
`` `provider 'google_drive' does not declare capability '<name>'` `` (same wording as
`fake.ts`), except `search` which is gated by the `search` capability as well.

## Root folder contract

- Every account gets a single **`9drive`** folder under the Drive root
  (`'root' in parents`, folder MIME, `trashed = false`), created on first use by any
  meta-returning operation (upload, list, move, copy, createFolder, search).
- The id is cached per `ctx.account.id` in the provider instance.
- `parentId: null` / `''` / whitespace resolves to that folder. A real parent id is used
  verbatim; `'root'` (Drive root) stays literal `'root'`.
- `RemoteFileMeta.parentId` is `null` only when the Drive parent is the `9drive` folder;
  files with no parents at all also report `null`; Drive root stays `'root'`.
- If a root-resolved write fails with `parentNotFound`/`notFound`, the cached root id is
  invalidated (deleted folder, restored-from-trash drift) and the error propagates — the
  next operation recreates the folder. No blind retry. Manual cache purge:
  `clearGoogleDriveRootFolderCache(accountId?)`.

## Upload protocol

- Input validation: `fileName` required, `stream` must be a readable, `sizeBytes` must be
  a non-negative `bigint`; non-oauth2 credentials are rejected before any HTTP call.
- **Multipart** (`uploadType=multipart`) when `sizeBytes < 5 MiB`
  (`GOOGLE_DRIVE_RESUMABLE_THRESHOLD_BYTES`): one streamed request with a computed
  `Content-Length` (metadata part + file part + boundary framing). A stream that
  delivers fewer or more bytes than declared fails with `ERR_INVALID_INPUT`.
- **Resumable** (`uploadType=resumable`) when `sizeBytes >= 5 MiB` **or** a
  `resumeToken` is supplied (capability `uploadResumable`):
  1. `POST /upload/drive/v3/files?uploadType=resumable` with `X-Upload-Content-Length`
     (omitted for unknown-size streams) and the file metadata; the returned
     `Location` session URI must point at the configured origin or `*.googleapis.com`
     (`assertSessionUriAllowed`, otherwise `ERR_SSRF_BLOCKED`).
  2. Chunks of `GOOGLE_DRIVE_CHUNK_BYTES` (8 MiB) PUT with
     `Content-Range: bytes start-end/total` (or `/*` for unknown size); the remainder of
     an interrupted chunk is re-sent when the upstream reports partial progress.
  3. `308 Resume Incomplete` → read `Range: bytes=0-N` and continue; no-`Range` repeats
     are tolerated a bounded number of times, then `ERR_UPSTREAM_UNAVAILABLE`.
  4. Final chunk completes the session; the status query `bytes */{size|*}` resolves a
     `resumeToken` that already finished upstream.
- Every `resumeToken` is passed through the same session-URI allowlist before use.
- Uploads resolve the target parent through the `9drive` root fallback, so a deleted
  root folder heals on the next write.

## Download

- Folders → `ERR_INVALID_INPUT`.
- Google Workspace types are exported on the fly (`/export`), mirroring the legacy
  `stream-google-file.ts` targets:

| Drive MIME | Export MIME | Extension |
|---|---|---|
| `...document` | `application/pdf` | `.pdf` |
| `...spreadsheet` | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` | `.xlsx` |
| `...presentation` | `application/pdf` | `.pdf` |
| `...drawing` | `image/png` | `.png` |
| `...jam` | `application/pdf` | `.pdf` |
| `...map` | `application/pdf` | `.pdf` |

  Workspace types without a target (e.g. forms) → `ERR_INVALID_INPUT`; a byte range on
  an export → `ERR_INVALID_INPUT`. The `downloadRange` capability is checked before any
  HTTP call; ranges are sent as a `Range` header on `alt=media` and the response
  `Content-Range` is parsed back into `range {start,end,total}`.

## Sharing (security-contract §5)

- Only `public_read` and `private` are accepted; anything else → `ERR_INVALID_INPUT`.
- `public_read` creates (or downgrades to) a **`reader`** permission
  `type: anyone, allowFileDiscovery: false`, with an optional `expirationTime`.
  An existing `anyone` permission with a higher role is PATCHed down to `reader`.
  The result URL is the file's `webViewLink`. There is no code path that grants
  `writer`; auto-sharing never happens outside an explicit `createShare` call.
- `private` and `revokeShare` delete `anyone` permissions (404 tolerated).

## Quota and health

- `getQuota` reads `/drive/v3/about?fields=storageQuota`; all arithmetic is `bigint`
  (string sizes from Google exceed `Number.MAX_SAFE_INTEGER`), `limit` absent →
  unlimited (`null`), `availableBytes` never negative.
- `healthCheck` pings `/drive/v3/about?fields=user`; success → `healthy`, failures go
  through `mapErrorToHealthState` (`health.ts`) so 401/refresh failure → `unauthorized`,
  unreachable/timeout → `unreachable`, capability missing is impossible (declared).

## Error mapping (contract §5)

`mapGoogleHttpError` inspects HTTP status, legacy `errors[].reason`, RPC
`details[].reason` and `status` strings from both response shapes:

| Google signal | Code |
|---|---|
| 404, `notFound`/`fileNotFound`/`not_found` | `ERR_NOT_FOUND` |
| 429, `rateLimitExceeded`, `userRateLimitExceeded`, `rate_limit_exceeded`, `resource_exhausted` | `ERR_RATE_LIMITED` |
| 401, `unauthenticated` | `ERR_AUTH_EXPIRED` |
| 403 / `permission_denied` without a rate-limit reason | `ERR_AUTH_REVOKED` |
| `storageQuotaExceeded`, `teamDriveQuotaExceeded`, `downloadQuotaExceeded`, `publishingQuotaExceeded`, `sharingQuotaExceeded`, `quotaExceeded` | `ERR_QUOTA_EXCEEDED` |
| 5xx, `backendError`, `internalError`, `unavailable` | `ERR_UPSTREAM_UNAVAILABLE` |
| abort/timeout (`isTimeoutError`) | `ERR_TIMEOUT` |
| anything else | `fromHttpStatus(status)` |

`mapGoogleTransportError` passes `ProviderError`s through untouched (so `ERR_SSRF_BLOCKED`,
`ERR_INVALID_INPUT` and refresh failures keep their code) and maps connection failures to
`ERR_UPSTREAM_UNAVAILABLE`.

## Refresh behaviour

`DriveApiClient` sends the access token, retries a 401 exactly once after
`session.renew()` returns `true`, and only replays request bodies that are replayable
(JSON payloads, never the upload streams). `renew()` returns `false` when the credentials
lack a refresh token/client id/secret, so the 401 maps to `ERR_AUTH_EXPIRED`. The token
request uses the transport `tokenUrl` and never logs the refresh token.

## Timeouts

JSON calls: 30 s (`JSON_TIMEOUT_MS`); uploads/downloads/exports: 15 min
(`TRANSFER_TIMEOUT_MS`), enforced through undici `headersTimeout`/`bodyTimeout` plus the
caller's `ctx.signal`. Errors map to `ERR_TIMEOUT`.

## Rate limits and platform limits

- Google does not publish fixed per-project Drive API rates; when the API returns 429 or
  a rate-limit reason the adapter surfaces `ERR_RATE_LIMITED` immediately and does not
  retry internally — callers and job backoff (`job-contract.md`) own the pacing.
- Resumable sessions expire upstream (Google closes idle sessions); a stale session
  surfaces as 404/`ERR_NOT_FOUND` from the status or chunk request and the caller
  restarts the upload with a fresh (no `resumeToken`) call.
- `pageSize` is capped at 1000 (`MAX_PAGE_SIZE`), default 100.

## Limitations (official API / v1 scope)

- **No shared drives**: queries use `corpora=user` and never send
  `supportsAllDrives`/`driveId`; files that live only in shared drives are not listed,
  and operations on them may 404.
- **Search is account-wide**: Drive has no "search only under X" query operator, so
  `search()` runs `name contains '<term>' and trashed = false` with `corpora=user`
  across the whole My Drive and filters nothing by parent. It is an extra method (not
  part of the `StorageProvider` interface) for future UI use; `list` remains the
  subtree operation.
- **No `orderBy`**: results are sorted client-side per page (folders first, then name,
  then id) instead of relying on Drive's server-side ordering.
- **Trash**: `delete` without `permanent` moves to trash (`PATCH trashed=true`);
  permanent delete is `DELETE`. Listing never returns trashed items.
- **`search` name matching** is Drive's `contains` semantics (substring, token-based),
  not a regex or full-text search (full text would need `fullText contains`).

## Test transport seam

Production traffic is pinned to `https://www.googleapis.com` and
`https://oauth2.googleapis.com/token`. Tests call
`setGoogleDriveTransport({ baseUrl, tokenUrl })` (exported from `transport.ts`) to point
the adapter at a local fake Drive server; `resetGoogleDriveTransport()` restores the
defaults. The override is a module-level seam never derived from user input, so it adds
no SSRF surface (security-contract §7).

## Registration

`registerGoogleDriveProvider()` (and the `googleDriveProvider` singleton) exist for the
coordinator to wire into `providers/index.ts`; `oauth2.ts` self-registers its
`OAuth2ClientConfig` on import. Catalog parity is asserted in
`google-drive.auth.test.ts` (declared capabilities === catalog `ALL`).
