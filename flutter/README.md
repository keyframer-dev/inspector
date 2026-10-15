# keyframer_inspector (Flutter)

The Keyframer runtime inspector for Flutter apps. It is the Flutter counterpart of `@keyframerdev/inspector`
(React Native): a Flutter app reports its animated values and animations with their call sites, samples
values every frame while recording, measures frames on the UI and raster threads, records touches and
navigation, and plays recordings back. It speaks the same protocol (`protocol/inspector.ts`),
so the panel, the trace and problems engine and the MCP server read a Flutter app as they read a React
Native one.

Status: a working vertical slice. Debug builds are verified end to end on macOS desktop.

## Quick start

Flutter 3.29 or later.

```yaml
# pubspec.yaml
dependencies:
  keyframer_inspector: ^0.1.1
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

## Running the example against a relay

The desktop app will host the relay. Until then, `tool/relay.dart` is a stand-in with the same contract.

```sh
cd inspector-native/flutter
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

A physical device connects to the Mac over the LAN:

```sh
dart run tool/relay.dart --lan
flutter run --dart-define=KEYFRAMER_HOST=192.168.1.20      # the Mac's LAN IP
```

The Android emulator reaches the Mac at `10.0.2.2`, which is the default on Android. The example's iOS
`Info.plist` allows local networking, its Android debug manifest allows cleartext, and its macOS
entitlements allow outgoing connections.

## Transport

`ws://<host>:8790/app?name=<app>&platform=<os>`. Each text frame is one JSON `InspectorMessage`.

- The app sends `hello`, then the catalog (`events` with every `signal`), then batches every 100 ms.
- `hello` says what the app is: `platform` is the OS (`macos`, `ios`, `android`), with `framework:
  'flutter'`, `osVersion` (Apple platforms; dart:io cannot tell Android's), `protocol: 1`, `sdk`, the
  threads (`js`: UI isolate, animates; `ui`: Raster) and `capabilities` (`playback`, `scrub`,
  `overrides`, `replay`, `scenarios`, and `capture` under `KeyframerInspector`).
- On `presence` with more editors than before, it sends the catalog again (as client.ts does). A relay
  that forwards an editor's `hello` instead gets the app's `hello` and the catalog back.
- Keep-alive is the WebSocket protocol's own ping (every 10 s, the socket closes when no pong comes), not
  the room's text `ping`, so every text frame stays JSON. Reconnects back off from 500 ms to 10 s.

What the dev relay does, and the desktop relay should too: send `presence` to everyone on each join and
leave, keep one app (a new one replaces it), and hand a late editor the app's last `hello` (in the room
editors join first; locally the app usually does).

## What is reported, and how

| Protocol | Flutter source |
| --- | --- |
| `signal` sites | Each `KfAnimationController` (or tracked controller or notifier): its value, located where it was constructed (`column` when the stack has one). A second mounted instance of the same call site is `<id>#2`, as in React Native. |
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

## Call sites: the choice

| Approach | Works today | Automatic | Notes |
| --- | --- | --- | --- |
| `KfAnimationController` (a subclass) capturing `StackTrace.current` | Yes | One rename per controller | Chosen. Exact for creation and for every start (each start parses the stack of that call). Sees the command, its duration and curve. |
| `controller.kfTrack('name')` (an extension) | Yes | One call per controller | For controllers you do not construct. A plain controller cannot be intercepted, so starts are seen only as status changes: no call site, curve or exact command. |
| `--track-widget-creation` locations | Debug only | Fully | Locates widgets, not controllers (a controller is not a widget), and needs the debug inspector service. It could map an `AnimatedBuilder` to its source later. |
| A kernel transformer | Needs a custom build step | Fully | The route to React Native parity (rewrite `AnimationController(` and `.forward(` calls with baked-in sites, including implicit animations). Flutter has no supported plugin point for kernel transformers today, so it means a forked frontend or a build wrapper. Later. |

Stack traces give `file:line:column` in debug builds and `file:line` in profile and release (AOT). Built
with `--split-debug-info` or `--obfuscate`, AOT prints addresses: sites then fall back to the value's
name (`value:card`, `value:card#forward`).

## Tests

```sh
flutter test          # 43 tests
```

- `call_site_test.dart`: VM, AOT, web and V8 stack formats, the split-debug-info case, app frames,
  project-relative files, component names.
- `protocol_test.dart`: a scripted session through the real client, compared with `test/goldens/*.json`.
  The goldens are also written to `test/goldens/messages.ts` with `satisfies InspectorAppMessage`, and the
  test runs `tsc` on it (with the monorepo's TypeScript, skipped when it is not installed): a missing or
  extra field or a wrong literal fails. `KF_UPDATE_GOLDENS=1 flutter test test/protocol_test.dart`
  rewrites them.
- `client_test.dart`: hello and catalog, batching, presence, recording (samples, both threads' frames,
  touches, navigation), playback, capture, scenarios, overrides, reconnect, the frame meter.
- `controller_test.dart`: sites from a real widget, every start kind, overrides, playback handing a loop
  back, instances, `kfTrack`, the navigator observer.
- `relay_test.dart`: app and editor over real WebSockets through the dev relay.

## Not yet

Implicit animations (`AnimatedContainer`, `TweenAnimationBuilder`) and `Hero` are not seen; build and
layout cost per widget (the `commits` / `tasks` equivalents) is not reported; recordings made on the
device (`recording` message) are not built; Flutter web needs a non-dart:io transport; profile builds are
not yet verified on a device.
