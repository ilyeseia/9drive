# Dropbox adapter

`backend/src/providers/dropbox/**` — the `SUPPORTED` `dropbox` adapter from
`provider-contract.md` §11.

| File | Role |
|---|---|
| `index.ts` | `DropboxProvider implements StorageProvider`, `dropboxProvider`, `createDropboxProvider()`, `registerDropboxProvider()`, `encodeDropboxResumeToken()`/`decodeDropboxResumeToken()`, upload/download/list/search/share logic |
| `oauth2.ts` | `DROPBOX_OAUTH_CLIENT` + scopes + self-registration on import |
| `client.ts` | `DropboxClient` — undici `request()` JSON/content calls, auth header, 401 refresh retry, `gatedRequest()` for temporary links, timeouts |
| `errors.ts` | Dropbox `error_summary` → security-contract/provider-contract §5 taxonomy |
| `transport.ts` | API/content/token URL seam (`setDropboxTransport`), `dropboxUrl()` |

The adapter is exported through `providers/index.ts` by the coordinator; this agent owns
only the directory above, its tests (`backend/src/__tests__/**/dropbox/**`) and this
document.

## Auth setup

1. In the [Dropbox App Console](https://www.dropbox.com/developers/apps) create an app.
2. Choose **Scoped access** (the adapter uses granular scopes, not the deprecated
   permission strings) and a **Development** or **Full Dropbox** access type.
3. **Permissions** tab: enable exactly the scopes listed below and **Submit** (scoped
   apps reject tokens issued with undeclared scopes).
4. **Settings → Redirect URIs**: add the provider-neutral connect callback
   `<9drive origin>/connected-accounts/dropbox/callback`
   (`provider-contract.md` §8: `GET /connected-accounts/:provider/connect-url` →
   `GET /connected-accounts/:provider/callback`).
5. Copy the app key/secret into the OAuth client config the connect flow reads
   (`oauth2.ts` config for this deployment).

`oauth2.ts` registers the config with `registerOAuth2Client()` at import time:

- authorization URL `https://www.dropbox.com/oauth2/authorize`
- token URL `https://api.dropboxapi.com/oauth2/token`
- authorization param `token_access_type=offline` (long-lived refresh token)
- scopes:
  `account_info.read`, `files.metadata.read`, `files.metadata.write`,
  `files.content.read`, `files.content.write`, `sharing.read`, `sharing.write`

The connect flow stores Dropbox's `account_id` as `ConnectedAccount.providerAccountId`;
`getAccountInfo` reads the same id from `users/get_current_account`.

## Capabilities

The provider declares all 18 contract capabilities (catalog entry `dropbox` uses
`ALL_CAPABILITIES`); the constructor accepts a `capabilities` override for tests.
`authenticate` is declared but has no runtime method — the connect flow owns it.
Every method gates on its capability first with
`` `provider 'dropbox' does not declare capability '<name>'` `` (same wording as
`fake.ts`), plus two conditional gates:

- `uploadResumable` is required when a `resumeToken` is supplied and before the
  upload-session path (size above the simple-upload threshold), mirroring Google Drive.
- `downloadRange` is required when `input.range` is set, before any HTTP call.

## Root folder and path addressing

- There is **no per-account `9drive` folder** (unlike Google Drive): uploads address the
  connected account root directly.
- `remoteId` is a Dropbox file id (`id:…`). The root is addressed by the literal id
  `'root'` or `parentId: null` / `''` / whitespace; `files/get_metadata` refuses the
  root path, so `getMetadata({remoteId: 'root'})` is synthesised locally
  (`rootFolderMeta()`), and `delete('root')` → `ERR_INVALID_INPUT`.
- Dropbox metadata carries no parent id: `#toMeta` derives `parentId` from
  `path_display` with one extra `files/get_metadata` on the parent path (root children →
  `null`). `list` skips that lookup by passing the requested `parentId` down, so listing
  stays one call per page.

## Upload protocol

- Input validation before any HTTP call: `fileName` required and free of `/`, `.`/`..`;
  `stream` must be readable; `sizeBytes` must be a non-negative `bigint` no larger than
  `Number.MAX_SAFE_INTEGER`; non-OAuth2 credentials → `ERR_INVALID_INPUT`.
- The target path is resolved per call (`files/get_metadata` on the parent folder) and
  uploads always use `mode: 'overwrite'` with `autorename: false` — re-uploading the
  same name replaces the file in place (no silent ` (1)` copies).
- **Simple upload** (`files/upload`) when `sizeBytes <= 150 MB`
  (`DROPBOX_SIMPLE_UPLOAD_THRESHOLD_BYTES`): one streamed request carrying the
  `Content-Type`; a stream shorter/longer than `sizeBytes` fails `ERR_INVALID_INPUT`.
- **Upload session** above that threshold **or** whenever a `resumeToken` is supplied
  (capability `uploadResumable`):
  1. `upload_session/start` with the first chunk, then `upload_session/append_v2`
     (`cursor: {session_id, offset}`) per chunk, then `upload_session/finish` with the
     `cursor` and the commit `{path, mode: 'overwrite', autorename: false}`.
  2. Chunks are `DROPBOX_UPLOAD_CHUNK_BYTES` (8 MiB) — a multiple of Dropbox's 4 MiB
     minimum and well under the 150 MiB per-request cap.
  3. `resumeToken` = base64url `{sid, off}` (see `encodeDropboxResumeToken`); a token
     that does not decode, or whose `offset` is beyond `sizeBytes`, fails with
     `ERR_INVALID_INPUT` before any upload request. The offset bytes are skipped from
     the incoming stream (`skipBytes`), and the byte totals are checked against
     `sizeBytes` — a mismatch → `ERR_INVALID_INPUT` (the session is abandoned, not
     committed).
- `UploadResult.resumeToken` is always `null`: Dropbox finishes sessions atomically and
  the adapter never surfaces a half-uploaded session to callers (Google Drive parity).

## Download

- Folders → `ERR_INVALID_INPUT` (metadata tag check after `files/get_temporary_link`;
  Dropbox itself also answers `path/is_a_folder`).
- `files/get_temporary_link` returns a URL valid for a few hours; the adapter fetches it
  through the same SSRF gate as every other request (`gatedRequest`: scheme/port/address
  checks, redirects re-gated per hop) and streams the body directly. No link is ever
  returned to the client — downloads are streams only.
- `Range` (capability `downloadRange`) is sent as a `Range` header; a `206` reply's
  `Content-Range` is parsed back into `range {start, end, total}`. If the link ignores
  the header and answers `200`, the adapter reports the whole object
  (`range {0, total-1, total}`) instead of pretending the slice applied.
- A range starting beyond the object (or any range on a zero-byte file) →
  `ERR_INVALID_INPUT`, checked against the metadata size before the link is fetched.

## Listing and search

- `list` pages with `files/list_folder` + `files/list_folder/continue`; the Dropbox
  cursor is passed through opaquely as `nextCursor`. `limit` defaults to 100 and is
  capped at 1000 (`MAX_PAGE_SIZE`); the adapter fills the page across upstream calls and
  stops on a page that yields no entries. Entries that are neither `file` nor `folder`
  are skipped.
- `search()` is an extra method (not part of `StorageProvider`, Google Drive parity)
  gated by the `search` capability: `files/search_v2` for the first page (sizes the page
  through `options.max_results`), `files/search/continue_v2` afterwards; empty query →
  `ERR_INVALID_INPUT`. `MetadataV2` wrappers are unwrapped (the bare shape is accepted
  too), non file/folder matches are dropped, and each match resolves its parent id with
  one `files/get_metadata` on the parent path.
- Rename/move/copy are `files/move_v2` / `files/copy_v2` with `autorename: false`;
  a name conflict (409 `path/conflict`) → `ERR_INVALID_INPUT`. `move` into the current
  parent (or root → root) is a no-op that returns the existing metadata; moving a folder
  into itself → `ERR_INVALID_INPUT`. `createFolder` is idempotent: a
  `path/conflict`/`already_exists` failure re-resolves the path and returns the existing
  folder.

## Sharing (security-contract §5)

- Only `public_read` is accepted; `private` (and anything else) → `ERR_INVALID_INPUT`
  — Dropbox sharing is link-based, there is no "shared with this account only" link, so
  9Drive never pretends to create one. Revoking (deleting the link) is the way back to
  private.
- `createShare` calls `sharing/create_shared_link_with_settings` with an optional
  `settings.expires` (normalised ISO 8601; malformed or past → `ERR_INVALID_INPUT`).
  A `shared_link_already_exists` failure re-reads the existing link through
  `sharing/list_shared_links` and returns it instead of failing.
- `revokeShare` lists the link and calls `sharing/revoke_shared_link`; no link present →
  no-op (idempotent).
- No code path grants write access or auto-shares outside an explicit `createShare` call.

## Quota and health

- `getQuota` reads `users/get_space_usage`; `allocation.individual.allocated` (or
  `team.allocated`) is the limit, all arithmetic in `bigint`, no allocation → unlimited
  (`null`), `availableBytes` never negative, `trashBytes: null` (Dropbox reports no
  separate trash total).
- `healthCheck` pings `users/get_current_account`; success → `healthy`, failures go
  through `mapErrorToHealthState` (`health.ts`): 401/refresh failure → `unauthorized`,
  unreachable/timeout → `unreachable`, rate/quota/SSRF → `degraded`.

## Error mapping (contract §5)

`mapDropboxHttpError` inspects the HTTP status and the Dropbox `error_summary`
(`reason/subreason/detail`); the raw payload stays on `ProviderError.detail` (including
the `fromHttpStatus` fallback branch, so summary-based detection keeps working):

| Dropbox signal | Code |
|---|---|
| `revoked` | `ERR_AUTH_REVOKED` |
| `expired_access_token`, `invalid_access_token` | `ERR_AUTH_EXPIRED` |
| `not_found`, `unavailable_path`, `lookup_failed` | `ERR_NOT_FOUND` |
| `rate_limit…`, `too_many_write_operations`, `throttl…`, `busy`, `concurrency`; 429 | `ERR_RATE_LIMITED` |
| `insufficient_space`, `no_space`; 413 | `ERR_QUOTA_EXCEEDED` |
| 401 | `ERR_AUTH_EXPIRED` |
| 403 | `ERR_AUTH_REVOKED` |
| 404 | `ERR_NOT_FOUND` |
| 409/412 and other 4xx (incl. `path/conflict…`) | `ERR_INVALID_INPUT` |
| 5xx | `ERR_UPSTREAM_UNAVAILABLE` |
| timeout socket codes (`ETIMEDOUT`, `UND_ERR_*_TIMEOUT`, …) | `ERR_TIMEOUT` |
| connection codes (`ENOTFOUND`, `ECONNRESET`, …) | `ERR_UPSTREAM_UNAVAILABLE` |

`mapDropboxTransportError` passes `ProviderError`s through untouched (so
`ERR_SSRF_BLOCKED`/`ERR_INVALID_INPUT` keep their code).

## Refresh behaviour

`DropboxClient` sends `Authorization: Bearer …`, retries a 401 exactly once after
`session.renew()` returns `true`, and only replays bodies that are replayable (JSON
payloads, never upload streams). `renew()` returns `false` without a refresh
token/client id/secret, so the 401 maps to `ERR_AUTH_EXPIRED`. The token request uses
`transport.tokenUrl` and never logs the refresh token.

## Timeouts

JSON calls: 30 s (`JSON_TIMEOUT_MS`); uploads (all session calls) and link downloads:
15 min (`TRANSFER_TIMEOUT_MS`), enforced through undici `headersTimeout`/`bodyTimeout`
plus the caller's `ctx.signal`. Errors map to `ERR_TIMEOUT`.

## Rate limits and platform limits

- Dropbox publishes per-app rate limits (calls/minute and calls/day) and returns 429 or
  `too_many_write_operations` (sometimes with 503) when exceeded; the adapter surfaces
  `ERR_RATE_LIMITED` immediately and never retries internally — callers and job backoff
  (`job-contract.md`) own the pacing. There is no internal retry except the single 401
  refresh replay.
- Temporary links expire upstream (Dropbox reissues on every download call, so this only
  matters for a stalled stream — the caller restarts the download).
- `pageSize` is capped at 1000 (`MAX_PAGE_SIZE`), default 100.

## Limitations (official API / v1 scope)

- **No permanent delete**: `delete(permanent)` is accepted and ignored — Dropbox only
  offers the recoverable deleted-files trash (`files/delete_v2`); there is no purge API.
- **Search is account-wide**: `files/search_v2` has no "only under this folder" filter,
  so `search()` matches names across the whole account while `list` remains the subtree
  operation. Matching is Dropbox's own semantics (name + content), not a regex.
- **No `webUrl`**: Dropbox metadata carries no preview URL, so `RemoteFileMeta.webUrl`
  is `null`; use `createShare` for a link.
- **Share settings are minimal**: only `settings.expires` is set (audience, password and
  download-only toggles are not exposed); an expiry cannot be *changed* after creation —
  `createShare` returns the existing link as-is when one already exists.
- **No mid-session resume tokens**: failures inside an upload session discard the
  Dropbox session id (`UploadResult.resumeToken` stays `null`); a caller restarts the
  upload from scratch. `resumeToken` input is still honoured (opaque `{sid, off}`) for
  externally recovered sessions.
- **Parent ids are path-derived**: a `files/get_metadata` per standalone lookup (search
  matches, `getMetadata`) — unavoidable with Dropbox's metadata shape.

## Test transport seam

Production traffic is pinned to `https://api.dropboxapi.com/2`,
`https://content.dropboxapi.com/2` and `https://api.dropboxapi.com/oauth2/token`. Tests call
`setDropboxTransport({ apiUrl, contentUrl, tokenUrl })` (exported from `transport.ts`)
to point the adapter at a local fake Dropbox server; `resetDropboxTransport()` restores
the defaults. The override is a module-level seam never derived from user input, so it
adds no SSRF surface (security-contract §7).

Account-supplied endpoints (`ctx.account.config` `apiBaseUrl`/`apiUrl`,
`contentBaseUrl`/`contentUrl`) are user input: they run through the full SSRF gate
(`assertFetchAllowed`) before use.

## Registration

`registerDropboxProvider()` (and the `dropboxProvider` singleton) exist for the
coordinator to wire into `providers/index.ts`; `oauth2.ts` self-registers its
`OAuth2ClientConfig` on import. Catalog parity is asserted in `dropbox.auth.test.ts`
(declared capabilities === catalog `ALL`, incl. `search: supported === true`).
