---
title: Simulator agents
description: Use Argent, agent-device, Maestro, Expo cloud simulators and TesterArmy's e2e runner with the inspector.
order: 3
section: Coding agents
---

# Simulator agents

Simulator agents drive the app on a simulator or emulator, so a coding agent can reproduce what a person would do. They drive; the inspector measures. Live, the agent calls `start_recording`, drives the app with the other tool, then `stop_recording`. In CI, [check files](../ci/check-files.md) run the same tools as drivers.

| Tool | Live, with an agent | In CI | Set up |
|---|---|---|---|
| Argent (Software Mansion) | Its MCP tools between the two recording calls | `steps:` and `flow: argent` | `npx @swmansion/argent init` |
| agent-device (Callstack) | Its MCP server or CLI between the two recording calls | `.ad` scripts and `steps:` | `npm i -D agent-device`, then `npx agent-device doctor` |
| Maestro | `maestro test` between the two recording calls | `flow: maestro` | The install script below (Java 17) |
| Expo cloud simulators | Driven by Argent or agent-device, paired through a room | Not yet | A Keyframer account |
| TesterArmy's e2e runner | | The `motion` fixture | `@keyframerdev/inspector/e2e` |

## Argent

Run it next to the inspector's MCP server:

```sh
npx @swmansion/argent init
```

Live, use its MCP tools between `start_recording` and `stop_recording`: `launch-app` or `open-url`, `describe` for element frames, `gesture-tap` at an element's center (normalized 0 to 1), `gesture-swipe`, `run-sequence` for several steps, and `await-ui-element` to wait.

In CI, Argent runs `steps:` and Argent flows through its MCP server with no model: its `open-url`, `describe` then `gesture-tap` at the element's center, `await-ui-element`, `gesture-swipe`, `keyboard`, `button` and `flow-execute`. Its simulator-server binaries are Software Mansion's (see its license), and `DO_NOT_TRACK=1` is set for it.

> Argent as a CI driver is unit tested, not run end to end yet.

## agent-device

```sh
npm i -D agent-device          # Node 22.12 or newer
npx agent-device doctor
claude mcp add agent-device -- npx agent-device mcp
```

Live, use its MCP server (`open`, `snapshot`, `press`, `fill`, `scroll`, `gesture`, `wait`) or its CLI between the two recording calls. For example: `open` with `app: "Expo Go"` and `url: "exp://127.0.0.1:8081/--/sheet"`, then `snapshot` with `interactiveOnly: true` for refs, then `press` with `id="sheet-open-full"`.

In CI it runs `.ad` scripts, `steps:` and (with `--maestro-driver agent-device`) Maestro YAML through its Node API. A saved agent-device run works as a flow: end it without `close`, since the app must stay up while the recording settles.

On iOS simulators, agent-device builds an XCTest runner the first time (a few minutes), and the runner needs a simulator runtime close to the Xcode's. With Xcode 27, an iOS 18 simulator cannot start it.

## Maestro

```sh
curl -fsSL "https://get.maestro.mobile.dev" | bash
```

```yaml
# .keyframer/checks/sheet.yml
flow: { maestro: .maestro/sheet.yaml }
expect:
  - value: sheetY
    settle: < 600ms
```

`ci` runs it with `maestro --udid <device> test`, or through agent-device's Maestro backend with `--maestro-driver agent-device`. Live, run `maestro test` between the two recording calls.

## Cloud simulators and device farms

An app on an Expo cloud simulator (`eas simulator`, in preview) or a device farm cannot reach Metro or the relay on your machine. Pair it through a Keyframer room instead. In the app:

```ts
connectInspector({ apiUrl: 'https://api.keyframer.dev', code: 'ABC234' })
```

The code is any 6 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`. Then join the same code from the MCP server:

```sh
claude mcp add keyframer-inspector -- npx keyframer-inspect mcp --code ABC234
```

- The room lets in signed-in editors only. With `KEYFRAMER_TOKEN` set to a Keyframer session token or a `kf_` API key it joins at once. Without it, the first tool call answers with a keyframer.dev link and a code to approve.
- The first account to open a code owns it.
- Messages over 256 KB do not cross the room, so large captured frames and recordings with screenshots do not. Prefer `get_trace` and small `capture_frame` widths.
- The room does not pass `reload`, so the fix loop falls back to the app's replay.
- `--metro` points at the app's Metro, when this machine can reach it, to symbolicate stacks.

> Expo's cloud simulators are untested (waitlist). The room changes for `kf_` keys and late editors need the API deployed.

## TesterArmy's e2e runner

`@keyframerdev/inspector/e2e` is a fixture for TesterArmy's [e2e](https://github.com/tester-army/e2e) runner, which drives mobile apps through agent-device. It has no dependency on it.

```ts
import { test as base } from 'e2e'
import { motionFixture, type Motion } from '@keyframerdev/inspector/e2e'

export const test = base.extend<{ motion: Motion }>({ motion: motionFixture({ metro: 'http://localhost:8081' }) })

test('the sheet opens smoothly', async ({ screen, motion }) => {
  await motion.start()                          // { speed: 0.25 } records slowed, { signals } only some values
  await screen.getByText('Open fully').tap()
  const report = await motion.stop()
  report.expectSettles('sheetY', { within: '600ms' }).expectOvershoot('sheetY', { below: '5%' })
  report.expectNoProblems('reduce-motion', 'unseen').expectFrames({ dropped: 0 })
})
```

- `report.expect(...)` takes a check file's expectations (`{ value: 'sheetY', settle: '< 600ms' }`, `{ frames: { dropped: 0 } }`, `{ none: ['jump'] }`) and is judged by the same rules as `ci`. A miss throws with each limit in words.
- `report.problems`, `framesLost`, `longestFrameMs` and `motion('sheetY')` hold the numbers.
- `motion.scenario(name)` runs a registered scenario instead.
- `createMotion(opts)` is the same recorder outside a fixture.
- Options: `metro` or `relay`, `root`, `connectTimeoutMs`, `settleMs`.

## Things that trip runs up

- Expo Go's first launch covers the app with its developer menu, and the first `exp://` link asks "Open in Expo Go?". `ci` handles both on simulators; by hand, dismiss them once, or pre-approve the link as the [GitHub Actions job](../ci/running.md#github-actions) does.
- Start recording after `open`: launching the app inside a recording measures the launch.
- A flow that leaves a screen changed (a sheet left open) makes the next run measure nothing.
- agent-device takes a claim on the device it drives: close its session (`close`) before another tool drives the same simulator.
- Run one driver per device.
- Do not slow the simulator's own animations to slow motion: use `set_time`.
