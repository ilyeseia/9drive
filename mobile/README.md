# 9Drive Mobile

Android and iOS client for the [9Drive](../README.md) storage gateway. React Native + strict TypeScript on Expo
(SDK 58). It talks to the existing 9Drive backend through its authenticated REST API; the server stays authoritative
for authorisation, storage placement, quotas and the AI assistant.

> Status: all planned phases are implemented and verified with automated tests, type-checking, linting and Metro
> bundle exports for both platforms. **It has not been run on a physical device or emulator yet** (the build machine
> had no Android SDK or Xcode). See [what is and is not verified](../docs/mobile/04-behaviour-and-limits.md#verification-status).

## What it does

- Sign in/out with secure session handling (Keychain/Keystore), optional biometric/passcode app lock.
- Browse, search, sort, filter files and folders; rename, move, copy, trash; multi-select.
- Resumable chunked uploads (files, photo library, camera) and authenticated downloads with honest progress,
  cancel, resume.
- Storage accounts with capacity/health, routing policy view/edit and a placement preview; S3-compatible connect.
- Public share links (with warnings), shared-links list, revoke.
- AI assistant chat on the existing server-side orchestrator, with approval cards for sensitive actions.
- Arabic (RTL), English, French; light/dark; opt-in offline copy of list metadata.

## Documentation

| Doc | Contents |
|---|---|
| [00 Audit and plan](../docs/mobile/00-audit-and-plan.md) | what the backend really offers, decisions, quirks |
| [01 Architecture](../docs/mobile/01-architecture.md) | structure, data flow, key design decisions |
| [02 Development](../docs/mobile/02-development.md) | setup, env vars, device networking, i18n, tests, troubleshooting |
| [03 Release](../docs/mobile/03-release.md) | Android/iOS builds, signing, TestFlight, checklist |
| [04 Behaviour and limits](../docs/mobile/04-behaviour-and-limits.md) | offline matrix, accessibility/RTL, performance, limitations |
| [05 Security review](../docs/mobile/05-security-review.md) | threat model, dependency audit, residual risks |
| [SECURITY.md](SECURITY.md) | how to report a vulnerability, incident response |

## Quick start

```bash
cd mobile
npm ci
cp .env.example .env        # set EXPO_PUBLIC_API_URL (see below)
npm run check               # typecheck + lint + format + tests
npx expo start              # then press a (Android) / i (iOS) or scan the QR in Expo Go
```

`EXPO_PUBLIC_API_URL` is the only required setting. **`localhost` on a phone is the phone itself**, not your computer —
see [device networking](../docs/mobile/02-development.md#reaching-your-backend-from-a-device).

Prerequisites: Node 22 (20+ works), npm 10, and for running on devices Android Studio (SDK 35+ and an emulator) and/or
Xcode 16+ on macOS. Expo Go cannot run every native module used here (secure store options, local authentication);
use a development build (`npx expo run:android` / `run:ios`, or EAS `development` profile).

## Scripts

| Command | Does |
|---|---|
| `npm run typecheck` | `tsc --noEmit` (strict, `noUncheckedIndexedAccess`) |
| `npm run lint` | ESLint with `--max-warnings 0` |
| `npm run format:check` / `format` | Prettier |
| `npm test` | Jest (jest-expo + Testing Library) |
| `npm run check` | all of the above |
| `npm run scan:secrets` | fails on secret-looking strings in tracked files |
| `npm run export:check` | Metro bundle for Android (add `--platform ios` for iOS) |
| `npm run doctor` | `expo-doctor` configuration checks |

## Layout

```
src/
  api/          typed HTTP client, errors, retry policy, per-feature endpoint modules with Zod schemas
  app/          composition root (services), query client, offline cache controller
  auth/         session manager, secure token store, app lock, biometrics
  config/       environment validation (HTTPS-only in release)
  core/         redacting logger, prefs, clipboard, network, offline cache, bidi helpers
  features/     auth, files, storage, sharing, assistant, settings (screens + queries)
  i18n/         message catalogue (en/ar/fr), RTL, formatting
  navigation/   tab + stack navigators
  theme/ ui/    design tokens and accessible components
  transfers/    resumable upload runner, queue manager, device integration, safe names
  test/         shared test harness and executable security/architecture rules
```

## Licence

Apache-2.0, same as the rest of the repository.
