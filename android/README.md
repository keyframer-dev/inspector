# Keyframer inspector for Android

The Android side of the Keyframer runtime inspector: an Android app (Views, and Jetpack Compose through
an opt-in module) reports its animations with their call sites, records and replays animated values,
measures frames and touches, runs its animations in slow motion, paused or frame by frame for the
editor, and speaks the same protocol as the React Native inspector (`protocol/inspector.ts`).
The panel, the trace and problems engine and the MCP server read it as they read a React Native app.

Status: verified end to end on an API 34 emulator against the fake relay (record, scenario, playback,
capture at chosen times, overrides, replay; `time` on Views and Compose, render hints, visibility and
accessibility markers), and by instrumented tests on the same emulator.

## Layout

```
keyframer-inspector-core/   pure Kotlin (JVM), no Android: tested with ./gradlew test
  Protocol.kt               the wire types, mirrored from inspector.ts (golden JSON tests, type-checked by tsc)
  EditorMessage.kt          what an editor sends: record, playback, capture, overrides, replay, scenario, time, presence
  Json.kt                   small JSON writer and reader (numbers print like JSON.stringify)
  InspectorSession.kt       port of client.ts connectInspector: hello, batching, record, playback, capture,
                            time, render hints, reconnect
  CallSites.kt              first app frame of a JVM stack: file, line, component (composables and their lambdas too)
  FrameMeter.kt             port of frameMeter.ts, counting against the display's rate when it is known
  TimeClock.kt              animation time under the editor's speed: scaled, held, stepped, never jumping
  Visibility.kt             visibility markers from checks of tracked views, and their reasons
  Devices.kt                what the hello says about the device, from Build fields and getprop output
  OkHttpSockets.kt          WebSocket transport
keyframer-inspector/        Android library (minSdk 24)
  Keyframer.kt              public API: start, track / kfTrack, signal, setRoute, setNavigator, registerReplay, registerScenario
  Animators.kt              tracked ValueAnimator / ObjectAnimator / AnimatorSet children: events, signals,
                            scrubbing, overrides, their views (visibility, render hints)
  TimeControl.kt            the `time` capability: the animator duration scale, holding and stepping animators
  RenderHints.kt            what costs more than it needs to on an animated view: layer-alpha, elevation, mask, blur
  Visibility.kt             checks tracked views while recording: detached, covered, hidden, offscreen
  DeviceProbe.kt            the device for the hello: Build fields and getprop, run once off the main thread
  AndroidHost.kt            activities, touches, navigation markers, app state, display and motion settings,
                            PixelCopy screenshots, navigating back
  KeyframerExtensions.kt    what keyframer-inspector-compose reaches the session through (opt-in, not app API)
  Platform.kt               main thread scheduler, clock, Choreographer frame loop
  TouchCallback.kt          Window.Callback wrapper that sees every touch
  src/androidTest/          instrumented tests: time on each kind of animator, render hints, visibility, the device
keyframer-inspector-noop/   what release builds link: Keyframer's API with empty bodies, no dependencies
keyframer-inspector-compose/       Jetpack Compose (opt-in): tracked animate*AsState, Animatable, updateTransition,
                                   rememberInfiniteTransition, and Compose's frame clock on the inspector's time
keyframer-inspector-compose-noop/  its release stand-in: the same functions, each Compose's own
example/                    an entrance, a loop, a drag, a second screen, a Compose screen and four scenarios
                            (debug: the libraries; release: the no-ops)
fake-relay/                 stand-in for the desktop relay, plus a scripted editor (EditorClient, Script)
```

## Toolchain

JDK 17, Android SDK (platform 35, build tools), Gradle 8.14.3 through the wrapper, AGP 8.13.2, Kotlin
2.2.10 (the Compose compiler is Kotlin's: `org.jetbrains.kotlin.plugin.compose` 2.2.10), Compose 1.7.6 as
the oldest the Compose module supports. `ANDROID_HOME` must point at the SDK (or add a `local.properties`
with `sdk.dir`).

```sh
./gradlew test                    # 82 JVM tests: protocol goldens, parsing, call sites, frame meter, time clock,
                                  # visibility, device rules, session, relay end to end
./gradlew :keyframer-inspector:connectedDebugAndroidTest   # 13 tests on a device or emulator (every connected
                                  # one: ANDROID_SERIAL=<serial> picks one)
./gradlew :example:assembleDebug  # the example APK (assembleRelease: the same app on the no-ops)
./gradlew publishToMavenLocal     # every module, signed (keys from ~/.gradle/gradle.properties)
```

`GoldensTest` writes every message the SDK sends into `keyframer-inspector-core/src/test/goldens/messages.ts`
and runs `tsc` over it against the protocol when the workspace has TypeScript installed (skipped
otherwise). After changing a message: `./gradlew :keyframer-inspector-core:test -PupdateGoldens=true`.

## Try it

1. Run a relay (the desktop app later, the fake one now):

   ```sh
   ./gradlew :fake-relay:run                          # ws://127.0.0.1:8790, logs every message
   ```

2. Install and open the example. On the emulator it connects to `ws://10.0.2.2:8790` by itself. On a
   device run `adb reverse tcp:8790 tcp:8790` (it uses 127.0.0.1 there), or build with
   `-Pkeyframer.host=<LAN IP>` and add that IP to `network_security_config.xml`.

   ```sh
   ./gradlew :example:installDebug
   ```

3. Or let the scripted editor drive a whole session and check it:

   ```sh
   ./gradlew :fake-relay:installDist
   fake-relay/build/install/fake-relay/bin/fake-relay --script --record 3500 \
     --scenario "drag card,open detail" --capture-at 300,800,1500 --out /tmp/kf
   ```

   It waits for the app, records everything while the scenarios run, prints a summary (signals,
   samples per track, frame windows, long frames, markers, animations with call sites), plays the
   recording back, then captures the given moments (navigating to the screen each one was on) as JPEGs.

4. Check slow motion, pause and step on the device: `--time <signal name>` records while it sets the
   speed to 1, 0.25, 0 (then steps 6 frames) and 1 again, and measures how fast that signal moves in
   each phase, aligned on the `time` markers the app put in the recording:

   ```sh
   fake-relay/build/install/fake-relay/bin/fake-relay --script --time pulse                          # Views
   fake-relay/build/install/fake-relay/bin/fake-relay --script --time scale --scenario "open compose" # Compose
   ```

   It also prints the hello's display and motion settings, the `time`, `display`, `accessibility` and
   `visibility` markers, and the render hints it saw. `--port` moves the relay off 8790 (build the app
   with the same `-Pkeyframer.port`).

## Use it in an app

```kotlin
// build.gradle.kts
debugImplementation("dev.keyframer:keyframer-inspector:0.2.0")
releaseImplementation("dev.keyframer:keyframer-inspector-noop:0.2.0")   // same API, does nothing, no OkHttp

// Application.onCreate
Keyframer.start(this)                                   // debuggable builds only, unless enableInRelease

// Animators: reported on every start, value and play time recorded and replayable
ObjectAnimator.ofFloat(title, View.ALPHA, 0f, 1f).kfTrack("title").start()

// A ValueAnimator that moves a view from its update listener: pass the view, so the panel sees it
// leave the screen and gets render hints for it, as it does for an ObjectAnimator's target
ValueAnimator.ofFloat(1f, 1.3f).apply { addUpdateListener { ... } }.kfTrack("pulse", pulse).start()

// Anything else that moves: a drag, a scroll offset, a progress (the view is optional, for visibility)
Keyframer.signal("cardX", card, read = { card.translationX }, write = { card.translationX = it })

// Screens that are not activities (fragments, Navigation)
navController.addOnDestinationChangedListener { _, d, _ -> Keyframer.setRoute(d.route ?: d.label.toString()) }
Keyframer.setNavigator { route, _ -> navController.navigate(route); true }

// Something an agent can run to reproduce a problem
Keyframer.registerScenario("drag card") { done -> runTheDrag(); done(null) }
```

The relay is plain `ws://`, so the app must allow cleartext to that host only (see
`example/src/main/res/xml/network_security_config.xml`).

### Jetpack Compose

```kotlin
// build.gradle.kts: these replace the two lines above (each brings its base module)
debugImplementation("dev.keyframer:keyframer-inspector-compose:0.2.0")
releaseImplementation("dev.keyframer:keyframer-inspector-compose-noop:0.2.0")

// The same calls with kf in front: the same parameters, the same behaviour
val height by kfAnimateDpAsState(if (open) 200.dp else 110.dp, spring(dampingRatio = 0.6f), label = "height")
val corner by kfAnimateFloatAsState(if (open) 32f else 20f, tween(400), label = "corner")
val card = kfUpdateTransition(open, label = "card")          // children: Compose's own animateFloat, animateColor...
val pulse = rememberKfInfiniteTransition(label = "pulse")     // children: Compose's own animateFloat...
val x = rememberKfAnimatable(0f, label = "ballX")
scope.launch { x.kfAnimateTo(0f, spring(dampingRatio = 0.35f)) }
```

Nothing else to set up: `Keyframer.start` finds the module, the hello then says `framework: "compose"`,
and every Compose window runs on the inspector's animation time (see Time, below).

Release builds: the no-op module has the same functions, each one Compose's own call
(`kfAnimateFloatAsState` is `animateFloatAsState`), on keyframer-inspector-noop. A separate artifact
rather than one module that checks `Keyframer.isRunning`: the tracking code reaches into the session
(keyframer-inspector-core), which a release build does not link, and a shrunk release build would fail
on the missing classes.

## How Android maps onto the protocol

- **Call sites.** `Throwable().stackTrace` at `track()` / `signal()`: the first frame outside the SDK,
  the platform and libraries (`CallSites.libraryPrefixes`, plus `KeyframerConfig.libraryPrefixes`).
  `file` is the package as folders plus the file name (`dev/keyframer/example/MainActivity.kt`),
  `column` is 0 (JVM frames have no column), `component` is the outer class, or the function for a
  top-level function (how a composable will be named).
- **Hello.** `platform: "android"`, `framework: "android-views"` (`"compose"` with the Compose module),
  `osVersion`, `protocol: 1`, `sdk: { name: "keyframer-inspector", version }`,
  `threads: { js: { label: "Main", animates: true } }`, `capabilities: ["capture", "playback",
  "overrides", "replay", "scenarios", "time"]` (no `scrub`: the play-time tracks cover it through
  `playback` and `capture`; no device `recordings` yet), `display` and `accessibility` (below), and
  `device`, so a relay or a CI run can tell two apps apart:
  - an emulator (its qemu properties, or a goldfish or ranchu build) sends `simulator: true`, `id` its
    AVD name (`ro.boot.qemu.avd_name`, `ro.kernel.qemu.avd_name` on older images), `name` the same
    with spaces (else the emulator's own device name setting) and `model` (`Build.MODEL`);
  - a physical device sends `simulator: false` and `model` (`Build.MODEL`, with `Build.MANUFACTURER`
    in front when the model leaves it out) and never a name: the one a phone has is the one its owner
    gave it, and recordings get shared.

  The properties come from running `getprop` once at start, off the main thread (the
  `SystemProperties` class is hidden API); the rules are in core's `Devices.kt`.
- **Animations.** One `anim` event per start, `thread: "js"`, `fn` is `ValueAnimator` or
  `ObjectAnimator`, `target` the name given (or the target view's id name), `prop` the property.
  `args` is one config object shaped like the React Native "CSS animation" args, so existing readers
  understand it: `{ duration, delay, iterationCount, direction, interpolator, values: { alpha: [0, 1] } }`.
  `params` are `duration`, `startDelay` and `repeatCount`: the panel's live overrides apply to them on
  the next start. `durationMs` is the delay plus every repeat (left out for an infinite animator).
  While recording, events carry `t` and `frames` (the stack, resolved on the device).
- **Recorders.** `record` carries an optional `recorder` id: the app keeps the recorders that are on
  and records while any is, over the union of their ids, so one editor stopping does not stop
  another. Requests without an id share one anonymous recorder. Every recorder goes when the last
  editor leaves or the connection drops.
- **Signals.** A tracked animator registers `<site>` (or `<site>:<property>` for several properties),
  its animated value (with `prop`, the property it animates), and `<site>:time`, its play time
  (`kind: "time"`: a track playback writes, not a value on screen, so the motion problems skip it).
  The name given to `kfTrack` is part of the site: one line that tracks `row1` to `row50` in a loop
  gives fifty animators with ids of their own (several under one name get `#2`, `#3`). Playback and capture write the time track: the
  SDK pauses the animator and seeks a clone of it, which shares the app's update listeners and an
  ObjectAnimator's target, so the views show that moment while the real animator is untouched; when
  done it resumes the original or puts the views back. `Keyframer.signal` values are written directly.
  The value signals say `writable: false`; the time track and `Keyframer.signal` values with a
  `write` are writable. Signals go away with the activity they were created in (or `Keyframer.untrack`
  / `Keyframer.removeSignal`), and the panel gets `{ kind: "unsignal", id }`.
- **Frames and threads.** Threads are reported by role: `js` is the app thread, `ui` the frame thread.
  The Android main thread is the app thread (and, `animates: true`, where animators run), so a
  `Choreographer.FrameCallback` runs the same frame meter as React Native and reports frame stats,
  drops and anims as `"js"`. Compose draws its frames from the same Choreographer, so the meter covers
  it as it is (recomposition, layout and draw all run on the main thread). `ui` would be RenderThread:
  it is left out of `threads` until it is measured (FrameMetrics or JankStats, a next step). Samples are
  read just after each frame (a message posted at the front of the queue from the frame callback), so a
  sample holds what that frame showed.
- **Display.** `display: { hz, adaptive }`: the highest rate among the default display's modes at its
  resolution (`Display.getSupportedModes`), `adaptive` when there are several. Frames are counted
  against the current `Display.getRefreshRate()` (rounded to whole hertz) instead of a guess from the
  frames, kept current by a `DisplayListener`: each change while recording is a `display` marker, and a
  recording that starts below the hello's rate (an adaptive display idling at 60 Hz) gets one at `t: 0`.
- **Accessibility.** `accessibility: { reduceMotion }` is "Remove animations": the
  `Settings.Global.ANIMATOR_DURATION_SCALE` setting at 0 (`ValueAnimator.areAnimatorsEnabled()` when
  the setting cannot be read). A `ContentObserver` turns changes while recording into `accessibility`
  markers.
- **Time** (the `time` message, answered every time with `{ type: "time", scale }` and the speed in
  effect, and a `time` marker on each change and each step while recording; a recording started
  slowed gets one at `t: 0`). The rules every SDK shares (core's `TimeRules`): a scale that is not a
  finite number of at least 0 changes nothing, 0 pauses, others run from 0.01 to 1; a step counts only
  while paused, in whole frames from 1 to 120. Slow motion is the animator
  duration scale, set through ValueAnimator's hidden `setDurationScale` (allowed by reflection,
  "unsupported" but not blocked, on API 34): every ValueAnimator, ObjectAnimator, AnimatorSet,
  ViewPropertyAnimator and Transition in the process slows. A running animator reads the scale every
  frame, so a change would move it along its curve; tracked ones are put back at their play time, so
  they do not jump. Pause cannot use the scale (0 is "animations off": everything jumps to its end), so
  the tracked running animators are held instead: every frame their play time is set back to where it
  was (an AnimatorSet as a whole on API 26+), which re-anchors their start time, so letting go
  continues from there. A step moves that play time on by one frame at the display's rate, one per
  frame. Each change lands on the next frame, where the animation clock is locked to the vsync, so the
  play times read and set are exact; the reflection waits for the first `time` message, so an app that
  never gets one never touches hidden API. When the reflection is refused, slow motion drives the
  tracked animators the same way. Compose
  runs on the same animation time (`TimeClock`) through each window's frame clock (installed with
  `WindowRecomposerPolicy`), so slow motion, pause and step reach every Compose animation, tracked or
  not, with no jumps. The speed goes back to 1 when the editor sends 1, when the last editor leaves (a
  `presence` with no editors), when the connection drops, and on `Keyframer.stop`, and the app says
  so (`{ type: "time", scale: 1 }`) while it is still connected.
- **Visibility.** While recording, the views of tracked animators (an ObjectAnimator's target, or the
  view given to `kfTrack(name, view)`) and of `Keyframer.signal(name, view, ...)` are checked every
  100 ms while their animation runs (and while reported not visible, to see them come back):
  `detached` (not in a window), `covered` (its window is not shown: another activity on top),
  `hidden` (`isShown` false, or it or a parent at alpha 0; a view whose own alpha animates is not hidden
  at 0, that is its fade), `offscreen` (`getGlobalVisibleRect` false: outside the window or clipped
  away). Each change is a `visibility` marker for the view's value signals. In the background nothing
  is checked: that is the `appState` marker.
- **Render hints.** Read on the first frame of each start of a tracked animator, sent once per signal
  and hint, and kept with the catalog for editors that join later (Compose has none yet):
  - `layer-alpha`: alpha animates on a view with overlapping rendering and no hardware layer.
  - `elevation` (a key of this SDK, documented for the problems engine): elevation, translationZ or z
    animates, so the shadow is drawn again every frame.
  - `mask`: the view or a parent clips to a path outline (`clipToOutline` with `Outline.setPath`, API
    33+); rect and round rect clips are cheap and not reported.
  - `blur`: the view's window, or the activity window above it, blurs what is behind it
    (`FLAG_BLUR_BEHIND`, API 31+). A view's own `RenderEffect` has no getter, so it cannot be seen.
- **Compose.** The tracked functions find their call site once, from the stack of their first
  composition: the composable that called them is the component (a lambda inside it too; one Compose
  hoisted into `ComposableSingletons` is named after its file). `animate*AsState` and `kfAnimateTo`
  report an `anim` on every start, `fn` the Compose name (`animateFloatAsState`,
  `Animatable.animateTo`), `target` the label, `args` the spec as `{ type: "tween" | "spring" |
  "keyframes" | "snap" | "repeatable" | "infiniteRepeatable", duration, delay, easing, dampingRatio,
  stiffness, iterationCount, direction, values: { label: [from, to] } }`, and `durationMs` from
  Compose's own math (a spring's settle time from its current velocity). Their `params` (duration and
  delay of a tween, damping ratio and stiffness of a spring) take the panel's live overrides on the next
  start. Values are signals: one per component (an Offset's x and y), written by playback and capture
  through `snapTo` (the animation stops while it is held, and the app's target takes over again after).
  `kfUpdateTransition` reports each change of state with every child's spec and the total duration, and
  its play time and each child (by label) are read-only signals; `rememberKfInfiniteTransition` reports
  each child once when it starts. A screen made again by playback takes over the ids of the one that is
  finishing, so recorded samples still find their values.
- **Touches and screens.** A `Window.Callback` wrapper on every activity window sends `touch`
  markers (start, move at most every 8 ms per finger, end, cancel) in dp screen coordinates, timed by
  the event. Each resumed activity is a `navigation` marker (or what `setRoute` set), and the app going
  to the background and back is `appState` (`background` / `active`). Playback and capture navigate
  back to an activity by name (`FLAG_ACTIVITY_CLEAR_TOP` when it is still in the stack).
- **Capture.** `PixelCopy` of the top window (a software draw below API 26), scaled to `width` and
  encoded off the main thread.
- **Replay.** Re-creates the top activity, which re-runs its entrances, unless the app registered its own.
- **Transport.** OkHttp WebSocket to `ws://<host>:8790/app?name=<app>&platform=android`, reconnecting
  with a 500 ms to 10 s backoff. Liveness uses WebSocket ping frames instead of the text "ping". A new
  editor gets the catalog again on a `presence` with more editors, or on an editor `hello` forwarded by
  the relay.

## Limits of this kickstart

- Animators must be registered (`kfTrack`): Android has no public global hook (`AnimationHandler` is
  hidden API, and reading it by reflection is denied on API 34). `ViewPropertyAnimator`
  (`view.animate()`), `SpringAnimation` / `FlingAnimation` (androidx.dynamicanimation), `Transition`s,
  `MotionLayout` and drawable animations are not covered yet.
- `time`: untracked animators (ViewPropertyAnimator, Transitions) slow with the duration scale but are
  not held when paused, and jump when the speed changes; an animator still in its start delay is held
  once its delay is over. SpringAnimation (its own frame loop) does not follow the speed at all.
- Compose: transitions are read-only (playback shows their children through the recording, it does not
  seek the transition); Compose render hints are not read yet; the window frame clock replaces
  Compose's default `WindowRecomposerFactory`, so an app that sets its own factory should do so after
  `Keyframer.start` (it then keeps Compose's clock).
- AnimatorSet children are tracked one by one; on API 26+ the set drives them, so a set-level time
  track would scrub them together more faithfully.
- Touches on dialogs and popups (their own windows) are not seen; the keyboard marker is not wired.
- No device recordings (`recording` message, `.kfrec.json` export), no `tasks` (long main-thread
  messages) and no `commits` equivalent yet.
- Keyframe values are read from `PropertyValuesHolder.toString()` (no public getter); path-based
  holders report none.

## Compose, next

- **More wrappers:** `animateContentSize`, `AnimatedVisibility` and `AnimatedContent` (their transitions
  are reachable through `Transition.transitions`), `Animatable.animateDecay`, and seeking transitions
  for playback (`Transition.seek`, internal API today).
- **Call sites without wrappers:** the Compose compiler's `sourceInformation` (in debug builds) gives
  file and line of each composable call; a small Kotlin compiler plugin (or AGP's ASM instrumentation
  API) can rewrite `animate*AsState` and `Animatable.animateTo` calls to pass their site, the way the
  Babel plugin does.
- **Render hints:** `Modifier.blur` and `graphicsLayer { renderEffect }` over moving content, alpha
  through `Modifier.alpha` on overlapping content (`CompositingStrategy`).
- **Frames:** JankStats (androidx.metrics) per window for RenderThread as the `ui` thread, which also
  reports state that was active during a janky frame.

## Protocol

Adopted from protocol pass 1 (`protocol/inspector.ts`): threads by role, the hello fields
(framework, osVersion, protocol, sdk, threads, capabilities), `frames` and `durationMs` on `anim`,
`unsignal`, and `column` / `writable` on signal sites. From the "every developer, every platform" pass:
the `time` message and answer and the `time` capability, `display` and `accessibility` in the hello,
`renderHint` events, and the `accessibility`, `display`, `visibility` and `time` markers (no device
recordings yet, so no recording `hints`). Still open:

1. **`fn` vocabulary for timing estimates.** `motionStats.estimateMs` switches on React Native names;
   Android sends `durationMs`, which readers should prefer when present.
2. **Source paths.** Native call sites know a package path, not a repository path. A `sourceRoots` hint
   in `hello` (or the cli resolving `dev/keyframer/example/MainActivity.kt` under `src/main/{java,kotlin}`)
   would let `source` and `apply` work for native apps.

## Next steps

1. `ViewPropertyAnimator` (its update listener exposes the internal ValueAnimator, which would also let
   `time` hold it), `SpringAnimation`, and AnimatorSet as one time track.
2. A Gradle plugin using AGP's ASM instrumentation to rewrite `Animator.start()` and
   `View.animate()` call sites in debug variants: tracking without `kfTrack`, with exact file and line.
3. Main-thread `tasks` (kind `looper`) from `Looper` message timing, and RenderThread as the `ui`
   thread from `FrameMetrics` / JankStats.
4. Device recordings: `recording` messages and `.kfrec.json` export without a panel connected.
5. Compose: wrappers, then the compiler plugin.
6. Dialog and popup windows for touches, the keyboard marker through window insets, and Fragment
   lifecycle callbacks as navigation markers.
