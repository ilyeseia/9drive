# 9Drive Mobile — architecture

## Layers and rules

```
UI (features/*, ui/*)  ──►  queries/hooks (TanStack Query)  ──►  endpoint modules (api/endpoints/*)  ──►  ApiClient
        │                                                                                                   │
        └── navigation, i18n, theme                                   Zod validation ◄── fetch ◄── retry/timeout/auth
services (app/services.tsx): ApiClient · SessionManager · LockController · TransferManager · QueryClient
```

- **UI never calls `fetch`.** Only `api/client.ts` (and the transfer transports in `transfers/device.ts`) do; an
  executable rule enforces it (`src/test/architecture-rules.test.ts`).
- **Every response is validated** with Zod at the boundary (`api/endpoints/*`). Unknown fields are stripped;
  violations become `ApiError('invalid_response')`.
- **The server is authoritative.** The app never decides storage placement, ownership, roles or AI actions; it shows
  and edits settings and renders server results. No optimistic success: mutations succeed only when the server says
  so and lists are then refetched.
- **Errors** are typed (`ApiErrorKind`) and shown from the app's own translated catalogue; server text is never
  displayed verbatim.

## Session and security core

- `auth/session.ts` — sign-in/register/restore/sign-out; **single-flight refresh** (the backend revokes a session when
  a rotated refresh token is reused); the new token pair is persisted **before** the new access token is used; a
  transient failure never ends the session; sign-out always wipes local credentials, caches, transfers and downloads.
- `auth/tokenStore.ts` — the only credential store: Keychain/Keystore, `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, validated on
  read, corrupt blobs wiped.
- `auth/lock.ts` — optional device-authentication lock; cold start locks; idle and background timeouts; fail-closed;
  enabling/disabling requires authentication. It is a local privacy screen, not authentication.
- `core/logger.ts` — the single logging path; redacts tokens, JWTs, signed-URL parameters and sensitive keys.

## Transfers

`transfers/upload.ts` implements the backend's provider-neutral resumable protocol (`/uploads/resumable/*`):
server-confirmed progress; after any failed chunk it asks the server for the offset and continues from there;
bounded retry for transient errors only; idempotent via `clientUploadId`; one chunk in memory at a time.
`transfers/manager.ts` queues uploads/downloads (2 at a time), persists unfinished uploads (no tokens) so they can be
resumed after a restart, and never retries silently beyond the runner's policy. Downloads go through the
authenticated Range-capable endpoint into the app cache and are handed to the OS share sheet.
There is **no guarantee of background transfer**: iOS/Android may suspend the app; resumable upload is the recovery.

## Offline

Queries pause offline and keep showing their last data; mutations use `networkMode: 'always'` so they fail
immediately instead of being queued (no silent deferred destructive actions). An opt-in copy of list metadata
(`core/offlineCache.ts`) is allow-listed, validated on restore, capped at 7 days and deleted on sign-out.

## AI assistant

`features/assistant/*` is a client of the existing orchestrator in `backend/src/modules/ai`. It sends text, polls the
persisted task, shows steps, and presents proposals as approval cards; approving sends the `argsHash` that was shown.
Answers render through a restricted Markdown component; links are inert text.

## Why React Native + Expo

See [00-audit-and-plan.md §6](00-audit-and-plan.md). In short: one strongly-typed codebase, first-party maintained
modules for every native capability needed (secure storage, local authentication, file system with streaming
uploads/downloads, pickers, share sheet), no custom native code, and a managed/CNG workflow with EAS for releases.

## Design system

Tokens in `theme/theme.tsx` (light/dark palettes whose contrast ratios are unit-tested, spacing, radius, 48 dp
minimum target). Components in `ui/*` use logical start/end properties so layouts mirror in RTL, expose roles/labels/
states for assistive technologies, and cap font scaling at 1.6× to avoid layout breakage while honouring dynamic type.
