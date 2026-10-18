# 9Drive Mobile — build, signing and release

> **Honest status:** the Metro bundles for Android and iOS export successfully and `expo-doctor` passes, but **no
> native binary (APK/AAB/IPA) has been built or signed** — the build machine had no Android SDK, no Xcode and no
> Apple/Google credentials. Everything below marked *(unverified)* was written from the tool documentation and must be
> run once on a suitably equipped machine. **Nothing has been published to Google Play or the App Store.**

## 0. Before the first release

1. Replace the placeholder identifiers in `app.json`: `ios.bundleIdentifier` and `android.package`
   (currently `app.ninedrive.mobile`) with ones you own; set `name`, `slug`, `scheme`, `version`.
2. Replace the icons/splash in `assets/` (the Expo placeholders are still there).
3. Decide the production API URL (HTTPS). Set it as an EAS environment variable / CI variable, never in git.
4. Create the signing credentials (below). **Never commit** keystores, `.p8/.p12`, provisioning profiles, or `.env`
   (they are in `.gitignore`).
5. Re-read [05-security-review.md](05-security-review.md) §4 (residual risks).

## 1. Recommended path: EAS Build *(unverified)*

`eas.json` defines three profiles: `development` (dev client, internal), `preview` (internal APK / ad-hoc), and
`production` (store builds, auto-incrementing build numbers).

```bash
npm i -g eas-cli
eas login
eas build:configure                       # first time: links the project
eas env:create --name EXPO_PUBLIC_API_URL --value https://drive.example.com --environment production
eas build --platform android --profile production      # AAB for Google Play
eas build --platform ios --profile production           # IPA for TestFlight/App Store (EAS runs macOS for you)
eas submit --platform android                           # needs a Play service-account key
eas submit --platform ios                               # needs an App Store Connect API key
```

EAS can generate and store the Android keystore and the iOS certificates/profiles for you (`eas credentials`); keep
an encrypted backup of the Android upload key — losing it blocks updates.

## 2. Android, locally *(unverified)*

Prerequisites: JDK 17, Android SDK (platform 35 + build-tools), `ANDROID_HOME` set.

```bash
cd mobile
npx expo prebuild --platform android --clean   # generates android/ (git-ignored)
cd android && ./gradlew bundleRelease          # AAB;  ./gradlew assembleRelease for an APK
```

Signing: the generated release build is signed with the **debug** key until you configure a release keystore.
Create an upload key once, keep it outside the repo, and inject it from CI secrets:

```bash
keytool -genkeypair -v -storetype PKCS12 -keystore 9drive-upload.jks -alias upload -keyalg RSA -keysize 2048 -validity 10000
```

Add a `signingConfigs.release` block reading `storeFile/storePassword/keyAlias/keyPassword` from environment
variables (or Gradle properties) and reference it in `buildTypes.release` (do this through an Expo config plugin so
`prebuild --clean` keeps it). Enroll in Play App Signing; the key above is then only the *upload* key.

## 3. iOS *(unverified)*

Requires macOS, Xcode 16+, and an Apple Developer Program membership.

```bash
cd mobile
npx expo prebuild --platform ios --clean       # generates ios/ (git-ignored)
cd ios && pod install
xcodebuild -workspace 9Drive.xcworkspace -scheme 9Drive -configuration Release -destination 'generic/platform=iOS' archive -archivePath build/9Drive.xcarchive
```

Signing: choose your team in Xcode (Signing & Capabilities) or use EAS-managed credentials. Face ID usage text is
already configured (`expo-local-authentication` plugin). Export with an `ExportOptions.plist` (method `app-store`) and
upload with `xcrun altool`/Transporter, or let `eas submit` do it.

### TestFlight preparation

1. App Store Connect → create the app with your bundle ID.
2. Upload a build (EAS submit or Transporter); wait for processing.
3. Fill *Test Information*, add internal testers (no review) or external testers (Beta App Review).
4. Provide the **App Privacy** answers from the table below.
5. Export compliance: the app only uses standard OS encryption (HTTPS/Keychain); `ITSAppUsesNonExemptEncryption` is
   set to `false` in `app.json` — confirm this matches your legal assessment.

## 4. Privacy declarations (what the app collects)

| Data | Where it goes | Notes |
|---|---|---|
| E-mail, name | your 9Drive server | account identity |
| File/folder names, sizes, dates, storage-account e-mails | your 9Drive server; optionally cached on the device (opt-in) | |
| Photos/files the user picks to upload | your 9Drive server, then the user's storage providers | only what the user selects |
| Diagnostics | **none leaves the device**: there is no analytics or crash-reporting SDK | a log sink can be attached later; it receives redacted events only |

Permissions requested: camera (only when the user chooses *Take a photo*), Face ID/biometrics (app lock). Not
requested: location, contacts, microphone (blocked in `app.json`), broad media-library access (system picker used).

## 5. CI

`.github/workflows/mobile-ci.yml` runs on changes under `mobile/`: install (`npm ci --ignore-scripts`, verified to
work), typecheck, lint, format check, secret scan, tests, `expo-doctor`, Android and iOS Metro bundle exports, and
`npm audit` (fails on **critical**, uploads the full report; the known toolchain-only findings are documented in the
security review). It cannot build native binaries; run EAS or a macOS runner for that. The workflow was validated
for syntax and its commands were run locally, but **has not been executed on GitHub Actions yet**.
Pin third-party actions to commit SHAs in your fork.

## 6. Versioning and changelog

Semantic versioning in `app.json` (`expo.version`); build numbers are managed by EAS (`autoIncrement`). Record user-
visible changes in `mobile/CHANGELOG.md` before each release.

## 7. Release checklist

- [ ] Placeholders replaced (bundle id/package, icons, name); production HTTPS API URL set via secrets
- [ ] `npm run check`, `npm run scan:secrets`, `npm run export:check` green on the release commit
- [ ] `npm audit --omit=dev` reviewed; no new finding that reaches the bundle
- [ ] Backend deployed with the endpoints this app version needs (see `00-audit-and-plan.md`)
- [ ] Signing credentials present in the secret store, backed up; **not** in git
- [ ] Manual device checklist below passed on at least one Android and one iOS device
- [ ] Privacy declarations match section 4
- [ ] CHANGELOG updated; version bumped; tag created
- [ ] Rollback plan: previous build stays available in the store/TestFlight; server remains backwards compatible

## Manual device test checklist

Run on a real device on Wi-Fi *and* on mobile data, in English and Arabic, light and dark:

1. Fresh install → sign in → force-quit → reopen: still signed in. Sign out → credentials gone (reopen shows sign-in).
2. Wrong password, airplane mode during sign-in: friendly errors, no crash.
3. Enable app lock (Face ID/fingerprint/passcode): background the app → locked; cancel the prompt → stays locked;
   app-switcher preview shows no content.
4. Upload a 1 MB file, a 100 MB+ file, a photo, a video, from camera: progress moves; kill the app mid-upload,
   reopen, **Resume** completes it without a duplicate file.
5. Upload while toggling airplane mode: it fails/pauses with a clear message and resumes on request.
6. Download a PDF and an image: share sheet appears; cached copy is removed after sign-out.
7. Rename/move/copy/trash a file; confirm each change is visible in the web app.
8. Create a share link: warning shown, link opens in a browser without signing in; revoke → link stops working.
9. Storage tab: capacity/health look right; toggle "use for new uploads"; preview placement.
10. Assistant: ask a read-only question; ask for a deletion → approval card; decline; approve a harmless action.
11. Offline mode (if enabled in Settings): lists show with a "saved copy" note; changes fail with a clear error.
12. TalkBack/VoiceOver: all controls are reachable and labelled; text size at maximum does not break layouts.
