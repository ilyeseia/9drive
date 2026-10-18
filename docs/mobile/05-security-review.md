# 9Drive Mobile — security review (Phase 7)

Scope: the React Native app in `mobile/`, as of the commit that adds this file. This is an engineering self-review
backed by automated tests and tooling output. It is **not** a penetration test, a formal audit or a compliance
certification, and none is claimed.

## 1. Trust boundaries and threat model

| Asset | Threat | Control (where) | Evidence |
|---|---|---|---|
| Access/refresh tokens | read by other apps / backups / malware with file access | only in Keychain/Keystore via `expo-secure-store`, `WHEN_UNLOCKED_THIS_DEVICE_ONLY` (`auth/tokenStore.ts`); never in AsyncStorage | `architecture-rules.test.ts` (SecureStore imported by one module; AsyncStorage only by `core/prefs.ts`); `tokenStore.test.ts` |
| Refresh token | theft via race → server revokes session | single-flight refresh; persist-before-use; reuse ⇒ distinct "compromised" message (`auth/session.ts`) | `session.test.ts` (mutation-checked: 6 refresh calls without single-flight vs 1) |
| Credentials in transit | MITM / downgrade | release builds accept `https:` only, no switch to disable certificate checks (`config/env.ts`); no TLS-weakening APIs anywhere | `env.test.ts`, architecture rule "TLS is never weakened" |
| Passwords | stored or logged | never stored; redacting logger masks bearer/JWT/`token=`/keys | `logger.test.ts`, `session.test.ts` "secrets never reach the logs" |
| Logs / crash reports | leak of secrets, signed URLs | all output goes through `core/logger.ts` (redaction + size caps); raw `console.*` forbidden outside it | architecture rule, logger tests |
| Server responses | malformed or hostile data reaching the UI | every response validated with Zod; failure ⇒ typed `invalid_response`; unknown fields stripped | `contract.test.ts` (14 endpoints × 8 garbage bodies, prototype pollution, hostile error text) |
| Stolen unlocked phone | open app | optional device-auth app lock, idle + background timeout, fail-closed, privacy cover for the app switcher (`auth/lock.ts`, `LockGate`) | `lock.test.ts`. Not authentication: the server session is unchanged |
| Share links | phishing/URL injection by a compromised server; clipboard exposure | link trust-check before display/copy (`isTrustedShareUrl`); shown once; clipboard cleared best-effort after 90 s only if unchanged | `sharing.test.tsx` |
| AI output | prompt injection → action | the model only proposes; server enforces allow-list, risk policy and hash-bound single-use confirmations; app shows proposals as plain text, links inert, approve sends the shown `argsHash` | `assistant.test.tsx`; server tests in `backend/src/__tests__/ai` |
| File names | path traversal into app storage; bidi spoofing | `safeFileName` (code-point based), no `..`, no separators; bidi isolates in UI; no literal bidi controls in source | `names.test.ts`, `source-hygiene.test.ts` |
| Large/odd uploads | memory exhaustion, overflow | chunk-at-a-time reads, exact integer offsets beyond 4 GiB | `upload.test.ts` "very large files" |
| Retries | duplicated destructive/side-effect requests | retry only GET/idempotent + transient; chunk retry reconciled with server offset; `clientUploadId` idempotency | `retry.test.ts`, `client.test.ts`, `upload.test.ts` |
| Offline data | sensitive data left on device | opt-in only; allow-listed, first page, validated on restore, 7-day cap, wiped on sign-out/opt-out | `offlineCache.test.ts` |
| Offline actions | silent queued destructive operations | mutations `networkMode: 'always'` (fail fast, never queue) | `queryClient.test.ts` |
| Deep links | malicious link triggers an action | no deep-link handling is implemented; the registered `ninedrive` scheme only opens the app; no `Linking.openURL` anywhere | architecture rules |
| Authorization | cross-user access, role spoofing | enforced **server-side** on every call; the app sends no ownership/role claims. Backend isolation tests: `backend/src/__tests__/security/tenant-isolation.test.ts`, `auth.test.ts` | not re-proven client-side |

## 2. Dependency review

Commands run in `mobile/`: `npm audit`, `npm audit --omit=dev`, a bundle inspection and a lockfile scan.

- `npm audit` reports **51** findings (26 moderate, 25 high, 0 critical); `--omit=dev` reports 23 (8 moderate, 15 high).
- **All of them are in the Expo/React Native build toolchain** (`@expo/cli`, `metro*`, `@expo/config*`, `node-forge` via
  `@expo/code-signing-certificates`, `braces`/`micromatch`, `uuid` via `xcode`). The npm "fix" it proposes
  (`expo@44`, `react-native@0.72`) is a downgrade of the whole framework and is **not** a fix.
- **They are not in the shipped app.** A non-bytecode Android bundle (2.1 MB) was inspected: `node-forge`, `xcode`,
  `braces`, `micromatch`, `@expo/cli`, `metro-config` occur **0** times.
- Exposure is therefore to the developer/CI machine while building (ReDoS in `braces`, certificate-parsing in
  `node-forge` used only by Expo's own signing tooling). Mitigation: build on trusted CI runners, do not run the Expo
  tooling on untrusted project files, and update Expo patch releases as they land. This is tracked, not ignored.
- **Install-time scripts**: only 3 packages in the whole tree have any (`@parcel/watcher` build, `fsevents`,
  `unrs-resolver` postinstall) — all dev tooling. CI installs with `npm ci --ignore-scripts` where possible (see CI).
- **Licences (production tree, 517 packages)**: MIT 447, ISC 28, Apache-2.0 6, BSD 9, MPL-2.0 12, others permissive.
  No GPL-only component (one dual "BSD-3-Clause OR GPL-2.0" is used under BSD). MPL-2.0 is file-level copyleft and
  applies only to unmodified third-party files.
- **Direct dependencies (33)** are all MIT (TypeScript is Apache-2.0), from first-party Expo, React/React Native,
  TanStack, React Navigation, Software Mansion, Callstack and Colin McDonnell (zod) — widely used, actively maintained.
  `@react-native-async-storage/async-storage` and `@react-native-community/netinfo` are the two community modules;
  both are the standard choices for their purpose.
- Re-evaluate on every dependency update; Dependabot-style updates are enabled in CI configuration (Phase 8).

## 3. What was tested (summary)

`npm test` runs 240+ tests: unit (client, retry, errors, logger, i18n, theme contrast), session/lock lifecycle,
transfer engine against a fake server that mimics the real resumable protocol, screen-level integration tests for
every feature, and the security rules in §1. Integration tests use an in-memory server, **not** a live 9Drive
backend — they prove the app's behaviour against the documented contract, not the backend itself.

## 4. Known gaps and residual risks

1. **Offline copy is not encrypted at rest.** It holds file/folder names, sizes, dates and account e-mails. It is
   opt-in, off by default, bounded and wiped on sign-out; device encryption (iOS Data Protection, Android FBE)
   still applies. Encrypting it with a Keystore key would need a native module.
2. **Cached downloads** live in the app cache until sign-out/startup cleanup; the OS may also keep them in
   its own backups depending on platform settings.
3. **Rooted/jailbroken devices, screenshots, screen recording and malware** are not defended against. FLAG_SECURE /
   screenshot blocking is not enabled (it would block legitimate use); the app-switcher cover is provided.
4. **Biometric prompt, native upload/download, pickers and the share sheet were not run on a device** here (no
   Android SDK or Xcode on the build machine). Their logic is covered by tests with fakes.
5. **Clipboard clearing** is best-effort (works only while the app is alive and the value is unchanged).
6. **No certificate pinning.** Normal OS validation only. Pinning adds outage risk (rotation) and was not requested
   as a hard requirement; it can be added with a maintained native module if the deployment needs it.
7. **Backend quirks that affect safety/usability** (documented in `00-audit-and-plan.md`): share links have a fixed
   30-day expiry and no options; revoke is all-or-nothing per file; `PATCH /files/:id` uses the Google API for every
   non-S3 provider; Google sign-in cannot complete inside the app.
8. **Vulnerability reporting**: see `SECURITY.md` at the repository root of `mobile/` (added in Phase 8).

## 5. Findings fixed during development (found by tests or tooling)

- Upload retry budget was effectively unbounded (found by the retry-budget test).
- Downloaded file names could contain `..` (found by the file-name test).
- Source contained literal invisible bidi-control characters; now built from code points and guarded by a test.
- A new chat's first message could race with the app adopting the conversation id and lose its task (found by the
  assistant flow test).
- A test-only gap pushed commit `93dc0bf` with failing tests (NetInfo mock); fixed in `cfc4b8e` and the release
  gate now blocks pushes on any failure.
