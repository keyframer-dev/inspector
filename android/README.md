# Keyframer inspector for Android

The Android side of the Keyframer runtime inspector: an Android app (Views today, Compose next) reports
its animations with their call sites, records and replays animated values, measures frames and touches,
and speaks the same protocol as the React Native inspector (`protocol/inspector.ts`). The
panel, the trace and problems engine and the MCP server read it as they read a React Native app.

Status: kickstart. Verified end to end on an API 34 emulator against the fake relay (record, scenario,
playback, capture at chosen times, overrides, replay).

## Layout

```
keyframer-inspector-core/   pure Kotlin (JVM), no Android: tested with ./gradlew test
  Protocol.kt               the wire types, mirrored from inspector.ts (golden JSON tests)
  EditorMessage.kt          what an editor sends: record, playback, capture, overrides, replay, scenario, presence
  Json.kt                   small JSON writer and reader (numbers print like JSON.stringify)
  InspectorSession.kt       port of client.ts connectInspector: hello, batching, record, playback, capture, reconnect
  CallSites.kt              first app frame of a JVM stack: file, line, component
  FrameMeter.kt             port of frameMeter.ts
  OkHttpSockets.kt          WebSocket transport
keyframer-inspector/        Android library (minSdk 24)
  Keyframer.kt              public API: start, track / kfTrack, signal, setRoute, setNavigator, registerReplay, registerScenario
  Animators.kt              tracked ValueAnimator / ObjectAnimator / AnimatorSet children: events, signals, scrubbing, overrides
  AndroidHost.kt            activities, touches, navigation markers, app state, PixelCopy screenshots, navigating back
  Platform.kt               main thread scheduler, clock, Choreographer frame loop
  TouchCallback.kt          Window.Callback wrapper that sees every touch
keyframer-inspector-noop/   what release builds link: Keyframer's API with empty bodies, no dependencies
example/                    Views app: entrance, loop, drag, second screen, two scenarios (debug: the
                            library; release: the no-op)
fake-relay/                 stand-in for the desktop relay, plus a scripted editor (EditorClient, Script)
```

## Toolchain

JDK 17, Android SDK (platform 35, build tools), Gradle 8.14.3 through the wrapper, AGP 8.13.2, Kotlin
2.2.10. `ANDROID_HOME` must point at the SDK (or add a `local.properties` with `sdk.dir`). Only the core
module and the relay are needed for `./gradlew test`.

```sh
./gradlew test                    # 43 JVM tests: protocol goldens, parsing, call sites, frame meter, session, relay end to end
./gradlew :example:assembleDebug  # the example APK
```

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

## Use it in an app

```kotlin
// build.gradle.kts
debugImplementation("dev.keyframer:keyframer-inspector:0.1.0")
releaseImplementation("dev.keyframer:keyframer-inspector-noop:0.1.0")   // same API, does nothing, no OkHttp

// Application.onCreate
Keyframer.start(this)                                   // debuggable builds only, unless enableInRelease

// Animators: reported on every start, value and play time recorded and replayable
ObjectAnimator.ofFloat(title, View.ALPHA, 0f, 1f).kfTrack("title").start()

// Anything else that moves: a drag, a scroll offset, a progress
Keyframer.signal("cardX", read = { card.translationX }, write = { card.translationX = it })

// Screens that are not activities (fragments, Navigation)
navController.addOnDestinationChangedListener { _, d, _ -> Keyframer.setRoute(d.route ?: d.label.toString()) }
Keyframer.setNavigator { route, _ -> navController.navigate(route); true }

// Something an agent can run to reproduce a problem
Keyframer.registerScenario("drag card") { done -> runTheDrag(); done(null) }
```

The relay is plain `ws://`, so the app must allow cleartext to that host only (see
`example/src/main/res/xml/network_security_config.xml`).

## How Android maps onto the protocol

- **Call sites.** `Throwable().stackTrace` at `track()` / `signal()`: the first frame outside the SDK,
  the platform and libraries (`CallSites.libraryPrefixes`, plus `KeyframerConfig.libraryPrefixes`).
  `file` is the package as folders plus the file name (`dev/keyframer/example/MainActivity.kt`),
  `column` is 0 (JVM frames have no column), `component` is the outer class, or the function for a
  top-level function (how a composable will be named).
- **Hello.** `platform: "android"`, `framework: "android-views"`, `osVersion`, `protocol: 1`,
  `sdk: { name: "keyframer-inspector", version }`, `threads: { js: { label: "Main", animates: true } }`
  and `capabilities: ["capture", "playback", "overrides", "replay", "scenarios"]` (no `scrub`: the
  play-time tracks cover it through `playback` and `capture`; no device `recordings` yet).
- **Animations.** One `anim` event per start, `thread: "js"`, `fn` is `ValueAnimator` or
  `ObjectAnimator`, `target` the name given (or the target view's id name), `prop` the property.
  `args` is one config object shaped like the React Native "CSS animation" args, so existing readers
  understand it: `{ duration, delay, iterationCount, direction, interpolator, values: { alpha: [0, 1] } }`.
  `params` are `duration`, `startDelay` and `repeatCount`: the panel's live overrides apply to them on
  the next start. `durationMs` is the delay plus every repeat (left out for an infinite animator).
  While recording, events carry `t` and `frames` (the stack, resolved on the device).
- **Signals.** A tracked animator registers `<site>` (or `<site>:<property>` for several properties),
  its animated value, and `<site>:time`, its play time. Playback and capture write the time track: the
  SDK pauses the animator and seeks a clone of it, which shares the app's update listeners and an
  ObjectAnimator's target, so the views show that moment while the real animator is untouched; when
  done it resumes the original or puts the views back. `Keyframer.signal` values are written directly.
  The value signals say `writable: false`; the time track and `Keyframer.signal` values with a
  `write` are writable. Signals go away with the activity they were created in (or `Keyframer.untrack`
  / `Keyframer.removeSignal`), and the panel gets `{ kind: "unsignal", id }`.
- **Frames and threads.** Threads are reported by role: `js` is the app thread, `ui` the frame thread.
  The Android main thread is the app thread (and, `animates: true`, where animators run), so a
  `Choreographer.FrameCallback` runs the same frame meter as React Native and reports frame stats,
  drops and anims as `"js"`. `ui` would be RenderThread: it is left out of `threads` until it is
  measured (FrameMetrics, a next step). Samples are read just after each frame (a message posted
  at the front of the queue from the frame callback), so a sample holds what that frame showed.
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
  hidden API). `ViewPropertyAnimator` (`view.animate()`), `SpringAnimation` / `FlingAnimation`
  (androidx.dynamicanimation), `Transition`s, `MotionLayout` and drawable animations are not covered yet.
- AnimatorSet children are tracked one by one; on API 26+ the set drives them, so a set-level time
  track would scrub them together more faithfully.
- Touches on dialogs and popups (their own windows) are not seen; the keyboard marker is not wired.
- No device recordings (`recording` message, `.kfrec.json` export), no `tasks` (long main-thread
  messages) and no `commits` equivalent yet.
- Keyframe values are read from `PropertyValuesHolder.toString()` (no public getter); path-based
  holders report none.

## Compose, next

- **Signals and events:** wrappers (`kfAnimatable`, `kfAnimateFloatAsState`, `rememberKfTransition`)
  that report starts with their `AnimationSpec` (tween duration and easing, spring damping and
  stiffness) and register the value as a signal; `Snapshot.registerApplyObserver` can sample state
  reads without polling.
- **Playback:** `Animatable.snapTo` for scrubbing, and `MutableState` writes for plain state.
- **Call sites:** the Compose compiler's `sourceInformation` (in debug builds) gives file and line of
  each composable call; a small Kotlin compiler plugin (or AGP's ASM instrumentation API) can rewrite
  `animate*AsState` and `Animatable.animateTo` calls to pass their site, the way the Babel plugin does.
- **Frames:** JankStats (androidx.metrics) per window, which also reports state that was active during
  a janky frame.

## Protocol

Adopted from protocol pass 1 (`protocol/inspector.ts`): threads by role, the hello fields
(framework, osVersion, protocol, sdk, threads, capabilities), `frames` and `durationMs` on `anim`,
`unsignal`, and `column` / `writable` on signal sites. Still open:

1. **`fn` vocabulary for timing estimates.** `motionStats.estimateMs` switches on React Native names;
   Android sends `durationMs`, which readers should prefer when present.
2. **Source paths.** Native call sites know a package path, not a repository path. A `sourceRoots` hint
   in `hello` (or the cli resolving `dev/keyframer/example/MainActivity.kt` under `src/main/{java,kotlin}`)
   would let `source` and `apply` work for native apps.

## Next steps

1. `ViewPropertyAnimator` (its update listener exposes the internal ValueAnimator), `SpringAnimation`,
   and AnimatorSet as one time track.
2. A Gradle plugin using AGP's ASM instrumentation to rewrite `Animator.start()` and
   `View.animate()` call sites in debug variants: tracking without `kfTrack`, with exact file and line.
3. Main-thread `tasks` (kind `looper`) from `Looper` message timing, and RenderThread as the `ui`
   thread from `FrameMetrics` / JankStats.
4. Device recordings: `recording` messages and `.kfrec.json` export without a panel connected.
5. Compose: wrappers, then the compiler plugin.
6. Dialog and popup windows for touches, the keyboard marker through window insets, and Fragment
   lifecycle callbacks as navigation markers.
