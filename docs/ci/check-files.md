---
title: Check files
description: The full reference for .keyframer/checks/*.yml, the readable format for motion checks.
order: 3
section: CI
---

# Check files

A check file says what drives the app, how to record it, and what its motion must do. One file per check, in `.keyframer/checks/*.yml`. `ci` runs every check after the app's scenarios, under the check's name, which is its key in the baseline.

Scenarios live in the app's code, which suits React Native. A check's flow can drive any app from outside.

## A complete example

```yaml
# yaml-language-server: $schema=../../node_modules/@keyframerdev/inspector/schema/check.schema.json
name: sheet opens
flow:
  steps:
    - open: "Expo Go"
      url: exp://127.0.0.1:8081/--/sheet
    - wait: { id: sheet-open-full }
      timeout: 15s
    - tap: sheet-open-full
    - wait: 900ms
    - tap: sheet-close          # leave the app as you found it
    - wait: 900ms
record:
  speed: 1
  settle: 800ms
expect:
  - value: sheetY
    settle: < 600ms
    overshoot: < 5%
  - frames: { dropped: 0, longest: < 50ms }
  - none: [reduce-motion, unseen, two-writers]
```

## Editor support

The package ships the format as a JSON Schema, `@keyframerdev/inspector/schema/check.schema.json`. The comment on the first line points the YAML language server at it, so editors complete and check the keys. Adjust the relative path to where your `node_modules` is.

## Top-level keys

| Key | Required | |
|---|---|---|
| `name` | No | The check's name in the baseline and the reports. Default: the file name without its extension |
| `flow` | Yes | What drives the app: exactly one source |
| `record` | No | How to record it |
| `expect` | No | What the motion must do: a list of expectations |
| `targets` | No | Devices to run on side by side. See [Several devices](devices.md) |

No other keys are allowed.

## flow

Exactly one of:

| Key | Value | Runs through |
|---|---|---|
| `scenario` | A scenario name | The app (`registerScenario`). A check named like a scenario stands in for it |
| `agent-device` | A `.ad` script, relative to the project root | agent-device's Node API. End it without `close`: the app must stay up while the recording settles |
| `maestro` | A Maestro flow, relative to the project root | The `maestro` CLI, or agent-device's Maestro backend with `--maestro-driver agent-device` |
| `argent` | An Argent flow (`.argent/flows/*.yaml`), relative to the project root | Argent's MCP server (`flow-execute`) |
| `steps` | A list of steps (below) | agent-device (compiled to an `.ad` script), or Argent |

```yaml
flow: { scenario: "welcome: replay the entrance" }
```

```yaml
flow: { agent-device: flows/sheet.ad }
```

```yaml
flow: { maestro: .maestro/sheet.yaml }
```

agent-device and Maestro are not dependencies. Install agent-device in the project (`npm i -D agent-device`, Node 22.12 or newer) and Maestro on the PATH (Java 17).

## steps

| Step | Form | |
|---|---|---|
| `open` | `open: <app, deep link or URL>`, optional `url:` | With an app such as Expo Go, `url` is the URL it opens. The app's bundle id or package opens it to the front without relaunching |
| `tap` | `tap: <target>` | |
| `longpress` | `longpress: <target>`, optional `ms: <time>` | |
| `type` | `type: { into: <target>, text: "..." }` | |
| `scroll` | `scroll: up`, `down`, `left` or `right`, or `scroll: { direction: down, until: <target> }` | |
| `wait` | `wait: <time>`, or `wait: <target>` with `timeout: <time>` | |
| `back` | `- back`, or `back: true` | |

A target is a testID (`sheet-open-full`), `{ id: sheet-open-full }`, `{ text: "Open fully" }` for a label, or `{ x: 120, y: 640 }` in screen points.

```yaml
steps:
  - open: com.example.app
  - wait: { text: "Feed" }
    timeout: 10s
  - scroll: { direction: down, until: { id: row-20 } }
  - longpress: row-20
    ms: 600ms
  - type: { into: search, text: "spring" }
  - back
```

**Leading `open` steps run before the recording.** Opening the app or a deep link may launch or reload it (Expo Go on Android reloads on every link), so they run unrecorded, and the run waits for a reloaded app to say hello again. agent-device's steps need an app session, so start a flow with `open`.

## record

| Key | Value | |
|---|---|---|
| `speed` | `1`, `0.5`, `0.25` or `0.1` | The app's animation speed while recording. Motion is measured on the app's clock either way |
| `settle` | A time | How long to keep recording after the flow ends. Default: `ci --settle` (800 ms) |
| `signals` | A list of names or ids | Values to record. Default: all |

## expect

Each item is one of three shapes.

### A value or a site

```yaml
- value: sheetY            # or site: app/sheet.tsx:41
  settle: < 600ms
  overshoot: < 5%
  duration: 300ms..500ms
  velocity: < 3000/s
  tolerance: 2%
```

| Key | Unit | |
|---|---|---|
| `value` | | A value's name (the `useSharedValue` variable), `Component.name` for one component's, or its id: every motion it makes |
| `site` | | An animation's call site, `file:line`: what it animates, each time it runs |
| `settle` | time | From the start of a motion until it stays within the tolerance of its end value |
| `overshoot` | percent | How far past its end value it goes, a fraction of the travel |
| `duration` | time | How long a motion lasts |
| `velocity` | units per second | Peak velocity |
| `tolerance` | percent | How close to the end counts as settled (default 2%) |

Give exactly one of `value` or `site`.

### frames

```yaml
- frames: { dropped: 0, ui: 0, js: < 2, longest: < 50ms }
```

| Key | |
|---|---|
| `dropped` | Frames dropped on both threads together |
| `ui` | Frames dropped on the frame thread (React Native's UI thread) |
| `js` | Frames dropped on the app thread (React Native's JS thread) |
| `longest` | The longest frame, a time |

iOS and Android do not measure a frame thread, so `ui` says nothing about those apps.

### none

```yaml
- none: [reduce-motion, unseen, two-writers]
```

A problem kind, or a list of them: `js-task`, `render-storm`, `slow-render`, `ui-work`, `busy-start`, `burst`, `layout-anim`, `js-unknown`, `screen-mount`, `ui-unknown`, `error`, `warning`, `reduce-motion`, `unseen`, `two-writers`, `jump`, `render-hint`. See [Problems](../problems/index.md).

## Limits and amounts

| Form | Means |
|---|---|
| `< X` | At most X (the end is included) |
| `> X` | At least X (the end is included) |
| `X..Y` | Between X and Y |
| `X` | At most X |

| Amount | Written as |
|---|---|
| Time | `400ms`, `0.4s`, or a number of ms |
| Percent (overshoot, tolerance) | `5%` or `0.05` |
| Velocity | `3000/s` |
| Frames | Whole numbers |

## How a check passes or fails

- `expect` compiles to the same [motion assertions](baselines.md#motion-assertions-in-the-baseline) as the baseline's, scoped to the check. A missed limit fails the check whether or not it has a baseline entry.
- An expectation on a value or site that did not move fails the check, also while recording the baseline (which then keeps its old entry): `sheetY did not move: expected to settle in at most 600 ms`.
- A flow's own failure (a step that found nothing, a script that diverged) fails the check as `failed`, with what went wrong, and motion is not measured: `the flow failed (agent-device): REPLAY_DIVERGENCE: ... (at step 3)`.
- A file that is not right stops `ci` before anything runs (exit 2), with the file and the line: `.keyframer/checks/sheet.yml:6: "overshot" is not a key of an expectation (did you mean overshoot?)`.

## Leave the app as you found it

Every run of a check, and the warm-up, starts from where the last one ended. A deep link to the screen already showing keeps its state: a flow that opens a sheet and leaves it open finds it open the next time, taps an open sheet, and nothing moves. End a flow where it began (close the sheet again), or reset first: by default `ci` reloads apps that have the `reload` capability.

## iOS simulators

- agent-device drives the app through an XCTest runner it builds with Xcode the first time (a few minutes). `ci` builds it before the first flow and says so; later runs reuse it.
- The runner has to start on the simulator's iOS. With Xcode 27, an iOS 18 simulator cannot start it ("Failed to initialize for UI testing"): `ci` names the runner's log and the newest runtime installed. Use a simulator on a current iOS.
- Before a flow opens a link, `ci` lets the simulator open its scheme without the "Open in ...?" prompt (`exp://` for Expo Go, which also gets its developer menu's introduction marked seen).
- A simulator agent-device booted for the run is shut down after it, and clones are deleted.

`KEYFRAMER_DEBUG=1` prints what each run did and when.
