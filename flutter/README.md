# keyframer_inspector (Flutter)

The Keyframer runtime inspector for Flutter apps. It is the Flutter counterpart of `@keyframerdev/inspector`
(React Native): a Flutter app reports its animated values and animations with their call sites, samples
values every frame while recording, measures frames on the UI and raster threads, records touches and
navigation, and plays recordings back. It speaks the same protocol (`protocol/inspector.ts`),
so the panel, the trace and problems engine and the MCP server read a Flutter app as they read a React
Native one.

Status: a working vertical slice. Debug builds are verified end to end on macOS desktop and on the web
(Chrome, debug and profile builds).

## Quick start

Flutter 3.29 or later. iOS, Android, macOS, Windows, Linux and the web.

```yaml
# pubspec.yaml
dependencies:
  keyframer_inspector: ^0.2.0
```

```dart
import 'package:keyframer_inspector/keyframer_inspector.dart';

void main() => runApp(const KeyframerInspector(
      app: 'My app',
      appPackage: 'my_app', // your pubspec name: call sites read lib/x.dart
      child: MyApp(),
    ));

// In MyApp:
MaterialApp(navigatorObservers: [kfNavigatorObserver], routes: {...});

// Animated values: AnimationController( → KfAnimationController(
late final card = KfAnimationController(vsync: this, duration: const Duration(milliseconds: 400), name: 'card');
```

That is all the app needs. Optional:

- `controller.kfTrack('name')` for a controller you do not construct (call `kfUntrack()` in dispose),
  `valueNotifier.kfTrack('name')` for a `ValueNotifier<double>` (a drag offset).
- `registerReplay(() => ...)`: what the panel's replay runs (re-fire an entrance).
- `registerScenario('drag card', () async {...})`: an interaction an editor or agent can run.

`KeyframerInspector` connects in debug and profile builds and is a plain `RepaintBoundary` in release,
unless built with `--dart-define=KEYFRAMER_INSPECTOR=true` or given `enabled: true`.

Nothing else to add for the rest: implicit animations (`AnimatedContainer`, `AnimatedOpacity`,
`TweenAnimationBuilder` and the other ImplicitlyAnimatedWidgets you write) and `Hero` flights are found
on their own (see below), and the panel's speed control, pause and frame step work on every animation in
the app.

## Running the example against a relay

The desktop app will host the relay. Until then, `tool/relay.dart` is a stand-in with the same contract.

```sh
cd flutter
dart run tool/relay.dart --verbose          # ws://127.0.0.1:8790, /app and /editor

cd example
flutter run -d macos                        # or: flutter build macos --debug, then open the .app
```

Then drive it headless with the repo's own trace and problems engine (bun runs the TypeScript directly):

```sh
bun tool/fake_editor.ts --scenario "drag card" --scenario "open details" \
  --playback --capture /tmp/frame.png --out /tmp/flutter.kfrec.json
```

It records while the scenarios run, prints what `trace.ts` and `issues.ts` make of it (values, frame
summary per thread, markers, animations with their stacks, problems), plays the recording back into the
app, captures the frame where the dragged card was furthest out, and saves a `.kfrec.json` that the panel
opens.

On the web, run the example in Chrome (`flutter run -d chrome`): the page connects to the relay on the
host it was served from when that is this machine or the local network, else to 127.0.0.1
(`--dart-define=KEYFRAMER_HOST=` overrides it). `tool/fake_editor.ts` takes `--time 0.25` (record at
that speed) and `--pause` (pause mid-recording, step 30 frames, resume) too, and lists render hints and
the visibility, display, accessibility and time markers.

A physical device connects to the Mac over the LAN:

```sh
dart run tool/relay.dart --lan
flutter run --dart-define=KEYFRAMER_HOST=192.168.1.20      # the Mac's LAN IP
```

The Android emulator reaches the Mac at `10.0.2.2`, which is the default on Android. The example's iOS
`Info.plist` allows local networking, its Android debug manifest allows cleartext, and its macOS
entitlements allow outgoing connections.

## Transport

`ws://<host>:8790/app?name=<app>&platform=<os>`. Each text frame is one JSON `InspectorMessage`. The
socket is dart:io's on iOS, Android and desktop, and the browser's (package:web) on the web, chosen by a
conditional import, so a web build never imports dart:io.

- The app sends `hello`, then the catalog (`events` with every `signal`), then batches every 100 ms.
- `hello` says what the app is: `platform` is the OS (`macos`, `ios`, `android`, `web`), with `framework:
  'flutter'`, `osVersion` (Apple platforms; dart:io cannot tell Android's, a browser does not say), `protocol:
  1`, `sdk`, the threads (`js`: UI isolate, animates; `ui`: Raster), `capabilities` (`playback`,
  `overrides`, `replay`, `scenarios`, `time`, `capture` under `KeyframerInspector`, and `widget-sites`
  when widget creation is tracked), `display` (the
  view's refresh rate, rounded; `adaptive` on iOS, Android and Macs above 60 Hz, and on the web) and
  `accessibility` (`reduceMotion`: `disableAnimations` or the platform's Reduce Motion), and `device`
  (below). The first hello waits up to 2 s for the device.
- `device` tells apps apart on one relay or in a CI run, read in plain Dart (no plugin, no method
  channel). An iOS simulator: its UDID (`id`), name and model identifier from the environment Xcode
  gives the apps it launches; one `simctl` launches gets no `SIMULATOR_*` variables, so its UDID comes
  from the app's own path and its name from the simulator's `device.plist` (no model then). An Android
  emulator: its AVD as `id` and `name`, and `ro.product.model`, from `getprop`, which an app may run. A
  physical iPhone or Android phone: `model` only (`iPhone17,1` from sysctl `hw.machine` through
  dart:ffi, `ro.product.model`) and `simulator: false`, never the name its owner gave it: recordings get
  shared. Macs send `hw.model`, Linux the DMI product name, Windows and the web nothing.
- On `presence` with more editors than before, it sends the catalog again (as client.ts does). A relay
  that forwards an editor's `hello` instead gets the app's `hello` and the catalog back.
- Keep-alive is the WebSocket protocol's own ping (every 10 s, the socket closes when no pong comes), not
  the room's text `ping`, so every text frame stays JSON. A browser cannot send WebSocket pings: on the
  web it is the relay's text `ping`, answered with `pong` (which the client drops), and the socket closes
  when nothing arrives for three intervals. Reconnects back off from 500 ms to 10 s.
- `widget-sites` is in the capabilities only when widgets carry their creation location
  (`--track-widget-creation`: on in `flutter run`, `flutter test` and `flutter build apk|macos --debug`,
  off in `flutter build ios --debug`). Without it the app reports no implicit animations, no Hero flights
  and no render-hint locations, and a debug build says so once in the console; run it with `flutter run`.
- `time`, the rule every SDK follows: a scale that is missing, not a number, infinite or negative changes
  nothing; 0 pauses; between 0 and 0.01 is 0.01; above 1 is 1. `step` counts only while paused (after the
  message's own scale), as whole frames from 1 to 120 (rounded; one that is not a positive number is no
  step). Every `time` message is answered with `time` (the speed the app now runs at, 1 when it cannot
  change it); an editor that joins later gets it after the catalog when it is not 1. The speed goes back
  to 1 when the last editor leaves (announced as `time` 1, every time) or the relay goes away (announced
  after the next `hello`).
- `record` carries an optional `recorder`: the app keeps the recorders that are on and records while any
  is, sampling the union of their values (`*` in any: every value, including ones that mount meanwhile).
  `on: false` stops only that recorder. Requests without one share one anonymous recorder. Every
  recorder goes when the last editor leaves or the connection drops.

What the dev relay does, and the desktop relay should too: send `presence` to everyone on each join and
leave, keep one app (a new one replaces it), and hand a late editor the app's last `hello` and, after it,
its last `time` answer (in the room editors join first; locally the app usually does). A new `hello`
clears the speed: a reloaded app runs at 1x.

## What is reported, and how

| Protocol | Flutter source |
| --- | --- |
| `signal` sites | Each `KfAnimationController` (or tracked controller or notifier): its value, located where it was constructed (`column` when the stack has one). A second mounted instance of the same call site is `<id>#2`, as in React Native; its name gets ` #2` only when another instance has the same name (two rows named after their index keep their own). |
| `unsignal` | A tracked value disposed (its screen closed): it leaves the catalog. A recording keeps its id, so the screen opened again is followed. |
| `anim` events | `forward`, `reverse`, `animateTo`, `animateBack`, `repeat`, `fling`, `animateWith`, each at its own call site, `target` = the value's name. Args mirror `withTiming(to, { duration, ... })`: `[to, { duration, from, curve }]`; `repeat` is `[{ min, max, reverse, period }]`. `durationMs` is how long it runs: the duration scaled by the range left to cover (as AnimationController does), an explicit duration as given, a simulation until it rests; none for `repeat` and `fling`. While recording they carry `t`, `frames` (the stack mapped to source, Flutter's frames marked `collapse`) and `stack` (app frames, printed the way the panel parses stacks). |
| `params` / `overrides` | `1.duration` (or `0.period` for repeat) is tunable: an override applies the next time that call runs. |
| `samples` | Every recorded value's `.value`, once per frame, after the frame's animations ticked. |
| `frames`, `drops` | `js`: the UI isolate (build, layout, app code), measured like React Native's JS thread by a frame callback that reschedules itself. `ui`: the raster thread, from `SchedulerBinding.addTimingsCallback`; a frame is long when rasterising it took more than a refresh interval. Both use a port of `frameMeter.ts`. Engine timestamps map onto the recording's clock by the smallest offset seen, as client.ts maps the UI thread. |
| `touch` markers | `GestureBinding.instance.pointerRouter` global route: down, move (at most one per 8 ms per pointer), up, cancel, in logical points, timed by the event's own stamp. |
| `navigation` markers | `KfNavigatorObserver`: page routes by `RouteSettings.name`, with JSON route arguments as `params`. Dialogs are not screens. |
| `playback` | Samples written into the values in time order, navigating along `routes`. A value is the inspector's while it plays: its controller stops, and what the app starts on it meanwhile waits. When playback ends, that deferred start runs, or an animation that was running before (a loop) starts again. |
| `scrub` | A playback whose samples all share one moment holds its values (a loop stays where the playhead shows) until the next playback, capture or recording. |
| `capture` | Navigate to the moment's screen, set the values, wait two frames, `RenderRepaintBoundary.toImage`. Always PNG (the answer's `format` says so, which the protocol allows): Flutter has no JPEG encoder without a plugin. 600 ms after the last capture of an export the values go back to what they were. |
| `scenario`, `replay` | `registerScenario`, `registerReplay`. |
| `time` | Slow motion is `timeDilation` (what DevTools' Slow animations sets; the app's own value comes back at 1). A pause cannot be a dilation, so while paused `KfClock` stands in front of the scheduler's frame handler (`PlatformDispatcher.onBeginFrame`) and gives every frame the same time stamp; a `step` moves it on by one frame at the display's rate per frame drawn. Every ticker reads that clock, so this covers every animation in the app (tracked or not, implicit animations, Hero flights, route transitions, scroll physics), while the app still builds and answers touches. Back to normal, it counts from where it stood: no jump. `time` markers while recording (at 0 when it starts slowed). |
| `display` | `FlutterView.display.refreshRate`; a change (`didChangeMetrics`) is a `display` marker while recording. Frames are counted against it: a fixed rate is the budget (a 16.7 ms frame on a 120 Hz display missed one refresh), an adaptive one starts at 60 Hz and is learned upward but never past the display. |
| `accessibility`, `appState` markers | `didChangeAccessibilityFeatures` and `didChangeAppLifecycleState` while recording: `reduceMotion`, and `active`, `inactive` or `background`. |
| Implicit animations | While recording, a walk of the element tree about once a second finds the `ImplicitlyAnimatedWidgetState`s the app wrote (Flutter's own, inside every Material, are left out) and makes each a value: its progress through the current change, eased by its curve (`writable: false`), with the property it animates as the site's `prop` (`opacity` for AnimatedOpacity, `scale`, `rotate`, `translate`, `position`, `alignment`, `padding`, `size`, `elevation`, `textStyle`, `theme`; none for TweenAnimationBuilder, whose builder decides, or for AnimatedContainer, whose each `anim` says what that change animates, comma-joined: `size,color`). Each change is an `anim` named after the widget (`fn: 'AnimatedContainer'`, `[to, { duration, curve }]`, `durationMs`), located where the widget was written, with the component whose build wrote it. Locations come from widget creation tracking, so debug builds that have it only (`widget-sites`). They leave the catalog when their widget goes or the recording stops. |
| `Hero` flights | `KfNavigatorObserver` matches the Hero tags of the two screens a push or pop moves between (as HeroController does, minus `HeroMode(enabled: false)`) and reports an `anim` per flight (`fn: 'Hero'`, `target: 'Hero(<tag>)'`, `[1 or 0, { duration, tag, from, to }]`) at the landing Hero (or the app's widget around it, for a FloatingActionButton's), with a value that follows the flight until it lands. A back swipe's flights follow the finger and are not reported. |
| `visibility` markers | Every 200 ms while recording, for each value that moved: are any of its widgets visible. Its widgets are the animated widgets listening to it (AnimatedBuilder and every AnimatedWidget, FadeTransition, ValueListenableBuilder, through CurvedAnimation, Tween.animate and the other wrappers), else the State whose ticker drives it, but only for a value no animated widget was ever seen listening to: one whose widgets all went is `offscreen` when the last of them sat in a scrollable (a lazy list unmounted the row it scrolled away), else `detached`, never its still-visible State. `detached` (gone while it moves), `hidden` (an opacity of 0, Offstage, Visibility, a muted TickerMode, no area), `offscreen` (outside the screen or its viewport), `covered` (an opaque screen above it finished arriving). Hidden is confirmed on two looks in a row, so a value Flutter mutes as its screen is covered is not reported, and a screen sliding in or out is not judged. Visible again: a marker at once. |
| `renderHint` events | From the same looks, once per value and hint (they join the catalog): `opacity-widget` (an `Opacity` rebuilt with another opacity between 0 and 1), `blur` (a `BackdropFilter` drawn over where a value moves, or an `ImageFiltered` around it), `mask` (`ClipPath`, `ShaderMask` around a moving value), `save-layer` (a clip with `Clip.antiAliasWithSaveLayer` around one). `detail` names the widget and, in debug builds, where it was written. |

## Call sites: the choice

| Approach | Works today | Automatic | Notes |
| --- | --- | --- | --- |
| `KfAnimationController` (a subclass) capturing `StackTrace.current` | Yes | One rename per controller | Chosen. Exact for creation and for every start (each start parses the stack of that call). Sees the command, its duration and curve. |
| `controller.kfTrack('name')` (an extension) | Yes | One call per controller | For controllers you do not construct. A plain controller cannot be intercepted, so starts are seen only as status changes: no call site, curve or exact command. |
| `--track-widget-creation` locations | Debug only | Fully | Locates widgets, not controllers (a controller is not a widget). Used for what has no call of its own: implicit animations, Hero flights, render hints. |
| A kernel transformer | Needs a custom build step | Fully | The route to React Native parity (rewrite `AnimationController(` and `.forward(` calls with baked-in sites, including implicit animations). Flutter has no supported plugin point for kernel transformers today, so it means a forked frontend or a build wrapper. Later. |

Stack traces give `file:line:column` in debug builds and `file:line` in profile and release (AOT). Built
with `--split-debug-info` or `--obfuscate`, AOT prints addresses: sites then fall back to the value's
name (`value:card`, `value:card#forward`). On the web, a debug build's stacks are mapped to source
(`lib/main.dart:42:26`, components unnamed: it prints methods without their class); a profile or
release build's point into `main.dart.js`, so sites fall back to names there too.

## Tests

```sh
flutter test                                   # 102 tests
flutter test --platform chrome test/web_test.dart   # what must hold in a browser too
```

- `call_site_test.dart`: VM, AOT, web and V8 stack formats, the split-debug-info case, app frames,
  project-relative files, component names, compiled web frames never taken as call sites.
- `protocol_test.dart`: a scripted session through the real client, compared with `test/goldens/*.json`
  (hello with display, accessibility and `time`; the `time` answer; the visibility, display,
  accessibility, appState and time markers; a render hint). The goldens are also written to
  `test/goldens/messages.ts` with `satisfies InspectorAppMessage`, and the test runs `tsc` on it (with the
  monorepo's TypeScript, skipped when it is not installed): a missing or extra field or a wrong literal
  fails. `KF_UPDATE_GOLDENS=1 flutter test test/protocol_test.dart` rewrites them.
- `client_test.dart`: hello and catalog, batching, presence, recording (samples, both threads' frames,
  touches, navigation), playback, capture, scenarios, overrides, reconnect, the frame meter (with and
  without a display), `time` (answers, markers, steps only while paused, back to 1 when editors leave),
  display, accessibility and lifecycle markers, the scene's markers and hints, and a host written before
  the optional interfaces.
- `controller_test.dart`: sites from a real widget, every start kind, overrides, playback handing a loop
  back, instances, `kfTrack`, the navigator observer.
- `time_test.dart`: the clock on real controllers: slow motion, a pause held through engine-style frames
  and stepped by display frames, back to normal with no jump, the fallback without a frame handler.
- `scene_test.dart`: real widgets: implicit animations with their sites and components (Flutter's own
  left out), visibility for every reason (and none for a value muted as its screen is covered, or while
  a screen slides in), every render hint and what is not one, Hero flights there and back.
- `web_test.dart`: the scan, the clock and call sites, in a browser as well as on the VM.
- `device_test.dart`: what each platform may send (simulators by UDID and name, with and without
  Xcode's environment; emulators by AVD; physical devices by model only), getprop's listing, and the
  real reading on this machine (sysctl through dart:ffi on a Mac).
- `relay_test.dart`: app and editor over real WebSockets through the dev relay, `time` routed both ways
  and handed to late editors.

## Not yet

Implicit animations are found in debug builds only (their locations need widget creation tracking), and
`AnimatedSwitcher`, `AnimatedCrossFade` and `AnimatedSize` (not ImplicitlyAnimatedWidgets) are not;
Hero flights driven by a back swipe are not reported; build and layout cost per widget (the `commits` /
`tasks` equivalents) is not reported; recordings made on the device (`recording` message) are not
built; profile builds are not yet verified on a device; a compiled web build's call sites are names, not
lines.
