# TeraBox adapter

`backend/src/providers/terabox/**` — the `SUPPORTED` `terabox` adapter from
`provider-contract.md` §11. The API is reverse-engineered (TeraBox exposes no
official self-serve surface), so request shapes live in §4 and every quirk is
called out where it diverges from the other adapters.

| File | Role |
|---|---|
| `index.ts` | `TeraBoxProvider implements StorageProvider`, `teraboxProvider`, `createTeraBoxProvider()`, `registerTeraBoxProvider()`, `TERABOX_CAPABILITIES`, path helpers (`tbPath`, `parentOf`), upload/download/list/search/file-operation logic |
| `client.ts` | `TeraBoxClient` — undici `request()` with cookie auth, app query, jsToken acquisition, regional base switch, `{ errno }` checking, `gatedDownload()` (SSRF-gated dlink fetch), `buildMultipartBody()`, `normalizeTeraBoxCookie()` |
| `transport.ts` | Pinned production endpoints (`TERABOX_BASE_URL`, `TERABOX_UPLOAD_HOST`), desktop fingerprint (`TERABOX_USER_AGENT`, `TERABOX_APP_QUERY`), test seam (`setTeraBoxTransport`/`resetTeraBoxTransport`), hostname validators (`isTeraboxHostname`, `regionBaseUrl`, `uploadHostUrl`) |
| `sign.ts` | `signDownload()` (RC4-style dlink signature), `extractJsToken()` (SPA shell scrape), `decodeMd5()`/`controlMd5()` (whole-file md5 verification) |
| `errors.ts` | errno/HTTP/transport → security-contract/provider-contract §5 taxonomy, `TOKEN_REFRESH_ERRNOS`, `isTeraBoxConflict()`/`isTeraBoxAuthError()` |

The adapter is exported through `providers/index.ts` by the coordinator; this
document owns only the directory above, its tests
(`backend/src/__tests__/providers/terabox/**`) and this file.

## 1. Auth setup

TeraBox has no OAuth flow: the adapter authenticates with the **web session
cookie** and declares `authMode: 'api_key'` (the contract's slot for
paste-a-credential providers).

1. Sign in at `https://www.terabox.com` in a browser.
2. DevTools (F12) → Application → Cookies → `https://www.terabox.com` → copy
   the `ndus` value (or the whole cookie header).
3. In the 9Drive frontend, **Connect TeraBox** (Providers page) opens a modal
   that POSTs `{ apiKey, name? }` to `POST /providers/terabox/accounts`
   (`provider-contract.md` §8); the backend `createApiKeyAccount()` encrypts
   the credential into `ConnectedAccount.accessTokenEncrypted` and derives
   `providerAccountId = apikey:<sha256-prefix>` (upsert by credential hash).
4. `buildContext()` hands the stored value back as
   `credentials = { kind: 'api_key', apiKey }`.

`normalizeTeraBoxCookie()` in `client.ts` accepts all three paste shapes at
request time: a bare value with no `=` becomes `ndus=<value>; lang=en` (the
same normalisation the rclone backend performs), a quoted value is unquoted,
and a full `ndus=…; …` header is passed through. An empty credential throws
`ERR_AUTH_EXPIRED` before any request is made.

Requests carry `Cookie`, the desktop `User-Agent`, `Referer: <base>/`,
`X-Requested-With: XMLHttpRequest`, and the app query
`app_id=250528&channel=dubox&clienttype=0` plus `jsToken` when one has been
scraped (§4). A redirect to a login page (or an HTML login page body) maps to
`ERR_AUTH_EXPIRED`.

`healthCheck` pings `GET /api/check/login`; success → `healthy`, failures go
through `mapErrorToHealthState` (`health.ts`).

## 2. Capabilities

`TERABOX_CAPABILITIES` is `ALL_CAPABILITIES` minus three entries — **15 of 18**:

- `uploadResumable` — TeraBox upload sessions are never surfaced; every upload
  restarts from scratch, so no `resumeToken` is ever produced or accepted
  (`upload()` throws `ERR_CAPABILITY_UNSUPPORTED` when a `resumeToken` input
  is supplied).
- `createShare` / `revokeShare` — the cookie session exposes no share API.
  Both methods throw `ERR_CAPABILITY_UNSUPPORTED` unconditionally, even when a
  test forces the capability into the set.

Every method gates on its capability first with
`` `provider 'terabox' does not declare capability '<name>'` `` (same wording
as `fake.ts`). `search()` is an extra method (not part of `StorageProvider`,
Dropbox parity) gated by the `search` capability. The catalog entry uses the
same `TERABOX_CAPABILITIES` array, and `registry.test.ts`/`catalog.test.ts`
assert the parity.

## 3. Error mapping (contract §5)

TeraBox answers every endpoint with `{ errno, … }` on HTTP 200 instead of HTTP
statuses, so `mapTeraBoxErrno()` is the primary mapping (raw payloads stay on
`ProviderError.detail`, truncated, never returned verbatim):

| Signal | Code |
|---|---|
| `-1`, `-6`, `104`, `132` (AUTH) | `ERR_AUTH_EXPIRED` |
| `-9`, `102`, `36010` (NOT_FOUND) | `ERR_NOT_FOUND` |
| `-7`, `-11`, `4`, `5` (INVALID_PATH); `-8`, `12`, `36014` (CONFLICT) | `ERR_INVALID_INPUT` |
| `-10`, `-32`, `58`, `31116`, `36009`, `36011` (QUOTA) | `ERR_QUOTA_EXCEEDED` |
| `111`, `31034`, `36013`, `36022`, `36024` (RATE) | `ERR_RATE_LIMITED` |
| `2` | `ERR_INTERNAL` |
| any other non-zero errno | `ERR_UPSTREAM_UNAVAILABLE` (transient; the job retry cap bounds the damage) |
| `4000023`, `450016`, `400810`, `4000020` (TOKEN_REFRESH) | one jsToken refresh + replay (`MAX_TOKEN_RETRIES = 1`), then the errno mapping above |

`filemetas` answers `{"errno":12,"info":[{"errno":-9}]}` — with
`preferInfoErrno`, the **per-item code outranks the envelope**, and a resolved
item is success even when the envelope carries a stale conflict code
(`client.ts` documents the exact precedence).

HTTP fallback (`mapTeraBoxHttpStatus`, for gateways/WAF): 401/403 →
`ERR_AUTH_EXPIRED`, 404 → `ERR_NOT_FOUND`, 413 → `ERR_QUOTA_EXCEEDED`, 429 →
`ERR_RATE_LIMITED`, 5xx → `ERR_UPSTREAM_UNAVAILABLE`, other 4xx →
`ERR_INVALID_INPUT` (a payload `errno` still wins when present).

Transport (`mapTeraBoxTransportError`): timeout socket codes/`TimeoutError`/
`AbortError` → `ERR_TIMEOUT`; network codes → `ERR_UPSTREAM_UNAVAILABLE`;
`ProviderError`s pass through untouched (so `ERR_SSRF_BLOCKED` keeps its
code). Chunk uploads report failures in `error_code` instead of `errno`
(`errnoField: 'error_code'`).

## 4. API request shapes

All requests append the app query (`app_id`, `channel`, `clienttype`,
`jsToken`) unless `appQuery: false`. Endpoints are relative to the regional
base (§"regional base" below).

| Method | Endpoint | Query/form | Notes |
|---|---|---|---|
| GET | `/main`, then `/` | — | App shell; `extractJsToken()` scrapes `jsToken` (six known embed shapes). Production serves the shell at `/main` and bounces bare `/` with `302 /login` for **every** session (verified live), so `ensureJsToken()` tries `/main`, falls back to `/`, and treats a redirect as "no token" - never as auth (API errnos decide that). Reads work without a token; `precreate`/`create`/`filemanager` call `ensureJsToken()` first |
| GET | `/api/check/login` | — | `uk` = account id; also the health probe and the source of the `region-domain-prefix` header |
| GET | `/api/user/getinfo` | `user_list=JSON([uk])`, `need_relation=0`, `need_secret_info=1` | `records[0].uname` → displayName (best-effort; auth errors rethrow, anything else is logged) |
| GET | `/api/quota` | `checkexpire=1`, `checkfree=1` | `total`/`used`/`free` |
| GET | `/api/list` | `dir`, `page`, `num`, `order=name`, `desc=0` | paged listing |
| GET | `/api/search` | `key`, `recursion=1`, `order=name`, `desc=0`, `num`, `page` | account-wide |
| GET | `/api/filemetas` | `target=JSON([path])`, `dlink=0\|1` | `preferInfoErrno`; `dlink=1` opts into the temporary link field |
| GET | `/api/home/info` | — | `data.sign3`/`sign1`/`timestamp` for the signed dlink fallback |
| GET | `/api/download` | `type=dlink`, `vip=2`, `sign`, `timestamp`, `need_speed=1`, `fidlist=JSON([fs_id])` | `sign = signDownload(sign3, sign1)` (§sign) |
| POST | `/api/filemanager` | query `opera=delete\|move\|rename\|copy`, `async` (`1`, `2` for copy), `onnest=fail`; form `filelist=JSON` | jsToken required; `taskid > 0` → poll `/share/taskquery`, otherwise check `info[].errno` |
| GET | `/share/taskquery` | `taskid` | `status: "running"` → backoff, `list[].error_code` mapped; 3 attempts then `ERR_TIMEOUT` |
| POST | `/api/create` | mkdir: `a=commit`, `path`, `isdir=1`, `rtype=0`, `block_list=[]`; commit: `path`, `size`, `isdir=0`, `block_list`, `uploadid`, `rtype=3`, `target_path`, `local_mtime` | `rtype=3` = overwrite existing file |
| POST | `/api/precreate` | `path`, `autoinit=1`, `size`, `file_limit_switch_v34=true`, `block_list` (placeholder md5s), `target_path`, `local_mtime` | placeholder block list: `5910a591…`/`a5fc157d…`, one entry for a single-chunk file |
| GET | `/rest/2.0/pcs/file` | `method=locateupload` (`appQuery: false`) | `host` → upload base (must be a `terabox.com` hostname, §16) |
| POST | `<upload-host>/rest/2.0/pcs/superfile2` | `method=upload` + app query + `path`, `uploadid`, `partseq`, `uploadsign=0` | multipart body, field `blob`; errors in `error_code` |
| GET | `/rest/2.0/membership/proxy/user` | `method=query`, `membership_version=1.0` | `data.member_info.is_vip` (only consulted above the free-tier size) |

**Regional base**: `/api/check/login` may answer with `region-domain-prefix`
(or `url-domain-prefix`); a value matching `^[a-z0-9-]{1,63}$` (anything but
`terabox` itself) switches `baseUrl` to `https://<prefix>.terabox.com` —
**once ever** (`MAX_REGION_SWITCHES = 1`), and only ever under the pinned
`terabox.com` suffix. The in-flight request is replayed against the new base.
A plain GET redirect to another `terabox.com` host is followed the same way
(`MAX_REDIRECTS = 3`); login redirects throw `ERR_AUTH_EXPIRED`.

**Signing (`sign.ts`)**: `signDownload()` is the RC4-style KSA/PRGA the web
player applies to `sign1` keyed by `sign3`, base64-encoded — version-fragile
and mirrored from the community client. `decodeMd5()` undoes `/api/create`'s
whole-file md5 obfuscation (position 9 shifted by `'g'`, XOR by index,
8-byte block rotation); `controlMd5()` recomputes the expected value (the
single chunk md5, or `md5(JSON.stringify(blockList))` for multi-chunk files).

## 5. Root folder and path addressing

- **`remoteId` is the POSIX path** (`/`, `/dir/file.txt`) — TeraBox list
  responses carry no public object ids usable as opaque handles.
- `tbPath()` normalises: trim, leading `/`, trailing `/` stripped (`/` stays
  `/`). Root aliases for `list`: `null`, `/`, `""` only — a bare name like
  `Docs` is an unslashed remoteId resolving to `/Docs`.
- `parentOf()` maps `/` **and direct children of the root** to `null`
  (Dropbox parity); deeper paths map to their directory part.
- `getMetadata({remoteId: '/'})` returns a synthesised root folder meta
  (TeraBox answers `filemetas` for `/` with an empty entry); `rename`/`move`/
  `copy`/`delete` of the root throw `ERR_INVALID_INPUT`.
- Timestamps are seconds → ISO 8601; `server_mtime` falls back to
  `server_ctime`. `md5` → `checksum`, `webUrl: null` (no preview URL).
  Files report `application/octet-stream`, folders `inode/directory`.

## 6. Upload protocol

- Input validation before any HTTP call: `fileName` required, no `/`, not
  `.`/`..`; `stream` must be pipeable; `sizeBytes` a non-negative `bigint`
  within `Number.MAX_SAFE_INTEGER`; non-`api_key` credentials →
  `ERR_INVALID_INPUT`.
- Size limits: above `128 GiB` → `ERR_QUOTA_EXCEEDED` outright; above `4 GiB`
  (free tier, rclone parity) a membership query runs — `is_vip <= 0` →
  `ERR_QUOTA_EXCEEDED`. Membership failures other than auth/timeout are
  logged and treated as "not premium".
- Always overwrite: the commit uses `rtype=3`, so re-uploading the same path
  replaces the file (no silent ` (1)` copies).
- **Protocol** (no resume — `resumeToken` output is always `null`):
  1. `precreate` reserves the session with a **placeholder block list**
     (both reference clients do this; the real md5s go to `create`).
  2. The source streams through `streamChunks()` at `TERABOX_CHUNK_BYTES`
     (4 MiB, rclone `getChunkSize` parity, fixed regardless of file size);
     each chunk is md5-hashed locally, then POSTed to
     `superfile2` on the `locateupload` host as a multipart part.
     The server's returned chunk md5 must equal the local one; mismatches
     retry up to `CHUNK_UPLOAD_ATTEMPTS = 3`, but `ERR_AUTH_EXPIRED` and
     `ERR_INVALID_INPUT` are never re-sent.
  3. `create` commits with the real `block_list`, `rtype=3`, `target_path`
     (directory part with trailing slash) and `local_mtime`.
  4. The returned whole-file md5 is `decodeMd5`'d against `controlMd5()` —
     a mismatch is **logged, never fatal** (the per-chunk md5s already proved
     the bytes; this mirrors the upstream obfuscation being best-effort).
- Byte accounting is exact: a stream longer or shorter than `sizeBytes`
  throws `ERR_INVALID_INPUT` (the session is abandoned, not committed).

## 7. Download

- `filemetas` with `dlink=1`; folders → `ERR_INVALID_INPUT`.
- Preferred URL: the `dlink` field. Fallback: `/api/home/info` → `sign1`/
  `sign3` → `signDownload()` → `/api/download` (`fidlist`) → `dlink`.
- The URL is fetched through `gatedDownload()`: `assertFetchAllowed()` runs
  **before every hop** (max 3 redirects, undici never follows them itself),
  and the session cookie travels with the first hop — the signed link is
  issued to this session — then is dropped the moment a redirect leaves that
  host (`client.ts` `downloadHeaders()` provides Cookie/User-Agent/Accept/
  Referer for the first hop).
- `Range` (capability `downloadRange`) is validated before any HTTP call
  (integer start ≥ 0, end ≥ start; start ≥ size or a zero-byte file →
  `ERR_INVALID_INPUT`); a `206` reply's `Content-Range` is parsed back into
  `range {start, end, total}`. If the CDN ignores the header and answers
  `200`, the whole object is served (`range {0, total-1, total}`) instead of
  pretending the slice applied.
- HTTP ≥ 400 on the download: 401/403 → `ERR_AUTH_EXPIRED`, 404 →
  `ERR_NOT_FOUND`, else `ERR_UPSTREAM_UNAVAILABLE`; a redirect with no
  location → `ERR_UPSTREAM_UNAVAILABLE`. No link is ever returned to the
  client — downloads are streams only.

## 8. Listing and search

- `list` pages with `/api/list` (`order=name`); the cursor is the **page
  number as a string** (invalid cursors → `ERR_INVALID_INPUT`). `limit`
  defaults to 100 and is capped at 1000 (`MAX_PAGE_SIZE`); the adapter fills
  the page across upstream calls and stops on a short page (`nextCursor =
  null`). Entries without a `path` are skipped.
- `search()` mirrors it on `/api/search` with `recursion=1` — account-wide,
  no folder scoping; empty query → `ERR_INVALID_INPUT`.

## 9. Rename / move / copy / delete

All four go through `/api/filemanager` with `ensureJsToken()` first and
`onnest=fail`; per-entry `errno` is mapped (§3). Copy uses `async=2` and, when
a `taskid` comes back, polls `/share/taskquery` up to 3 times
(0/1/2 s backoff on `running`) before `ERR_TIMEOUT`.

- `rename`: no-op when the name is unchanged; root → `ERR_INVALID_INPUT`.
- `move`: no-op when the destination is the current parent; folder into
  itself (or its own subtree) → `ERR_INVALID_INPUT`; root → invalid.
- `copy`: optional `newName` (validated), folder-into-itself → invalid,
  then re-fetches the destination path for the result metadata.
- `delete`: `permanent` is **accepted and ignored** — TeraBox only offers the
  shared recycle bin (contract §11); root → `ERR_INVALID_INPUT`.
- `createFolder` is idempotent: a conflict (`isTeraBoxConflict`) re-resolves
  the path and returns the existing folder; a conflict where the lookup says
  `ERR_NOT_FOUND` → `ERR_INVALID_INPUT`. A `filemetas` miss after a
  successful create returns a synthesised folder meta (upstream lag).

## 10. Quota and health

- `getQuota` reads `/api/quota` (`total`/`used`/`free`), all arithmetic in
  `bigint`, no `total` → unlimited (`null`), `availableBytes` never negative,
  `trashBytes: null` (the recycle bin shares one quota pool).
- `healthCheck` pings `/api/check/login`; success → `healthy`, failures via
  `mapErrorToHealthState` (auth → `unauthorized`, timeout/unreachable →
  `unreachable`, else `degraded`).

## 11. Sharing (security-contract §5)

Not supported: the cookie session exposes no share API, so `createShare` and
`revokeShare` are not declared as capabilities and throw
`ERR_CAPABILITY_UNSUPPORTED` unconditionally (even when a test injects them).
No code path ever pretends to create a link.

## 12. Timeouts

JSON calls: 30 s (`JSON_TIMEOUT_MS`); chunk uploads and dlink downloads:
15 min (`TRANSFER_TIMEOUT_MS`), enforced through undici
`headersTimeout`/`bodyTimeout` plus the caller's `ctx.signal`. Errors map to
`ERR_TIMEOUT`. JSON response bodies are capped at 4 MiB
(`MAX_JSON_BODY_BYTES`).

## 13. Rate limits and platform limits

- Rate errnos (§3) → `ERR_RATE_LIMITED` immediately; the adapter never
  retries internally except the single jsToken refresh replay and the chunk
  md5 retry — callers and job backoff (`job-contract.md`) own the pacing.
- Free accounts are limited to 4 GiB per file (premium 128 GiB), enforced
  client-side before `precreate`.
- jsToken/sign/UA values are version-fragile: TeraBox can rotate them
  without notice (§15).

## 14. Limitations (reverse-engineered API / v1 scope)

- **No official API**: every endpoint above is reverse-engineered from the
  web client (mirrored from the community client and rclone backend, both
  live-tested against the real service). TeraBox may change any shape
  without notice — the catalogue `notes` field carries this warning.
- **No sharing** over the cookie session (§11).
- **No permanent delete**: `permanent` is ignored; the recycle bin shares
  the quota pool and there is no purge API.
- **No trash total**: `trashBytes: null`.
- **Search is account-wide**: no folder scoping; matching is TeraBox's own
  semantics.
- **No `webUrl`**: metadata carries no preview URL; `webUrl: null`.
- **No mid-session resume**: a failed upload discards the session
  (`resumeToken` is always `null`); callers restart from scratch.
- **Path-derived ids**: `remoteId` is the path, so two files with the same
  name in different folders stay distinct, but renames/moves change the id.
- **Single region switch**: at most one `region-domain-prefix` rebasing per
  client instance.

## 15. Test transport seam

Production traffic is pinned to `https://www.terabox.com` and
`https://c-all.terabox.com`. Tests call
`setTeraBoxTransport({ baseUrl, uploadHost })` (exported from `transport.ts`)
to point the adapter at a local fake server; `resetTeraBoxTransport()`
restores the defaults. The override is a module-level seam never derived from
user input, so it adds no SSRF surface (security-contract §7).

Upstream-supplied hosts are validated instead of trusted:

- the regional prefix must match `^[a-z0-9-]{1,63}$` and re-base under the
  `terabox.com` suffix only (`regionBaseUrl`/`isTeraboxHostname`);
- the `locateupload` host must be a `terabox.com` hostname
  (`uploadHostUrl`), otherwise the pinned `TERABOX_UPLOAD_HOST` fallback is
  used (a non-terabox host never receives an upload);
- dlinks re-enter `assertFetchAllowed()` per redirect hop inside
  `gatedDownload()`.

The fake server (`src/__tests__/providers/terabox/server.ts`) serves the SPA
shell, all §4 endpoints, `/dl/:fsId` range-capable download links and the
multipart chunk upload, with failure queues, corrupt-chunk injection and
cookie capture helpers (`withFakeTeraBox`, `makeContext`). Because the fake's
`/dl/` links point at `127.0.0.1`, those tests run with
`ALLOW_INSECURE_ENDPOINTS=true` and `SSRF_ALLOWLIST=127.0.0.1` (saved and
restored by the helper) — the allowlist bypasses the port check, which is
the only way a localhost dlink can pass the SSRF gate. Tests suites:
`terabox.auth.test.ts` (registration, cookie normalisation, quota, health,
error mapping, capability parity), `terabox.files.test.ts` (list/getMetadata/
createFolder/rename/move/copy/delete/search), `terabox.transfer.test.ts`
(upload precreate/chunk-md5/overwrite/premium limits, download range/signed
fallback/HTTP failures).

## 16. Registration

`registerTeraBoxProvider()` (and the `teraboxProvider` singleton) is wired
into `providers/index.ts` by the coordinator; importing
`providers/terabox/index.js` has no side effects. The catalog entry is
`{ id: 'terabox', status: 'SUPPORTED', authMode: 'api_key', capabilities:
TERABOX_CAPABILITIES }` with the reverse-engineering warning in `notes`;
`registry.test.ts` and `catalog.test.ts` assert catalog/registry parity, and
`provider-contract.md` §11 documents the contract-level expectations.
