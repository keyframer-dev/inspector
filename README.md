# Keyframer Inspector

A motion debugger for apps. Every animation, with the line of code that started it, what it cost, and
why frames dropped, recorded on the device and scrubbed like a video. Tune a duration or a spring and
write the numbers back to your source. Hand the recording to a coding agent over MCP, or gate pull
requests on it in CI.

This repository holds the SDKs that go into your app, for every platform, under MIT.

| Platform | Folder | Install |
| --- | --- | --- |
| React Native (Reanimated) | [`react-native/`](./react-native) | `npm i -D @keyframerdev/inspector` |
| iOS (UIKit) | [`ios/`](./ios) | Swift Package Manager: `https://github.com/keyframer-dev/inspector` |
| Android (Views) | [`android/`](./android) | `debugImplementation("dev.keyframer:keyframer-inspector:<version>")` |
| Flutter | [`flutter/`](./flutter) | `flutter pub add keyframer_inspector` |

The apps connect to **Keyframer Inspector**, the desktop app: the panel, the recordings library, and an
MCP server for Claude Code, Codex, Cursor and others. Download it from
[Releases](https://github.com/keyframer-dev/inspector/releases/latest) (macOS). React Native apps can
also use the panel inside Expo's dev tools, no desktop app needed.

## Quick start

**React Native.** Add the Babel plugin in development (before `react-native-worklets/plugin`), connect,
then press **shift+m** in Metro and open **@keyframerdev/inspector**. The
[npm README](https://www.npmjs.com/package/@keyframerdev/inspector) has the details, bare React Native
included.

```js
// babel.config.js (Expo)
plugins: process.env.NODE_ENV !== 'production' ? ['@keyframerdev/inspector/babel'] : []
```

```ts
// your root layout
if (__DEV__) require('@keyframerdev/inspector/devtools').connectDevTools({ app: 'MyApp' })
```

**iOS.**

```swift
import KeyframerInspector

#if DEBUG
KeyframerInspector.start()                              // simulator: ws://127.0.0.1:8790
KeyframerInspector.start(.init(host: "192.168.1.20"))   // a device: the Mac's LAN address
#endif
```

**Android.**

```kotlin
// Application.onCreate (debuggable builds only)
Keyframer.start(this)
ObjectAnimator.ofFloat(title, View.ALPHA, 0f, 1f).kfTrack("title").start()
```

**Flutter.**

```dart
void main() => runApp(const KeyframerInspector(app: 'My app', appPackage: 'my_app', child: MyApp()));
```

Each folder's README covers the API, what is reported and how, and its tests.

## Protocol

Every SDK speaks one wire protocol, [`protocol/inspector.ts`](./protocol/inspector.ts): `hello`, the
signals an app exposes, animation events with their call sites, frames, screens, recordings, and what
an editor sends back (record, scrub, overrides, scenarios). A new platform needs only to speak it.

## Issues and contributions

Issues for any platform, the desktop app and the npm package go here. This repository is published
from Keyframer's own; pull requests are welcome, and land here once merged there.

## License

MIT for everything in this repository ([LICENSE](./LICENSE)). The desktop app is free and closed
source. In the npm package, what runs in your app is MIT (its source is `react-native/`), and the tools
(the CLI, the MCP server and the panel) are under the Functional Source License; see its
[LICENSE.md](https://www.npmjs.com/package/@keyframerdev/inspector?activeTab=code).
