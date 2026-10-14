# Storage routing

Automatic destination selection for uploads: `backend/src/providers/routing.ts`
(`selectAccount`). It runs across **all** connected accounts of the user regardless of
provider (Google Drive, S3-compatible, Dropbox, OneDrive, pCloud, TeraBox), so mixed
setups and several accounts per provider work the same way.

## Evaluation order

1. **Connected**: `status = 'connected'`, owned by the uploading user (an explicit
   `targetAccountId` or the target folder's account narrows the set to one account).
2. **Provider usable**: catalog status `SUPPORTED`/`VIA_S3` and an adapter registered.
3. **Routing switches** *(per account/provider)*:
   - `metadata.routingEnabled === false` → rejected `routing_disabled`.
   - `experimental` providers (legacy cookie `terabox`) need
     `routingEnabled === true` → else `experimental_not_opted_in`.
   - An explicit target bypasses these two switches only.
4. **Quota trust** *(providers with `quotaPolicy: 'required'`, i.e. both TeraBox
   providers)*: quota must be **known** (`availableBytes` present and a `lastSyncedAt`)
   and **recent** (≤ `QUOTA_MAX_AGE_MS` = 30 min) → else `quota_unknown` /
   `quota_stale`. This applies even to an explicit target. Unknown quota is never
   treated as unlimited space.
5. **Capability**: the provider must declare every capability the operation needs
   (e.g. `createFolder` excludes `terabox_open`) → `missing_capability`.
6. **Space**: `availableBytes − reserved ≥ fileSize` → else `insufficient_space`.
   `reserved` is the Redis counter of bytes already promised to in-flight uploads
   (`9drive:acct:<id>:reserved`), which the upload route increments right after a
   selection, so concurrent uploads do not both claim the same free space.
7. **Policy ordering** over the survivors (`UploadRoutingPolicy.mode`): `most_available`
   (default), `least_used`, `round_robin`, `priority`, `provider_preference`,
   `file_size`, `file_type`, `health_aware`, `user_policy`; ties break by account age
   then id (deterministic).
8. **Health**: accounts whose last health state is `unauthorized` or `unreachable` are
   removed (`unhealthy`); `degraded` and `unknown` stay eligible. `health_aware` sorts
   by health instead of filtering.

If nothing survives, `selectAccount` returns `null` and the upload endpoints answer
`400 NO_ACCOUNT_WITH_ENOUGH_SPACE` with a message that lists the reasons, e.g.
`No connected storage account can accept this upload: 1 account(s): quota is unknown
(refresh the account quota); 2 account(s): not enough free space.`

## Quota semantics

Capacities are only compared where their meaning is the same: the *free bytes the
provider reports for the account*. Caveats:

- **TeraBox quota is account-wide** (`/openapi/api/quota` total/used) even though 9Drive
  can only write inside the application folder; free space is therefore an upper bound.
- Providers with `quotaPolicy: 'optional'` (Google Drive, S3, Dropbox, OneDrive, pCloud)
  keep their historical behaviour: `availableBytes === null` means "no reported limit"
  and such accounts sort first in `most_available`. This is intentional for them
  (unbounded S3 buckets, unlimited Workspace plans) and is **pre-existing**.
- The upload routes refresh quotas older than 5 minutes before selecting, so a healthy
  TeraBox account normally stays inside the 30-minute trust window; if refreshing fails
  repeatedly the account drops out with `quota_stale` until it succeeds.
- TeraBox gives no documented per-file size limit, so file-size eligibility is decided
  by quota only; a provider-side refusal surfaces as an upload error.

## Duplicate prevention and retries

- Routing never "replicates": a file lives on exactly one account; its
  `connectedAccountId` and `providerFileId` (`remoteId`) are stored on the `File` row.
- The TeraBox adapter retries only idempotent shard transfers. The final `create` step
  is not replayed automatically (see terabox-integration.md §6), so retries cannot
  create `name(1)` duplicates by themselves.

## Operator controls

| Control | How |
|---|---|
| Routing mode / priority order | existing `/routing` API and settings |
| Per-account on/off | `PATCH /providers/accounts/:id/routing` `{ "enabled": boolean }`, *Routing* button in Providers |
| Dry run / explanation | `/routing/preview` (note: its step list predates the TeraBox rules; the actual choice is made by `selectAccount`) |
| Pin an upload to one account | `targetAccountId` on the upload |

## Tests

`backend/src/__tests__/providers/terabox-open/terabox-open.routing.test.ts` (18 tests,
mocked Prisma/Redis, deterministic): mixed Google/TeraBox/S3, multiple TeraBox accounts,
priority/round-robin/least-used, insufficient capacity, disabled and experimental
accounts, stale and unknown quota, unsupported capability, unauthorized/unreachable
health, reservations, no eligible destination.
