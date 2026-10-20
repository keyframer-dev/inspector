# KeyframerInspector for iOS

The Keyframer runtime inspector for UIKit apps. It speaks the same protocol as the React Native
inspector (`protocol/inspector.ts`), so the same panel, trace and problems engine and MCP
server can record, trace, scrub and replay a native iOS app.

Status: UIKit, with time control (slow motion, pause, step), display and Reduce Motion awareness,
visibility markers and render hints. SwiftUI through an opt-in product, `KeyframerInspectorSwiftUI`
(see the end for what it can and cannot see).

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
measurements on ProMotion iPhones, `CADisableMinimumFrameDurationOnPhone = YES` (without it a display
link runs at 60 Hz at most on iPhone, and frames are counted against 60).

For SwiftUI views, add the second product too:

```swift
.product(name: "KeyframerInspectorSwiftUI", package: "inspector")

import KeyframerInspectorSwiftUI

withKeyframerAnimation(.spring(response: 0.5, dampingFraction: 0.6)) { cardOffset = -120 }

RoundedRectangle(cornerRadius: 24)
    .offset(y: cardOffset)
    .keyframerTrace("card", value: cardOffset)
```

### Running it against a relay

Until the desktop app hosts the relay, `Tools/` has a stand-in and a scripted editor (Bun):

```sh
bun Tools/relay.ts                        # ws://0.0.0.0:8790, /app and /editor, logs one line per message
bun Tools/editor.ts watch                 # print what the app sends
bun Tools/editor.ts smoke                 # drive the example app through the whole protocol (below)
```

Both take a port (`bun Tools/relay.ts --port 18797`, `--url ws://127.0.0.1:18797/editor`) when 8790 is
the desktop app's; launch the app with `SIMCTL_CHILD_KEYFRAMER_INSPECTOR_PORT=18797 xcrun simctl launch
...`, or `TEST_RUNNER_KEYFRAMER_INSPECTOR_PORT=18797` for the UI test.

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
| `withKeyframerAnimation(_:_:)` (SwiftUI) | `withAnimation` reported from its exact call site (`#fileID`, `#line`, `#column`). |
| `.keyframerTrace("name", value:)` (SwiftUI) | A value as a signal, sampled every frame while SwiftUI animates it; changes made with an animation are `anim` events. |

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

Native frames carry no line numbers at runtime. The SDK reads the app's Swift sources off the main
thread (`sourceRoot`, else the folder of the file that calls `start`), so such a site gets the file and
the line of its function's declaration; that works in the simulator, which reads the Mac's disk. On a
device, or without readable sources, the site has `file` = the function and `line` = 0, and the app's
log says why once (`[KeyframerInspector] native call sites have no file and line: ...`). The id is the
function and the key path (`closure #1 in CardsViewController.bounce()/position`): the same across
builds and edits, and one block animating two properties is one call. While
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
`frameMeter.ts`, counting against that rate rather than 60 Hz from the first window on (on iPhone,
60 Hz unless `CADisableMinimumFrameDurationOnPhone` lets the display link go faster). Threads are named by role in the protocol: `js` is the app thread (where app code
runs), `ui` the frame thread. On iOS the main thread is the app thread, so frame stats, drops and
animations report `js`, and `hello` says `threads: { js: { label: 'Main', animates: true } }`. There is no
`ui` entry: the render server (another process, where Core Animation animations actually run) is out of
reach, so a hitch there with an idle main thread is not seen, and an animation already handed to it
keeps running smoothly while the main thread is blocked.

**Display and Reduce Motion.** The hello carries `display: { hz, adaptive }` (the key window's screen,
`UIScreen.maximumFramesPerSecond`; `adaptive` on ProMotion, the highest rate it has reported, so a
device in Low Power Mode at 60 Hz still says so) and `accessibility: { reduceMotion }`
(`UIAccessibility.isReduceMotionEnabled`). While recording, a change is a marker: `display` when the
rate changes (`NSProcessInfoPowerStateDidChange`, and read again once a second for thermal limits; the
frame meter follows), `accessibility` on `reduceMotionStatusDidChangeNotification`. A recording that
starts after either changed since the hello says so at its start.

**Device.** The hello's `device` lets a relay or a CI runner tell apps apart (an iPhone 16 Pro and an
iPhone 17 simulator on one runtime). Whether it is a simulator is decided when the app is built. On a
simulator: `simulator: true`, `id` (`SIMULATOR_UDID`), `name` (`SIMULATOR_DEVICE_NAME`) and `model`
(`SIMULATOR_MODEL_IDENTIFIER`) from the app's environment. When a launcher started the app without
those variables, the UDID comes from where the app lives (`.../Devices/<UDID>/data/...`) and the name
from that simulator's `device.plist`; the path itself never leaves the app (it holds the Mac's user
name), and the model is left out (`device.plist` has no model identifier). On a physical device: `simulator: false` and `model` from `utsname.machine`
(`iPhone17,1`), never the device's name (usually its owner's, and recordings get shared) nor an id.
Mac Catalyst and macOS: `model` only (`hw.model`).

**Slow motion, pause and step** (`time`, the `time` capability). The key window's layer runs on a clock
of the inspector's, so every animation under it follows, whoever started it (`UIView.animate`, property
animators, keyframes, springs, hand-built Core Animation): the render server computes them from that
clock, nothing per animation is touched. A speed change keeps the window's local time continuous
(`speed`, `beginTime` = now, `timeOffset` = the local time now), so animations slow down or pause where
they are; `step` while paused moves `timeOffset` on by whole frames of the display (`1 / hz` each).
Every `time` message is answered with the speed now, and the hello is followed by one when it is not 1.
The rule every SDK shares: a scale that is missing, not finite or negative is ignored (still answered),
0 pauses, others are clamped to 0.01 to 1; `step` counts only with scale 0, floored and clamped to 1 to
120 frames. Each reset to 1x (the last editor left, the connection dropped, `stop()`) says `time 1`, at
once or right after the next hello;
while recording, a change is a `time` marker. Back at 1x the speed is the app's again while the clock
still lags the real one by the time spent slowed: the window gets its own `speed`, `beginTime` and
`timeOffset` back as soon as nothing animates under it (at most 5 s later, for something that repeats
forever), and at once when the editor leaves (`presence` with no editors, or the connection closes) or
`stop()` runs. A window that becomes key meanwhile joins at the same speed. Scrubbing a recording made
in slow motion reads the window clock's history, so a moment lands where the animations really were.
Not slowed: SwiftUI's own animations (except the ones `KeyframerInspectorSwiftUI` can reach, below),
`UIScrollView` deceleration, UIKit Dynamics, and the app's own display links and timers. App code that
sets an animation's `beginTime` from `CACurrentMediaTime()` (instead of the layer's `convertTime`)
starts late while the window's clock lags.

**Visibility.** While recording, an animated layer that cannot be seen is a `visibility` marker for each
of its recorded signals, and another when it comes back: `detached` (not in a window), `hidden` (it or a
layer above it hidden, at opacity 0, or scaled to nothing), `offscreen` (outside the window or every
clipping layer above it: a scroll view scrolled away). It is read from the presentation tree (what
shows now), when an animation is added and three times a second for layers with animations attached;
while an animation is being added and the model (where it goes) and the presentation tree disagree, the
next check decides, so a view about to slide in or out is not called gone too early. A change is placed
within about 300 ms. `covered` (another screen on top) is not detected yet; a screen pushed over
another removes its views from the window, which is `detached`.

**Render hints.** When an animation is added, the layer and the layers above it are looked at once for
what costs the render server work on every frame it runs, and each finding is a `renderHint` event, once
per layer and hint (an editor that joins later gets them with the catalog). `id` is the first signal of
what animates (the call site for colors and paths):

| `hint` | Seen when |
| --- | --- |
| `shadow-path` | A shadow (`shadowOpacity` > 0) without a `shadowPath` on the layer or above it: its shape is worked out from pixels every frame. |
| `mask` | A `mask` layer on the layer or above it: an offscreen pass every frame. |
| `blur` | A `UIVisualEffectView` with a blur (or glass) drawn above the animated view and overlapping where it moves, or a blur view that moves itself. |
| `group-opacity` | `opacity` animates on a layer with `allowsGroupOpacity` that draws sublayers over its own content (or several sublayers): the group is drawn offscreen first. |
| `rasterize` | `shouldRasterize` on a layer whose animation changes what it draws (anything but position, transform, opacity), or on a layer above it. |

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
(`platform: "ios"`, `framework: "uikit"`, or `"swiftui"` once `KeyframerInspectorSwiftUI` was used,
`protocol: 1`, `sdk`, `osVersion`, `threads`, `capture`, `screen`, `scenarios`, `display`,
`accessibility`, `device`, and `capabilities`: capture, playback, scrub, overrides, replay, scenarios,
time), then
`time` when the speed is not 1, then the catalog of signals and render hints (also re-sent when an
editor says `hello` or `presence` counts more editors), then the queue. The SwiftUI module used after
the hello said `uikit` sends the hello again. Events and samples are
batched every 100 ms (samples in chunks of 3000). Heartbeat: a WebSocket ping every 10 s, reconnect
after 25 s of silence (the room's text `ping`/`pong` are not used, a `pong` text frame is ignored).

| Message | iOS |
| --- | --- |
| `record` (ids or `*`, `recorder?`) | Samples, frame stats, drops, markers. `*` also records signals that appear later. Each `recorder` is kept on its own (requests without one share one); the app records while any is on, and drops them all when the last editor leaves or the connection drops. |
| `playback`, `capture` (with `route`) | Pins; the navigator or the navigation stack for routes. |
| `overrides`, `replay`, `scenario` | As on React Native. |
| `scrub` `{ t: number \| null }` | Seek Core Animation's timeline to `t` ms of the last recording, `null` to let it run. |
| `time` `{ scale, step? }` | The key window's clock at `scale` (0 paused, 0.01 to 1), `step` frames (1 to 120) on while paused; answered with `{ type: "time", scale }`. |
| markers | touch, navigation, appState, keyboard, note, and accessibility, display, visibility, time. |
| events | anim, signal, unsignal, renderHint. |
| commits, tasks, work, device `recording` | Not sent (no React; see next steps). |

## Example app and end-to-end check

`Example/` is a UIKit app (cards, a spring, a hand-built spin, a property animator, a 150 ms main
thread block, a pushed screen with keyframes, a draggable card with a shadow and no shadow path, a
scrolling strip, a pill that slides out of the screen and pulses there, and a pushed SwiftUI screen
traced with `KeyframerInspectorSwiftUI`) and a UI test that touches it. `Example/KeyframerExample.xcodeproj` is written by `Example/generate-project.py`: it uses
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
`playback` and with `scrub`, captures frames (`/tmp/kf-editor/*.jpg`), applies an override and replays;
then slows time to 0.25x (a bounce runs four times longer on the recording's clock), pauses (nothing
moves) and steps, checks the render hints, the pill's visibility markers and the time markers, and the
SwiftUI screen: the exact line of `withKeyframerAnimation`, an implicit `.animation` through the
transaction, every frame sampled (spring overshoot included), slow motion and an override reaching it.

## Tests

```sh
swift test                                            # the protocol and pure parts, on macOS
xcodebuild test -scheme KeyframerInspector-Package -destination "id=<a simulator>"   # all of them on iOS
```

`swift test` covers the protocol (fixtures), the time math (TimeControl, TimeMap, LayerClock), the
visibility and render hint rules on plain layer trees, the frame meter, and the SwiftUI animation
descriptions (SwiftUI's core is the same on macOS). The iOS run adds the window clocks on real layers,
scrubbing a recording made in slow motion, blur detection with views, pins and scrub state.

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
                                  key paths and values, animation descriptions, sample compression,
                                  time control math, visibility and render hint rules, recorders,
                                  the source index (call sites to file and line)
Sources/KeyframerInspector/       public API, connection, swizzles, signals, playback and scrubbing,
                                  window clocks (time), layer watch (visibility, hints)
Sources/KeyframerInspectorSwiftUI/ withKeyframerAnimation, .keyframerTrace, SwiftUI animation descriptions
Tests/                            Core and SwiftUI description tests (macOS and iOS), timeline tests (iOS)
Tools/                            relay.ts, editor.ts, fixtures.ts
Example/                          the example app, its UI test, and the project generator
```

## SwiftUI

SwiftUI runs its animations itself: on the main thread, from its own clock, interpolating the values
views were given. They never pass through `addAnimation:forKey:` (the choke point UIKit animations
share), and SwiftUI has no public hook that sees every animation. So SwiftUI is opt-in, per value,
through the `KeyframerInspectorSwiftUI` product, and the honest split is:

**Automatic, without the module.** Frames (the display link meter), touches, scenarios, the connection,
`navigation` markers for `UIHostingController`s (a subclass names the screen), time control for
whatever SwiftUI hands to Core Animation (UIKit views inside `UIViewRepresentable`, some system
transitions), and render hints and visibility for those layers.

**With `.keyframerTrace("name", value:)`.** The value becomes a signal (`Owner.name`, the owner being the
file's name; a point or a size is one signal per component, `dot/x`, `dot/y`), sampled every frame while
SwiftUI animates it, spring overshoot included. It works through public SwiftUI only:

- `Animatable`: a modifier whose `animatableData` SwiftUI interpolates gets every frame's value (SwiftUI
  sets it each frame without evaluating the modifier's body, so the setter is the hook).
- `.transaction`: a closure that sees the Transaction changing the views inside it, with its Animation,
  including an implicit `.animation(_:value:)` placed around the trace. A change made with an animation
  is an `anim` event: `fn: "withAnimation"` with the exact line when it came from
  `withKeyframerAnimation`, `fn: "Transaction"` with the trace's own line otherwise (an implicit
  animation, or a plain `withAnimation` the module cannot tell apart from it). The closure may change
  the animation, which is how the panel's overrides rebuild it and the editor's slow motion reaches it
  (`Animation.speed`).
- `Animation` has no public parameters: they are read with `Mirror` (BezierAnimation, the springs, the
  delay, speed and repeat modifiers, as SwiftUI builds them on iOS 17 to 26) into `args[1]` (`spring`
  with `response` and `dampingFraction`, `interpolatingSpring` with mass, stiffness and damping, a
  `timingCurve` or its easing name with the bezier points; times in ms) and the params the panel may
  tweak. `.default` and an app's own `CustomAnimation` are named, with nothing to tweak. A future
  SwiftUI that changes those shapes shows up as the type's name, never as wrong numbers.

`withKeyframerAnimation` stamps its call site on the transaction it starts (a transaction key, iOS 17;
on iOS 15 and 16 the update that follows within 100 ms takes it), so each traced value it changes is
reported from its line; one that changes no traced value is reported on its own, without a target.
While recording it also carries its stack.

**What needs care.** Put `.keyframerTrace` inside (before) the `.animation` modifiers that animate the
same value, so it sees their animation. In a list, give each row its own name (`"card#\(index)"`).
Values the app animates outside a trace (most of a SwiftUI screen) are not seen. Slow motion reaches
animations that start inside a traced view or from `withKeyframerAnimation` (SwiftUI fixes an
animation's speed when it starts, so one already running keeps its speed); pause and step reach Core
Animation only. Playback cannot write a traced value back (`writable: false`): SwiftUI state belongs to
the app. Not covered yet: `keyframeAnimator`, `phaseAnimator`, `matchedGeometryEffect`, and navigation
from `NavigationStack` paths.

Off (the inspector not started, or a release build), `withKeyframerAnimation` is `withAnimation` and a
trace costs a struct copy per animation frame.

## Motion Vitals (`KeyframerVitals`)

Slow frames from production, per screen and per animation, for the Motion Vitals dashboard. A separate
product (MIT), meant for release builds; it links nothing of the development inspector (no relay, no
recording, no playback) and is safe to ship next to it.

```swift
.product(name: "KeyframerVitals", package: "inspector")

import KeyframerVitals

// application(_:didFinishLaunchingWithOptions:), or the App's init.
KeyframerVitals.start(key: "kfp_live_…")      // appVersion and build default from the bundle
```

- **Consent, the Sentry way.** Nothing happens before `start`; then it reports. An app that needs
  consent calls `start` after it, or `KeyframerVitals.setEnabled(false)`, which stops and drops
  everything not sent. Debug builds send nothing unless `environment: .development` is passed.
- **Screens** are view controller types (containers skipped), masked like the inspector's redaction and
  cut to 64 characters. SwiftUI: `.vitalsScreen("Feed")`, or `KeyframerVitals.setScreen("Feed")`.
- **Animations.** UIKit and Core Animation animations are seen on their own (the
  `addAnimation:forKey:` swizzle) and reported as code addresses (`native` sites) that the uploaded
  dSYM names. Name them yourself with `KeyframerVitals.trace("card-expand") { … }`; SwiftUI changes
  need a name: `trace` around `withAnimation`, or `.vitalsTrace("card-expand", value: expanded)`.
- **Cost.** Nothing runs while nothing moves. A display link runs only inside motion windows (an
  animation's run, a touch until 1.5 s after it lifts, plus 250 ms), asking for 60 Hz and never more,
  so it never raises the display's rate. Sessions are sampled (10% by default, the project's config
  decides), at most 3 a day per device. One request per window, gzipped, when the app goes to the
  background; a checkpoint every 60 s of motion is sent on the next launch if the app dies first.
- **What is sent**: counters only (frame histograms, hitch time, frozen frames, per-site counts, the 5
  worst frames with a cause), app version, OS major, model (unless the project turns it off), device
  tier, refresh rate, Low Power Mode, thermal state, Reduce Motion only when the project collects it.
  Never screenshots, text, values, touches, identifiers or absolute times.
- **Privacy manifest**: `PrivacyInfo.xcprivacy` declares Performance Data, not linked, no tracking,
  and the required reasons for system boot time (35F9.1) and UserDefaults (CA92.1).

**dSYM upload.** Add a Run Script build phase, last, that runs `Tools/vitals-upload-dsym.sh` (with
`${DWARF_DSYM_FOLDER_PATH}/${DWARF_DSYM_FILE_NAME}/Contents/Resources/DWARF/${TARGET_NAME}` as an input
file), and set `KEYFRAMER_VITALS_UPLOAD_KEY` to the project's CI key (`kft_…`) in CI. It calls
`npx -y @keyframerdev/vitals-cli symbols upload --dsym …` for every dSYM of the build; without a key it
warns and the build goes on (`KEYFRAMER_VITALS_SYMBOLS=required` makes it fail, `off` skips it).

**How a native site is made.** At `addAnimation:forKey:` the reporter takes 32 return addresses
(`backtrace`), skips its own frames (counted once per session by a calibration call) and takes the
first frame in an app image (the main executable or a framework inside the `.app`). Inside a
`UIView.animate` block it takes the code that called `UIView.animate`, not the block (an optimized
build often leaves only a shared compiler thunk there). It sends the image index and the return
address's offset from the image's `__TEXT` vmaddr, slide removed, with the image's LC_UUID, file name
and architecture; the server looks up `offset - 1` in the uploaded symbols.

Tests: `swift test` covers the counting, sessions, storage, upload, gzip and the Mach-O offsets (atos
resolves a captured offset to its function); the golden report is
`packages/protocol/fixtures/vitals/report-ios.json` and the shared validator checks the encoder's
output. `xcodebuild test -scheme KeyframerInspector-Package -only-testing:KeyframerVitalsTests` on a
simulator adds the swizzle's calibration (debug and release).
