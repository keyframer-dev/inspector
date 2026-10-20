---
title: Tune and Apply to code
description: Change an animation's numbers live on the device, then write them back into your source.
order: 3
section: The panel
---

# Tune and Apply to code

## Tune a call

1. Record, then click an animation's segment in Tracks.
2. Move the sliders: to value, duration, damping, stiffness, delay. Every call of a chain, such as `withDelay(withSequence(...))`, is tuned together.
3. Trigger the animation again in the app, or press **Replay**. The next run of those lines uses the new numbers.

The app applies these as live overrides the next time that line runs. Nothing in your source changes yet.

## Apply to code

Press **Apply to code**. It rewrites the changed number literals in your source in one go. Formatting and comments stay. Files outside the project are refused.

```tsx
// before
sheetY.value = withSpring(0, { damping: 12, stiffness: 180 })
// after Apply to code with damping tuned to 18
sheetY.value = withSpring(0, { damping: 18, stiffness: 180 })
```

**Reset** puts the chain back to the code's numbers.

## What each SDK lets you tune

| SDK | Tunable numbers |
|---|---|
| React Native | The numeric literals of each Reanimated call |
| iOS | `duration`, `delay`, spring `stiffness` and the rest, applied to a copy of the next animation added from that call site |
| SwiftUI | The parameters read from the `Animation`; `.default` and custom animations have none |
| Android Views | `duration`, `startDelay` and `repeatCount`, on the next start |
| Compose | A tween's duration and delay, a spring's damping ratio and stiffness, on the next start |
| Flutter | `duration` (or `period` for `repeat`), the next time that call runs |

## From the Keyframer editor

The same app can join a pairing room for the Keyframer editor's Inspector panel. There, "Apply to code" sends the tuned values to `keyframer-inspect`, running next to your source, which writes them:

```sh
npx keyframer-inspect --code ABC234 --root .
```

It rewrites only those number literals and refuses paths outside `--root`. See [CLI](../reference/cli.md#join-a-pairing-room).
