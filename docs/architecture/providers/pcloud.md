# pCloud adapter

`backend/src/providers/pcloud/**` — the `SUPPORTED` `pcloud` adapter from
`provider-contract.md` §11 (docs.pcloud.com).

| File | Role |
|---|---|
| `index.ts` | `PcloudProvider implements StorageProvider`, `pcloudProvider`, `createPcloudProvider()`, `registerPcloudProvider()`, `PCLOUD_CAPABILITIES`, upload/download/list/search/share logic |
| `oauth2.ts` | `PCLOUD_OAUTH_CLIENT` + `PCLOUD_AUTHORIZATION_URL`/`PCLOUD_TOKEN_URL` + self-registration on import |
| `client.ts` | `PcloudClient` — GET JSON calls with `access_token` in the query, envelope `{result}` checks, 401 refresh retry, `upload()` (raw PUT), `gatedRequest()` for upstream-supplied URLs, timeouts |
| `errors.ts` | pCloud result codes and HTTP statuses → security-contract/provider-contract §5 taxonomy |
| `transport.ts` | API base + token URL + CDN scheme seam (`setPcloudTransport`), `pcloudUrl()`, `pcloudCdnUrl()` |

The adapter is exported through `providers/index.ts` by the coordinator; this agent owns
only the directory above, its tests (`backend/src/__tests__/**/pcloud/**`) and this
document.

## Auth setup

1. Sign in at [my.pcloud.com](https://my.pcloud.com) and open **Developer App**
   (`my.pcloud.com/developer`) to create an app (app key + app secret).
2. Add the provider-neutral redirect URI
   `<9drive origin>/connected-accounts/pcloud/callback`
   (`provider-contract.md` §8) to the app's allowed redirect URLs.
3. Copy the app key/secret into the OAuth client config this deployment reads
   (`oauth2.ts`).

`oauth2.ts` registers the config with `registerOAuth2Client()` at import time:

- authorization URL `https://my.pcloud.com/oauth2/authorize`
- token URL `https://api.pcloud.com/oauth2_token` (note: `oauth2_token`, not
  `oauth2/token`)
- **no scope parameter** — pCloud's authorize page takes none and the app receives full
  access; `scopes: []` and the shared `buildAuthorizationUrl()` omits `scope`
- no extra authorization/token params

Token responses carry `{result: 0, access_token, token_type: 'bearer', uid}` and nothing
else: **no `expires_in`, no refresh token**. The adapter therefore stores
`expiresAt: null`, `renew()` never has refresh material and always returns `false`, and
the connect flow persists `uid` as `ConnectedAccount.providerAccountId`
(`getAccountInfo` reads the same `userid`).

**EU accounts**: the authorize response redirects to
`…/callback?hostname=eapi.pcloud.com` for EU accounts, and every subsequent API call
must use `eapi.pcloud.com` instead of `api.pcloud.com`. The account's `apiBaseUrl`
config key (see *Test transport seam*) is the storage for that hostname. The shared
connect callback currently persists only `code`/`state`, so the coordinator must extend
it to persist `hostname` before EU accounts work end to end — reported as a wiring item.

## Capabilities

The adapter declares all 18 contract capabilities **except `uploadResumable`** (17 —
`PCLOUD_CAPABILITIES`); the constructor accepts a `capabilities` override for tests.
`authenticate` is declared but has no runtime method — the connect flow owns it.
Every method gates on its capability first with
`` `provider 'pcloud' does not declare capability '<name>'` ``, plus two conditional
gates:

- `uploadResumable` is required when a `resumeToken` is supplied (before any request) —
  and pCloud never declares it, so `resumeToken` input always fails
  `ERR_CAPABILITY_UNSUPPORTED`.
- `downloadRange` is required when `input.range` is set, after `assertRange` and before
  any HTTP call.

The `pcloud` catalog entry currently advertises capabilities `ALL`; the adapter's real
surface is 17 caps. The divergence is asserted as such in `pcloud.auth.test.ts` and
reported to the coordinator (catalog correction).

## Root folder and path addressing

- There is **no per-account `9drive` folder**: uploads address the connected account
  root (`folderid=0`) directly.
- `remoteId` is pCloud's own metadata id: `f<fileid>` / `d<folderid>`, with the literal
  aliases `root` and `d0` for the root folder. `delete('root')`/`delete('d0')` →
  `ERR_INVALID_INPUT`.
- `parentId` input accepts `null`/`'root'`/`'d0'` (→ `folderid=0`) or a folder
  `remoteId`; a file `parentId` → `ERR_INVALID_INPUT`. Metadata `parentfolderid: 0`
  maps back to `parentId: null`.
- **`stat` is files-only** (1004/2009 for folders): `getMetadata` resolves files through
  `stat` and folders (including root) through `listfolder`.

## Upload protocol

- Input validation before any HTTP call: `fileName` required and free of `/`, `.`/`..`;
  `stream` must be readable; `sizeBytes` must be a non-negative `bigint` no larger than
  `Number.MAX_SAFE_INTEGER`; non-OAuth2 credentials → `ERR_INVALID_INPUT`.
- **`PUT uploadfile`** with the raw stream as the body and `folderid`, `filename` and
  `nopartial=1` in the query string, `Content-Type` from `input.mimeType` (default
  `application/octet-stream`). pCloud has no partial-upload/resumable session API on
  this path — one streamed attempt, no internal replay (a failed stream cannot be
  re-sent), 15-minute transfer timeout.
- An existing file with the same name is **overwritten in place** (same `fileid`),
  which matches upload semantics elsewhere; a *folder* with that name → 2004 →
  `ERR_INVALID_INPUT`.
- The response `metadata[0]` yields `remoteId`/`sizeBytes`; if only `fileids[0]`
  returns, the adapter synthesises `f<id>` and trusts the declared `sizeBytes`.
  `UploadResult.resumeToken` is always `null`.

## Download

- Metadata is read first (`stat`): folders → `ERR_INVALID_INPUT`, a range starting at/beyond
  `sizeBytes` (or any range on a zero-byte file) → `ERR_INVALID_INPUT` before the link
  endpoint is touched.
- `getfilelink?forcedownload=1` returns `hosts[]` + `path`; the adapter takes
  `hosts[0]` and builds the CDN URL through `pcloudCdnUrl()` (scheme from the transport
  seam) and fetches it through the same SSRF gate as every other upstream-supplied URL
  (`gatedRequest`: scheme/port/address checks, redirects re-gated, no credentials cross
  the origin). The body streams directly — no link is ever returned to the client.
- `Range` (capability `downloadRange`) is sent as a `Range` header; a `206` reply's
  `Content-Range` is parsed back into `range {start, end, total}`. If the CDN ignores
  the header and answers `200`, the adapter reports the whole object
  (`range {0, total-1, total}`) instead of pretending the slice applied. A CDN `404`
  maps to `ERR_NOT_FOUND` through `fromHttpStatus`.
- `expires` on the link is advisory; the adapter does not cache links between calls.

## Listing and search

- `list` calls `listfolder?folderid=…` and pages **client-side**: pCloud's
  `listfolder` has no server-side paging, so each cursor re-fetches the folder and
  slices it with an opaque offset cursor (`encodeOffsetCursor`/`decodeOffsetCursor`).
  `limit` defaults to 100 and is capped at 1000 (`MAX_PAGE_SIZE`). Deleted entries are
  excluded by the upstream response.
- `search()` is an extra method (not part of `StorageProvider`, Google Drive/Dropbox/
  OneDrive parity) gated by the `search` capability: pCloud exposes **no search API**,
  so the adapter walks `listfolder?recursive=1` from the root, filters names
  case-insensitively in process, and pages the matches with the same offset cursors —
  an O(tree) re-walk per page (documented caveat). Empty query → `ERR_INVALID_INPUT`.
- Rename is `renamefile`/`renamefolder` with `toname` (same name → no request).
  Move is the *same* endpoint with `tofolderid` (same parent → no-op returning existing
  metadata, folder into itself → `ERR_INVALID_INPUT`, folder into its own descendant →
  2043 → `ERR_INVALID_INPUT`, missing destination → 2005 → `ERR_NOT_FOUND`).
- `createFolder` is idempotent: 2004 (exists) re-resolves the child through
  `listfolder` and returns the existing folder when found.
- Copy is `copyfile`/`copyfolder` with `noover=1`: a destination name conflict fails
  2004 → `ERR_INVALID_INPUT` instead of silently replacing (contract parity with the
  other adapters). Folder copy is synchronous and recursive; self/descendant copies →
  2206/2207 → `ERR_INVALID_INPUT`.
- Delete: files → `deletefile` (recoverable trash). Folders → `deletefolder` (trash);
  the non-empty answer (2006) falls back to `deletefolderrecursive`. `permanent: true`
  skips the trash attempt and calls `deletefolderrecursive` directly. Root guard →
  `ERR_INVALID_INPUT`.

## Sharing (security-contract §5)

- `private` → every public link on the item is deleted (`listpublinks` filtered by the
  item's metadata id, then `deletepublink`) and the result is
  `{url: '', visibility: 'private', expiresAt: null}` (Google Drive/OneDrive parity:
  revoking links *is* going private). Already link-free → same result (idempotent).
- `public_read` → `getfilepublink`/`getfolderpublink` with `expire` in RFC 2822 with a
  numeric offset (`Wed, 02 Oct 2013 14:29:11 +0000`) when `expiresAt` is set; malformed
  or past → `ERR_INVALID_INPUT` before any request. The response `link` is returned
  verbatim; the echoed `expires` is normalised to ISO 8601.
- `revokeShare` deletes every public link matching the item's id; no link present →
  no-op (idempotent), and an already-deleted link (2027) counts as success.
- Unsupported visibilities → `ERR_INVALID_INPUT`. No code path grants write access or
  auto-shares outside an explicit `createShare` call; root shares upstream → 2015 →
  `ERR_INVALID_INPUT`.

## Quota and health

- `getQuota` reads `userinfo`: `quota` → `totalBytes` (`null` when the field is absent
  = unlimited), `usedquota` → `usedBytes`, `availableBytes = max(0, total - used)`,
  `trashBytes` is `null` (userinfo reports no trash total). Arithmetic in `bigint`;
  values are JSON numbers or digit strings (both accepted, 2^53-safe), and the raw
  payload is kept on `QuotaInfo.raw`.
- `healthCheck` pings `userinfo`; success → `healthy` with latency/timestamp, failures
  go through `mapErrorToHealthState` (`health.ts`): result 1000/2000 → `ERR_AUTH_EXPIRED`
  → `unauthorized`, unreachable/timeout → `unreachable`, rate/quota/SSRF → `degraded`.

## Error mapping (contract §5)

pCloud answers HTTP 200 with a `{result: <code>}` envelope, so `mapPcloudResultError`
keys on the **result code** (docs.pcloud.com/errors plus every per-method table this
adapter calls); the payload stays on `ProviderError.detail` (`pcloudResultOf` recovers
it). Plain non-2xx HTTP goes through the shared `fromHttpStatus` re-wrapped with the
status and detail.

| pCloud signal | Code |
|---|---|
| `1000`, `2000` (login required/failed) | `ERR_AUTH_EXPIRED` |
| `2003` (access denied) | `ERR_INVALID_INPUT` (see taxonomy note) |
| `2008` (over quota) | `ERR_QUOTA_EXCEEDED` |
| `1017`, `2002`, `2005`, `2009`, `2027`, `2208` | `ERR_NOT_FOUND` |
| `1013`, `2001`, `2004`, `2006`, `2007`, `2010`, `2011`, `2014`, `2015`, `2023`, `2026`, `2028`, `2042`, `2043`, `2119`, `2206`, `2207` | `ERR_INVALID_INPUT` |
| `1900–1999` (sync between API servers) | `ERR_UPSTREAM_UNAVAILABLE` (retryable) |
| other `1xxx` (API client misbehaved) | `ERR_INTERNAL` |
| other `2xxx`, `3xxx` | `ERR_INVALID_INPUT` |
| `4xxx` (rate limiting) | `ERR_RATE_LIMITED` |
| `5xxx` (internal) | `ERR_UPSTREAM_UNAVAILABLE` |
| `6xxx` / unknown | `ERR_INTERNAL` |
| HTTP 401 / 403 / 404 / 409 / 413 / 429 / 5xx / other 4xx | `ERR_AUTH_EXPIRED` / `ERR_AUTH_REVOKED` / `ERR_NOT_FOUND` / `ERR_INVALID_INPUT` / `ERR_QUOTA_EXCEEDED` / `ERR_RATE_LIMITED` / `ERR_UPSTREAM_UNAVAILABLE` / `ERR_INVALID_INPUT` |
| timeout codes (`ETIMEDOUT`, `UND_ERR_*_TIMEOUT`, abort) | `ERR_TIMEOUT` |
| connection codes (`ENOTFOUND`, `ECONNREFUSED`, `ECONNRESET`, …) | `ERR_UPSTREAM_UNAVAILABLE` |

Taxonomy note: pCloud has no dedicated *permission denied* code and contract §5 has no
permission bucket — `2003` maps to `ERR_INVALID_INPUT`, which fails the job fast without
suggesting that re-authorising could fix it.

Helpers: `isPcloudConflictError` (2004) drives `createFolder`'s return-existing path;
`isPcloudNotEmptyError` (2006) drives the delete fallback; `mapPcloudTransportError`
passes `ProviderError`s through untouched (so `ERR_SSRF_BLOCKED`/`ERR_INVALID_INPUT`
keep their code).

## Refresh behaviour

`PcloudClient` sends the token as an `access_token` **query parameter** (pCloud's
documented transport — not an `Authorization` header), retries a 401 exactly once after
`session.renew()` returns `true`, and only replays bodies that are replayable (JSON
payloads, never upload streams). Permanent pCloud tokens carry no refresh material, so
`renew()` returns `false` without calling anything and the 401 maps to
`ERR_AUTH_EXPIRED`. Tokens are never logged.

## Timeouts

JSON calls: 30 s (`JSON_TIMEOUT_MS`); uploads (`uploadfile` PUT) and downloads (CDN
fetch): 15 min (`TRANSFER_TIMEOUT_MS`), enforced per request alongside the caller's
`ctx.signal`. Errors map to `ERR_TIMEOUT`.

## Rate limits and platform limits

- The `4xxx` category is pCloud's rate limiting; the adapter surfaces
  `ERR_RATE_LIMITED` immediately and never retries internally — callers and job backoff
  (`job-contract.md`) own the pacing. The only internal retry anywhere is the single
  401 refresh replay.
- `list`/`search` `pageSize` is capped at 1000 (`MAX_PAGE_SIZE`), default 100.
- Uploads use `nopartial=1`; there is no chunked/resumable path to size-escalate into.

## Limitations (official API / v1 scope)

- **No resumable upload**: `uploadResumable` is not declared; `resumeToken` input fails
  `ERR_CAPABILITY_UNSUPPORTED`, and `UploadResult.resumeToken` is always `null`.
- **No server-side paging**: `listfolder` has no offset/continuation parameters, so
  every cursor re-downloads the whole folder (client-side slicing).
- **No search API**: `search` walks the entire tree per page (O(tree)); there is no
  upstream relevance ranking or subtree filter.
- **No recursive trash**: pCloud's trash (`deletefolder`) refuses non-empty folders, and
  no recursive variant exists — a non-empty delete falls back to
  `deletefolderrecursive` (permanent purge) even when `permanent` is false.
- **No permission-denied code**: `2003` → `ERR_INVALID_INPUT` (taxonomy note above).
- **`hash` is never exposed**: metadata `hash` exceeds `Number.MAX_SAFE_INTEGER` and
  would be corrupted by `JSON.parse`, so `RemoteFileMeta.checksum` is always `null`.
- **Timestamps are RFC 2822 upstream** (`Wed, 02 Oct 2013 14:29:11 +0000`) and
  normalised to ISO 8601 in the adapter; malformed values become `null`.
- **Permanent tokens never expire**: revocation happens only at pcloud.com; there is no
  refresh flow to detect it before the next call does.
- **EU hostname is not persisted yet**: the authorize callback carries `hostname`, but
  the shared callback only stores `code`/`state` (coordinator wiring item above).
- **Catalog/contract errata to report**: the `pcloud` catalog entry claims capabilities
  `ALL` (real: 17, no `uploadResumable`), and provider-contract §11's `writefile`/
  `savefile` column is not pCloud API — uploads are `PUT uploadfile`; `listfolder` has
  no paging parameters.

## Test transport seam

Production traffic is pinned to `https://api.pcloud.com` and
`https://api.pcloud.com/oauth2_token`. Tests call
`setPcloudTransport({ apiUrl, tokenUrl, cdnScheme })` (exported from `transport.ts`) to
point the adapter at a local fake pCloud server — including `cdnScheme: 'http'`, which
lets the fake serve `getfilelink` downloads over plain HTTP — and
`resetPcloudTransport()` restores the defaults. The override is a module-level seam
never derived from user input, so it adds no SSRF surface (security-contract §7).

Account-supplied endpoints (`ctx.account.config` `apiBaseUrl`/`apiUrl` and `tokenUrl`)
are user input: they run through the full SSRF gate (`assertFetchAllowed`) before use —
this is where an EU account's `eapi.pcloud.com` base URL goes. Every upstream-supplied
URL — `getfilelink` `hosts[]`/`path` (CDN download) — is gated per use.

## Registration

`registerPcloudProvider()` (and the `pcloudProvider` singleton) exist for the
coordinator to wire into `providers/index.ts`; `oauth2.ts` self-registers its
`OAuth2ClientConfig` on import. Tests assert the adapter's real 17-capability surface
explicitly rather than catalog equality (see *Capabilities*), plus the no-scope
authorization URL, the token exchange against a fake `oauth2_token` endpoint
(`expiresAt: null`), health states, and the full result-code error table.
