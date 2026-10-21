---
name: keyframer-vitals
description: Set up Keyframer Motion Vitals (production slow-frame and janky-animation monitoring) in a React Native, Expo, iOS (SwiftUI, UIKit), Android (Compose, Views) or Flutter app, upload symbols (dSYMs, R8 mappings, Flutter split debug info, React Native site manifests), read field problems with the field_problems and field_compare MCP tools, check one locally with check and field: SHOP-12, and fix it with the local Keyframer Inspector. Use when asked to add Motion Vitals, @keyframerdev/vitals, KeyframerVitals, dev.keyframer:vitals or keyframer_vitals, to upload symbols for it, to answer App Store or Play privacy forms for it, or to fix a field problem such as SHOP-12.
---

# Keyframer Motion Vitals

Goal: the app reports slow frames from release builds to Motion Vitals, call sites have names, and field problems get fixed and confirmed. Docs: https://keyframer.dev/inspector/docs/vitals

Motion Vitals is not the inspector. The inspector is development-only and records everything; Motion Vitals goes in store builds and sends counters only (no screenshots, text, values, touches or identifiers). Never put the inspector in a release build to get field data.

## 1. Find the platform and the key

- `package.json` with `react-native-reanimated` (and `expo`): React Native. Step 2a.
- An `.xcodeproj` or `Package.swift` app with UIKit or SwiftUI: iOS. Step 2b.
- `build.gradle(.kts)` with `com.android.application`: Android. Step 2c.
- `pubspec.yaml` with `flutter`: Flutter. Step 2d.

The project's field key (`kfp_live_…`) comes from https://keyframer.dev/app/vitals: the person creates a project there and copies it. You cannot. The field key is public and may be committed; upload (`kft_`) and read (`kfw_`) keys are secret: never commit them or put them in the app.

Ask before choosing when reporting starts. By default it starts at `start`, like Sentry. If the app already has a consent tool for analytics or diagnostics, call `start` only once consent is given and `setEnabled(false)` when it is withdrawn.

## 2a. React Native and Expo

First choice: the setup wizard, without questions, with the field key the person gave you. It installs the package, adds the Babel plugin and starts the reporter with the navigation ref, so screens are named:

```sh
npx @keyframerdev/wizard --yes --products vitals --key kfp_live_… --skip-verify --no-agents
```

- Run it from the app's folder (in a monorepo, `--root apps/mobile`). `--dry-run` shows the changes without writing them.
- Without a key, the person can let the wizard find it: `--auth browser` opens keyframer.dev to approve a sign-in, then it picks or creates the project. Only use it when the person is at the browser.
- It writes the key into the start file: the field key is public, that is fine. Never pass a `kft_` or `kfw_` key.
- If the package can't be found or the wizard fails, set it up by hand below.

By hand:

```sh
npm i @keyframerdev/vitals
```

A regular dependency, it ships in release builds. At the app entry:

```ts
import { startVitals } from '@keyframerdev/vitals'
import Constants from 'expo-constants'
import { Platform } from 'react-native'

// Not expo-application: a native module added in an EAS Update crashes binaries built without it.
const build = Platform.OS === 'ios' ? Constants.platform?.ios?.buildNumber : Constants.expoConfig?.android?.versionCode

startVitals({
  key: 'kfp_live_…',
  appVersion: Constants.expoConfig?.version ?? '0',
  build: build == null ? undefined : String(build),
  navigationRef,              // React Navigation or expo-router ref; otherwise setVitalsScreen(name)
  storage: AsyncStorage,      // optional, ask first: without it nothing survives a restart (no checkpoints or retries)
})
```

Add `@keyframerdev/vitals/babel` for call sites. It coexists with the inspector's development plugin in any order:

```js
plugins: [...(dev ? ['@keyframerdev/inspector/babel'] : []), '@keyframerdev/vitals/babel'],
```

Keep `react-native-worklets/plugin` last in bare React Native. Restart Metro with `-c` after Babel changes. Optional: `<VitalsRoot>` around the app (touch windows), `device` from expo-device. In `__DEV__` it reports as `development`.

## 2b. iOS

Add the product `KeyframerVitals` from `https://github.com/keyframer-dev/inspector` (from `0.1.0`) to the app target, in every configuration; `KeyframerInspector` stays behind `#if DEBUG`.

```swift
import KeyframerVitals
KeyframerVitals.start(key: "kfp_live_…")   // App init or didFinishLaunching; Debug builds need environment: .development
```

UIKit animations are seen by themselves. SwiftUI animations are seen only when named: `KeyframerVitals.trace("card-expand") { withAnimation { ... } }` or `.vitalsTrace("card-expand", value: expanded)`. Name SwiftUI screens with `.vitalsScreen("Feed")` or `KeyframerVitals.setScreen("Feed")`. Set Debug Information Format to DWARF with dSYM File for Release.

## 2c. Android

The Gradle plugin is on Maven Central, not the Gradle Plugin Portal: check that `settings.gradle.kts` has `mavenCentral()` in `pluginManagement { repositories { … } }` (Android Studio projects do).

```kotlin
plugins { id("dev.keyframer.vitals") version "0.1.0" }
dependencies {
  implementation("dev.keyframer:vitals:0.1.0")
  implementation("dev.keyframer:vitals-compose:0.1.0")   // Compose apps
}
// Application.onCreate; debuggable builds need environment = "development"
KeyframerVitals.start(this, key = "kfp_live_…")
```

Name animations: `ObjectAnimator...kfTrack("title-fade")` (import `dev.keyframer.vitals.kfTrack`) for Views. For Compose, the tracked calls from `dev.keyframer.vitals.compose` (`kfAnimateFloatAsState(..., label = "card-press")` and the other `kfAnimate*AsState`, `Animatable.kfAnimateTo`, `kfUpdateTransition`, `rememberKfInfiniteTransition`). They share names with the inspector's Compose helpers: a file imports one set or the other, never both. Screens: `KfVitalsNavigation(navController)` next to the NavHost, `KfVitalsScreen("name")`, or `KeyframerVitals.setScreen`. Keep `-keepattributes SourceFile,LineNumberTable` in the R8 rules for exact lines.

## 2d. Flutter

```sh
flutter pub add keyframer_vitals
```

```dart
await KeyframerVitals.start(key: 'kfp_live_…', appVersion: info.version, build: info.buildNumber, appPackage: 'my_app'); // before runApp
MaterialApp(navigatorObservers: [KeyframerVitals.navigatorObserver], ...)
```

Use `VitalsAnimationController(..., name: 'card-expand')` for controllers the app constructs, and `controller.vitalsTrack('sheet')` (with `vitalsUntrack()` in dispose) for others. Optional: `VitalsScrollListener` around the app, a persistent `VitalsStorage` (shared_preferences; the default is in memory, with no checkpoints), and on Android `device: VitalsDevice(osMajor: ...)` from device_info_plus (Flutter's own OS string is the kernel's).

## 3. Upload symbols

The CLI is `npx @keyframerdev/vitals-cli symbols upload` with one flag per source kind. Every tool reads the upload key from `KEYFRAMER_VITALS_UPLOAD_KEY` (a CI secret, never in the app).

| Platform | Needed when | How |
|---|---|---|
| React Native | Only with `hashSites: true` | Build with `--reset-cache`, then `--rn-sites .keyframer/sites-<version>+<build>.json` |
| iOS | For sites without a name | A last Run Script phase: `"${BUILD_DIR%/Build/*}/SourcePackages/checkouts/inspector/ios/Tools/vitals-upload-dsym.sh"` (`KEYFRAMER_VITALS_SYMBOLS=required` in release CI), or `--dsym build/App.xcarchive/dSYMs` |
| Android | For sites without a name | The `dev.keyframer.vitals` Gradle plugin uploads after R8 (key from the variable or the `keyframerVitalsUploadKey` Gradle property); or `--mapping mapping.txt --app-version <v> --build <b>` |
| Flutter | With `--split-debug-info` | `--dsym build/symbols/app.ios-arm64.symbols` (iOS is Mach-O) and `--elf build/symbols` (Android) |

Use `--dry-run` (with `--out <dir>` to see the files) first, and `keyframer-vitals symbols inspect <path>` to check a file's debug ids. Upload for every build that ships; symbols from another build do not match.

## 4. Verify

1. Build a release build with `sampleRate: 1` (or ask the person to raise the project's rate) so the session is sampled.
2. Run it, animate something, send the app to the background.
3. The project's setup page at keyframer.dev shows the first report within a few minutes. Ask the person to check.
4. Set the sample rate back to the default before shipping.

Report what was added, the file of each change, where reporting starts (launch or after consent), and which symbol uploads are wired.

## 5. Store privacy answers

App Store: Diagnostics > Performance Data, not linked to the user, not used for tracking, purposes App Functionality and Analytics. The iOS SDK ships its privacy manifest. Google Play Data safety: App info and performance > Diagnostics, collected, not shared, encrypted in transit. Nothing else for Motion Vitals. Point the person to https://keyframer.dev/inspector/docs/vitals/store-privacy, and do not present this as legal advice.

## 6. Read field problems

The inspector's MCP server (`npx keyframer-inspect mcp`, or the desktop app's) reads them with a key in its environment: `KEYFRAMER_VITALS_READ_KEY` set to a workspace read key (`kfw_…`, Motion Vitals, Keys) or the person's `kf_` API key. Ask the person to set it where the MCP server is configured; never write it into the project. Without it the tools say so.

- `field_problems({ project: 'SHOP' })`: the top problems, most frames lost first, in the dashboard's words. Each has its id (`SHOP-12`), status (New, Came back, Worse, Ongoing, Resolving, Fixed, Ignored), call site and screen, drop rate while it runs against its screen's baseline, frames lost and sessions hit, where it hurts most (OS and tier, then each tier, each OS and the worst models), the causes of its slow frames, the version it started in, the check command and the dashboard's "Copy for your agent" prompt. `project` is the code or the project id; narrow with `version`, `os` (`ios`, `android`), `status` (default `unresolved`; `all`) and `limit` (default 5, at most 20).
- `field_compare({ project: 'SHOP', from?, to? })`: a version against another (default the latest against the one before it with enough sessions): hitch time, slow and frozen frames, janky sessions, and every problem call site as Worse, Came back, New, Still there, Better, Fixed or Ignored with its drop rate in each.

Pick by status (New, Came back and Worse first), then by frames lost. Say "dropped frames while it ran", never "caused", unless the cause mix and the local recording agree.

## 7. Fix with the local inspector

Follow the `keyframer-inspector-motion` and `keyframer-inspector-fix` skills, with the field facts as the brief:

1. Open the call site from the problem (`app/feed.tsx:42:9`, or search for the `trace`, `kfTrack` or controller name).
2. Reproduce on a device like the one it hurts most (the tier and OS). A fast simulator often hides field jank; say so if it does not reproduce, and do not claim a fix you could not measure.
3. Run `check` with `field: 'SHOP-12'` (and `scenarios`, or `recording`; from a terminal, `keyframer-inspect check --field SHOP-12`). It runs the usual check, then says whether that call site dropped frames here: **reproduced** (the local problems at the site, with their refs), or **not reproduced**, either because the site ran and dropped nothing (try a slower device) or because it did not run (check a scenario or recording that runs it). It never claims more than that. Sites match by file and line (React Native) or by the `trace`, `kfTrack` or controller name (native). Read the frames and their causes. Map the field cause: `screen-mount` (defer work until the transition ends), `burst` (stagger or animate a container), `busy-start` (React Native: start from a worklet or move the JS work), `scroll` and `gesture` (per-frame render cost).
4. Fix, then `recheck` (or `compare`) locally until the problem is gone.
5. Tell the person to mark the problem Resolving in the dashboard when the fix ships. The next version with enough sessions marks it Fixed, or reopens it. Run `field_compare` on the two versions after the release to confirm.

Never change the sample rate, project switches or keys to make a problem disappear.
