---
title: Dropped frames
description: Problems that cost frames, what each one means, and the fix per framework.
order: 2
section: Problems
---

# Dropped frames

Each long frame is traced to what ran in it. Drops with the same cause become one problem. The fixes below are the text the inspector prints for each framework.

Some kinds need data only one SDK sends. React commits, JS tasks and UI-thread worklet times come from the React Native Babel plugin, so `slow-render`, `render-storm`, `ui-work` and `layout-anim` are React Native problems.

### JS task

Kind: `js-task`. An event handler, effect or timer blocked the app thread: `onPress in Glitches, app/glitches.tsx:86, ran 299 ms`. The Babel plugin times handlers and effects written in the app, and handlers that arrive from elsewhere (a prop, a hook's result, an import) where they are attached, named after the function: `onPress (submit)`. Timers carry the stack that scheduled them.

- **React Native:** Move the heavy work out of this callback: defer it until the animation ends, split it into chunks, or memoize the result. Animations it starts should be driven by shared values so the UI thread keeps them running.
- **React Native, an effect:** Effects run right after a render, so heavy work here delays the next frame. Defer it (`InteractionManager.runAfterInteractions`, or a timer after the animation), split it into smaller pieces, or memoize what it computes.
- **Flutter:** Move the heavy work out of this callback: run it in an isolate (`compute`, `Isolate.run`) or after the animation, split it, or cache the result. The UI isolate also ticks the animations, so they stop while it runs.
- **UIKit:** Move the heavy work off the main thread (a background queue or a Task, then update the UI on the main actor), or after the animation. Animations set up while it runs start late.
- **SwiftUI:** Move the heavy work off the main actor (a detached Task or a background actor, then set state on the main actor), or after the animation. SwiftUI evaluates body and starts animations on the main thread, so they start late while it runs.
- **Android Views and Compose:** Move the heavy work off the main thread (a coroutine on `Dispatchers.Default`, then post the result back), or after the animation. Animators tick on the main thread, so they stop while it runs.

```tsx
// before: the press handler does the work, the spring waits for it
onPress={() => { const rows = sortAll(items); setRows(rows); open() }}
// after: start the motion, then do the work once it is done
onPress={() => { open(); InteractionManager.runAfterInteractions(() => setRows(sortAll(items))) }}
```

### Slow render

Kind: `slow-render`. A React commit blocked the JS thread. Commits charge library components (View, Text, navigators) to the app component that rendered them, and say why it rendered: `props: tick`, `state`, `parent`, `mount`. The fix depends on the reason:

- **Its parent rendered, with equal props:** wrap it in `React.memo`, and memoize the props you pass it (`useMemo`, `useCallback`).
- **Its own state changed:** if this runs during an animation, keep the changing value in a shared value instead of `useState` so React does not render.
- **New props:** memoize them in the parent, or move the animated part into a shared value.
- **Otherwise:** make the render cheaper: memoize the expensive children (`React.memo`), virtualize long lists (FlatList, FlashList), and avoid rendering during the animation.

### Render storm

Kind: `render-storm`. A component renders in commit after commit, near the frame rate (at least 20 commits, 15 or more a second).

- **Props change every frame:** they are set by state in its parent. Drive the per-frame value with a shared value and `useAnimatedStyle` instead of `setState`, so React does not render at all while it moves.
- **Its own state is set every frame:** keep that value in a shared value (`useSharedValue`) and read it in `useAnimatedStyle`.
- **Its parent re-renders every frame:** wrap it in `React.memo`, then fix the parent the same way.

```tsx
// before: setState 60 times a second
const [y, setY] = useState(0)
// after: the UI thread animates it, React does not render
const y = useSharedValue(0)
const style = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }] }), [y])
```

### JS unknown

Kind: `js-unknown`. The app thread was blocked by code the inspector does not time.

- **React Native:** This is work outside the app's handlers, effects and timers: a library, a native module callback, or a timer scheduled before recording started. Record again with React Native DevTools' Performance panel to see the function, or start recording earlier.
- **Flutter:** Work on the UI isolate outside the code the inspector times: a build or layout, a platform channel callback, or a timer started before recording. Open Flutter DevTools' Performance view on a profile build.
- **UIKit:** Main-thread work outside what the inspector sees: layout, view setup, or a synchronous call (disk, keychain, a lock). Profile it with Instruments' Time Profiler or the Hangs instrument.
- **SwiftUI:** Body evaluation, layout, or a synchronous call. Profile it with Instruments' SwiftUI and Time Profiler instruments.
- **Android:** Inflation, layout, a binder call, or disk I/O (StrictMode finds those). Record a trace with Android Studio's profiler.

### UI work

Kind: `ui-work`. An animated style, derived value, reaction, scroll handler, gesture callback or `scheduleOnUI` worklet took too long for the UI thread, timed by the Babel plugin.

- **A worklet run with `scheduleOnUI`:** never block the UI thread: every frame waits for it. Split the work, or do it on the JS thread and hand the result over in a shared value.
- **A per-frame worklet:** keep it to reading shared values and interpolating. Move heavy math, loops and object building out: precompute in a `useDerivedValue` that changes rarely, or on JS.

### UI unknown

Kind: `ui-unknown`. The frame thread took too long with nothing the inspector timed.

- **React Native:** Native work, not a worklet: layout (an animated width, height, margin or padding), shadows or blur on moving views, large images decoding, or views mounting. Animate transforms and opacity instead of layout properties, and keep shadows off views that move.
- **Flutter:** The raster thread took too long: saveLayer (Opacity, ShaderMask, clips with anti-aliasing), shadows and blurs, or large images. Use `FadeTransition` instead of `Opacity`, keep `BackdropFilter` off moving content, and wrap what moves in a `RepaintBoundary`.
- **UIKit:** Offscreen passes (shadows without a `shadowPath`, masks, corner clipping with blur), large images decoding on the main thread, or layout every frame. Set `shadowPath`, decode images ahead of time, and animate transforms instead of frames.
- **SwiftUI:** Offscreen passes (shadows, masks, blurs and materials over moving views), large images, or layout every frame. Give shadows a shape, flatten still content with `.drawingGroup()`, and animate `offset` and `scaleEffect` instead of `frame`.
- **Android:** Overdraw, large bitmaps, elevation shadows on moving views, or a layer redrawn every frame. Animate translation, scale and alpha (with `withLayer()` for complex views), and keep bitmaps at the size they are drawn.

iOS and Android do not measure a frame thread yet, so this kind comes from React Native and Flutter apps.

### Burst

Kind: `burst`. Many animations started in the same frame.

- **React Native:** Stagger them with `withDelay`, or drive them from one shared progress value with `interpolate`.
- **Flutter:** Stagger them with `Interval` curves on one `AnimationController`.
- **UIKit:** Stagger them with a delay, or group them in one `UIViewPropertyAnimator`.
- **SwiftUI:** Start them in one `withAnimation` (one transaction), or stagger them with `.delay`.
- **Android:** Stagger them with `startDelay`, or play them together in one `AnimatorSet`.

```tsx
// one progress value, many rows
const progress = useSharedValue(0)
progress.value = withTiming(1, { duration: 600 })
// in each row: interpolate(progress.value, [index * 0.05, index * 0.05 + 0.3], [0, 1], Extrapolation.CLAMP)
```

### Busy start

Kind: `busy-start`. An animation was started while the app thread was blocked, so its first frames waited.

- **React Native:** Start it from a worklet (a gesture callback or `useAnimatedReaction`), or move the blocking work after it.
- **Flutter:** Move the blocking work to an isolate (`compute`, `Isolate.run`) or after the animation.
- **UIKit, SwiftUI and Android:** Move the blocking work off the main thread, or start the animation before it.

### Screen mount

Kind: `screen-mount`. Opening a screen dropped frames, during its transition.

- **React Native:** Keep the first render light: render heavy parts after the transition (`InteractionManager.runAfterInteractions`, or a short delay), virtualize lists, and avoid starting many animations on mount.
- **Flutter:** Keep the first build light: build heavy parts after the transition (a post-frame callback), use `ListView.builder` for long lists, and precache images.
- **UIKit:** Defer heavy work until it has appeared, load data off the main thread, and keep cell setup light.
- **SwiftUI:** Keep body cheap: load data in `.task` off the main actor, use `List` or a Lazy stack for long content, and defer heavy subviews until it has appeared.
- **Android:** Inflate less up front (`ViewStub`), load data off the main thread, and use `RecyclerView` for long lists.

### Layout animation

Kind: `layout-anim`. An animated style animates layout properties (width, height, margins, padding, flex, border width, gap, position) every frame, so the native side lays the view out again on every frame.

- **React Native:** Animate `transform` (translateX/Y, scale) instead, or use a Reanimated layout animation for size changes.

```tsx
// before
useAnimatedStyle(() => ({ height: h.value }), [h])
// after
useAnimatedStyle(() => ({ transform: [{ scaleY: s.value }] }), [s])
```

### Error and warning

Kinds: `error`, `warning`. Logged while recording, with the app frame that logged it. Fix errors before tuning motion: an error may stop an animation or a screen from finishing.
