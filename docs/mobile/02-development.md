# 9Drive Mobile — development guide

## Toolchain

| Tool | Version used | Notes |
|---|---|---|
| Node | 22 (20+ works) | `node -v` |
| npm | 10 | lockfile is `package-lock.json`; always `npm ci` |
| Expo SDK | 58 | React Native 0.88, React 19, TypeScript ~6 |
| Android | Android Studio, SDK 35+ | needed to run/build on Android |
| iOS | Xcode 16+ on macOS | iOS builds are impossible on Windows/Linux locally; use EAS Build |

## Install and run

```bash
cd mobile
npm ci
cp .env.example .env          # PowerShell: Copy-Item .env.example .env
# edit EXPO_PUBLIC_API_URL
npx expo start                # dev server; press a / i, or use a development build
npx expo run:android          # builds & installs a development build (needs the Android SDK)
npx expo run:ios              # macOS only
```

## Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `EXPO_PUBLIC_API_URL` | yes | API origin (+ optional path prefix) of your 9Drive backend, e.g. `https://drive.example.com` |

`EXPO_PUBLIC_*` values are **embedded in the app bundle and public** — never put a secret, token or key in them.
Rules enforced by `src/config/env.ts`: release builds accept `https:` only; debug builds may use `http:` (flagged in
Settings); no credentials, query string or fragment in the URL. A missing/invalid value shows an explanatory screen
instead of crashing. `.env` is git-ignored; only `.env.example` is committed.

## Reaching your backend from a device

`localhost` / `127.0.0.1` **on a phone refers to the phone itself**, not your computer.

| Where the app runs | Use for `EXPO_PUBLIC_API_URL` |
|---|---|
| Android emulator | `http://10.0.2.2:4000` (the emulator's alias for the host machine) |
| iOS simulator | `http://localhost:4000` |
| Physical phone on the same Wi-Fi | `http://<your computer's LAN IP>:4000` (backend must listen on `0.0.0.0` and the firewall must allow it) |
| Physical phone anywhere | an HTTPS URL: a reverse proxy, Tailscale (`https://<machine>.<tailnet>.ts.net`), or a tunnel |

The backend's CORS setting does not apply to native apps (no browser origin), but its rate limits do. Plain `http://`
works only in debug builds; Android blocks cleartext in release and the app refuses it by design. On iOS, App
Transport Security may block plain HTTP to a LAN IP in some configurations — if so, use HTTPS (a tunnel or a local
certificate trusted by the device). Never hard-code a private address into a production build.

## Localisation workflow (ar / en / fr)

All strings live in `src/i18n/messages.ts`. English is the source: `MessageKey` is derived from it and the Arabic and
French dictionaries are typed `Record<MessageKey, string>`, so a missing translation is a **compile error**; a unit
test also checks key parity and that every translation uses the same `{placeholders}`.

1. Add the key + English text to `en`, then the Arabic and French text (compile errors guide you).
2. Use `const { t } = useI18n(); t('myKey', { name })`. Never concatenate translated fragments.
3. File names, e-mails and other untrusted text go through `isolate()` (`i18n/format.ts`); sizes through `formatBytes`
   (always left-to-right) so numbers stay beside their unit in RTL text.
4. Switching between LTR and RTL needs an app restart on React Native; Settings shows a notice when it is required.

## Testing

```bash
npm test                      # everything (~1–2 min cold; the first render per file pays the Babel transform)
npx jest src/transfers        # a folder
npx jest -t "single-flight"   # by name
npm run check                 # typecheck + lint + format + tests (what CI runs)
npm run scan:secrets
```

What the tests are (and are not): unit tests; session/lock/transfer logic against fakes that mimic the real server
(including the resumable-upload protocol); screen-level integration tests with an in-memory server; and executable
security rules (`src/test/architecture-rules.test.ts`). They do **not** talk to a live backend, and native modules
are mocked — device behaviour (biometric prompt, native upload/download, pickers, share sheet) must be checked
manually; see the [manual test checklist](03-release.md#manual-device-test-checklist).

## Debugging and troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| "Server address not configured" screen | `EXPO_PUBLIC_API_URL` missing when Metro/EAS started; restart with `npx expo start -c` |
| "Secure connection required" | a release build with an `http://` URL — use HTTPS |
| Login shows "offline / cannot be reached" on a device | `localhost` was used; see the table above |
| Session ends right after login | server clock/secret changed, or refresh-token reuse was detected (the app says so) |
| `Could not find a native module` | running in Expo Go; use a development build |
| Jest hangs at the end | the config uses `forceExit` (React Native list timers); investigate with `--detectOpenHandles` |
| Layout not mirrored after choosing Arabic | restart the app (React Native applies RTL on launch) |
| `npm audit` shows many findings | all are in the build toolchain and absent from the bundle; see the security review |

Logs: use `src/core/logger.ts` (`log.debug/info/warn/error`); debug/info are emitted only in debug builds, and every
event is redacted. Do not add raw `console.*` calls (an architecture test fails on them).
