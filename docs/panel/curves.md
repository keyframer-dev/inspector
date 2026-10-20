---
title: The curve view
description: Read a motion as value and velocity over time, and change it by dragging the curve.
order: 2
section: The panel
---

# The curve view

Click a value in the Values list, or a track's name, to see its curve.

## Read a motion

The curve shows one value over time with its velocity, one motion at a time: the one under the playhead, or step through them. Or show the whole session.

| Reading | Meaning |
|---|---|
| Start and end | Where the motion began and finished |
| Overshoot | How far past its end value it went, as a part of its travel |
| Settle time | From the start of the motion until it stays within 2% of its travel |
| Duration | How long the motion lasted |
| Peak velocity | Its fastest speed, in units per second |

The plot draws a settle band, the settled line, the end line and the overshoot marker.

- **Dropped frames** are gaps in the curve, with a red bridge and red ticks under it.
- **Frame times**: a strip beneath shows the time between samples against the frame budget (1000 / Hz ms).
- **Slowed recordings** read at normal speed.
- **Remounts**: a value whose screen remounted is read one mount at a time.
- **Render hints** for the value are listed with what the SDK saw.

These are the same metrics `ci` checks with `settle`, `overshoot`, `duration` and `velocity` in a [check file](../ci/check-files.md).

## Edit the curve

A motion that an animation call made can be changed on the curve. The panel runs the calls behind it again exactly as Reanimated 4 runs them (every Easing, physics and duration springs, `withDelay`, `withSequence`, `withRepeat`), lined up with the recording. The simulator matches real recordings with a median error of 0.02% to 0.08% of travel.

Handles set the numbers:

| Handle | Drag | Changes |
|---|---|---|
| End value | Up or down | The `toValue` |
| Duration | Left or right | A `withTiming`'s duration |
| Delay | Left or right | A `withDelay`'s wait |
| Overshoot peak | Up or down | A spring's damping (or `dampingRatio` on a duration config) |
| Settle line | Left or right | A spring's stiffness (keeping the bounce), or its duration |

Arrow keys nudge a focused handle; Shift nudges by ten.

## Try it and keep the best one

1. Drag a handle. The next run is drawn dashed over the recorded one, and the numbers above are its own.
2. Release. The app gets the numbers: its next run of those calls uses them.
3. Click **Try it**. The panel records a short run with the app's replay. The new curve shows, and the run before stays faded behind it.
4. Click **Apply to code** to write the numbers into your source, or **Reset** to go back to the code's numbers.

The numbers of every call in a chain (for example `withDelay`, then `withTiming`, then `withSpring`) sit in one block beside the plot, with one Reset and one Apply to code.

## What can be dragged

Handles are for numbers the code writes as literals, so Apply to code can write what was dragged. Easing functions are not in recordings, so a timing that clearly is not the default `inOut(quad)` gets the named easing that fits its curve.

The simulator behind the handles is a port of Reanimated 4.5.1's timing, spring, delay, sequence and repeat, so it models Reanimated calls. Try it needs the app's registered replay.
