---
title: Motion bugs
description: Problems in how things move that drop no frames, and the fix per framework.
order: 3
section: Problems
---

# Motion bugs

These problems cost no frames, so a frame counter never shows them. They are always at least medium severity. They come from what recordings hold and what the SDKs add: display, accessibility, visibility and time markers.

### Reduce Motion

Kind: `reduce-motion`. An animation moved over several frames while the person had Reduce Motion on (Remove animations on Android). Fades and color changes are allowed, and an animation that jumped straight to its end honored the setting. With no samples to tell, it counts only where the framework does not follow the setting by itself: Reanimated does, unless a call says `ReduceMotion.Never`; Android's animators do.

- **React Native:** Leave Reanimated's `reduceMotion` at `ReduceMotion.System` (the default; `ReduceMotion.Never` ignores the setting), or read `useReducedMotion()` and set the end value directly, or fade instead of moving. Motion driven by `setState` or a JS loop does not follow the setting at all.
- **Flutter:** Check `MediaQuery.disableAnimationsOf(context)` and skip the animation when it is true: set the controller's value to the end, use a zero duration, or fade instead of moving.
- **UIKit:** Check `UIAccessibility.isReduceMotionEnabled` before animating (and observe `reduceMotionStatusDidChangeNotification`): set the final state directly, or cross-fade instead of moving.
- **SwiftUI:** Read `@Environment(\.accessibilityReduceMotion)` and animate with `nil` (or a short fade) when it is true.
- **Android Views:** Check `ValueAnimator.areAnimatorsEnabled()` (false when animations are removed) and set the end state directly. Animators already follow the duration scale, so this one is driven some other way (a Handler, a Choreographer callback, a custom loop).
- **Compose:** Use Compose's animation APIs (`animate*AsState`, `Animatable`, `updateTransition`), which follow the duration scale, or check `ValueAnimator.areAnimatorsEnabled()` and `snapTo` the target. Loops in `withFrameNanos` ignore the setting.

```swift
@Environment(\.accessibilityReduceMotion) var reduceMotion
withAnimation(reduceMotion ? nil : .spring()) { expanded.toggle() }
```

### Unseen

Kind: `unseen`. Frames nobody sees: a value kept changing while its view was off screen, hidden, covered or detached, or while the app was in the background. A loop (`withRepeat`, an infinite animation) is named as one. Visibility markers can land up to 300 ms late (iOS checks three times a second), so changes that close to one are not counted.

- **React Native:** `cancelAnimation` when the screen loses focus (`useIsFocused`, `useFocusEffect`) or the app goes to the background (`AppState`), and start it again on return. For items scrolled away, pause on viewability (`onViewableItemsChanged`).
- **Flutter:** `TickerMode` mutes the tickers of covered routes (use the State's vsync); `RouteAware`'s `didPushNext` and `AppLifecycleListener` say when; `VisibilityDetector` covers items scrolled away.
- **UIKit:** Pause or remove it when the view leaves the window or the app goes to the background (`didMoveToWindow`, `viewDidDisappear`, `sceneDidEnterBackground`); a Core Animation loop pauses with `layer.speed = 0`.
- **SwiftUI:** Stop it in `onDisappear` and when `scenePhase` leaves `.active`, and drive loops from state that is only set while the view is on screen.
- **Android Views:** Pause the animator when the view is detached or hidden (`onDetachedFromWindow`, `onPause`, `View.isShown`) and resume it on return.
- **Compose:** `rememberInfiniteTransition` stops when it leaves composition; run loops in `LaunchedEffect` under `repeatOnLifecycle(Lifecycle.State.STARTED)`, or key them to visibility.

```tsx
useFocusEffect(useCallback(() => {
  pulse.value = withRepeat(withTiming(1.2, { duration: 600 }), -1, true)
  return () => cancelAnimation(pulse)
}, [pulse]))
```

What each SDK can see: iOS reports `detached`, `hidden` and `offscreen` (not `covered`); Android and Flutter report all four.

### Two writers

Kind: `two-writers`. Another call site animated a value while an animation of it was still running. `withDelay(..., withTiming(...))` is one write, and the same call starting again is a restart, not a second writer. A spring counts as running while it visibly moves: until it stays within 2% of the distance it started from (a bare `withSpring`, Gentle, for 400 ms of its 833). One taken over in that last 2%, its energy tail, does not jump, so it is not a clash.

- **React Native:** Assigning to a shared value cancels the animation running on it, so the last writer wins and the motion restarts from wherever it was. Give the value one owner: drive both from one place (one handler, or a `useAnimatedReaction`), or `cancelAnimation` and hand over on purpose.
- **Flutter:** Give the property one `AnimationController` and `animateTo` from its current value, or stop the other one first.
- **UIKit:** The newer animation replaces the older (or adds to it, when additive). Use one `UIViewPropertyAnimator` for the property and continue it, or remove the older animation first.
- **SwiftUI:** Let one of the transactions change the state, or chain them with `withAnimation`'s completion.
- **Android Views:** Cancel the running animator first, or use the view's `ViewPropertyAnimator`, which replaces its own animation of a property.
- **Compose:** Keep one `Animatable` and call `animateTo`, which cancels the running animation and continues from the current value and velocity.

### Jump

Kind: `jump`. An interrupted animation's value jumped within one frame, far more than the motion around it, as the new animation started. A repeat that wraps around by itself does not count, nor does a step while the editor had the app paused.

- **React Native:** Start from the current value: do not set `.value` before animating, and pass the gesture's velocity to `withSpring` (or use `withDecay`) so the motion continues.
- **Flutter:** Do not reset the controller when interrupting it (setting `controller.value`, or `forward(from: 0)`): `animateTo` from its current value, or `animateWith` a `SpringSimulation` that starts at its current velocity.
- **UIKit:** Start from what is on screen, not from the model value: `UIView.animate` with `.beginFromCurrentState`, or a `UIViewPropertyAnimator`, which can be continued or reversed.
- **SwiftUI:** SwiftUI continues from the value on screen when the same state animates again. A jump means the state was reset first, or the view got a new identity (an id, or a changed if branch). Animate the change itself, with a spring that keeps the velocity.
- **Android Views:** Cancel the running animator and start the next from the view's current value (`ObjectAnimator.ofFloat` with only an end value starts there), or use a `SpringAnimation`, which keeps its velocity.
- **Compose:** Keep one remembered `Animatable` and call `animateTo`. Avoid `snapTo` before animating, and remember the `Animatable` so recomposition does not create a new one.

```tsx
// before: resets to 0, then springs
offset.value = 0
offset.value = withSpring(target)
// after: continues from where it is, with the finger's speed
offset.value = withSpring(target, { velocity: e.velocityY })
```

## Gesture conflicts

React Native only: the Babel plugin wraps react-native-gesture-handler's callbacks (`Gesture.Pan().onBegin(…)` and the others written inline), and a list's offsets are recorded when it has an `onScroll` handler. Each gesture is read in attempts, from the finger coming down to `onFinalize`, and `onEnd` and `onFinalize` record whether it succeeded and whether it had activated. A gesture needs `onBegin` (or `onTouchesDown`) written for an attempt that never activates to be seen at all.

### Lost gesture

Kind: `gesture-lost`. A drag gesture began and never activated, twice or more, while the touch went elsewhere: the list under it scrolled while the finger went across the list's axis (a sideways drag in a vertical list), or another drag gesture activated on a drag along an axis this one takes at other times. A finger going along the list is the list's (scrolling over a swipeable row is not a conflict), and a tap or long press failing as a drag starts is how they work.

- Give each its direction: `activeOffsetX([-10, 10])` and `failOffsetY([-5, 5])` on a sideways gesture in a vertical list (`activeOffsetY` and `failOffsetX` in a horizontal list or pager).
- To move both at once, use the `ScrollView` or `FlatList` from react-native-gesture-handler and `simultaneousWithExternalGesture` with its `Gesture.Native()`. For the gesture to win, `blocksExternalGesture` on it: the list waits for it to fail.
- Lost to another gesture: `simultaneousWithExternalGesture` to run both, `requireExternalGestureToFail` on the other (or `blocksExternalGesture` on this one) for this one to win.

### Cancelled gesture

Kind: `gesture-cancelled`. A gesture was active and ended without succeeding (`onFinalize`'s `success` was false) as another gesture activated within 50 ms: the other one cancelled it, and what it drives stops part way. An end that succeeded (the finger lifted) does not count, nor do recordings older than the `success` marker field.

- `simultaneousWithExternalGesture` (or `Gesture.Simultaneous` on one view) if both should run; `requireExternalGestureToFail` on the other, or `blocksExternalGesture` on this one, if the other should wait; `activeOffsetX/Y` and `failOffsetX/Y` on the other keep it from activating on this one's drags.

### Stolen scroll

Kind: `gesture-steals-scroll`. A gesture took drags that belong to a list. Either the list was scrolling under the same finger when the gesture activated and then stood still for 150 ms or more while the finger kept moving (a stall), or a gesture that activates sideways at other times activated on drags along a list's axis, twice or more, while that list, which scrolls on the same screen, did not move. A list still coasting from an earlier fling when the finger lands is not a stall, and a list that keeps scrolling with the gesture (`simultaneousWithExternalGesture`) is fine.

- Make it activate only in its own direction: `activeOffsetX([-10, 10])` and `failOffsetY([-5, 5])` on a sideways gesture in a vertical list (`activeOffsetY` and `failOffsetX` in a horizontal one).
- Use the `ScrollView` or `FlatList` from react-native-gesture-handler, with `requireExternalGestureToFail` and its `Gesture.Native()` if the list should always win, or `simultaneousWithExternalGesture` if both may move.

```tsx
import { Gesture, GestureDetector, ScrollView } from 'react-native-gesture-handler'

// The list, a ScrollView from react-native-gesture-handler: <ScrollView ref={list}>…</ScrollView>.
// Each row, with the list's ref passed down: sideways drags swipe it, vertical ones scroll the list.
const swipe = useMemo(
  () =>
    Gesture.Pan()
      .activeOffsetX([-10, 10])
      .failOffsetY([-5, 5])
      .simultaneousWithExternalGesture(list)
      .onUpdate((e) => {
        offsetX.value = e.translationX
      }),
  [list],
)
```
