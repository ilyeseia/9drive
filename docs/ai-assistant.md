# 9Drive AI Assistant – setup, security and operations

Design and rationale: [ai-agent-architecture.md](ai-agent-architecture.md). This page is the
operator/user guide. **Status in one line:** fully implemented and covered by mock-based tests;
**never run against a live model provider or a live Postgres/Redis in this repository's
test environment** (none was available) – see §9.

## 1. What it is

A chat assistant (page **AI Assistant**, route `/assistant`) that answers questions about the signed-in
user's own storage and can perform a fixed set of operations through typed tools. The model only
*proposes* tool calls; the backend validates, authorises, asks for confirmation when required,
executes, re-reads the result and reports it. Without AI configuration everything else in 9Drive keeps
working and the page shows why the assistant is unavailable (plus read-only quick actions).

## 2. Configuration (backend environment only)

```bash
AI_PROVIDER=anthropic            # or openai_compatible
AI_MODEL=<model id from your provider>
AI_API_KEY=<secret>              # backend only; never sent to the browser or the worker
AI_BASE_URL=                     # openai_compatible: required for self-hosted servers, e.g. http://host:11434/v1
```

| Variable | Default | Meaning |
|---|---|---|
| `AI_PROVIDER` | – | `openai_compatible` (OpenAI, Gemini's OpenAI-compatible endpoint, OpenRouter, Ollama, vLLM, LM Studio) or `anthropic`. Unset ⇒ assistant disabled |
| `AI_MODEL` / `AI_API_KEY` / `AI_BASE_URL` | – | model id, secret, optional endpoint. The key is optional only for `openai_compatible` with an explicit `AI_BASE_URL` |
| `AI_REQUEST_TIMEOUT_MS` | 60000 | per model request |
| `AI_MAX_OUTPUT_TOKENS` | 1500 | per model response |
| `AI_MAX_RETRIES` | 2 | bounded retries for 429/5xx/timeouts only (honours `Retry-After`, never retries auth errors or cancellation) |
| `AI_MAX_STEPS` | 8 | model turns per request |
| `AI_MAX_TOOL_CALLS` | 12 | tool executions per request |
| `AI_TASK_TIMEOUT_MS` | 180000 | wall-clock limit per request |
| `AI_MAX_CONCURRENT_TASKS_PER_USER` / `AI_MAX_CONCURRENT_TASKS` | 2 / 20 | concurrency caps |
| `AI_DAILY_TOKEN_LIMIT` | none | per-user input+output tokens per UTC day (usage is recorded; no price is ever invented) |
| `AI_CONFIRMATION_TTL_SECONDS` | 300 | lifetime of a confirmation |
| `AI_HISTORY_MAX_MESSAGES` | 30 | messages sent to the model (also capped by size) |
| `AI_MAX_BATCH` / `AI_MAX_RESULTS` | 100 / 50 | files per mutating call / rows per read |
| `AI_RETENTION_DAYS` | 90 | conversations untouched this long are deleted automatically |

Validation happens at startup and the reason is logged (`[ai] assistant disabled: …`) and shown on
the page; invalid numbers fall back to the default. There is **no fallback to another provider or
model**. `AI_BASE_URL` is set by the administrator, not by users; it is not an SSRF surface for user input.

Provider limits worth knowing: the adapters need **tool/function calling**. A model that does not
support it will answer in text and never act. Token streaming is not implemented; progress is shown
through persisted task steps and the answer appears when complete.

## 3. Install / migrate / run / test

```bash
# docker (migrate service applies the new tables automatically)
cp .env.docker.example .env      # set AI_PROVIDER / AI_MODEL / AI_API_KEY (+ the existing secrets)
docker compose up -d --build

# manual
cd backend && npm run prisma:generate && npm run db:migrate:deploy   # adds 6 ai_* tables only
npm run build && npm start
cd ../frontend && npm run build

# tests
cd backend  && npx tsc --noEmit && npx vitest run src/__tests__/ai   # 103 tests, no network/DB
cd frontend && npm test                                              # 37 tests
# optional live provider check (spends a few tokens)
cd backend && AI_LIVE_TEST=1 AI_PROVIDER=... AI_MODEL=... AI_API_KEY=... npx vitest run src/__tests__/ai/live-provider.test.ts
```

The migration `20261018000000_ai_assistant` is purely additive (six new tables and their indexes/foreign
keys; no existing table is altered). It was generated with `prisma migrate diff` and **not applied
to a live database here**.

## 4. What the assistant can do (tools)

Closed list; see the table in the architecture doc, or `GET /ai/capabilities`.

| Domain | Tools |
|---|---|
| Accounts | list, details, compare usage, needing attention, test connectivity, refresh quota, set routing, disconnect |
| Files | search (filters, pagination), details, folders, duplicate candidates, similar names, plan organise-by-year, create folder, rename, move, trash, purge, start migration |
| Routing | get policy, explain (dry-run of the real engine), update policy, diagnose uploads |
| Sharing | list links, create link, revoke links |
| Reports / jobs | storage usage, activity, provider health, list jobs, job status |

Honest scope notes:
- **No uploads or downloads through chat** (no authorised byte channel); the assistant previews the destination with the real routing engine and points to the upload workflow. File contents are never sent to the model.
- **"Move to another provider"** is only available as a background *migration job* (copy, or move that deletes each source file after its copy is verified).
- **"Files not accessed recently"**: 9Drive stores no access time, so this cannot be answered; creation date filters are available.
- **Duplicates**: only a checksum match on the same provider is "confirmed"; same size+name is "possible". Cleanup is always a proposal; deletion needs approval and is a two-step trash → purge.
- **TeraBox**: tools honour provider capabilities. `terabox_open` can list/rename/move/copy/delete/upload inside its application folder only; creating folders, sharing, resumable/range operations are reported as unsupported (see terabox-integration.md).
- The assistant cannot reconnect accounts (needs the browser) or change Google "anyone" permissions.

## 5. Permission and confirmation model

| Risk | Examples | Backend behaviour |
|---|---|---|
| low | list/search/report/diagnose/explain/test connectivity | runs immediately (still user-scoped) |
| medium | create folder, rename, move ≤5 files | runs immediately; **moves of >5 files ask** |
| medium (asks) | trash, move >5, create share link, change routing policy/account routing | confirmation required |
| high | purge (permanent delete), revoke links, disconnect, start migration | confirmation required + explicit "I understand" tick on the card |

Enforcement (all server-side): the model cannot lower a tool's risk, skip confirmation or approve one.
A pending action is stored with the **exact validated arguments**, a SHA-256 over them, a server-generated
preview (counts, sample names, warnings, built from real data and re-checked for ownership) and an expiry.
Approval (`POST /ai/confirmations/:id/approve`, authenticated browser request) is one atomic
`PENDING → CONSUMED` update, so replays, double clicks, expired, other-user and altered requests fail;
the stored arguments are re-hashed and re-validated before running. Only one confirmation-needing call
is processed per model turn; remaining calls in that turn are skipped and must be proposed again.
Ownership is re-checked at execution time (permissions may change between plan and execution). Cancelling
a task closes its confirmation.

## 6. Conversations, tasks and data kept

Tables: `ai_conversations`, `ai_messages`, `ai_tasks`, `ai_tool_executions`, `ai_action_confirmations`,
`ai_usage_records` (all cascade-delete with the user). Stored: your messages, the assistant's visible text,
structured tool calls/results **after scrubbing** (secret-shaped keys and credential-looking strings
redacted, control characters stripped), task status/step counters, confirmation data, token counts.
Not stored: hidden reasoning, tokens/keys, file contents, share URLs (those go only to the browser).
Delete a conversation from the UI to remove all of it; conversations idle for `AI_RETENTION_DAYS` are purged
daily (never one with a running/pending task); usage rows are kept 35 days.

Tasks run inside the API process and are persisted after every step. A restart marks interrupted tasks
`FAILED` on boot; tasks waiting for approval survive restarts (their card reappears) until the confirmation
expires. Idempotency: a tool-call id is executed at most once per task. Long operations are background jobs
(`get_job_status` reports the real job).

## 7. Security summary

- Authentication/rate limits on every `/ai` route (20 messages/min, 30 direct tool runs/min per user, 16 KB body limit).
- Prompt injection: tool data is sanitised and wrapped in `<untrusted_data>`; the system prompt says it carries no authority, **but nothing relies on that** – scoping, risk policy, confirmation and limits are code. A test drives a "gullible" model that obeys an injected file name and shows it still cannot delete anything.
- Every database access made by any tool is `userId`-scoped (a generic test inspects all queries of all tools); foreign ids are indistinguishable from missing ones.
- No credentials in outputs (views have no token fields; output is scrubbed again); share URLs are shown to the user only.
- Direct tool endpoint (`POST /ai/tools/:name/run`) runs only read-only tools and works without a model (degraded mode).
- Audit: mutations write the existing audit actions (`TRASH_FILE`, `MOVE_FILES`, …) plus `AI_*` actions and `AI_TOOL_EXECUTED`; metadata holds ids/counts, not file contents.

## 8. Troubleshooting

| Symptom | Cause / action |
|---|---|
| Page says "AI assistant is not available" + reason | set the variable named in the reason and restart the backend |
| `MODEL_AUTH` in the assistant's error message | wrong/expired `AI_API_KEY` (or wrong `AI_BASE_URL`) |
| `MODEL_NOT_FOUND` | model id not available for that key/endpoint |
| `MODEL_RATE_LIMITED` | provider quota; retries are bounded, try again later or raise the provider limit |
| Assistant answers but never acts | the model has no tool-calling support; choose another model |
| "Another request … still running or waiting" (409) | approve/decline the card or press Stop; confirmations expire after `AI_CONFIRMATION_TTL_SECONDS` |
| `The daily AI usage limit has been reached` | `AI_DAILY_TOKEN_LIMIT` (resets at 00:00 UTC) |
| Backend logs `retention run failed` / 500 on `/ai/*` right after upgrade | migration not applied: run `npm run db:migrate:deploy` |
| Task `FAILED: interrupted by a server restart` | restart during a request; send it again |

Read-only quick actions on the page keep working when the model is down.

## 8b. Admin console (AI Manager)

Page **AI Manager** (`/ai-manager`, admins only; the API answers 403 to everyone else via `requireRole('admin')`).
Shows the active provider/model/endpoint *host* and whether a key is set (never the key or full URL), the
effective limits (read-only: they are the `AI_*` environment variables), 7-day token usage by model, tasks
by status, per-tool success/failure/latency, and recent tasks across users (user id prefix, status, counts —
no message text or tool arguments). Actions: **Test connection** (one tiny tool-less model request) and
**Stop** on any running task. Endpoints: `GET /ai/admin/overview`, `POST /ai/admin/test`,
`POST /ai/admin/tasks/:id/cancel` (audited as `AI_ADMIN_TEST` / `AI_ADMIN_CANCEL_TASK`).
Changing the provider, model or key is deliberately **not** possible from the UI: they live in the backend
environment and need a restart.

## 9. Verification status

| Area | Status |
|---|---|
| Model adapters (OpenAI-compatible, Anthropic): request/response mapping, retries, timeouts, cancellation, error normalisation | Implemented and verified against a local HTTP fake; **not live-verified** (no credentials) – use the optional live test |
| Orchestrator, risk policy, confirmations, limits, cancellation, idempotency, recovery, retention | Implemented and verified with a scripted model and in-memory store |
| Tools (32): behaviour, ownership, verification text, partial failure | Implemented and verified against a stateful fake of Prisma and mocked adapters; real provider calls (rename/purge via adapters, `start_migration` enqueue, live quota/health) **not live-verified** |
| Prisma store + migration SQL | Type-checked against the generated client; **never executed against Postgres** (none available); apply and smoke-test once on a real database |
| HTTP API | Verified over real HTTP with mocked auth/runtime; DB-backed integration not run |
| Frontend (ar/en/fr, RTL, confirmation, progress, cancel, errors, keyboard) | 37 automated tests + manual visual check (dark/light, RTL) against a mock API |
| Existing 9Drive suite | 811 passed before the AI frontend work; 15 DB/Redis-dependent files fail identically with and without these changes (no Postgres/Redis here); `queue-definitions.test.ts` fails on `origin/main` independently of this work (a lock-duration mismatch introduced by commit 8447873) |
