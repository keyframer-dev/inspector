---
title: Protocol
description: The wire protocol every SDK speaks, for authors of a new SDK or tool.
order: 3
section: Reference
---

# Protocol

Every SDK speaks one protocol, defined in [`protocol/inspector.ts`](https://github.com/keyframer-dev/inspector/blob/main/protocol/inspector.ts) in the public repository. A new platform needs only to speak it to work with the panel, the MCP server and `ci`. The protocol version is `1`. New fields are optional, so older apps, panels and recordings keep working.

## Transport

- A WebSocket to the relay at `ws://<host>:8790/app?name=<app name>&platform=<os>`.
- Each text frame is one JSON message with a `type`. Binary frames are ignored. Up to 128 MB per message.
- Keep-alive: WebSocket pings, or a text frame `ping`, which the relay answers with `pong`. Ignore a `pong` text frame.
- Reconnect with a backoff, for example 500 ms doubling to 10 s.

## Session order

1. Connect, then send `hello` first.
2. Send `time` when the app's speed is not 1.
3. Send the catalog: one `events` message with every `signal` (and `style`, and `renderHint`) event.
4. Then batch `events` and `samples`, for example every 100 ms.
5. On `presence` with more `editors` than before, send the catalog again: a new panel missed the first one.

## hello

```json
{
  "type": "hello",
  "role": "app",
  "app": "My app",
  "platform": "ios",
  "framework": "uikit",
  "protocol": 1,
  "sdk": { "name": "my-sdk", "version": "0.1.0" },
  "osVersion": "18.2",
  "build": "debug",
  "threads": { "js": { "label": "Main", "animates": true } },
  "capabilities": ["capture", "playback", "scrub", "overrides", "replay", "scenarios", "time"],
  "display": { "hz": 120, "adaptive": true },
  "accessibility": { "reduceMotion": false },
  "device": { "simulator": true, "id": "<udid>", "name": "iPhone 16 Pro" },
  "scenarios": ["bounce"],
  "screen": { "width": 393, "height": 852, "scale": 3 }
}
```

| Field | |
|---|---|
| `platform` | The OS: `ios`, `android`, `macos`, `web` |
| `framework` | `react-native`, `flutter`, `uikit`, `swiftui`, `android-views`, `compose`, or your own. Without it: react-native |
| `threads` | The two threads by role: `js` is the app thread, `ui` the frame thread. Leave out one you do not measure |
| `build` | `debug`, `profile` or `release`. A debug build's frame slack is doubled in CI |
| `capabilities` | `capture`, `playback`, `scrub`, `overrides`, `replay`, `reload`, `scenarios`, `recordings`, `time`, `widget-sites`. Tools only offer what is listed |
| `display` | The refresh rate; it sets the frame budget. Without it: 60 Hz |
| `accessibility` | The person's motion setting |
| `device` | `name` and `id` only for simulators and emulators. A physical device sends `model` and `simulator: false`, never its owner's name |

## App to editor

| Message | |
|---|---|
| `hello` | What the app is (above) |
| `events` | `anim` (an animation started, with its call site, `args`, `thread`, and while recording `t`, `stack` or `frames`, `durationMs`), `signal` (a value registered), `unsignal` (a value went away), `style` (its `links` may carry `id`, the call site of a value passed in as a prop), `renderHint` |
| `samples` | Values over time (`{ id, t, v }`), and while recording `frames`, `drops`, `commits`, `markers`, `tasks`, `work`. `work` rows of kind `hop` count a worklet's calls to the JS thread (`calls` in that frame, `ms` 0). Optional `tracking`: what animates now (`InspectorMotionTracking`: `screen`, `windowMs`, `frames`, `inventory`, `values`, `styles`, `drivers`, `cells`, `restarts`, `churn`), every few seconds while an editor is in the room, recording or not |
| `scenarios` | The registered scenarios changed |
| `scenarioDone` | A scenario an editor asked for finished, or failed with `error` |
| `recording` | A recording made on the device |
| `frame` | The answer to `capture`: a base64 image, or why there is none |
| `time` | The app's speed now, after a `time` message |

## Editor to app

| Message | |
|---|---|
| `record` | `{ signalIds, on, recorder? }`: start or stop recording; `*` records every value, including ones that appear later |
| `playback` | `{ samples, routes? }`: write recorded values back, in time order, navigating along `routes` |
| `capture` | `{ id, samples, format?, width?, route? }`: show a moment and answer with `frame` |
| `scrub` | `{ t }`: seek to `t` ms of the last recording; `null` lets it run |
| `overrides` | New numbers for a call site's params, applied the next time it runs |
| `replay` | Run the registered replay |
| `reload` | Reload the app (apps with the `reload` capability) |
| `scenario` | `{ name }`: run a scenario |
| `time` | `{ scale, step? }`: the animation speed |

Ignore types you do not handle.

## Markers

`touch`, `navigation`, `appState`, `keyboard`, `log`, `note`, `gesture`, and the motion markers: `accessibility` (Reduce Motion changed), `display` (the refresh rate changed), `visibility` (`{ id, visible, reason }`, with `offscreen`, `hidden`, `detached` or `covered`), and `time` (the editor changed the speed; durations until the next one are stretched by 1 / scale).

## The time rule

Every SDK follows the same rule for `time`:

- A scale that is missing, not a number, infinite or negative changes nothing.
- 0 pauses. Between 0 and 0.01 is 0.01. Above 4 is 4.
- `step` counts only while paused, as whole frames from 1 to 120.
- Answer every `time` message with `time`: the speed the app now runs at, or 1 when it cannot change it.
- Go back to 1 when the last editor leaves (a `presence` with no editors) or the connection drops. A new `hello` means a reloaded app at 1x.
- While recording, each change is a `time` marker.

> The SDKs are still being aligned on this rule for 0.2.0 (negative values, the maximum, and announcing the reset to 1x).

## Values and call sites

A value's id is stable for one call site. A second mounted instance of the same call site is `<id>#2`. A call site has `file`, `line` (0 when the platform cannot say), `column`, `component` and `name`. Native SDKs send stacks already mapped (`frames`); React Native leaves them to Metro.

## The relay for editors

Editors connect to `/editor`. The relay sends `apps` (the connected apps), and after `{ "type": "hello", "role": "editor" }` attaches the editor to an app and sends its cached `hello`. `{ "type": "select", "app": "<id>" }` switches app; `"app": null` goes back to following the newest. Editor endpoints accept this machine only.

## Testing an SDK

Each SDK in the public repository checks its messages against `protocol/inspector.ts` with golden JSON files type-checked by `tsc`. Do the same: write every message your SDK sends to a fixture and check it with `satisfies InspectorAppMessage`.
