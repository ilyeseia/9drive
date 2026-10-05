# Database Contract

**Status:** NORMATIVE — source of truth for the persistence layer.
**Owner:** Coordinator. Agents MUST NOT edit `backend/prisma/schema.prisma` directly;
request changes via the proposal process.

---

## 1. Authoritative engine

- **PostgreSQL 16** is the only authoritative database.
- MySQL is removed. Redis is **never** a database substitute — it holds queues, cache,
  locks, rate-limit counters and ephemeral state only.
- Access exclusively through Prisma (`backend/src/config/prisma.ts`).
- **No file contents in the database.** Only metadata and provider references.

---

## 2. Schema authoring rules

| Rule | Detail |
|---|---|
| Datasource | `provider = "postgresql"`, `url = env("DATABASE_URL")` |
| Primary keys | `String @id @default(uuid()) @db.Uuid` |
| Foreign keys | `@db.Uuid`, matching the referenced PK type |
| **Exception** | `WorkspaceInvite.targetId` → `String @default("") @db.Text` (must round-trip `""`, not padded chars) |
| Variable strings | `@db.VarChar(n)` where `n` is meaningful; otherwise omit the native type (defaults to `text`) |
| Large text | `@db.Text` |
| Structured data | `Json` → **JSONB** on PostgreSQL (Prisma maps automatically) — used for provider config, scopes, policy, audit metadata, job payloads |
| Byte counts | `BigInt` — never `Int`/`Float` |
| Enums stored as text | keep `String` + `@db.VarChar(32)` (no native PG enums) so adding a value never needs a migration |
| Timestamps | `@default(now())` / `@updatedAt` (Prisma-managed) |
| Map names | keep existing `@map`/`@@map` snake_case names — raw SQL and the UI depend on them |
| Index names | must be ≤ 63 chars (PG identifier limit) |
| Soft delete | `deletedAt` columns preserved as-is |

### 2.1 Case-insensitivity (MANDATORY)
PostgreSQL `LIKE`/`contains` and unique lookups are case-sensitive; MySQL's were not.
Everywhere the current code relies on that behaviour it MUST be made explicit:

- Text search: `name: { contains: q, mode: 'insensitive' }`
- Email lookups (`auth.routes.ts` register/login/`findUnique({email})`):
  store `email` lowercased in application code **and** query with
  `mode: 'insensitive'` / normalized lowercase. Registration normalises to lowercase;
  existing rows are lowercased in the baseline migration's data step where possible.
- `WorkspaceInvite.inviteeEmail` matched against normalized lowercase email.

Failing this silently changes login and search behaviour — it is a release blocker.

### 2.2 Baseline migration strategy
The 16 existing MySQL migrations use MySQL-only SQL (`ALTER TABLE ... MODIFY`,
backticks, `utf8mb4` collation) and **cannot replay on PostgreSQL**.

1. Move them out of the migrations directory to
   `backend/prisma/mysql-migrations-archive/` (reference only; Prisma ignores it).
2. Generate a **single baseline migration** `0_init` against a real PostgreSQL instance.
3. `migration_lock.toml` → `provider = "postgresql"`.
4. Existing MySQL deployments migrate with a documented one-off export/import utility
   `backend/src/scripts/migrate-mysql-to-postgres.ts` (optional, documented; new
   deployments start clean). Never `prisma migrate reset` against real data.

---

## 3. Model inventory

### 3.1 Existing models (all retained)
`User`, `ApiKey`, `UploadRoutingPolicy`, `UserSession`, `AuthHandoff`, `ProviderConfig`,
`OauthState`, `ConnectedAccount`, `S3StorageConfig`, `StorageAccount`, `File`, `FileShare`,
`FilePreviewToken`, `Folder`, `UploadSession`, `AuditLog`, `WorkspaceInvite`.

### 3.2 Required additions

#### `User.role`
```
role  String  @default("user")  @db.VarChar(32)   // 'user' | 'admin'
```
Used by `requireRole('admin')` (see `security-contract.md` §3).

#### `ProviderCapability`
Static per-provider capability snapshot for API/UI and cross-provider queries.
```
id               String   @id @default(uuid()) @db.Uuid
provider         String   @db.VarChar(32)
capability       String   @db.VarChar(32)
supported        Boolean  @default(true)
notes            String?  @db.Text
createdAt        DateTime @default(now())
@@unique([provider, capability])
@@index([provider])
@@map("provider_capabilities")
```

#### `ProviderHealth`
```
id                 String    @id @default(uuid()) @db.Uuid
connectedAccountId String?   @unique @map("connected_account_id") @db.Uuid
provider           String    @db.VarChar(32)
state              String    @default("unknown") @db.VarChar(32)  // healthy|degraded|unauthorized|unreachable|unknown
latencyMs          Int?
message            String?   @db.Text
checkedAt          DateTime  @default(now())
createdAt          DateTime  @default(now())
updatedAt          DateTime  @updatedAt
@@index([provider, state])
@@index([checkedAt])
@@map("provider_health")
```

#### `Job` (queue mirror for the UI; Redis remains the execution source of truth)
```
id           String    @id @default(uuid()) @db.Uuid
userId       String?   @map("user_id") @db.Uuid
type         String    @db.VarChar(64)   // see job-contract.md §2
status       String    @default("queued") @db.VarChar(32) // queued|active|completed|failed|delayed|cancelled
priority     Int       @default(0)
attempts     Int       @default(0)
maxAttempts  Int       @default(5)
progress     Int       @default(0)
payload      Json
result       Json?
error        String?   @db.Text
provider     String?   @db.VarChar(32)
relatedId    String?   @map("related_id") @db.Uuid
bullJobId    String?   @unique @map("bull_job_id") @db.VarChar(64)
startedAt    DateTime?
finishedAt   DateTime?
createdAt    DateTime  @default(now())
updatedAt    DateTime  @updatedAt
@@index([userId, type, status, createdAt])
@@index([status, createdAt])
@@index([type, createdAt])
@@map("jobs")
```

#### `ReplicationJob`
```
id             String   @id @default(uuid()) @db.Uuid
userId         String   @map("user_id") @db.Uuid
sourceAccountId String  @map("source_account_id") @db.Uuid
targetAccountId String  @map("target_account_id") @db.Uuid
scope          Json     // { folderIds?, fileIds?, overwrite: boolean }
status         String   @default("pending") @db.VarChar(32)
filesTotal     Int      @default(0)
filesCopied    Int      @default(0)
filesFailed    Int      @default(0)
bytesCopied    BigInt   @default(0)
error          String?  @db.Text
startedAt      DateTime?
finishedAt     DateTime?
createdAt      DateTime @default(now())
updatedAt      DateTime @updatedAt
@@index([userId, status, createdAt])
@@map("replication_jobs")
```

#### `MigrationJob`
```
id              String   @id @default(uuid()) @db.Uuid
userId          String   @map("user_id") @db.Uuid
sourceAccountId String   @map("source_account_id") @db.Uuid
targetAccountId String   @map("target_account_id") @db.Uuid
status          String   @default("pending") @db.VarChar(32)
mode            String   @default("copy") @db.VarChar(16)   // copy | move
filesTotal      Int      @default(0)
filesDone       Int      @default(0)
filesFailed     Int      @default(0)
bytesMoved      BigInt   @default(0)
error           String?  @db.Text
startedAt       DateTime?
finishedAt      DateTime?
createdAt       DateTime @default(now())
updatedAt       DateTime @updatedAt
@@index([userId, status, createdAt])
@@map("migration_jobs")
```

#### `StorageOperation`
Append-only operational log (distinct from `AuditLog`, which is security/user-action).
```
id            String   @id @default(uuid()) @db.Uuid
userId        String?  @map("user_id") @db.Uuid
accountId     String?  @map("account_id") @db.Uuid
provider      String?  @db.VarChar(32)
operation     String   @db.VarChar(64)   // upload|download|delete|rename|move|copy|share|list|quota|health
fileId        String?  @map("file_id") @db.Uuid
status        String   @db.VarChar(16)   // started|succeeded|failed
latencyMs     Int?
bytes         BigInt?
errorCode     String?  @map("error_code") @db.VarChar(64)
metadata      Json?
createdAt     DateTime @default(now())
@@index([userId, createdAt])
@@index([accountId, createdAt])
@@index([operation, status, createdAt])
@@map("storage_operations")
```

#### `WebhookSubscription` + `WebhookDelivery` (automation surface, see `event-contract.md`)
```
WebhookSubscription:
  id, userId, url, secretEncrypted, events Json, status, createdAt, updatedAt
  @@unique([userId, url])  @@map("webhook_subscriptions")

WebhookDelivery:
  id, subscriptionId, event, payload Json, status, attempts, lastError,
  nextAttemptAt, deliveredAt, createdAt
  @@index([subscriptionId, status, nextAttemptAt])  @@map("webhook_deliveries")
```

#### `RateLimitCounter` (only if Redis is unavailable — Redis is primary; this table is optional)
Not created. Redis owns rate limiting (`security-contract.md` §8).

### 3.3 Model changes to existing tables

| Model | Change | Reason |
|---|---|---|
| `File` | add `remoteParentId String? @map("remote_parent_id") @db.VarChar(255)`; add `providerFolderId`-equivalent if absent | provider-neutral folder mapping |
| `File` | add `replicatedFromId String? @map("replicated_from_id") @db.Uuid` | replication lineage |
| `FileShare` | **drop plaintext `token` column**; keep `tokenHash` only | `security-contract.md` §10 |
| `FileShare` | `expiresAt` required with default `now() + 30 days` set by application | share links must expire |
| `Folder` | change `provider` default from `"google_drive"` to `""` (virtual folder) | folders are app-level; remote folder is per-account |
| `ConnectedAccount` | add `metadata Json?` for provider-specific non-secret fields (bucket, region, display) | replaces reliance on `S3StorageConfig` for S3 presets |
| `S3StorageConfig` | **retained** (secrets stay here) but accessed only via the S3 adapter | preserve existing functionality |
| `UserSession` | add `refreshTokenHash` rotation support: add `prevRefreshTokenHash String? @unique @map("prev_refresh_token_hash")` | rotation + reuse detection |
| `ProviderConfig` | unchanged apart from type mapping | — |
| `UploadRoutingPolicy` | add `mode` values as strings (no enum change needed); add `fileTypeRules Json?`, `minFileSizeBytes BigInt?`, `maxFileSizeBytes BigInt?` | extended routing modes |
| `AuditLog` | fix double encoding: write `metadata` as an object, not `JSON.stringify(...)` | see §4.3 |

---

## 4. Data handling rules

### 4.1 Secrets
- Encrypted at rest with AES-256-GCM (`security-contract.md` §9):
  `ProviderConfig.clientIdEncrypted/clientSecretEncrypted`,
  `ConnectedAccount.accessTokenEncrypted/refreshTokenEncrypted`,
  `S3StorageConfig.accessKeyIdEncrypted/secretAccessKeyEncrypted`,
  `WebhookSubscription.secretEncrypted`.
- Hashed (SHA-256): `UserSession.refreshTokenHash`, `AuthHandoff.tokenHash`,
  `OauthState.stateHash`, `FileShare.tokenHash`, `FilePreviewToken.tokenHash`,
  `ApiKey.keyHash`, `UserSession.prevRefreshTokenHash`.
- Passwords: argon2id.
- **Key rotation**: encrypted columns are stored as `v1:<base64(iv:tag:ciphertext)>`.
  Decrypt supports `v1`; re-encryption happens opportunistically on token refresh.

### 4.2 BigInt serialization
Every API response converting `BigInt` MUST call `.toString()` before `JSON.stringify`.
A shared `serializeBigInt()` helper in `backend/src/utils/serialize.ts` is the only
permitted implementation.

### 4.3 JSON
- Write `Json` columns with real objects/arrays. `AuditLog.metadata` must NOT be
  `JSON.stringify()`-ed before insertion (current bug: `utils/audit.ts:11`).
- Read defensively: `ApiKey.scopes` may arrive as a string from legacy rows — normalise.

### 4.4 Transactions
New multi-row writes MUST use `prisma.$transaction`. The codebase currently has none;
introducing one is required for: file + folder + share creation, replication progress
updates, and job state transitions.

### 4.5 Raw SQL
- Exactly one raw query exists (`storage.routes.ts` breakdown). It MUST cast:
  `COALESCE(SUM(size_bytes), 0)::bigint` and be typed `bigint` on the result.
- All other queries use Prisma structured `where`. `$queryRawUnsafe` is forbidden.

### 4.6 Indexing
Every new `where`-clause column set used on a hot path (files, folders, jobs, operations)
gets an `@@index`. Existing 34 indexes are preserved.

---

## 5. Environment

| Var | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | `postgresql://user:pass@host:5432/9drive?schema=public` |
| `REDIS_URL` | yes | `redis://host:6379` (see `job-contract.md` §1) |
| `DIRECT_URL` | optional | for `prisma migrate` against a superuser role |

`backend/src/config/env.ts` validates both with zod and **fails fast at boot**.

---

## 6. Verification gate

A schema change is only "done" when all pass:
```
cd backend && npx prisma validate
cd backend && npx prisma generate
cd backend && npx prisma migrate dev --name <change>   # against local PostgreSQL
cd backend && npm run build
cd backend && npm run test
```
