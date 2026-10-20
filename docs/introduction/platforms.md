---
title: Platforms
description: What each SDK sees, what it needs from your code, and what it does not cover yet.
order: 3
section: Introduction
---

# Platforms

| Platform | Package | What you add | Panel |
|---|---|---|---|
| React Native (Reanimated 4) | `@keyframerdev/inspector` (npm) | A Babel plugin and one connect call | Expo dev tools, or the desktop app |
| iOS, UIKit | `KeyframerInspector` (Swift Package Manager) | `KeyframerInspector.start()` | Desktop app |
| iOS, SwiftUI | `KeyframerInspectorSwiftUI`, an opt-in product | `withKeyframerAnimation` and `.keyframerTrace` per value | Desktop app |
| Android, Views | `dev.keyframer:keyframer-inspector` (Maven Central) | `Keyframer.start(this)` and `kfTrack` per animator | Desktop app |
| Android, Jetpack Compose | `dev.keyframer:keyframer-inspector-compose` | The `kf` versions of the animation calls | Desktop app |
| Flutter 3.29+ | `keyframer_inspector` (pub.dev) | A wrapper widget and `KfAnimationController` | Desktop app |

The desktop app runs on macOS, Windows and Linux; see [Desktop app](../getting-started/desktop.md).

## What each one sees

| | React Native | Flutter | iOS UIKit | iOS SwiftUI | Android Views | Compose |
|---|---|---|---|---|---|---|
| Animations found | All Reanimated calls, CSS and layout animations | `KfAnimationController` starts, implicit animations, Hero flights | Every Core Animation animation | Only traced values | Tracked animators | Tracked calls |
| Exact source line | Yes (Babel plugin) | Yes, from the stack | With `trace`; otherwise the function name | Yes, with `withKeyframerAnimation` | Yes, from the stack | Yes, from the stack |
| Slow motion, pause, step | Yes | Yes, every animation | Yes, under the key window | Partly (see limits) | Slow motion for all; pause holds tracked animators | Yes, every animation |
| Frames on two threads | JS and UI | UI isolate and Raster | Main only | Main only | Main only | Main only |
| Scrub the real app | Yes | Yes | Yes, Core Animation's own timeline | No | Yes, through play time | Yes (transitions read only) |
| Recordings on the device | Yes | No | No | No | No | No |

## Known limits

- **SwiftUI:** animations not wrapped with the trace are not seen, traced values cannot be played back, and pause and step reach Core Animation only.
- **iOS:** there is no `ui` thread entry. A hitch in the render server while the main thread is idle is not seen.
- **Android:** animators must be registered with `kfTrack`. `ViewPropertyAnimator`, `SpringAnimation`, `Transition`s and `MotionLayout` are not tracked. When paused, `ViewPropertyAnimator` and Transitions are not held. Compose transitions are read only.
- **Flutter:** `AnimatedSwitcher`, `AnimatedCrossFade` and `AnimatedSize` are not tracked. Implicit animations need widget creation tracking (debug builds from `flutter run`).
- **React Native Web** is not checked end to end.

Each [getting started](../getting-started/react-native.md) page lists its platform's limits in full.
