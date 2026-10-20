---
name: keyframer-inspector-motion
description: Debug an animation in a running mobile app with the Keyframer Inspector MCP server - reproduce it (with a registered scenario, or by driving the app with a simulator agent such as Argent or agent-device), record it, read the ranked problems, fix the top one and prove the fix with compare. Use when asked to check, debug or investigate an animation, a stutter, dropped frames, jank, a spring that overshoots or settles slowly, motion that ignores Reduce Motion, or "why does this screen feel slow", in a React Native, Flutter, iOS (UIKit, SwiftUI) or Android (Views, Compose) app on a simulator, emulator, device or cloud simulator. Not for first-time install (keyframer-inspector-setup) or CI checks (keyframer-inspector-ci).
---

# Motion debugging with Keyframer Inspector

The Keyframer Inspector MCP server (`mcp__keyframer-inspector__*`) measures what moved, what it cost and where it is written. When the app has no scenario for the interaction, a simulator agent drives it: Argent (`mcp__argent__*`) or agent-device (`mcp__agent-device__*`). The inspector never taps; the simulator agent never measures.

Docs: https://keyframer.dev/inspector/docs

## 0. Check the connection

Call `inspector_status`. It names the connected app, its framework, its scenarios, its values, its display rate and Reduce Motion, and whether it lists the `time` capability.

- No app: the inspector is not set up or the app is not running. Use the `keyframer-inspector-setup` skill.
- Several apps (desktop relay): call `select_app` with the app's id or name.

## 1. Reproduce

Pick the most repeatable way in, in this order:

1. **A registered scenario** (listed by `inspector_status`): `run_scenario` with `name` records while it runs and reports. Skip to step 3.
2. **A simulator agent.** Open the screen first, outside the recording:
   agent-device: `open` with `app: "Expo Go", url: "exp://127.0.0.1:8081/--/sheet"` (or the app's bundle id), then `snapshot` with `interactiveOnly: true` for refs.
   Argent: `list-devices`, `launch-app` or `open-url`, then `describe` for element frames.
3. **A person using the app**: `record` with `durationMs` (default 4000, at most 60000) while they do it.

## 2. Record while you drive

Call `start_recording`, then drive:

- agent-device: `press` with `target` (a ref, or `id="sheet-open-full"` for a testID), `scroll`, `gesture`, `wait`.
- Argent: `gesture-tap` at the element's center from `describe` (normalized 0 to 1), `gesture-swipe`, `run-sequence` for several steps, `await-ui-element` to wait.

Then call `stop_recording`. Do not use `record` here: it blocks for its whole duration. One recording runs at a time; it stops by itself after 5 minutes, and the report says so when the app restarted or disconnected.

## 3. Read

The report lists problems most costly first, each with a title, `where` (file:line), evidence and a fix worded for the app's framework.

- `get_trace` with `fromMs` and `toMs` gives the timeline around a problem: drops, JS tasks, worklet frames, commits with why, animations with stacks.
- `capture_frame` with `atMs` shows the screen at a moment; `scrub` with `atMs` holds the app there.
- For one value's motion (settle, overshoot, duration), the report and `get_trace` name the animations; the panel's curve view shows it as a plot.

## 4. Fix

Fix the top problem at its `where`. The `keyframer-inspector-fix` skill has the fix for each problem kind and framework.

- Never delete, disable or shorten an animation to make a problem go away. The fix loop counts that as Removed, not Fixed.
- Never change the inspector's own setup (its imports, `connectDevTools`, `registerScenario`, the Babel config, `.keyframer/`).
- Let the change reach the app: Fast Refresh, hot reload, or a rebuild. agent-device can reload Metro (`metro` with reload); Argent has `debugger-reload-metro`.

## 5. Verify

Run the same steps again, the same way, at the same speed:

- scenario: `run_scenario` again;
- driven: `start_recording`, the same steps, `stop_recording`.

Then `compare` (default: the last two sessions). It lists what got better, what is gone, what is still there and what is new. Report the numbers from compare, not your own reading.

For several problems at once, `check` then `recheck` (or the `fix-motion-problems` prompt) runs the whole loop with medians over several runs.

## Slow motion

For apps with the `time` capability: `set_time` with `scale: 0.25` slows the app's animations on the device, `scale: 0` pauses, and `scale: 0, step: 1` advances one frame; `capture_frame` shows each one. Recordings made slowed are measured on the app's clock, but call `set_time` with `scale: 1` before any recording you will compare.

Do not use the simulator's own slow animations (agent-device animation scale settings, Simulator's Debug menu): they slow everything, the inspector does not know, and the frame numbers are wrong.

## Evidence for the pull request

- `save_recording` keeps a `.kfrec.json` the panel opens; the panel's Share gives a `keyframer.dev/r/<id>` link.
- `export_recording` with `format: "gif"` renders it with touches drawn (MP4 needs ffmpeg).
- Paste `compare`'s text.

## Keep it fixed

Turn the steps into a check file so CI runs them on every pull request. Use the `keyframer-inspector-ci` skill.

## Cloud simulators and device farms

An app on an Expo cloud simulator or a device farm cannot reach Metro or the relay. Pair through a room: the app calls `connectInspector({ apiUrl: 'https://api.keyframer.dev', code: 'ABC234' })` (6 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`), and the server joins it:

```sh
claude mcp add keyframer-inspector -- npx keyframer-inspect mcp --code ABC234
```

The room lets in signed-in editors only: the first tool call answers with a keyframer.dev link and a code for the person to approve, unless `KEYFRAMER_TOKEN` holds a session token or a `kf_` API key. Messages over 256 KB do not cross the room, so prefer `get_trace` and small `capture_frame` widths. The room does not pass `reload`.

## Gotchas

- Expo Go's first launch shows a developer menu sheet over the app: dismiss it (agent-device `press` with `label="Continue"`) before recording, or its overlay is what you measure.
- Start recording after `open`: launching the app inside a recording measures the launch.
- Leave the app as you found it: a sheet left open is tapped open again next time and nothing moves.
- On iOS simulators agent-device builds an XCTest runner the first time (minutes) and needs a simulator runtime close to the Xcode's.
- A debug build's frame times are inflated: the problems are real, the milliseconds are not a release build's.
- iOS and Android measure only the main thread: a render-thread hitch is not seen there.
- When done, stop what you started: agent-device `close`, Argent `stop-all-simulator-servers`, and `set_time` with `scale: 1`.
