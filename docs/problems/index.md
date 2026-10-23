---
title: Problems
description: How a recording becomes a ranked list of problems, and every problem kind at a glance.
order: 1
section: Problems
---

# Problems

A recording is read as the few things to fix, most costly first. The panel's **Problems** tab, every MCP report and `ci` show the same list. Each problem has:

- a **title**, such as `onPress in Glitches blocked the JS thread`;
- **where** it is written (`file:line`) when the cause is in your code;
- **evidence**: when it happened and what was measured;
- a **fix**, worded for the app's framework (React Native, Flutter, UIKit, SwiftUI, Android Views or Jetpack Compose);
- a **severity**: high, medium or low.

On React Native, the Babel plugin also reads the code before it runs: worklet mistakes that crash the app, and motion mistakes such as a descending input range, a spring missing its mass or a per-frame `scheduleOnRN`. Those come without a recording; see [Static checks](static-checks.md).

## Severity

| Severity | When |
|---|---|
| High | An error, or 10 or more frames lost (counted as 60 Hz frames), or one block of 100 ms or more |
| Medium | 3 or more frames lost, or a block of 40 ms or more, or any of: `render-storm`, `warning`, `reduce-motion`, `unseen`, `two-writers`, `jump`, `gesture-lost`, `gesture-cancelled`, `gesture-steals-scroll`, `restart-storm`, `thread-hops` |
| Low | Everything else |

Frames lost count as 60 Hz frames for severity, so the same hitch is as severe on a 120 Hz screen, where it loses twice as many.

## Every kind

Use these names in a check file's `none:` list.

| Kind | In short | Page |
|---|---|---|
| `js-task` | An event handler, effect or timer blocked the app thread | [Dropped frames](frames.md#js-task) |
| `slow-render` | A React render blocked the JS thread | [Dropped frames](frames.md#slow-render) |
| `render-storm` | A component re-renders on every frame | [Dropped frames](frames.md#render-storm) |
| `thread-hops` | A worklet calls the JS thread on nearly every frame | [Dropped frames](frames.md#thread-hops) |
| `restart-storm` | Many views start the same animation over on every frame | [Dropped frames](frames.md#restart-storm) |
| `js-unknown` | The app thread was blocked by code the inspector does not time | [Dropped frames](frames.md#js-unknown) |
| `ui-work` | A worklet is too slow for the UI thread | [Dropped frames](frames.md#ui-work) |
| `ui-unknown` | The frame thread dropped frames with nothing timed over budget | [Dropped frames](frames.md#ui-unknown) |
| `burst` | Many animations started in the same frame | [Dropped frames](frames.md#burst) |
| `busy-start` | An animation started while the app thread was blocked | [Dropped frames](frames.md#busy-start) |
| `screen-mount` | Opening a screen dropped frames | [Dropped frames](frames.md#screen-mount) |
| `layout-anim` | An animated style animates layout properties | [Dropped frames](frames.md#layout-animation) |
| `error`, `warning` | Logged while recording | [Dropped frames](frames.md#error-and-warning) |
| `reduce-motion` | An animation moved while Reduce Motion was on | [Motion bugs](motion.md#reduce-motion) |
| `unseen` | A value kept moving where nobody could see it | [Motion bugs](motion.md#unseen) |
| `two-writers` | Two animations write one value at once | [Motion bugs](motion.md#two-writers) |
| `jump` | An interrupted animation jumps instead of continuing | [Motion bugs](motion.md#jump) |
| `render-hint` | A moving view is drawn in a costly way | [Render hints](render-hints.md) |
| `gesture-lost` | A gesture keeps losing the touch to a scrolling list or another gesture | [Motion bugs](motion.md#lost-gesture) |
| `gesture-cancelled` | An active gesture is cancelled as another one activates | [Motion bugs](motion.md#cancelled-gesture) |
| `gesture-steals-scroll` | A gesture takes drags that belong to a list | [Motion bugs](motion.md#stolen-scroll) |

## Read a problem

```text
P1 high  onPress in Glitches blocked the JS thread
  where: app/glitches.tsx:86
  evidence: 2.31s: onPress (submit) ran 299 ms, 18 frames lost
  fix: Move the heavy work out of this callback: defer it until the animation ends, ...
```

1. Open `where`.
2. Read the evidence to see when and how much.
3. Apply the fix, then record the same interaction again and [compare](../agents/mcp-server.md#compare-before-and-after).

## How frames are counted

- Frame budgets follow the display: 16.7 ms at 60 Hz, 8.3 ms at 120 Hz. Without a display in the app's hello, 60 Hz.
- Frames measured while the editor had the app paused are not counted.
- Durations are read on the app's own clock, so a slowed recording measures real lengths.
- A screen that remounts while recording is read one mount at a time: the step from the old instance to the new one is neither motion nor a jump.
- A debug build's frame times are inflated. The problems are real; the milliseconds are not a release build's.

## What animates now

Besides the problems in a recording, a React Native app counts what animates while it runs: Motion Scan's list shows it, and the MCP server's `inspector_status` prints it. It is information, never a problem, read over the last 2.5 to 5 seconds:

- **Mounted on the screen:** animated style instances, shared-value instances per `useSharedValue` (or `useDerivedValue`) call site (a list's rows each own one: `<site>`, `<site>#2`, …), and animated properties per view.
- **Fan-out:** how many style instances each driving value feeds, and their properties (one `scrollY` driving 24 rows is normal; it says where the per-frame work comes from).
- **Cost per list cell:** the UI work of a worklet that runs in several instances a frame, per instance and per frame, heaviest first. UI work is sampled a second in ten (in Motion Scan, while its list is open), so it can say "not measured in this window".
- **Restarts:** animation starts per frame by call site (runs against frames drawn). One a frame is a view following a value; more than three is a [restart storm](frames.md#restart-storm).
- **Remount churn:** shared-value slots claimed and freed per call site, how many while a list scrolled or a finger moved, against the instances mounted now. A virtualized list mounts rows as they come into view; every row mounting again several times over is a `renderItem` component made inline, or keys that change.
