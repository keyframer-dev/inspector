# KeyframerInspector for iOS

The Keyframer runtime inspector for UIKit apps. It speaks the same protocol as the React Native
inspector (`protocol/inspector.ts`), so the same panel, trace and problems engine and MCP
server can record, trace, scrub and replay a native iOS app.

Status: a working vertical slice (UIKit). SwiftUI is not covered yet (see the end).

## Try it

```swift
// Package.swift, or Xcode: File > Add Package Dependencies
.package(url: "https://github.com/keyframer-dev/inspector", from: "0.1.0")

import KeyframerInspector

// Once the first window is up (SceneDelegate, or the App's init for a UIKit-hosted app).
#if DEBUG
KeyframerInspector.start()                                   // simulator: ws://127.0.0.1:8790
KeyframerInspector.start(.init(host: "192.168.1.20"))        // a device: the Mac's LAN address
#endif
```

It connects to the local relay at `ws://<host>:8790/app?name=<app name>&platform=ios`, sends `hello`,
and reconnects on its own (0.5 s doubling to 10 s). Release builds do nothing unless
`allowInRelease: true`. The environment wins over code: `KEYFRAMER_INSPECTOR_HOST`,
`KEYFRAMER_INSPECTOR_PORT`, and `KEYFRAMER_INSPECTOR=0` (off) or `1` (on, even in release).

A device on the LAN also needs, in the app's Info.plist: `NSLocalNetworkUsageDescription`, and
`NSAppTransportSecurity > NSAllowsLocalNetworking = YES` for plain `ws://`. For 120 Hz frame
measurements on ProMotion iPhones, `CADisableMinimumFrameDurationOnPhone = YES`.

### Running it against a relay

Until the desktop app hosts the relay, `Tools/` has a stand-in and a scripted editor (Bun):

```sh
bun Tools/relay.ts                        # ws://0.0.0.0:8790, /app and /editor, logs one line per message
bun Tools/editor.ts watch                 # print what the app sends
bun Tools/editor.ts smoke                 # drive the example app through the whole protocol (below)
```

## API

| Call | What it does |
| --- | --- |
| `start(_:)` / `stop()` | Connect and watch, or stop and hand every layer back. |
| `trace("card") { ... }` | Animations started inside get this exact call site (`#fileID:#line:#column`) and target name. |
| `track(view, as: "card")` | Records a view the app moves itself (a drag setting `center`), not only through animations. |
| `registerScenario("bounce") { ... }` | An interaction the panel or an agent can run (`scenario` / `scenarioDone`). |
| `tap("bounce")` | Fires the control with that accessibility identifier: for scenarios. |
| `registerReplay { ... }` | What `replay` runs. |
| `registerNavigator { route, params in ... }` | How playback reaches a recorded screen (a route is the view controller's type name). Without one, playback pops back to it when it is in the navigation stack. |
| `scrub(toRecordingTime:)` / `endScrub()` | Freeze every animated layer at a moment of the last recording, Core Animation's own timeline. |
| `note(_:)` | A note marker on the recording. |

## How it works

**Animations.** `-[CALayer addAnimation:forKey:]` is swizzled once; every Core Animation animation
passes through it, whoever builds it: `UIView.animate` (UIKit adds additive `CASpringAnimation` /
`CABasicAnimation`s), `UIViewPropertyAnimator`, `UIView.animateKeyframes`, and hand-built
`CABasicAnimation` / `CASpringAnimation` / `CAKeyframeAnimation` / groups. Each one is reported as an
`anim` event: `prop` is the key path, `fn` the API that started it (read from UIKit's frames on the
stack: `UIView.animate`, `UIViewPropertyAnimator`, `UIView.animateKeyframes`, else the class), `args`
is `[to, config]` with `duration`/`delay` in ms, the timing curve (`easing`, `bezier`), spring
`mass`/`stiffness`/`damping`/`initialVelocity`/`settlingDuration`, and absolute `from`/`to` layer values
(UIKit's additive deltas go as `delta`/`deltaTo`). `params` name the numbers the panel may tweak
(`1.duration`, `1.stiffness`…); `overrides` from the panel edit a copy of the next animation added from
that call site. UIKit's own bookkeeping (`uiFractionalProgress`) and animations with no app code on the
stack (the text cursor, keyboard, navigation bar) are left out unless `reportSystemAnimations` is on.

**Call sites.** The stack is taken synchronously inside the swizzle, while the app's animation block
is still on it (`Thread.callStackSymbols`):

1. Everything above the swizzled `kf_add` frame is the inspector itself (including compiler thunks
   emitted into the app's image with no module name) and is cut.
2. App frames are those whose image is the app: its executable (`MyApp`), or `MyApp.debug.dylib`,
   where Xcode 16+ puts app code in debug builds, plus `appModules` you name.
3. The first app frame that is not compiler glue (reabstraction thunks, `partial apply`) is the
   call site. Its Swift symbol is demangled with the runtime's own `swift_demangle` (looked up with
   `dlsym`), then reduced to what a person reads: `closure #1 in CardsViewController.bounce()`, type
   `CardsViewController` (the `component`). Objective-C frames (`-[Class selector]`) are read as is.

Native frames carry no line numbers at runtime, so such a site has `file` = the function, `line` = 0,
and an id of the function plus the return address' offset into it (stable for one build). While
recording, an event also carries `frames` (`lineNumber` 0, with `image`, `offset` into the image from
`dladdr`, and the raw `symbol`, so the Mac can resolve lines with `atos`; library frames are
`collapse`d) and a `stack` in the V8 shape the panel parses. Every event carries `durationMs` (delay plus
duration times repeats; left out when it repeats forever). **The precise route
is `trace`**: its `#fileID`/`#line`/`#column` default arguments give the exact place, like the Babel
plugin does on React Native.

**Signals.** The protocol's samples are scalars, so a layer property becomes one signal per scalar
(`position` → `position.x`, `position.y`; `transform` → translation, scale, z rotation), with ids like
`CardsViewController.card/position.y`. The name comes from `track(as:)`, the accessibility identifier,
the stored property that holds the view (found with `Mirror` up the responder chain), or the type;
cells add their index path (`icon#0.3`) and sublayers their name. A view shown again takes over its id,
so recordings follow it. While recording, every signal is read from `presentation()` on each display
frame; repeated values are dropped without changing what the panel draws (the last held sample before
a move is kept). A scroll view joins (`bounds.origin`, its offset, `kind: 'scroll'`) the first time a finger touches it.
Every track is writable (pins hold any animatable key path). A track whose layer was freed (its screen
closed) leaves the catalog with `{ kind: 'unsignal', id }`, checked once a second.

**Frames.** A `CADisplayLink` on the main thread (asking for the display's top rate) feeds a port of
`frameMeter.ts`. Threads are named by role in the protocol: `js` is the app thread (where app code
runs), `ui` the frame thread. On iOS the main thread is the app thread, so frame stats, drops and
animations report `js`, and `hello` says `threads: { js: { label: 'Main', animates: true } }`. There is no
`ui` entry: the render server (another process, where Core Animation animations actually run) is out of
reach, so a hitch there with an idle main thread is not seen, and an animation already handed to it
keeps running smoothly while the main thread is blocked.

**Touches and screens.** `-[UIApplication sendEvent:]` is swizzled: touches become `touch` markers on
the recording's clock (`UITouch.timestamp` is the same clock as `CACurrentMediaTime`), at most one move
per finger per 8 ms, in screen points. `-[UIViewController viewDidAppear:]` gives `navigation` markers
for the app's own controllers (not containers; `UIHostingController` counts), plus the screen on top
when recording starts. App state and keyboard notifications become `appState` and `keyboard` markers.

**Playback and capture.** `playback` pins recorded values in time order, one display frame at a time.
A pin is an animation of the inspector's own (`kf.pin.<path>`, from = to = value, added last so it
wins), so the app's model is never written and releasing the pins hands the layer straight back (a real
touch releases them, so does `record`, `replay` and `scrub`). Scroll offsets scroll the real scroll
view. `capture` pins one moment, waits for the render server and snapshots the key window with
`drawHierarchy(afterScreenUpdates: true)` (what is on screen, animations included).

**Scrubbing Core Animation itself.** `scrub` freezes every animated layer with `speed = 0` and moves it
with `timeOffset` (each layer's local clock is measured first, so seeking is `local0 + (t - media0) *
rate`). Animations that already finished are put back from private copies kept as they were added
(no delegate, so UIKit's completion never fires twice; UIKit's additive deltas made absolute): the
first one per property at the bottom, filled both ways, the rest above in time order, held after they
end only when the layer kept their end value. The app's attached animations are never removed. Ending
the scrub removes the copies and restores each layer's `speed`, `timeOffset` and `beginTime`, so the app
carries on with the real clock as if nothing happened. Springs and keyframes show exactly what they
rendered, between samples too.

## Protocol

Message order and behaviour follow `react-native/src/client.ts`: on every connection `hello`
(`platform: "ios"`, `framework: "uikit"`, `protocol: 1`, `sdk`, `osVersion`, `threads`, `capture`,
`screen`, `scenarios`, and `capabilities`: capture, playback, scrub, overrides, replay, scenarios), then the catalog of signals (also re-sent when
an editor says `hello` or `presence` counts more editors), then the queue. Events and samples are
batched every 100 ms (samples in chunks of 3000). Heartbeat: a WebSocket ping every 10 s, reconnect
after 25 s of silence (the room's text `ping`/`pong` are not used, a `pong` text frame is ignored).

| Message | iOS |
| --- | --- |
| `record` (ids or `*`) | Samples, frame stats, drops, markers. `*` also records signals that appear later. |
| `playback`, `capture` (with `route`) | Pins; the navigator or the navigation stack for routes. |
| `overrides`, `replay`, `scenario` | As on React Native. |
| `scrub` `{ t: number \| null }` | Seek Core Animation's timeline to `t` ms of the last recording, `null` to let it run. |
| commits, tasks, work, device `recording` | Not sent (no React; see next steps). |

## Example app and end-to-end check

`Example/` is a UIKit app (cards, a spring, a hand-built spin, a property animator, a 150 ms main
thread block, a pushed screen with keyframes, a draggable card, a scrolling strip) and a UI test that
touches it. `Example/KeyframerExample.xcodeproj` is written by `Example/generate-project.py`: it uses
folder-synchronized groups (Xcode 16+), so it lists no source files and depends on this package as a
local package. Open it in Xcode and run, or from the command line:

```sh
UDID=$(xcrun simctl create "KF Inspector" com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro)
xcrun simctl boot $UDID
xcodebuild -project Example/KeyframerExample.xcodeproj -scheme KeyframerExample \
  -destination "id=$UDID" -derivedDataPath /tmp/kf-dd build-for-testing
xcrun simctl install $UDID /tmp/kf-dd/Build/Products/Debug-iphonesimulator/KeyframerExample.app

bun Tools/relay.ts &
bun Tools/editor.ts smoke &                           # waits for the app
xcrun simctl launch $UDID dev.keyframer.inspector.example

# Real touches, drags and navigation: record while the UI test plays with the app.
bun Tools/editor.ts touches --seconds 20 &
xcodebuild -project Example/KeyframerExample.xcodeproj -scheme KeyframerExample \
  -destination "id=$UDID" -derivedDataPath /tmp/kf-dd test-without-building
```

`smoke` records, runs the scenarios, checks every message against the protocol's shapes, scrubs with
`playback` and with `scrub`, captures frames (`/tmp/kf-editor/*.jpg`), applies an override and replays.

## Tests

```sh
swift test                                            # the protocol and pure parts, on macOS
xcodebuild test -scheme KeyframerInspector -destination "id=<a simulator>"   # plus scrub and pin state on iOS
```

`Tests/KeyframerInspectorCoreTests/Fixtures/messages.json` comes from `Tools/fixtures.ts`, whose values
are type-checked against `protocol/inspector.ts`; every one must decode and encode back to
the same JSON. Regenerate after a protocol change:

```sh
../../node_modules/.bin/tsc --noEmit --strict --skipLibCheck --target es2022 --moduleResolution bundler --module esnext Tools/fixtures.ts
bun Tools/fixtures.ts > Tests/KeyframerInspectorCoreTests/Fixtures/messages.json
```

## Layout

```
Package.swift
Sources/KeyframerInspectorCore/   protocol types, stack parsing and demangling, frame meter,
                                  key paths and values, animation descriptions, sample compression
Sources/KeyframerInspector/       public API, connection, swizzles, signals, playback and scrubbing
Tests/                            Core tests (macOS and iOS), timeline tests (iOS)
Tools/                            relay.ts, editor.ts, fixtures.ts
Example/                          the example app, its UI test, and the project generator
```

## SwiftUI

SwiftUI animations do not pass through `addAnimation:forKey:` (its renderer does not use per-property
Core Animation animations for most views), so there is no single choke point. What it needs: explicit
modifiers that report and sample (`.keyframerTrace("cardY", value)` around `withAnimation` and
`.animation`), `Animatable` values sampled through a small wrapper, and navigation from
`NavigationStack` paths. Frames, touches, scenarios and the connection work as they are; a SwiftUI app
hosted in `UIHostingController` already gets touches, frames and navigation markers.
