---
title: Symbols
description: Upload dSYMs, R8 mappings, Flutter split debug info and React Native site manifests so call sites have names, files and lines.
order: 8
section: Motion Vitals
---

# Symbols

Release builds are stripped, renamed or obfuscated, so the SDKs can send only addresses or renamed frames for animations you did not name. Upload your build's symbols and the dashboard turns them into functions, files and lines.

| Platform | Without uploads | Upload | How |
|---|---|---|---|
| React Native | `file:line:column` already, from the Babel plugin | Only with `hashSites: true`: the sites manifest | The CLI |
| iOS | `trace` and `.vitalsTrace` names, view controller types | The dSYMs | An Xcode build phase, or the CLI |
| Android | `kfTrack` names and Compose labels, the activity | The R8 mapping | The Gradle plugin, or the CLI |
| Flutter | `VitalsAnimationController` and `vitalsTrack` names | The split debug info | The CLI |

Names you give work without any upload. The project's overview says which symbols are missing for the latest version.

Symbols are extracted on your machine or CI, never on Keyframer's servers: the CLI reads the debug information (in WebAssembly, no native module), keeps only function names, files and line tables, and uploads them in small chunks. Source code is never uploaded.

## The upload key

Uploads need the project's upload key, `kft_…`, made in the project's settings. It is secret: keep it in CI secrets or your keychain, never in the app. Members, admins and owners can create one. Every tool reads it from the same variable:

```sh
export KEYFRAMER_VITALS_UPLOAD_KEY=kft_…
```

## The CLI

```sh
npx @keyframerdev/vitals-cli symbols upload --dsym build/App.xcarchive/dSYMs
```

The command is `keyframer-vitals`, from the npm package `@keyframerdev/vitals-cli`. It needs Node 18 or later. Each source flag can repeat, and several kinds can go in one call.

| Flag | What it uploads or sets |
|---|---|
| `--dsym <path>` | A `.dSYM` bundle, its DWARF file, or a folder of `.dSYM` bundles. Flutter's iOS `.symbols` file too |
| `--elf <path>` | An ELF file with DWARF, or a folder of them (Flutter's Android `--split-debug-info` output) |
| `--mapping <path>` | An R8 `mapping.txt`; needs `--app-version` and `--build`, or `--debug-id` |
| `--rn-sites <path>` | A React Native sites manifest, `.keyframer/sites-<version>+<build>.json` |
| `--app-version <v>`, `--build <b>` | The app version and build (required for a mapping without a debug id; recorded with the others) |
| `--app-id <id>` | The bundle id or package name, recorded with the upload |
| `--debug-id <id>` | The Gradle plugin's build id for a mapping, or the id of an ELF without a build id |
| `--key kft_…` | Instead of `KEYFRAMER_VITALS_UPLOAD_KEY` |
| `--endpoint <url>` | Instead of `https://vitals.keyframer.dev` (or `KEYFRAMER_VITALS_ENDPOINT`) |
| `--dry-run` | Builds everything and uploads nothing; with `--out <dir>`, writes the manifests and chunks there to look at |
| `--no-swift-demangle` | Keeps Swift names mangled (on macOS they are demangled with `xcrun swift-demangle`) |
| `--concurrency <n>` | Chunks uploaded at once (default 4) |

`keyframer-vitals symbols inspect <path>` prints what a binary or debug file holds (its debug ids, architectures and whether it has line tables) without uploading anything. Use it to check that a file matches the build you shipped.

## iOS

Each binary has a UUID; the SDK sends it with each address, and the dSYM with the same UUID names it.

Make sure release builds produce dSYMs: Build Settings, Debug Information Format, **DWARF with dSYM File**.

**In Xcode**, add a Run Script build phase as the last phase of the app target:

```sh
"${BUILD_DIR%/Build/*}/SourcePackages/checkouts/inspector/ios/Tools/vitals-upload-dsym.sh"
```

with this Input File, so Xcode runs it after the dSYM exists:

```
${DWARF_DSYM_FOLDER_PATH}/${DWARF_DSYM_FILE_NAME}/Contents/Resources/DWARF/${TARGET_NAME}
```

The script uploads every `.dSYM` of the build (the app's, its frameworks' and its extensions'). It reads `KEYFRAMER_VITALS_UPLOAD_KEY` from the environment or a build setting of that name, and needs Node (`npx`). It never breaks a local build: without a key, or in a build without a dSYM, it says so and succeeds. Set `KEYFRAMER_VITALS_SYMBOLS=required` in release CI to make a failed upload fail the build, or `KEYFRAMER_VITALS_SYMBOLS=off` to skip it. If Xcode's script sandbox blocks it, set `ENABLE_USER_SCRIPT_SANDBOXING = NO` for that target.

**In CI**, you can upload from the archive instead:

```sh
xcodebuild archive -scheme Shop -archivePath build/Shop.xcarchive
npx @keyframerdev/vitals-cli symbols upload --dsym build/Shop.xcarchive/dSYMs
```

## Android

The Gradle plugin `dev.keyframer.vitals` does both halves. For every minified variant it puts a random build id into the app (the string resource `keyframer_vitals_build_id`, which the SDK sends), and after R8 runs it turns that variant's `mapping.txt` into chunks and uploads them.

```kotlin
// app/build.gradle.kts
plugins { id("dev.keyframer.vitals") version "0.1.0" }
```

The plugin comes from Maven Central, so `mavenCentral()` must be in `pluginManagement { repositories { … } }` in `settings.gradle.kts` (Android Studio projects have it already).

The key comes from `KEYFRAMER_VITALS_UPLOAD_KEY`, or the Gradle property `keyframerVitalsUploadKey` (for example in `~/.gradle/gradle.properties`). Settings, all optional:

```kotlin
keyframerVitals {
  uploadKey.set(providers.environmentVariable("KEYFRAMER_VITALS_UPLOAD_KEY")) // the default
  uploadMapping.set(false)    // stamp build ids, upload nothing (upload later with the CLI)
}
```

Without a key the build still succeeds: the chunks are written under `build/outputs/keyframer-vitals/<variant>/`, and `keyframer-vitals symbols upload --mapping … --debug-id …` can send them later.

For exact lines in frames, keep the line table in your R8 rules (the default Android rules drop it):

```
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
```

Without the plugin, upload the mapping with the CLI:

```sh
npx @keyframerdev/vitals-cli symbols upload --mapping app/build/outputs/mapping/release/mapping.txt --app-version 2.4.1 --build 812
```

## Flutter

Build with split debug info, and keep the folder:

```sh
flutter build ipa --obfuscate --split-debug-info=build/symbols
flutter build appbundle --obfuscate --split-debug-info=build/symbols
```

The folder holds one `.symbols` file per platform and architecture, each with an id the SDK sends. The iOS file is Mach-O, the Android ones ELF:

```sh
npx @keyframerdev/vitals-cli symbols upload --dsym build/symbols/app.ios-arm64.symbols
npx @keyframerdev/vitals-cli symbols upload --elf build/symbols
```

Upload for every build you ship; a folder from another build does not match. Plugins with native code on iOS have dSYMs too: upload the archive's `dSYMs` folder as for iOS if you want their frames named.

## React Native

With plain call sites (the default) there is nothing to upload: the Babel plugin already put `file:line:column` in the bundle.

With `hashSites: true`, each build writes `.keyframer/sites-<version>+<build>.json` next to your project. Babel only sees the files it transforms, so build the release bundle with a clean cache (`--reset-cache`, or `expo export -c`) for a complete manifest, then upload it from the machine or CI job that made the bundle:

```sh
npx @keyframerdev/vitals-cli symbols upload --rn-sites .keyframer/sites-2.4.1+812.json
```

With EAS Build, run it in an `eas-build-on-success` script. The manifest holds file paths, function, component and property names, never code.

## Late uploads

Upload whenever you can: data recorded before the upload joins the named site once the symbols arrive (resolution runs every hour, and again when an upload lands). Symbols are kept while the project exists and are deleted with it.
