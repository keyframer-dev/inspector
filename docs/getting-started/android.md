---
title: Android (Views and Compose)
description: Add the Maven artifacts, start the SDK, and track animators or Compose animations.
order: 3
section: Getting started
---

# Android (Views and Compose)

`dev.keyframer:keyframer-inspector` reports the animators you register, with their call sites, records and replays their values, measures frames and touches, and runs animations in slow motion. Jetpack Compose is an opt-in module. Each has a no-op artifact for release builds.

You need minSdk 24 and the [desktop app](desktop.md) running. The Compose module supports Compose 1.7.6 and later.

## 1. Add the dependencies

Views:

```kotlin
// build.gradle.kts
debugImplementation("dev.keyframer:keyframer-inspector:0.2.0")
releaseImplementation("dev.keyframer:keyframer-inspector-noop:0.2.0")   // same API, does nothing, no OkHttp
```

Compose (these replace the two lines above; each brings its base module):

```kotlin
debugImplementation("dev.keyframer:keyframer-inspector-compose:0.2.0")
releaseImplementation("dev.keyframer:keyframer-inspector-compose-noop:0.2.0")
```

## 2. Start it

```kotlin
// Application.onCreate
Keyframer.start(this)   // debuggable builds only, unless enableInRelease
```

The relay is plain `ws://`, so allow cleartext to that host only, with a `network_security_config.xml` like the example app's.

## 3. Reach the relay

- On the emulator it connects to `ws://10.0.2.2:8790` by itself.
- On a device, run `adb reverse tcp:8790 tcp:8790` (it uses 127.0.0.1 there), or build with `-Pkeyframer.host=<LAN IP>` and add that IP to `network_security_config.xml`.
- `-Pkeyframer.port=<port>` moves it off 8790.

```sh
adb reverse tcp:8790 tcp:8790
```

## 4. Track what moves

### Views

Android has no public global hook for animators, so register them:

```kotlin
// Reported on every start, value and play time recorded and replayable
ObjectAnimator.ofFloat(title, View.ALPHA, 0f, 1f).kfTrack("title").start()

// A ValueAnimator that moves a view from its update listener: pass the view,
// so the panel sees it leave the screen and gets render hints for it
ValueAnimator.ofFloat(1f, 1.3f).apply { addUpdateListener { /* ... */ } }.kfTrack("pulse", pulse).start()

// Anything else that moves: a drag, a scroll offset, a progress
Keyframer.signal("cardX", card, read = { card.translationX }, write = { card.translationX = it })

// Screens that are not activities (fragments, Navigation)
navController.addOnDestinationChangedListener { _, d, _ -> Keyframer.setRoute(d.route ?: d.label.toString()) }
Keyframer.setNavigator { route, _ -> navController.navigate(route); true }

// Something an agent can run to reproduce a problem
Keyframer.registerScenario("drag card") { done -> runTheDrag(); done(null) }
```

### Compose

Use the same calls with `kf` in front. They take the same parameters and behave the same:

```kotlin
val height by kfAnimateDpAsState(if (open) 200.dp else 110.dp, spring(dampingRatio = 0.6f), label = "height")
val corner by kfAnimateFloatAsState(if (open) 32f else 20f, tween(400), label = "corner")
val card = kfUpdateTransition(open, label = "card")
val pulse = rememberKfInfiniteTransition(label = "pulse")
val x = rememberKfAnimatable(0f, label = "ballX")
scope.launch { x.kfAnimateTo(0f, spring(dampingRatio = 0.35f)) }
```

`Keyframer.start` finds the module by itself. The hello then says `framework: "compose"`, and every Compose window runs on the inspector's animation time, so slow motion, pause and step reach every Compose animation, tracked or not.

In release builds the no-op module's functions are Compose's own calls (`kfAnimateFloatAsState` is `animateFloatAsState`).

## Check that it works

- The desktop app's status bar shows your app as connected.
- Tracked animators and `kf` values appear in the panel's Values list. If it says "No animated values yet", nothing is registered: add `kfTrack` or `Keyframer.signal`.
- Record, then drag the playhead.

## Limits

- Animators must be registered with `kfTrack`. `ViewPropertyAnimator` (`view.animate()`), `SpringAnimation` and `FlingAnimation`, `Transition`s, `MotionLayout` and drawable animations are not covered yet.
- Slow motion: untracked animators slow with the duration scale but are not held when paused, and jump when the speed changes. `SpringAnimation` does not follow the speed at all.
- Compose: transitions are read only; Compose render hints are not read yet; an app that sets its own `WindowRecomposerFactory` should do so after `Keyframer.start`.
- No `ui` thread yet (RenderThread is not measured).
- Touches on dialogs and popups are not seen; the keyboard marker is not wired.
- No device recordings, no main-thread tasks, no commits equivalent.
