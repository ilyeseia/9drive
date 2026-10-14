# Storage provider architecture

This describes the abstraction **as it exists in the repository** (the task brief
assumed none; see [terabox-integration-assessment.md](terabox-integration-assessment.md)).
The normative contract is `docs/architecture/contracts/provider-contract.md`.

## Layers

```
routes / workers ──► registry.get(id) ──► StorageProvider (adapter)
        │                                    ├─ google-drive/   (OAuth2)
        │                                    ├─ s3/             (access keys; many presets)
        │                                    ├─ dropbox/ onedrive/ pcloud/ (OAuth2)
        │                                    ├─ terabox/        (legacy, cookie, experimental)
        │                                    └─ terabox-open/   (official, OAuth2 device-code)
        ▼
 providers/context.ts  buildContext(accountId)  ← only place that decrypts credentials / refreshes tokens
 providers/routing.ts  selectAccount()          ← chooses an account for an upload
 providers/health.ts   checkAccount/refreshQuota
 providers/catalog.ts  static capability + status catalogue
```

| Concern | Where |
|---|---|
| Interface and capability vocabulary | `providers/types.ts` (`StorageProvider`, `Capability`) |
| Stable errors | `providers/errors.ts` (`ProviderError`, `ERR_*`) |
| Registry/factory | `providers/registry.ts`, side-effect registration in `providers/index.ts` |
| Account/quota/health services | `modules/providers/account-service.ts`, `providers/health.ts` |
| Routing | `providers/routing.ts` |
| Shared metadata / virtual filesystem | `File`, `Folder`, `ConnectedAccount` Prisma models |

## Capabilities are explicit

An adapter declares the subset of `ALL_CAPABILITIES` it truly implements. Every method
first gates on its capability and throws `ERR_CAPABILITY_UNSUPPORTED`
(HTTP 400 `CAPABILITY_UNSUPPORTED`). There are no silent fallbacks. Routing only
considers accounts whose provider declares every capability the operation needs.

`terabox_open` declares 13 of 18: it lacks `createFolder`, `createShare`,
`revokeShare`, `uploadResumable`, `downloadRange` (none are in the official document).

## Changes made for TeraBox (all backward compatible)

| File | Change |
|---|---|
| `providers/oauth2.ts` | optional `OAuth2ClientConfig.refresh` hook for non-RFC token endpoints; generic providers unaffected |
| `providers/context.ts` | if a refresh fails but another process already stored fresh tokens, adopt them (needed for single-use refresh tokens) |
| `providers/catalog.ts` | new fields `connectMode`, `quotaPolicy`, `experimental`; new `terabox_open` entry; legacy `terabox` flagged experimental |
| `providers/routing.ts` | per-account routing switch, experimental opt-in, quota trust rule, rejection diagnostics |
| `modules/providers/*` | device-code connect routes, routing toggle route, rate limits, token erase on disconnect for `terabox_open` |
| `modules/uploads/upload.routes.ts` | "no destination" responses now list reasons |
| `config/env.ts`, compose, `.env.docker.example` | optional `TERABOX_*` settings and seed step |

No Prisma schema change.

## Adding another provider
1. Implement `StorageProvider` in `providers/<id>/`; declare only real capabilities.
2. Register it in `providers/index.ts` and add a catalog entry (status, authMode,
   capabilities, `docsUrl`, honest `notes`). Update the id lists in
   `__tests__/providers/{catalog,registry}.test.ts`.
3. For OAuth providers register an `OAuth2ClientConfig`; for non-standard token
   endpoints supply `refresh`. Use `connectMode: 'device_code'` if there is no redirect flow.
4. Add a fake-server test suite modelled on `__tests__/providers/terabox-open/`.
