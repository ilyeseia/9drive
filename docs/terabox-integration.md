# TeraBox integration (official Open Platform)

Provider id: **`terabox_open`**. Contract source: the official
[TeraBox Open Platform Integration Document](https://www.terabox.com/integrations/docs?lang=en).
Evidence and open questions are in [terabox-integration-assessment.md](terabox-integration-assessment.md).

> **Status: implemented and tested against a fake server built from the official
> document. It has NOT been run against the live TeraBox service**, because that
> requires application credentials TeraBox must approve. Items marked
> *(unverified)* below are exactly the points a first live test must confirm.

There are two TeraBox providers in 9Drive; do not confuse them:

| | `terabox_open` (this guide) | `terabox` (legacy) |
|---|---|---|
| Basis | Official Open Platform API | Reverse-engineered web API |
| Credential | OAuth tokens via QR approval | Pasted browser session cookie |
| Access | Only the app's own TeraBox folder | The whole account |
| Automatic routing | On by default | Off by default (experimental) |
| Support | Documented contract | May break without notice |

## 1. Register the application (external approval required)

1. Apply for TeraBox Open Platform access through the official integration page. The
   document states a vendor must apply for **`client_id` (AppKey)**,
   **`client_secret` (SecretKey)** and a **`private_secret`** used to sign token
   requests. There is no self-serve console in the document; approval is outside this
   project's control.
2. Note the application folder TeraBox assigns (the document names it
   `/From: Other Applications/<Application Name>-…` in one place and
   `/From: Other Device/<Application Name - Assigned Application ID>/` in another
   *(unverified which is correct)*. Confirm with your approved app.
3. There is **no redirect URI to register**: 9Drive connects with the device-code
   (QR) flow, which has none. (The authorization-code flow documents neither a
   `redirect_uri` nor a `state` parameter, so it is intentionally not used.)

## 2. Configure

Add to the `.env` used by Docker Compose (placeholders are in `.env.docker.example`):

```bash
TERABOX_CLIENT_ID=...            # AppKey
TERABOX_CLIENT_SECRET=...        # SecretKey
TERABOX_PRIVATE_SECRET=...       # signing secret – environment only, never stored in the DB
TERABOX_APP_ROOT=                # optional app-folder prefix, see §1 step 2
TERABOX_UPLOAD_CONCURRENCY=2     # concurrent staged uploads, 1–16
```

Then apply and seed (the `migrate` service does both on `docker compose up`):

```bash
docker compose up -d --build
# or manually:
cd backend && npm run db:migrate:deploy && npm run seed:terabox-config
```

`seed:terabox-config` stores `client_id`/`client_secret` encrypted (AES-256-GCM, key
`TOKEN_ENCRYPTION_KEY`) in `provider_configs`. It exits quietly when TeraBox is not
configured, and **the application starts normally without any TeraBox settings**;
Google Drive and S3 are unaffected. No database migration is required for this
feature (existing `connected_accounts` columns are reused).

## 3. Connect accounts (multiple supported)

*Providers → Connect TeraBox* shows a QR code. Scan it in the TeraBox mobile app and
approve. The page completes automatically. Repeat for each TeraBox account: accounts
are keyed by the TeraBox `user_id`, so a second scan of the same account
**reauthorizes** it in place (settings, routing flag and history are kept) instead of
duplicating it. Whether TeraBox allows several separately authorized accounts for one
approved application was **not stated in the document** *(unverified)*.

How it stays safe:

- The server holds the `device_code` (encrypted, short TTL); the browser only gets an
  opaque handle bound to the signed-in 9Drive user. Another user's handle behaves like
  an unknown one.
- Polling is throttled to the interval TeraBox returns and serialised, so a device code
  is never exchanged twice. One pending flow per user.
- TeraBox notes the QR login can require a VPN in some regions.

## 4. Token lifecycle

| Token | Lifetime (official) | Handling |
|---|---|---|
| access | 2 days | refreshed automatically when within 2 min of expiry |
| refresh | 30 days, **single use** | rotated on each refresh |

A refresh invalidates the old access token after ~15 s. To avoid destroying the
connection, concurrent refreshes inside a process share one request, and if a refresh
fails because *another process* already rotated the token, the freshly stored tokens
are adopted. Residual risk: if a refresh genuinely loses a race across processes and
no fresh pair is stored, the account turns `unauthorized` and must be reauthorized with
a new QR scan (a 30-day idle gap does the same). TeraBox documents **no revocation
endpoint**, so *Disconnect* marks the account disconnected and erases the stored
tokens locally; revoke the app inside TeraBox too if you want it removed there.

## 5. What works

| Operation | Supported | Notes |
|---|---|---|
| Account identity, quota, health | yes | identity = `/oauth/tokeninfo.user_id` |
| List, metadata, search | yes | paged by page number; search is app-wide |
| Upload | yes | precreate → 4 MiB shards → create; see §6 |
| Download | yes | streamed through the documented `dlink`; the token is never returned to browsers |
| Rename, move, copy, delete | yes | via `filemanager`; delete recoverability is **undocumented** |
| Create folder | **no** | not documented |
| Sharing (create/revoke) | **no** | the documented share APIs only read *other people's* links |
| Range/resumable download, resumable upload | **no** | not documented |
| Scope | app folder only | existing files elsewhere in the TeraBox account are unreachable |

Unsupported operations return `CAPABILITY_UNSUPPORTED`; nothing pretends to succeed.
Uploads into a folder that does not exist remotely fail with the provider's error.

## 6. Uploads in detail

- TeraBox's `precreate` needs the **md5 of every shard before the first shard is sent**.
  A one-shot stream cannot provide that, so 9Drive stages the upload to a private temp
  file (mode 0600) in `UPLOAD_SPOOL_DIR`, hashing while it writes (with backpressure),
  then sends 4 MiB shards from disk. Memory use is one shard; disk use is the file size
  per in-flight upload, bounded by `TERABOX_UPLOAD_CONCURRENCY`. The temp file is
  removed on success, failure and cancellation.
- Each shard is verified against the md5 TeraBox echoes. Transient failures and md5
  mismatches retry (≤3, backoff); auth failures never retry.
- **`create` is never retried automatically.** Name conflicts use `rtype=1` (rename),
  so a replay after a lost response could produce `name(1)`; instead the caller decides
  whether to re-run the upload. The stored path TeraBox returns becomes the file's
  `remoteId`, so duplicates never overwrite each other.
- Zero-byte files are rejected (the document defines no empty-shard behaviour).
- No resume: an interrupted upload restarts; the abandoned `uploadid` simply expires
  server-side (no abort API is documented).
- Size limits: the document lists none, so none are invented. TeraBox's own error is
  surfaced if a limit is hit. *(unverified)*

## 7. Routing and quota

See [storage-routing.md](storage-routing.md). In short: `terabox_open` accounts take
part in automatic routing next to Google Drive and S3, but only with a **known, recent
(≤30 min)** quota; unknown or stale quota never counts as free space. Each account
has a *Routing: On/Off* switch.

## 8. Disable or remove TeraBox safely

- Stop routing to an account: *Routing: Off* (files stay readable).
- Disconnect an account: *Disconnect* (tokens erased locally; its file records are kept
  and become usable again if the same TeraBox account is reconnected).
- Disable the provider entirely: clear `TERABOX_*` and redeploy. Existing TeraBox
  accounts turn `unauthorized` when their tokens next need refreshing (restore the
  variables to recover while the 30-day refresh token is valid); nothing else is affected.

## 9. Backup and key rotation

Tokens are encrypted with `TOKEN_ENCRYPTION_KEY`. Back up the database **and** keep the
key outside it; restoring one without the other makes every stored token unreadable and
all accounts must be reconnected. To rotate the key, decrypt/re-encrypt
`connected_accounts.access_token_encrypted/refresh_token_encrypted` and
`provider_configs.*_encrypted` with a one-off script under both keys, then swap the
environment value (there is no built-in rotation tool in this repository). Rotate
`TERABOX_PRIVATE_SECRET` by editing the environment and restarting backend + worker; no
data is re-encrypted.

## 10. Testing

```bash
cd backend
npx tsc --noEmit
npx vitest run src/__tests__/providers/terabox-open     # 96 tests, no network/DB needed
npx vitest run                                          # full suite (DB/Redis tests need Postgres + Redis)
cd ../frontend && npm run build
```

Live verification (once credentials exist): set the `TERABOX_*` variables, connect a
real account through the QR flow, then confirm the *(unverified)* items: the app-folder
prefix, the `sign` format, error numbers returned for expired tokens by file endpoints,
download redirect hosts, and any size limits.
