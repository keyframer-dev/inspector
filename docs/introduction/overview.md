---
title: Overview
description: What Keyframer Inspector records, what it tells you, and who it is for.
order: 1
section: Introduction
---

# Overview

Keyframer Inspector records how an app moves. A development build reports every animation with the file and line that started it, samples the animated values every frame, and measures the frames on the app's threads. You get that as a recording you can scrub, as a ranked list of problems with fixes, and as numbers a coding agent or a CI job can check.

## What you can do with it

- **Record and scrub.** Record a session, then drag the playhead. The app on the device follows, back to the screen that was open at that moment.
- **See each motion as a curve.** Value and velocity over time, with overshoot, settle time, duration, peak velocity, and dropped frames shown as gaps.
- **Tune and write back.** Change a duration, a delay or a spring on the curve or with sliders, try it on the device, then apply the numbers to your source (React Native).
- **Slow motion on the device.** Run the app's animations at 0.5x, 0.25x or 0.1x, pause them, and step one frame at a time.
- **Read problems, not frame counts.** Each long frame is traced to the handler, render or worklet that caused it. Motion bugs that drop no frames are found too: animations that ignore Reduce Motion, values moving where nobody can see them, two animations writing one value, interrupted animations that jump, and costly ways of drawing moving views.
- **Compare before and after.** Two sessions side by side: frame rates, frames lost, and the problems fixed, still there and new.
- **Give it to a coding agent.** An MCP server lets an agent record, read problems, change code and check the fix by measuring again.
- **Gate pull requests.** `keyframer-inspect ci` runs scenarios and check files against a committed baseline and fails a pull request that adds a problem or breaks a motion limit.

## Who it is for

- Developers tuning or debugging animations on React Native, Flutter, iOS and Android.
- Testers, who can record a glitch on the device and send one file (React Native).
- Coding agents, through MCP and the [agent skills](../agents/skills.md).
- CI, through [check files](../ci/check-files.md) and baselines.

## Development builds only

The SDKs run in development builds. React Native also supports internal preview builds you opt in to. Release builds get nothing or a no-op: the Babel plugin is left out on React Native, iOS does nothing unless you allow it, Android links a no-op artifact, and Flutter's widget is a plain `RepaintBoundary`.

## Next

- [How it works](how-it-works.md)
- [Platforms](platforms.md)
