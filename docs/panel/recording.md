---
title: Recording and scrubbing
description: Record a session, scrub it in the real app, and read the timeline, values, tracks and trace.
order: 1
section: The panel
---

# Recording and scrubbing

The panel is the same in Expo's dev tools and in the desktop app.

## Record a session

1. Press **Record** in the header. A timer runs.
2. Use the app.
3. Press **Record** again.

The ticked values in the Values list are what Record records (all by default). To record an interaction the app registered, use **Run scenario** instead: a split button that runs the last scenario, or one you pick, while it records.

From an agent, the same is `record`, `start_recording` and `stop_recording`, or `run_scenario`:

```json
{ "name": "run_scenario", "arguments": { "name": "sheet: open" } }
```

## Scrub

Drag the playhead on the timeline. The app follows, back to the screen that was open at that moment (with navigation tracked). Shift-drag selects a part, which is what Export renders.

**Replay**, next to Play, sets how fast a recording replays: 1x, 0.5x, 0.25x or 0.1x. Below 1x the panel steps the app through it frame by frame, with values interpolated between samples. This is the replay's speed; the app's own animation speed is the header's [speed control](slow-motion.md).

## The header

The connected app (with its framework, OS and display, such as `120 Hz ProMotion`, and a Reduce Motion badge when it is on), Record, Replay, Run scenario, the speed control, the session picker, and Open, Compare, Save, Share, Export and Clear.

## Timeline

One playhead over the whole recording, with frame drops per thread, animations, touches, screen changes and React commits. Parts recorded slowed or paused are shaded and labelled (`0.25x`: durations there are stretched). A change of display rate or of Reduce Motion is a flag. Frame rates are read against the display's rate, so 100 fps is short at 120 Hz.

## Values

Every animated value with a sparkline and its value at the playhead.

- Instances of one call site, such as `enter x6` in a list, fold into one row.
- Values that never moved hide behind "Show N unchanged".
- A value whose screen closed leaves the list. A session that sampled it keeps it, dimmed and marked closed.
- A sparkline is shaded where the value's view was off screen or hidden.
- A badge names the render hints the SDK reported for it, such as `shadow-path`.

Click a value for its [curve](curves.md).

## Tracks

Every animation as a segment on the value it moves, grouped by component. `withDelay(withSequence(...))` is drawn as its delay and steps. CSS and layout animations are included. A value that started again cuts off what it replaced. A lane is shaded where the view was not visible.

A track with more lanes than fit shows the first seven and one bar for the rest, such as "+20 more, staggered 70 ms". Click the bar, or the track's count, to show every lane.

Click a segment to [tune it](tune-and-apply.md), or a track's name for its value's curve.

## Trace

Every step in time order: animations with their stack, commits with why each component rendered, drops with what ran in them, gestures and logs. Search, and filter by kind, thread and file. Every step with a location opens in your editor; so does Cmd-click on a timeline dot.

## Problems

The recording read as what to fix. See [Problems](../problems/index.md).

## Compare

Two sessions side by side, before and after a change: frame rates, frames lost, render and task time, and the problems fixed, still there and new.

## Export and Share

Export renders an MP4 or GIF, each frame replayed in the app and captured, with touches drawn on it and the Keyframer mark, at the replay's speed or another (0.25x makes a video four times as long). The app must be able to capture its screen.

Share uploads the recording to your Keyframer account and gives you a `keyframer.dev/r/<id>` link. See [Privacy](../reference/privacy.md#share-links).

Drop a `.kfrec.json` anywhere on the panel to open it.
