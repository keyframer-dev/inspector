---
title: Slow motion and replay speed
description: Slow down, pause and step the app's animations on the device, and replay recordings slowly.
order: 4
section: The panel
---

# Slow motion and replay speed

There are two speeds. The app's speed slows the animations on the device, live. The replay speed slows playback of a recording. They are separate.

## Slow the app down

Apps whose hello lists the `time` capability show the speed control in the header: pause and resume, a speed (1x, 0.5x, 0.25x, 0.1x), and one frame forward while paused. The app runs it on its own clock, so every animation follows, tracked or not.

| Key | Does |
|---|---|
| P | Pause and resume |
| . | Step one frame (pausing first) |
| [ | Slower |
| ] | Faster |

The control shows the speed the app says it runs at, so two panels and an agent agree. It turns amber when slowed or paused.

From an agent:

```json
{ "name": "set_time", "arguments": { "scale": 0.25 } }
{ "name": "set_time", "arguments": { "scale": 0 } }
{ "name": "set_time", "arguments": { "scale": 0, "step": 1 } }
```

## How each platform slows down

| Platform | Clock |
|---|---|
| React Native | Reanimated's UI clock |
| Flutter | `timeDilation`, and held frame stamps while paused |
| iOS | The key window layer's speed |
| Android Views | The animator duration scale; tracked animators are held when paused |
| Compose | Compose's frame clock |

## Recordings made while slowed

Slowed stretches are shaded and labelled on the timeline, and every metric reads on the app's own clock, so a spring recorded at 0.25x reports its real settle time. Set the speed back to 1 before a recording you will compare.

## When it goes back to 1x

The speed goes back to normal when the last editor leaves, the connection drops or the app reloads.

## Replay a recording slowly

**Replay**, next to Play on the timeline, sets the replay speed: 1x, 0.5x, 0.25x or 0.1x. Below 1x the panel steps the app through the recording frame by frame, with values interpolated between samples, so any app that can be scrubbed replays in slow motion. iOS uses Core Animation's own timeline.

GIF and MP4 export take the same speed: a 0.25x export is four times as long.

## Limits

- iOS: SwiftUI's own animations (except traced ones), `UIScrollView` deceleration, UIKit Dynamics, and the app's own display links and timers are not slowed.
- SwiftUI: pause and step reach Core Animation only.
- Android: `ViewPropertyAnimator` and Transitions slow down but are not held when paused. `SpringAnimation` does not follow the speed.
- Do not use the simulator's own slow animations (Simulator's Debug menu, or agent-device's animation scale settings) for measuring: they slow everything, the inspector does not know, and the frame numbers are wrong.
