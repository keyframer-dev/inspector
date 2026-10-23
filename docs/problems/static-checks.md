---
title: Static checks
description: Worklet crashes and motion mistakes found in React Native code before it runs, every rule, and how to silence one.
order: 5
section: Problems
---

# Static checks

The React Native Babel plugin reads each file while Metro builds it, before anything runs, and reports two kinds of mistakes:

- **Worklet crashes**: code that crashes the app on the UI thread.
- **Motion checks**: code that runs but moves wrong, costs frames, or uses an API that was replaced. Each finding has a rule and a severity.

Where they show up:

- **Metro's terminal**: one warning per finding, with the fix. Worklet crashes, and motion findings of severity `error` and `warning`.
- **The panel's Problems tab and `inspector_status`**: worklet crashes, as soon as the file loads.
- **`npx keyframer-inspect lint`**: both, from the source, without running the app. For coding agents and CI. See [CLI](../reference/cli.md#keyframer-inspect-lint).
- **The MCP tool `lint_project`**: the same over MCP, for a coding agent, most severe first. See [MCP server](../agents/mcp-server.md#static-checks).

Only what the file itself decides is reported. A check that would have to guess (an imported value, a config built at runtime, a spread) stays silent. Calls count when they come from the library (`withSpring` imported from react-native-reanimated, `Gesture` from react-native-gesture-handler), never by their name alone.

## Severity

| Severity | Means | In Metro | Fails `lint` |
|---|---|---|---|
| `error` | It does not do what it says | Yes | Yes |
| `warning` | It moves wrong somewhere, or costs frames | Yes | With `--fail-on warning` |
| `info` | Worth a look; often deliberate | With `motionWarnings: 'all'` | With `--fail-on info` |

A worklet crash always fails `lint`.

## Worklet crashes

| Rule | Finds |
|---|---|
| `declared-after` | A worklet that uses a function or value declared further down the same scope. A worklet captures what it uses when it is created, so it gets nothing. A function declaration that is a worklet is not hoisted. |
| `js-call` | A worklet that calls a function that is not one, on the UI thread: a state setter, a reducer's or Redux's dispatch, a callback prop (`on…`, also `onDone?.()`), navigation, `Alert`, `fetch`, a `useCallback`, a function in the file without `'worklet'`, or a method of the component a ref holds (`listRef.current?.scrollToOffset(…)`, for a ref given to an element in the file). The fix is `scheduleOnRN(fn, ...args)`, or making it a worklet. For scrolling, Reanimated's `scrollTo(animatedRef, x, y, true)` runs on the UI thread. |

## Motion rules

| Rule | Severity | Finds |
|---|---|---|
| [`descending-input-range`](#descending-input-range) | error | `interpolate` or `interpolateColor` with a literal input range of 3 or more points that does not ascend |
| [`deprecated-api`](#deprecated-api) | warning | `runOnJS`, `runOnUI`, deprecated and no-op Reanimated APIs, Gesture Handler's old components |
| [`screen-dimensions`](#screen-dimensions) | warning | `Dimensions.get('screen')` in a file that never reads the window |
| [`value-in-render`](#value-in-render) | warning | A shared value read while its component renders |
| [`per-frame-js`](#per-frame-js) | warning | `scheduleOnRN` or `runOnJS` on every frame, with no check |
| [`unclamped-zero-crossing`](#unclamped-zero-crossing) | warning | Opacity or scale from a scroll or a finger, unclamped, heading past 0 |
| [`measure-per-frame`](#measure-per-frame) | info | `measure()` in a worklet that runs every frame |
| [`ignored-finished`](#ignored-finished) | warning | An animation callback that chains on without reading `finished` |
| [`bare-spring`](#bare-spring) | info | `withSpring` without a config, `springify()` without spring settings |
| [`spring-missing-mass`](#spring-missing-mass) | warning | A spring with damping or stiffness but no mass |
| [`frame-rate-speed`](#frame-rate-speed) | warning | A frame callback that adds a fixed step each frame |
| [`unmemoized-gesture`](#unmemoized-gesture) | info | A `Gesture` built in a component's body |
| [`inline-cell-renderer`](#inline-cell-renderer) | warning | `CellRendererComponent` written inline or inside the component, or one that drops `onLayout` |
| [`console-per-frame`](#console-per-frame) | warning | `console.log`, `warn`, `info` or `debug` in a worklet that runs every frame |
| [`zero-duration`](#zero-duration) | info | `withTiming(v, { duration: 0 })` assigned to a value |
| [`reverse-sequence`](#reverse-sequence) | warning | `withRepeat(withSequence(…), n, true)` |
| [`transparent-color`](#transparent-color) | warning | `interpolateColor` toward black at alpha 0 |
| [`derived-side-effect`](#derived-side-effect) | warning | `useDerivedValue` that writes other shared values or calls `scheduleOnRN` |
| [`floor-scroll-offset`](#floor-scroll-offset) | warning | `Math.floor` of a scroll offset when momentum ends |

"Every frame" means the worklets that run on each frame they are needed: `useAnimatedStyle`, `useAnimatedProps`, `useFrameCallback`, a scroll handler's `onScroll`, a gesture's `onUpdate`, `onChange` and `onTouchesMove`, and (for some rules) `useDerivedValue` and a reaction's second function. Gestures with `.runOnJS(true)` run on the JS thread and are left out.

### descending-input-range

Reanimated finds the segment a value falls in with a binary search that assumes the input range ascends. With three or more points that do not, values land on the wrong segment. Two points may go either way.

```ts
interpolate(y.value, [200, 100, 0], [0, 0.5, 1]) // wrong segment between the points
interpolate(y.value, [0, 100, 200], [1, 0.5, 0]) // the same mapping, ascending
```

Reads literal arrays, and constants set to one that nothing changes (`RANGE.reverse()` turns it off).

### deprecated-api

Each import (or each use, through `import * as Reanimated`) of an API its library replaced, with the replacement and the lines that use it. Checked against Reanimated 4.5.1, react-native-worklets 0.10 and Gesture Handler 2.32.

| Import | Use instead |
|---|---|
| `runOnJS`, `runOnUI` (Reanimated or worklets) | `scheduleOnRN(fn, ...args)`, `scheduleOnUI(fn, ...args)` from react-native-worklets |
| `executeOnUIRuntimeSync`, `runOnRuntime`, `makeShareableCloneRecursive` | `runOnUISync`, `scheduleOnRuntime`, `createSerializable` from react-native-worklets |
| `addWhitelistedNativeProps`, `addWhitelistedUIProps`, `enableLayoutAnimations` | Nothing: they do nothing in Reanimated 4 |
| `useAnimatedKeyboard` | react-native-keyboard-controller |
| `useScrollViewOffset`, `Extrapolate` | `useScrollOffset`, `Extrapolation` |
| `useAnimatedGestureHandler` | `Gesture.Pan()` and friends in a `GestureDetector` (it is gone in Reanimated 4) |
| `PanGestureHandler`, `TapGestureHandler` and the other `…GestureHandler` components | `Gesture.Pan()`, `Gesture.Tap()`… in a `GestureDetector` |
| `Swipeable`, `DrawerLayout` | `ReanimatedSwipeable`, `ReanimatedDrawerLayout` |
| `gestureHandlerRootHOC` | `GestureHandlerRootView` |
| Gesture Handler's `Touchable…` | Gesture Handler's `Pressable` |

The Reanimated 4 entries stay silent in an app on Reanimated 3.

### screen-dimensions

`Dimensions.get('screen')` is the whole display: on Android it includes the status and navigation bars, and it ignores split screen and resizable windows. Use `useWindowDimensions()`. A file that also reads the window is left alone: comparing the two is how a navigation bar's height is measured.

### value-in-render

Reading `.value` (or `.get()`) of a shared value the component made, in the component's body: in JSX, a dependency array, or a condition. A shared value changing does not re-render the component, so what it renders goes stale. Read it in a worklet (`useAnimatedStyle`, `useAnimatedProps`, `useDerivedValue`), or follow it with `useAnimatedReaction` and `scheduleOnRN` when React state must. In a dependency array, depend on the shared value itself.

Reads inside callbacks, effects, handlers and worklets are fine, and so are shared values that came in as props (the check cannot see where they were made).

### per-frame-js

`scheduleOnRN` or `runOnJS` in a worklet that runs every frame (and in a reaction's second function, which also runs every time its inputs change), with nothing checking whether the value changed. Each call is a trip to the JS thread, and a React render when it sets state.

```ts
useAnimatedReaction(
  () => Math.round(x.value),
  (now, prev) => {
    if (now !== prev) scheduleOnRN(setIndex, now)
  },
)
```

Any `if`, ternary, `&&`, `switch` or early `return` before the call counts as a check. Calls in a finish callback or in `onEnd` run once and are left alone.

### unclamped-zero-crossing

`opacity` or `scale` from `interpolate` with default (extend) extrapolation, on an edge that keeps heading toward 0 and past it. A scale that goes negative mirrors the view.

```ts
transform: [{ scale: interpolate(scrollY.value, [-100, 0], [1.5, 1]) }] // 0 at 200, mirrored after
transform: [{ scale: interpolate(scrollY.value, [-100, 0], [1.5, 1], Extrapolation.CLAMP) }]
```

Only for inputs known to run past any range: a shared value set from a scroll offset or a gesture's movement (without a clamp), `useScrollOffset`, or the event's `contentOffset` and `translationX/Y`. A timing-driven progress from 0 to 1 never leaves its range, so it is left alone. So are translations, and slopes of exactly 1 (a pin that follows the input on purpose).

### measure-per-frame

`measure()` is a synchronous layout read on the UI thread. If the measured view does not move while the worklet runs, measure once when the gesture or scroll starts and keep the result in a shared value. A view that moves needs it, so this is info.

### ignored-finished

A `withTiming`, `withSpring`, `withDecay` or `withRepeat` callback that starts another animation or calls `scheduleOnRN` without reading its first argument. The callback also runs when the animation is cancelled, with `finished` false, so an interrupted animation still chains on.

```ts
x.value = withTiming(1, {}, (finished) => {
  if (finished) x.value = withSpring(0)
})
```

A parameter named with a leading underscore (`_finished`) is ignored on purpose and left alone.

### bare-spring

Reanimated 4's default spring is `GentleSpringConfig` (damping 120, mass 4, stiffness 900): critically damped, so it settles without overshoot. Reanimated 3's bounced. If it should bounce, pass `WigglySpringConfig` or a config; for a layout animation, chain `.damping()`, `.stiffness()`, `.mass()` or `.dampingRatio()` after `springify()`.

### spring-missing-mass

A spring config is merged over Reanimated 4's default, whose mass is 4. `{ damping: 12, stiffness: 180 }` written for mass 1 (Reanimated 3's default, and most examples) moves half as fast and bounces more: damping ratio 0.22 instead of 0.45. Add `mass: 1`, or write the mass you tuned with. The config can be in the call or in a constant in the file. Configs with `duration` or `dampingRatio` (where mass does not matter), spreads, imported configs and constants that something changes are left alone. The same goes for `springify().damping(…)` without `.mass(…)`.

### frame-rate-speed

A `useFrameCallback` that adds a fixed step to a shared value every frame (`rotation.value += 2`) runs once per frame, so it goes twice as fast at 120 Hz as at 60 Hz, and slows down when frames drop. Scale the step by `timeSincePreviousFrame`. A callback that reads the frame's time is left alone, and so are counters (`frames.value += 1`).

### unmemoized-gesture

`Gesture.Pan()` (or any gesture builder) in a component's or hook's body is a new gesture on every render: Gesture Handler updates the native handler and sends its callbacks to the UI thread again each time. Build it in `useMemo`. Silent under React Compiler, and in a component with `'use memo'`.

### inline-cell-renderer

A `CellRendererComponent` written inline, or declared inside the component that renders the list, is a new component type on every render, so every cell unmounts and mounts again. Declare it at the top of the file. A cell renderer that never passes `onLayout` on (not spread from its props, not taken by name) breaks how the list measures its cells: scrolling to an index, sticky headers and which cells render all go wrong.

### console-per-frame

A `console` call in a worklet that runs every frame is copied to the JS thread each time, and floods the log.

### zero-duration

`x.value = withTiming(v, { duration: 0 })` still starts an animation: the value changes a frame later. Set it: `x.value = v`. Inside a `withSequence` (a jump between steps) or with a callback, it is left alone.

### reverse-sequence

`withRepeat`'s `reverse` swaps the inner animation's target. A `withSequence` has none of its own, so every repeat plays the sequence forward again. Write the way back into the sequence and drop `reverse`.

### transparent-color

`interpolateColor` toward black at alpha 0 (`rgba(0, 0, 0, 0)`, `#0000`, `#00000000`) passes through a dark, half-clear grey. Fade the same color to alpha 0 instead (`'rgba(255, 0, 0, 0)'` for red). `'transparent'` is reported only for an app on Reanimated before 4.1.4, which does the same; 4.1.4 and later take the neighbouring color's channels for it.

### derived-side-effect

A `useDerivedValue` should only compute and return. It runs again whenever what it reads changes, so a write to another shared value (`.value =` or `.set()`) or a `scheduleOnRN` in it runs on every frame, and can feed itself. Move it to a `useAnimatedReaction` on the same inputs.

### floor-scroll-offset

`Math.floor` of `contentOffset` in `onMomentumScrollEnd` (inline or a handler declared in the file) or a scroll handler's `onMomentumEnd`. A paging list often stops a fraction short of a page (374.99 for 375), so the index comes out one too low. Use `Math.round`.

## Silence a finding

A comment naming the rule, on the line above the finding or at the end of its line. Without a rule, every rule on that line. Text after ` -- ` is for people. It works for the worklet crash rules too.

```tsx
// keyframer-disable-next-line bare-spring -- critically damped on purpose
scale.value = withSpring(1)
progress.value = withTiming(0, { duration: 0 }) // keyframer-disable-line zero-duration
```

Between a JSX element's props, a `//` comment works as it is. Among its children, put the same words in a block comment: `{/* keyframer-disable-next-line value-in-render */}`.

## Plugin options

```js
['@keyframerdev/inspector/babel', { workletWarnings: true, motionWarnings: true }]
```

| Option | Default | |
|---|---|---|
| `workletWarnings` | `true` | `false` stops printing worklet crashes in Metro. The panel and agents still get them. |
| `motionWarnings` | `true` | `true` prints motion errors and warnings in Metro, `'all'` adds info, `false` prints none. |

## What the checks read from the project

From the project root (the plugin's `root`, or `lint --root`):

- **The installed react-native-reanimated**, looked up through `node_modules` from the root. On Reanimated 3, `deprecated-api` leaves the 3.x APIs alone; `transparent-color` reports `'transparent'` only before 4.1.4. Without it, Reanimated 4 is assumed.
- **React Compiler**: `babel-plugin-react-compiler` in `package.json`, `experiments.reactCompiler` in Expo's app config, or the plugin in the Babel config. With it, `unmemoized-gesture` stays silent.
