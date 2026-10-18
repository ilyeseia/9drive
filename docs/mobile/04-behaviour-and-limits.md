# 9Drive Mobile — behaviour, accessibility, performance and limits

## What works offline and what does not

| Capability | Offline? | Detail |
|---|---|---|
| Browse file/folder/account lists | **only with "Offline copy" on** | opt-in; first page of allow-listed lists; each list says "Saved copy from <date>. It may be out of date." |
| Open the app, see settings, app lock | yes | |
| Open/preview/download a file | no | needs the server (and the provider) |
| Upload | no | fails with a clear message; an interrupted upload resumes (from the server's confirmed offset) when you tap **Resume** — it is never restarted or queued silently |
| Rename, move, copy, trash, share, revoke, routing, disconnect, AI chat | no | mutations are never queued; they fail immediately with an "offline" message |
| Sign in | no | |
| Sign out | yes (locally) | local credentials are removed even if the server cannot be told; the app says when the server could not confirm |

Why nothing is queued: a delayed destructive action firing minutes later, after the situation changed, would be
surprising and unsafe. Re-validating permissions and state at execution time requires the server, i.e. a connection.

## Accessibility and RTL

Implemented and unit/integration tested:
- Roles, labels and states on every interactive element; progress bars with values; alerts announced (`role=alert`,
  live regions); modals marked as modal; the locked screen hides the app content from screen readers.
- Touch targets ≥ 48 dp; AA contrast (≥ 4.5:1) for text and filled buttons in both light and dark palettes (computed in
  `ui.test.tsx`); dynamic type honoured with a 1.6× cap.
- Arabic (RTL), English, French; logical start/end spacing; bidi isolates around file names/e-mails; sizes always
  left-to-right; Arabic/Latin mixed names, numbers and dates covered by tests and by the Arabic screen tests.
- Layout mirroring requires an app restart after switching to/from Arabic (a React Native limitation); the app says so.

**Not verified:** behaviour with TalkBack/VoiceOver on a real device, large-text devices, and RTL visual layout on
screen — these need a manual pass (checklist in [03-release.md](03-release.md)).

## Performance and reliability measures

- Virtualised lists (`FlatList`, windowed rendering), debounced search (350 ms), server-side sort/filter/paging;
  query cache with explicit invalidation after each successful mutation; refetch is explicit, not on every focus.
- Bundle: the Android Hermes bundle is ~2.1 MB (JS) with 33 direct dependencies; no analytics/crash SDK.
- Uploads: one chunk in memory at a time (5 MiB), streaming Blob slices, exact integer offsets beyond 4 GiB (tested).
- Network: configurable timeouts (20 s default, 120 s per upload chunk), bounded exponential backoff with full jitter,
  `Retry-After` honoured (capped), retries only for safe/idempotent requests and transient failures.
- **No measurements on a device exist yet** (cold start time, frame rate, memory). Profile on target devices before
  optimising; none of the above was tuned from measurements.

## Known limitations (backend-driven)

- No password recovery/verification, MFA, push notifications or device-session list in the backend → not in the app.
- Google sign-in and provider connection (Google Drive, Dropbox, OneDrive, pCloud, TeraBox) need a browser flow that
  redirects to the web app → connect them on the web; they then appear in the app.
- Share links: fixed server expiry (currently 30 days), no password/limit options, shown once, revoke-all per file.
- File-list cursor paging works only for date sorting; name/size sorts load one page of up to 200 results.
- `PATCH /files/:id` (rename/move) is implemented against the Google API for every non-S3 provider on the server today;
  such operations may fail for other providers and the app reports the server's refusal.
- Editing account labels and file-type routing rules is not available through the API (shown read-only).

## Not implemented

Push notifications, deep links, background (OS-level) transfers, document scanning, home-screen widgets, tablet-
specific layouts, certificate pinning, offline queue of changes, in-app trash/restore screen (use the web app),
TeraBox QR/device-code connect, Google sign-in inside the app.

## Verification status

| Area | Status |
|---|---|
| Type-check, lint, format, 255+ automated tests, `expo-doctor` | **implemented and verified** (run in CI-equivalent form locally) |
| Android and iOS JavaScript bundles (Metro/Hermes export) | **verified** |
| Session/refresh/lock/transfer/offline/AI logic against fakes mimicking the backend contract | **verified** |
| Live backend integration (real login, upload, download, sharing, AI) | **not verified** — no environment; the contract was read from source and the web client |
| Native behaviour on device (biometrics, pickers, native upload/download, share sheet, secure store) | **implemented, not verified on a device** |
| Android APK/AAB, iOS IPA builds and signing | **not built** (no SDK/Xcode/credentials on the build machine); procedures documented |
| Store publication | **not done** |
