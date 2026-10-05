# OneDrive adapter

`backend/src/providers/onedrive/**` — the `SUPPORTED` `onedrive` adapter from
`provider-contract.md` §11 (Microsoft Graph).

| File | Role |
|---|---|
| `index.ts` | `OnedriveProvider implements StorageProvider`, `onedriveProvider`, `createOnedriveProvider()`, `registerOnedriveProvider()`, `encodeOnedriveResumeToken()`/`decodeOnedriveResumeToken()`, upload/download/list/search/share logic |
| `oauth2.ts` | `ONEDRIVE_OAUTH_CLIENT` + scopes + self-registration on import |
| `client.ts` | `OnedriveClient` — undici `request()` JSON calls, auth header, 401 refresh retry, `gatedGet()`/`gatedRequest()` for upstream-supplied URLs, `sessionPut()` (anonymous chunk PUT), timeouts |
| `errors.ts` | Graph `{error: {code, message}}` → security-contract/provider-contract §5 taxonomy |
| `transport.ts` | Graph base + token URL seam (`setOnedriveTransport`), `graphUrl()` |

The adapter is exported through `providers/index.ts` by the coordinator; this agent owns
only the directory above, its tests (`backend/src/__tests__/**/onedrive/**`) and this
document.

## Auth setup

1. In the [Azure portal](https://portal.azure.com) open **Microsoft Entra ID →
   App registrations → New registration** (any account type that can sign in;
   the adapter talks to the `common` endpoint).
2. **Authentication → Platform: Web → Redirect URIs**: add the provider-neutral
   connect callback `<9drive origin>/connected-accounts/onedrive/callback`
   (`provider-contract.md` §8: `GET /connected-accounts/:provider/connect-url` →
   `GET /connected-accounts/:provider/callback`).
3. **API permissions → Add a permission → Microsoft Graph → Delegated**: `User.Read`,
   `Files.ReadWrite`, `Files.ReadWrite.All` (grant consent if the tenant requires it).
   `offline_access` is added by the v2 endpoint when requested as a scope — no admin
   consent needed for it.
4. **Certificates & secrets → New client secret**; copy the value before leaving the page.
5. Copy the **Application (client) ID** (and Directory ID if the app is tenant-bound)
   into the OAuth client config the connect flow reads (`oauth2.ts` config for this
   deployment).

`oauth2.ts` registers the config with `registerOAuth2Client()` at import time:

- authorization URL `https://login.microsoftonline.com/common/oauth2/v2.0/authorize`
- token URL `https://login.microsoftonline.com/common/oauth2/v2.0/token`
- no extra authorization params (the v2 endpoint returns a refresh token whenever
  `offline_access` is requested)
- scopes: `offline_access`, `User.Read`, `Files.ReadWrite`, `Files.ReadWrite.All`

The connect flow stores the profile `id` (AAD object id from `/me`) as
`ConnectedAccount.providerAccountId`; `getAccountInfo` reads the same id.

## Capabilities

The provider declares all 18 contract capabilities (catalog entry `onedrive` uses
`ALL_CAPABILITIES`); the constructor accepts a `capabilities` override for tests.
`authenticate` is declared but has no runtime method — the connect flow owns it.
Every method gates on its capability first with
`` `provider 'onedrive' does not declare capability '<name>'` `` (same wording as
`fake.ts`), plus two conditional gates:

- `uploadResumable` is required when a `resumeToken` is supplied and before the
  upload-session path (size above the simple-upload threshold), mirroring Google Drive
  and Dropbox.
- `downloadRange` is required when `input.range` is set, after `assertRange` and
  before any HTTP call.

## Root folder and path addressing

- There is **no per-account `9drive` folder**: uploads address the connected account
  root directly.
- `remoteId` is a Graph drive item id; the literal `'root'` addresses the drive root
  (`/me/drive/root`), so `getMetadata({remoteId: 'root'})` is a real request and
  `delete('root')` → `ERR_INVALID_INPUT`.
- `parentId` comes from `parentReference.id`; Graph omits the reference on root
  children, which the adapter maps to `null` (and `parentId: 'root'` normalises to
  `null` before use).
- Children are addressed by id under `/me/drive/items/{id}` and by name under
  `/children/{name}` (used for `createFolder` conflict resolution and the copy
  monitor's name fallback).

## Upload protocol

- Input validation before any HTTP call: `fileName` required and free of `/`, `.`/`..`;
  `stream` must be readable; `sizeBytes` must be a non-negative `bigint` no larger than
  `Number.MAX_SAFE_INTEGER`; non-OAuth2 credentials → `ERR_INVALID_INPUT`.
- **Simple upload** (`PUT …/children/{name}/content`) when `sizeBytes <= 4 MB`
  (`ONEDRIVE_SIMPLE_UPLOAD_THRESHOLD_BYTES`): one streamed request carrying the
  `Content-Type`; the returned item's `size` must equal `sizeBytes` or the upload fails
  `ERR_INVALID_INPUT` (no silent truncation).
- **Upload session** above that threshold **or** whenever a `resumeToken` is supplied
  (capability `uploadResumable`):
  1. `POST …/children/{name}/createUploadSession` → `uploadUrl` (Graph issues it
     pre-authenticated for anonymous PUTs). The URL is gated once with
     `assertFetchAllowed()` and the chunk PUTs never carry `Authorization`
     (`sessionPut`), matching Graph's design.
  2. Chunks are `ONEDRIVE_UPLOAD_CHUNK_BYTES` (10 MiB) — a multiple of Graph's 320 KiB
     step and well under the 60 MiB per-chunk cap. Every chunk sends
     `Content-Range: bytes start-end/total`; intermediate chunks expect `202`, the
     final chunk expects `201`/`200` with the created item.
  3. `resumeToken` = base64url `{url, off}` (see `encodeOnedriveResumeToken`); a token
     that does not decode, or whose `off >= sizeBytes`, fails `ERR_INVALID_INPUT`
     before any upload request. The first `off` bytes are dropped from the incoming
     stream (`skippedChunks`), a stream longer than `sizeBytes` fails before the
     oversize chunk is sent, and a stream that ends short fails
     `stream ended after N bytes, expected M`.
- `UploadResult.resumeToken` is always `null`: sessions complete atomically in the
  adapter (Google Drive / Dropbox parity); the opaque `{url, off}` token is accepted as
  *input* for externally recovered sessions only.

## Download

- Metadata is read first (`$select` on the item): folders → `ERR_INVALID_INPUT`,
  a range starting at/beyond `sizeBytes` (or any range on a zero-byte file) →
  `ERR_INVALID_INPUT` before the content endpoint is touched.
- `GET …/content` with `Authorization` on the first hop (`client.gatedGet`); Graph
  answers `302` (or `303`) to a pre-authenticated URL that is fetched through the same
  SSRF gate as every other upstream-supplied URL (`gatedRequest`: scheme/port/address
  checks, redirects re-gated per hop, `Authorization` dropped as soon as a redirect
  crosses the origin boundary). The body streams directly — no link is ever returned
  to the client.
- `Range` (capability `downloadRange`) is sent as a `Range` header; a `206` reply's
  `Content-Range` is parsed back into `range {start, end, total}`. If the endpoint
  ignores the header and answers `200`, the adapter reports the whole object
  (`range {0, total-1, total}`) instead of pretending the slice applied.

## Listing and search

- `list` pages `…/children` with `$select` (the `DRIVE_ITEM_SELECT` column list) and
  `$top`; `limit` defaults to 100 and is capped at 200 (`MAX_PAGE_SIZE`, Graph's `$top`
  ceiling). The cursor is the opaque `@odata.nextLink` (gated with `assertFetchAllowed`
  before reuse); items with a `deleted` facet are filtered out.
- `search()` is an extra method (not part of `StorageProvider`, Google Drive/Dropbox
  parity) gated by the `search` capability: `GET /me/drive/root/search(q='term')` with
  single quotes doubled (`o'brien` → `q='o''brien'`), same `$top`/`nextLink` paging,
  empty query → `ERR_INVALID_INPUT`. Graph's search is account-wide (no subtree
  filter); matching is Graph's own semantics, not a regex.
- Rename is `PATCH {name}` (same name → no request). Move is
  `PATCH {parentReference: {id}}`: same-parent → no-op returning existing metadata,
  a folder into itself → `ERR_INVALID_INPUT`, `newParentId: null` resolves the root id
  via `GET /me/drive/root` first, a non-folder destination → `ERR_INVALID_INPUT`.
- `createFolder` is idempotent: a 409 `nameAlreadyExists` re-resolves the child through
  `…/children/{name}` and returns the existing folder when it exists.
- Copy is `POST …/copy` → `202` + `Location` monitor, polled every
  `copyPollDelayMs` (default 200 ms) up to `copyPollAttempts` (default 30) times while
  the monitor answers `202`; a `200` carrying the item resolves immediately, an empty
  body falls back to resolving by name at the destination, and an exhausted budget →
  `ERR_TIMEOUT`. A name conflict at the destination (409) → `ERR_INVALID_INPUT`.
- Delete is `DELETE …/items/{id}`; `permanent` is accepted and ignored (Graph exposes a
  single delete path — items land in the drive's recycle bin, which has no per-item
  API here).

## Sharing (security-contract §5)

- `private` → every `link` permission on the item is deleted and the result is
  `{url: '', visibility: 'private', expiresAt: null}` (Google Drive parity: revoking
  links *is* going private).
- `public_read` → existing anonymous link permissions are reused as-is (never
  duplicated), otherwise `POST …/createLink` with `{type: 'view', scope: 'anonymous'}`
  plus `expirationDateTime` when `expiresAt` is set (normalised ISO 8601; malformed or
  past → `ERR_INVALID_INPUT` before any request).
- `revokeShare` deletes every permission that has a `link`; no link present → no-op
  (idempotent).
- Unsupported visibilities → `ERR_INVALID_INPUT`. No code path grants write access or
  auto-shares outside an explicit `createShare` call.

## Quota and health

- `getQuota` reads `GET /me/drive?$select=quota`: `total > 0` else unlimited
  (`null`), `used` → `usedBytes`, `remaining` preferred for `availableBytes`
  (else `total - used`, never negative), `deleted` → `trashBytes` (`null` when
  omitted). Arithmetic in `bigint`; the raw quota object is kept on `QuotaInfo.raw`.
- `healthCheck` pings `GET /me?$select=id`; success → `healthy`, failures go through
  `mapErrorToHealthState` (`health.ts`): 401/refresh failure → `unauthorized`,
  unreachable/timeout → `unreachable`, rate/quota/SSRF → `degraded`.

## Error mapping (contract §5)

`mapOnedriveHttpError` inspects the HTTP status and the Graph `{error: {code, message}}`
envelope (the flat variant is accepted too); the raw payload stays on
`ProviderError.detail` (including the `fromHttpStatus` fallback branch, so marker-based
detection keeps working):

| Graph signal | Code |
|---|---|
| 401; `invalidAuthenticationToken`, `unauthenticated` | `ERR_AUTH_EXPIRED` |
| 403; `accessDenied`, `authorizationfailed`, `unauthorized` | `ERR_AUTH_REVOKED` |
| 404; `itemNotFound`, `resourceNotFound`, `deletedResource` | `ERR_NOT_FOUND` |
| 429; `activityLimitReached`, `tooManyRequests`, `throttl…`, `limitExceeded`, `busy` | `ERR_RATE_LIMITED` |
| 413; `quotaExceeded`, `storageQuota`, `insufficientStorage`, `notEnoughSpace` | `ERR_QUOTA_EXCEEDED` |
| 409/412 and other 4xx (incl. `nameAlreadyExists`) | `ERR_INVALID_INPUT` |
| 5xx | `ERR_UPSTREAM_UNAVAILABLE` |
| timeout socket codes (`ETIMEDOUT`, `UND_ERR_*_TIMEOUT`, `UND_ERR_ABORTED`, …) | `ERR_TIMEOUT` |
| connection codes (`ENOTFOUND`, `ECONNREFUSED`, `ECONNRESET`, …) | `ERR_UPSTREAM_UNAVAILABLE` |

`mapOnedriveTransportError` passes `ProviderError`s through untouched (so
`ERR_SSRF_BLOCKED`/`ERR_INVALID_INPUT` keep their code). `isOnedriveConflictError`
(409 or a conflict marker) is what drives `createFolder`'s return-existing path.

## Refresh behaviour

`OnedriveClient` sends `Authorization: Bearer …`, retries a 401 exactly once after
`session.renew()` returns `true`, and only replays bodies that are replayable (JSON
payloads, never upload streams — a 401 on the simple-upload content PUT is *not*
replayed from the consumed stream). `renew()` returns `false` without a refresh
token/client id/secret, so the 401 maps to `ERR_AUTH_EXPIRED`. The token request uses
`transport.tokenUrl` and never logs the refresh token.

## Timeouts

JSON calls: 30 s (`JSON_TIMEOUT_MS`); uploads (content PUT, session chunks) and
downloads (content + redirect hops): 15 min (`TRANSFER_TIMEOUT_MS`), enforced through
undici `headersTimeout`/`bodyTimeout` plus the caller's `ctx.signal` (the copy monitor's
sleep honours the signal too). Errors map to `ERR_TIMEOUT`.

## Rate limits and platform limits

- Microsoft Graph publishes per-tenant/app throttling (429 + `Retry-After`,
  `activityLimitReached`); the adapter surfaces `ERR_RATE_LIMITED` immediately and never
  retries internally — callers and job backoff (`job-contract.md`) own the pacing. There
  is no internal retry except the single 401 refresh replay.
- Simple uploads are capped at 4 MB per request by Graph (250 MB for large-file PUT
  sessions under newer limits, but the adapter uses `createUploadSession` for anything
  above 4 MB, which stays within published caps).
- `pageSize` is capped at 200 (`MAX_PAGE_SIZE`), default 100.

## Limitations (official API / v1 scope)

- **No permanent delete**: `delete(permanent)` is accepted and ignored — Graph moves
  items to the drive's recycle bin; purging a specific item is not exposed.
- **Search is account-wide**: `search(q=…)` has no "only under this folder" filter and
  the adapter fetches one Graph page per call (continuations go through the `nextLink`
  cursor), while `list` remains the subtree operation.
- **Copy is asynchronous**: the `202` monitor is polled in-process; a copy that exceeds
  the polling budget fails `ERR_TIMEOUT` (the item may still finish upstream).
- **Share settings are minimal**: only `type: 'view'` + `scope: 'anonymous'` +
  optional `expirationDateTime`; an expiry cannot be *changed* after creation —
  `createShare` returns the existing link as-is when one already exists.
- **No mid-session resume tokens**: failures inside an upload session do not surface a
  `resumeToken` (`UploadResult.resumeToken` stays `null`); `resumeToken` input is still
  honoured (opaque `{url, off}`) for externally recovered sessions.
- **Folders synthesise their mime type**: Graph has no mime type on the `folder` facet,
  so folder metadata reports `inode/directory` (Google Drive parity); files report the
  `file.mimeType` facet (default `application/octet-stream`).
- **Quota values are JSON numbers**: Graph quota fields are integers within
  `Number.MAX_SAFE_INTEGER`; the adapter still does the arithmetic in `bigint`.

## Test transport seam

Production traffic is pinned to `https://graph.microsoft.com/v1.0` and
`https://login.microsoftonline.com/common/oauth2/v2.0/token`. Tests call
`setOnedriveTransport({ graphUrl, tokenUrl })` (exported from `transport.ts`) to point
the adapter at a local fake Graph server; `resetOnedriveTransport()` restores the
defaults. The override is a module-level seam never derived from user input, so it adds
no SSRF surface (security-contract §7).

Account-supplied endpoints (`ctx.account.config` `graphBaseUrl`/`baseUrl`) are user
input: they run through the full SSRF gate (`assertFetchAllowed`) before use. Every
upstream-supplied URL — upload session `uploadUrl`, `@odata.nextLink`, download
redirects, copy monitor `Location` — is gated per use.

## Registration

`registerOnedriveProvider()` (and the `onedriveProvider` singleton) exist for the
coordinator to wire into `providers/index.ts`; `oauth2.ts` self-registers its
`OAuth2ClientConfig` on import. Catalog parity is asserted in `onedrive.auth.test.ts`
(declared capabilities === catalog `ALL`, incl. `search: supported === true`).
