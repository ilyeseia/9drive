# 9Drive AI Assistant – architecture

Status: Phase A–B document (written before implementation; the "Implementation
status" section at the end is updated when work lands).

## 1. Existing architecture (as found in the local checkout)

| Topic | Reality |
|---|---|
| Backend | Express 5 + TypeScript (ESM), Zod 4 validation, Prisma 6 on **PostgreSQL**, BullMQ/Redis worker (`src/worker*`), JWT bearer sessions (`requireAuth` checks the session row, revocation and `user.status` on **every** request) |
| Frontend | Vite + React 19 + Tailwind 4, react-router, hand-rolled components (`components/ui`, `components/drive`), `apiFetch` helper with token refresh. **No i18n system and no frontend test runner exist.** |
| Deployment | Docker Compose: postgres, redis, `migrate` (prisma migrate deploy + seed scripts), backend, worker, nginx frontend |
| AI | **None.** No model SDK, no chat tables, no prompt code anywhere in the repo |
| Tests | Vitest in `backend/src/__tests__` (fake provider servers, mocked-DB unit tests, DB/Redis-backed API/security tests that need Postgres+Redis) |

### Business services available to reuse
Most file/folder logic lives inside route handlers; these are importable services:

| Service | Location | Used by the agent for |
|---|---|---|
| Provider registry + capabilities | `providers/registry.ts`, `catalog.ts` | what each account can do |
| `buildContext` | `providers/context.ts` | the only place credentials are decrypted (agent never sees them) |
| `selectAccount` (+ diagnostics) | `providers/routing.ts` | routing decisions; **no second algorithm is written** |
| `previewRouting` | `modules/routing/routing.explain.ts` | "why was this destination chosen" |
| `getOrCreateRoutingPolicy`, `updateRoutingPolicy` | `modules/routing/routing.service.ts` | read/change routing policy |
| `checkAccount`, `refreshQuota` | `providers/health.ts` | connectivity test, quota freshness |
| `disconnectOwnedAccount`, `findOwnedAccount`, `toProviderAccountView` | `modules/providers/account-service.ts` | account views (no tokens), disconnect |
| `createAuditLog` | `utils/audit.ts` | audit trail |
| `enqueueJob` + `MigrationJob` rows | `queues/queues.ts`, `modules/migration` | cross-provider copy/move (job based; "move" deletes source only after verified copy) |
| `sanitizeSecrets`, `sanitizeErrorMessage` | `modules/jobs/shared.ts` | scrubbing tool output |

### Data model (relevant)
`User` → `ConnectedAccount` (provider, encrypted tokens, status, `metadata`) → `StorageAccount` (quota) ;
`File` (provider, `providerFileId`, size, checksum, status `active|deleted`, `folderId`), `Folder` (virtual tree),
`FileShare` (9Drive public links), `UploadSession`, `Job`, `StorageOperation`, `AuditLog`, `ProviderHealth`,
`UploadRoutingPolicy`, `MigrationJob`, `ReplicationJob`. Every row is scoped by `userId`; there is a
single-user ownership model (no teams/tenants), enforced in handlers via `where: { userId }`.

### Semantics the agent must respect
- "Move" of a file in the app is a **virtual folder move** (`File.folderId`), not a provider-side move.
- Delete is two-step: trash (`status='deleted'`) then permanent purge (provider delete + row delete).
- Moving data between providers exists only as a **Migration job** (copy or move).
- File upload carries bytes through multipart/resumable endpoints; a chat message has no byte channel.
- Provider capability differences are explicit (`ProviderCapability`, adapters throw `ERR_CAPABILITY_UNSUPPORTED`).
  TeraBox (`terabox_open`) can only touch its application folder and cannot share or create folders.

### Authorization boundaries
Single trust boundary = authenticated user id. All reads/writes are filtered by it; connected accounts, files,
folders, shares, jobs, audit rows are user-owned. Roles: `user`/`admin` (system routes only). The agent adds no
privilege: it runs **as the requesting user** and re-applies the same scoping inside each tool.

## 2. Proposed AI architecture

```
Browser ─ Assistant page (chat, task progress, confirmation cards) ─ i18n ar/en/fr + RTL
   │  REST + polling (no provider keys, no tool execution in the browser)
   ▼
/ai routes (requireAuth, rate limit, size limit, Zod)
   ▼
Agent orchestrator  ── bounded loop (max steps / tool calls / wall time) ──┐
   │ model proposes tool calls (structured)                                 │ persisted every step
   ▼                                                                        ▼
Policy engine (risk → confirm?)  ─►  Confirmation store (hash-bound, TTL, single-use)
   ▼ validated args (Zod) + user re-authorization
Tool registry  ──►  existing services / Prisma (userId-scoped) / provider registry / routing / jobs
   ▼ untrusted-data wrapping + secret scrubbing + size caps
Model provider abstraction: openai_compatible | anthropic   (HTTP, keys server-side)
```

### Model providers
`openai_compatible` (OpenAI, Gemini's OpenAI-compatible endpoint, OpenRouter, Ollama/vLLM/LM Studio – any server
implementing `/chat/completions` with `tools`) and `anthropic` (native Messages API with `tool_use`). Both are plain
HTTPS calls with timeout, abort and bounded retries (429/5xx/timeouts only, honouring `Retry-After`). No SDK dependency
is added. There is **no automatic fallback** to another provider/model. Token streaming is not implemented (progress is
streamed as persisted task events and polled); this is documented as a limitation.

### Execution lifecycle
`RECEIVED → ANALYZING → [AWAITING_CONFIRMATION] → EXECUTING → VERIFYING → COMPLETED | PARTIALLY_COMPLETED | FAILED | CANCELLED`
(`AWAITING_CLARIFICATION` is entered when the model answers with a question and no tool call). Tasks run in-process in
the API server (bounded concurrency per user and globally) and are persisted after every step; tasks orphaned by a
restart are marked `FAILED` on boot. Long operations (migration) are **jobs**; the tool returns the job id and the
assistant reports the real job status via the Jobs table.

### Persistence (new tables, one migration, no change to existing tables)
`AiConversation`, `AiMessage` (visible text + structured tool-call/tool-result JSON, no hidden reasoning),
`AiTask` (status, plan summary, step/tool counters, provider/model, error), `AiToolExecution` (tool, args, status,
verification outcome, idempotency key, latency), `AiActionConfirmation` (args hash, risk, summary, status, expiry),
`AiUsageRecord` (tokens per model call → daily limits). All cascade-delete with the user; clearing a conversation
deletes its messages/tasks/executions.

## 3. Tool catalog

Risk: **L** low (no confirmation), **M** medium, **H** high. "C" = backend demands confirmation.

| Tool | Domain | Risk | C | Notes |
|---|---|---|---|---|
| `list_storage_accounts` | accounts | L | – | provider, status, quota, health, routing flag; never tokens |
| `get_account_details` | accounts | L | – | capabilities, last error, quota freshness |
| `compare_account_usage` | accounts | L | – | sorted free/used across accounts |
| `find_accounts_needing_attention` | accounts | L | – | unauthorized / stale-unknown quota / unhealthy |
| `test_account_connectivity` | accounts | L | – | `checkAccount` (live provider call, rate-limited) |
| `refresh_account_quota` | accounts | L | – | `refreshQuota` |
| `set_account_routing` | accounts | M | C | `metadata.routingEnabled` |
| `disconnect_account` | accounts | H | C | `disconnectOwnedAccount` |
| `search_files` | files | L | – | filters + cursor pagination, hard cap |
| `get_file_details` | files | L | – | metadata only |
| `list_folders` | files | L | – | virtual tree |
| `find_duplicate_candidates` | files | L | – | confirmed (same size + same-provider checksum) vs possible (name/size) |
| `find_similar_names` | files | L | – | normalised-name clusters |
| `plan_organize_by_year` | files | L | – | read-only plan; execution uses `create_folder` + `move_files` |
| `create_folder` | files | M | – | virtual folder |
| `rename_file` | files | M | – | single file; provider rename if supported |
| `move_files` | files | M | C if > 5 | virtual move between folders |
| `trash_files` | files | M | C | reversible soft delete |
| `purge_files` | files | H | C | permanent; only files already in trash; provider delete |
| `start_migration` | files | H/M | C | `MigrationJob`; "move" = H |
| `get_routing_policy` | routing | L | – | |
| `explain_routing` | routing | L | – | `previewRouting` + rejection reasons |
| `preview_upload_destination` | routing | L | – | `selectAccount` with diagnostics (dry run) |
| `update_routing_policy` | routing | M | C | `updateRoutingPolicy` |
| `diagnose_uploads` | routing | L | – | recent failed sessions/operations |
| `get_job_status` / `list_jobs` | system | L | – | real Job rows |
| `list_share_links` | sharing | L | – | |
| `create_share_link` | sharing | M | C | public 9Drive link, 30-day expiry |
| `revoke_share_links` | sharing | H | C | |
| `storage_usage_report` | reports | L | – | per account/provider |
| `activity_report` | reports | L | – | uploads, failures, jobs, time window |
| `provider_health_summary` | reports | L | – | |

### Explicitly **not** provided (and why)
- **Uploading bytes through chat** – there is no authorized byte channel in a chat turn. The assistant can preview the
  destination and point to the upload workflow; the existing upload API stays the only upload path.
- **Downloading content to the model** – metadata only; file contents are never sent to the model.
- **Provider-side public permissions** (Google "anyone" links), account reconnection (browser OAuth) – need user
  interaction; the assistant tells the user where to do it.
- **TeraBox beyond its verified capabilities** – tools consult provider capabilities; folder creation/sharing on
  `terabox_open` are reported as unsupported.

## 4. Security model

1. **Server-side authorization.** Every tool receives the authenticated user id from the session, never from the model;
   queries are `userId`-scoped; model-supplied ids that do not belong to the user behave as "not found".
2. **Backend-enforced confirmation.** A tool needing confirmation never runs from a model request. The orchestrator
   stores the exact validated arguments + a server-generated human-readable preview + SHA-256 of the canonical
   arguments, in `AiActionConfirmation` (TTL, default 5 min), bound to user and task. Only
   `POST /ai/confirmations/:id/approve` (authenticated browser call) can approve it; approval is an atomic
   `PENDING → CONSUMED` transition, so altered, expired, replayed or other-user confirmations are rejected. The model
   cannot create or approve one.
3. **Prompt-injection resistance.** File names/metadata/tool results are wrapped as untrusted data, sanitised
   (control chars stripped, length capped) and the system prompt says they carry no authority – but nothing relies on
   that: policy, scoping and confirmation are code.
4. **Bounded autonomy.** Max steps, tool calls, wall time, batch size, result size, concurrent tasks, daily tokens.
5. **No secret exposure.** Tool outputs are projected to safe fields and passed through `sanitizeSecrets`; provider
   keys exist only in backend env; errors are normalised.
6. **Audit.** Each tool execution is stored (`AiToolExecution`) and writes an `AuditLog` row (`AI_TOOL_*`) for mutations;
   audit metadata holds identifiers and counts, not file contents.
7. **Privacy.** Conversations store user text, assistant text and tool JSON (already sanitised); they can be deleted.

## 5. Configuration

`AI_PROVIDER` (`openai_compatible` | `anthropic`), `AI_MODEL`, `AI_API_KEY`, `AI_BASE_URL`, `AI_REQUEST_TIMEOUT_MS`,
`AI_MAX_OUTPUT_TOKENS`, `AI_MAX_RETRIES`, `AI_MAX_STEPS`, `AI_MAX_TOOL_CALLS`, `AI_TASK_TIMEOUT_MS`,
`AI_MAX_CONCURRENT_TASKS_PER_USER`, `AI_DAILY_TOKEN_LIMIT`, `AI_CONFIRMATION_TTL_SECONDS`, `AI_HISTORY_MAX_MESSAGES`.
Unset provider/model/key ⇒ AI disabled with an explicit reason (`GET /ai/status`); the rest of 9Drive is unaffected;
no mock assistant answers.

## 6. Phases and acceptance criteria

A assessment ✔ · B design ✔ · C backend foundation (config, providers, registry, orchestrator, policy, API, migration) ·
D tools · E frontend (assistant page, i18n ar/en/fr, RTL, confirmation cards) · F persistence/cancel/recovery ·
G tests/security · H docs/report.

Acceptance: `tsc` clean; backend/ frontend builds; unit tests for providers (mock HTTP), orchestrator (scripted model),
policy/confirmation (expired/altered/replayed/cross-user), tools (authorization + behaviour), injection scenarios;
frontend tests for i18n/RTL/confirmation/progress; DB-backed paths clearly marked as not executed locally.

## 7. Implementation status
_Updated at the end of the work (see the final report)._
