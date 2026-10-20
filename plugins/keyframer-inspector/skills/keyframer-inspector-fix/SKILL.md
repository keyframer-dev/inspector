---
name: keyframer-inspector-fix
description: Fix a motion problem the Keyframer Inspector reported (from the panel, an MCP report, check or keyframer-inspect ci) - read its kind, where and evidence, find the call site in a React Native, Flutter, UIKit, SwiftUI, Android Views or Jetpack Compose codebase, apply the fix for that kind and framework, and verify it with compare or recheck. Use when given an inspector problem such as js-task, render-storm, slow-render, ui-work, burst, busy-start, screen-mount, layout-anim, reduce-motion, unseen, two-writers, jump or a render hint (shadow-path, mask, blur, group-opacity, layer-alpha, elevation, opacity-widget, save-layer), or asked to fix dropped frames or jank the inspector found.
---

# Fix a Keyframer Inspector problem

Every problem has a kind, a title, `where`, evidence and a fix already worded for the app's framework. Start from that fix; this skill says how to find the code and how to prove the change worked. Docs: https://keyframer.dev/inspector/docs/problems

## 1. Read the problem

- **Kind** says what went wrong (table in step 3).
- **where** is the place to change. It can be `null` (work the inspector does not time): then read the evidence and `get_trace` around its time.
- **Evidence** says when (`2.31s: ...`) and how much (ms, frames lost, values). Keep it: you will compare against it.
- **Severity** high, medium or low. Fix the highest first. Motion bugs (`reduce-motion`, `unseen`, `two-writers`, `jump`) drop no frames but are at least medium.

Before changing code, get the surrounding timeline: `get_trace` with `fromMs` a little before and `toMs` a little after the evidence time.

## 2. Find the call site

| Framework | What `where` looks like | Where to look |
|---|---|---|
| React Native | `app/sheet.tsx:41`, relative to the project root | That exact line (the Babel plugin wrote it) |
| Flutter | `lib/main.dart:42:26` | That line. A name like `value:card` (AOT with split debug info) means search for `name: 'card'` |
| iOS UIKit | `closure #1 in CardsViewController.bounce():0` | Line 0 means no line info: search for the function in the named type. Code wrapped in `KeyframerInspector.trace` has exact lines |
| SwiftUI | a file and line from `withKeyframerAnimation`, or the trace's own line | That line, or the `.keyframerTrace` and the `.animation` next to it |
| Android, Compose | `dev/keyframer/example/MainActivity.kt:57`, a package path | `src/main/kotlin/` or `src/main/java/` plus that path |

When a value, not a call, is named (`sheetY`, `Card.offset`), search for its declaration (`useSharedValue`, `KfAnimationController(name: ...)`, `kfTrack("...")`, the stored property).

## 3. Apply the fix for the kind

The problem's own `fix` text is the primary guide. The patterns behind it:

| Kind | Typical change |
|---|---|
| `js-task` | Move heavy work out of the handler, effect or timer: after the animation, chunked, memoized, or off the main thread (`InteractionManager.runAfterInteractions`, `compute`/`Isolate.run`, a background queue or Task, `Dispatchers.Default`) |
| `slow-render` | By the reason: `parent` gets `React.memo` and memoized props; `state` moves to a shared value; `props` are memoized in the parent |
| `render-storm` | Stop per-frame `setState`: keep the value in `useSharedValue` and read it in `useAnimatedStyle` |
| `ui-work` | Keep worklets to reading values and interpolating; precompute heavy math in a rarely changing `useDerivedValue` or on JS |
| `layout-anim` | Animate `transform` (translate, scale) instead of width, height, margins or padding, or use a layout animation |
| `burst` | Stagger (`withDelay`, `Interval`, `startDelay`, `.delay`) or drive many from one progress value |
| `busy-start` | Start the animation before the blocking work, or from a worklet; move the work |
| `screen-mount` | Lighter first render or build: defer heavy parts until after the transition, virtualize lists |
| `js-unknown`, `ui-unknown` | Not timed: profile with the platform's tool (React Native DevTools, Flutter DevTools, Instruments, Android Studio); for `ui-unknown` look at shadows, blur, large images, layout on moving views |
| `reduce-motion` | Respect the setting: Reanimated `ReduceMotion.System`/`useReducedMotion()`, `MediaQuery.disableAnimationsOf`, `UIAccessibility.isReduceMotionEnabled`, `@Environment(\.accessibilityReduceMotion)`, `ValueAnimator.areAnimatorsEnabled()`. Jump to the end or fade instead of moving |
| `unseen` | Stop it while not visible: `cancelAnimation` on blur or background (`useFocusEffect`, `AppState`), TickerMode/RouteAware, `didMoveToWindow`/`viewDidDisappear`, `onDisappear`/`scenePhase`, `onDetachedFromWindow`/`onPause`, `repeatOnLifecycle` |
| `two-writers` | Give the value one owner: one handler, one controller, one property animator, one `Animatable`; or cancel the running animation first |
| `jump` | Continue from the current value and velocity: do not reset `.value` or the controller before animating; pass the gesture's velocity to the spring; `.beginFromCurrentState`; `animateTo` on one remembered `Animatable` |
| `render-hint` | By hint: `shadow-path` gives the shadow a shape; `mask`/`blur` keep them off moving content; `group-opacity`/`layer-alpha` animate children or use a hardware layer; `elevation` keeps elevation fixed and animates a transform; `opacity-widget` uses `FadeTransition`; `save-layer` uses `Clip.antiAlias`; `rasterize` turns rasterizing off while it animates |
| `error`, `warning` | Fix the logged error first: it may stop an animation from finishing |

Rules:

- Keep the motion. Never delete, disable or shorten an animation to make a problem go away. A problem whose animation stopped is Removed, not Fixed.
- Change only what the problem needs. Keep the animation's numbers unless the problem is about them.
- Do not touch the inspector's setup: its imports, `connectDevTools`, `registerScenario`, the Babel config, `.keyframer/`.

## 4. Let the change reach the app

React Native: Fast Refresh (Metro must watch files; `CI=1 npx expo start` does not). Flutter: hot reload. iOS and Android: rebuild and relaunch. Wait for `inspector_status` to show the app again.

## 5. Verify with compare

Reproduce exactly as before, at speed 1 (`set_time` with `scale: 1` if it was slowed):

```text
run_scenario { "name": "<same scenario>" }      # or start_recording, the same steps, stop_recording
compare                                         # the last two sessions
```

The fix holds when compare lists the problem as fixed and the frames lost or the motion numbers moved the right way. If it is still there, read the new evidence and try again. If a new problem appeared, it is yours to fix too.

For several problems or noisy numbers, use the loop instead: `check` (with `scenarios`) before the change, then `recheck` after. Only Fixed counts. Removed means an animation or value stopped: put it back and fix the cost instead. Not verifiable means no scenario reproduces it: say so and leave it to a person.

## 6. Report

Say which problem you fixed (kind, title, where), what you changed and why, and paste the `compare` or `recheck` lines that show it. If CI guards this motion, the baseline may need recording again: say so rather than doing it silently.
