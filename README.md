# Keyframer Inspector

A motion debugger for apps. Every animation, with the line of code that started it, what it cost, and
why frames dropped, recorded on the device and scrubbed like a video. Tune a duration or a spring and
write the numbers back to your source. Hand the recording to a coding agent over MCP, or gate pull
requests on it in CI.

https://github.com/user-attachments/assets/81d909d3-64fb-431b-a06f-1d20da5d5952

This repository holds the SDKs that go into your app, for every platform, under MIT.

| Platform | Folder | Install |
| --- | --- | --- |
| React Native (Reanimated) | [`react-native/`](./react-native) | `npm i -D @keyframerdev/inspector` |
| iOS (UIKit) | [`ios/`](./ios) | Swift Package Manager: `https://github.com/keyframer-dev/inspector` |
| Android (Views) | [`android/`](./android) | `debugImplementation("dev.keyframer:keyframer-inspector:<version>")` |
| Flutter | [`flutter/`](./flutter) | `flutter pub add keyframer_inspector` |

The apps connect to **Keyframer Inspector**, the desktop app (below). React Native apps can also use
the panel inside Expo's dev tools, no desktop app needed.

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

## The desktop app

**Keyframer Inspector** for macOS (Apple silicon and Intel) is where every SDK connects. Download it
from [Releases](https://github.com/keyframer-dev/inspector/releases/latest). It is free, signed and
notarized, and keeps itself up to date.

- **Every platform, one place.** iOS, Android, Flutter and React Native apps connect to it on
  `ws://<your Mac>:8790`: simulators and emulators on their own, devices on the same network with the
  address the status bar shows. Several apps at once, with a switcher.
- **The panel.** Record, then drag to scrub: the app follows, back to the screen it was on. Tracks show
  every animation as segments you can click to tune (duration, delay, spring) live, then apply the
  numbers to your source. Problems come ranked by the frames they cost, each with where it is, what was
  running and the fix. Compare two sessions, before and after a change. Open any step in Cursor, VS Code,
  Zed or Xcode.
- **An MCP server for coding agents.** Built in, one switch in Settings, and nothing else to install.
  Claude Code, Codex, Cursor, VS Code, Windsurf, Zed and Claude Desktop can record your app, run its
  scenarios, read the trace and the problems, and take screenshots. With `check` and `recheck` an agent
  runs the fix loop: measure, change the code, measure again, until the problems are gone and the
  motion still works. Settings shows the setup for each client; for Claude Code:

  ```sh
  claude mcp add --transport http keyframer-inspector http://127.0.0.1:8789/mcp
  ```

- **A recordings library.** Recordings (`.kfrec.json`) from the panel, from testers' devices or from
  share links land in one folder. Double-click one to open it; share links open in the app.
- **In the menu bar.** Closing the window keeps the relay running. The menu shows the connected apps
  and the MCP server, with switches for the server and for launching at login.
- **Updates on its own.** It checks after launch and every six hours, downloads in the background and
  installs when you restart or quit. Every update is signed, and the app installs nothing else.
- **Local.** Recordings, the relay and the MCP server stay on your Mac. Nothing leaves it unless you
  make a share link.

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
