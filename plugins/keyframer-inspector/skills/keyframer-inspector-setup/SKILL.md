---
name: keyframer-inspector-setup
description: Install and connect the Keyframer Inspector motion debugger in an app, then verify it works - the Babel plugin and connectDevTools for React Native or Expo, the KeyframerInspector Swift package for iOS (UIKit, SwiftUI), the dev.keyframer Maven artifacts for Android (Views, Compose), the keyframer_inspector package for Flutter, the desktop app's relay, and the MCP server for coding agents. Use when asked to add, install, set up or connect Keyframer Inspector, when inspector_status reports no app or no values, or when the panel stays empty.
---

# Set up Keyframer Inspector

Goal: the app reports to the inspector in development builds only, and `inspector_status` shows it with its values. Docs: https://keyframer.dev/inspector/docs/getting-started

## 1. Find the platform

Look at the project before changing anything:

- `package.json` with `react-native-reanimated` (and `expo`): React Native. Go to step 2a.
- `Package.swift` or an `.xcodeproj` with UIKit or SwiftUI code: iOS. Step 2b.
- `build.gradle(.kts)` with `com.android.application`: Android. Step 2c.
- `pubspec.yaml` with `flutter`: Flutter. Step 2d.

Native platforms (iOS, Android, Flutter) need the desktop app, Keyframer Inspector, running: it hosts the relay on `ws://127.0.0.1:8790`. Download it from https://github.com/keyframer-dev/inspector/releases/latest. Ask the person to install and start it; you cannot.

## 2a. React Native and Expo

First choice: the setup wizard, without questions. It installs the package, adds the Babel plugin, writes the connect code and the navigation ref, and changes nothing that is already in place:

```sh
npx @keyframerdev/wizard --yes --products inspector --view devtools --skip-verify --no-agents
```

- Run it from the app's folder (in a monorepo, the app's own folder, or `--root apps/mobile`). Show the person the changes first with `--dry-run` if they want to review them.
- `--view devtools` needs an Expo app. For bare React Native use `--view desktop`, once the person has installed and opened the desktop app (step 1): the wizard does not install it on its own under `--yes`.
- `--no-agents`: you are already connected through the MCP server. `--skip-verify`: check with `inspector_status` yourself after the app reloads (step 3), instead of the wizard's own wait.
- Exit code 2 names a missing flag; add it and run again. If it prints a snippet to paste (a navigation container it could not place), paste it where it says.
- If the package can't be found or the wizard fails, set it up by hand below.

By hand:

```sh
npm i -D @keyframerdev/inspector
```

Add the Babel plugin in development only, before `react-native-worklets/plugin`. Expo (`babel-preset-expo` adds the worklets plugin after it):

```js
// babel.config.js
module.exports = function (api) {
  api.cache.using(() => process.env.NODE_ENV)
  const dev = process.env.NODE_ENV !== 'production'
  return {
    presets: ['babel-preset-expo'],
    plugins: dev ? ['@keyframerdev/inspector/babel'] : [],
  }
}
```

If the project had no `babel.config.js`, also run `npx expo install -- --save-dev babel-preset-expo`, or Metro fails with `Cannot read properties of undefined (reading 'transformFile')`.

Bare React Native: `plugins: [...(dev ? ['@keyframerdev/inspector/babel'] : []), 'react-native-worklets/plugin']` with `const dev = api.env('development')`, the worklets plugin last.

Connect in the root layout:

```ts
if (__DEV__) {
  const { connectDevTools, registerReplay } = require('@keyframerdev/inspector/devtools')
  connectDevTools({ app: 'MyApp' })
}
```

To use the desktop app instead: `require('@keyframerdev/inspector/native').connectInspector({ apiUrl: 'http://127.0.0.1:8790', code: 'DESKTOP', app: 'MyApp' })`.

Optional, ask first: `npx expo install react-native-view-shot` (screen capture and export), `trackNavigation(navigationRef)` from `@keyframerdev/inspector/record` (playback returns to the right screen), `registerScenario` from `@keyframerdev/inspector/devtools` (repeatable interactions for agents and CI).

Restart Metro with a clean cache after the Babel change: `npx expo start -c`.

## 2b. iOS

Add the package `https://github.com/keyframer-dev/inspector` (from `0.1.0`), product `KeyframerInspector`. Start it once the first window is up:

```swift
import KeyframerInspector

#if DEBUG
KeyframerInspector.start()                              // simulator
// KeyframerInspector.start(.init(host: "192.168.1.20")) // a device: the Mac's LAN address
#endif
```

A physical device also needs Info.plist keys: `NSLocalNetworkUsageDescription`, `NSAppTransportSecurity > NSAllowsLocalNetworking = YES`, and `CADisableMinimumFrameDurationOnPhone = YES` for 120 Hz.

SwiftUI: add the product `KeyframerInspectorSwiftUI`, use `withKeyframerAnimation(...)` in place of `withAnimation(...)`, and add `.keyframerTrace("name", value: x)` before the `.animation` modifiers of each value to see. Values outside a trace are not seen.

Check that the app builds with `xcodebuild` for an iOS destination, not `swift build`.

## 2c. Android

```kotlin
// build.gradle.kts, Views
debugImplementation("dev.keyframer:keyframer-inspector:0.2.0")
releaseImplementation("dev.keyframer:keyframer-inspector-noop:0.2.0")
// or Compose (replaces the two lines above)
debugImplementation("dev.keyframer:keyframer-inspector-compose:0.2.0")
releaseImplementation("dev.keyframer:keyframer-inspector-compose-noop:0.2.0")
```

```kotlin
// Application.onCreate
Keyframer.start(this)
```

- Allow cleartext to the relay host only, with a `network_security_config.xml`.
- Views: register animators, `ObjectAnimator.ofFloat(title, View.ALPHA, 0f, 1f).kfTrack("title").start()`, and other values with `Keyframer.signal("name", view, read = { ... }, write = { ... })`.
- Compose: rename the calls (`kfAnimateFloatAsState`, `kfAnimateDpAsState`, `kfUpdateTransition`, `rememberKfInfiniteTransition`, `rememberKfAnimatable` with `kfAnimateTo`).
- The emulator reaches `10.0.2.2:8790` by itself. A device: `adb reverse tcp:8790 tcp:8790`.

## 2d. Flutter

```yaml
dependencies:
  keyframer_inspector: ^0.2.0
```

```dart
void main() => runApp(const KeyframerInspector(app: 'My app', appPackage: 'my_app', child: MyApp()));
// MaterialApp(navigatorObservers: [kfNavigatorObserver], ...)
// AnimationController( becomes KfAnimationController(..., name: 'card')
```

`appPackage` is the pubspec `name`. A physical device: `flutter run --dart-define=KEYFRAMER_HOST=<Mac LAN IP>`. Implicit animations need `flutter run` (widget creation tracking), not `flutter build ios --debug`.

## 3. Connect the MCP server

With the desktop app (any platform): the person turns on Settings, MCP Server. Then:

```sh
claude mcp add --transport http keyframer-inspector http://127.0.0.1:8789/mcp
```

Without it (React Native on Metro):

```sh
claude mcp add keyframer-inspector -- npx keyframer-inspect mcp
```

Native apps without the desktop app's server: `npx keyframer-inspect mcp --relay ws://127.0.0.1:8790`. The CLI needs Node 22 or later.

## 4. Verify

Run the app, then check each of these. Stop at the first failure and fix it.

1. `inspector_status` names the app, its framework and platform. No app: the app is not running, not a development build, or cannot reach Metro or the relay (port, host, cleartext or local network permission).
2. `inspector_status` lists values. None: on React Native the Babel plugin is not in the build (check the order, restart Metro with `-c`); on Flutter no `KfAnimationController` exists yet; on iOS nothing has animated yet; on Android nothing is registered with `kfTrack`.
3. `record` with `durationMs: 3000` while something animates returns a report with animations at your source files.
4. If you added scenarios: `run_scenario` with one of them finishes.

Report what was added, the file of each change, and the result of each check. Do not add the inspector to release builds.
