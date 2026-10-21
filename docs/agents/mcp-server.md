---
title: MCP server
description: Connect a coding agent to the inspector over MCP, and every tool it gets.
order: 1
section: Coding agents
---

# MCP server

A coding agent gets the same inspector through MCP: it records, runs scenarios, reads the problems with where they are and how to fix them, compares before and after, scrubs and captures frames, and runs the fix loop.

## Connect it

### As a plugin (Claude Code, Cursor)

The plugin is the MCP server and the five [agent skills](skills.md) in one install, and it stays current on its own:

```text
/plugin marketplace add keyframer-dev/inspector
/plugin install keyframer-inspector@keyframer
```

In Cursor, install Keyframer Inspector from the Cursor Marketplace, or add the server alone with this link: [Add to Cursor](cursor://anysphere.cursor-deeplink/mcp/install?name=keyframer-inspector&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBrZXlmcmFtZXJkZXYvaW5zcGVjdG9yIiwibWNwIl19).

The plugin runs the server with `npx -y @keyframerdev/inspector mcp` (Node 20.10 or later), so it uses the project's own copy when the package is installed there.

### With the desktop app

For React Native, Flutter, iOS and Android apps alike. Turn the server on in Settings, MCP Server (or from the menu bar), then:

```sh
claude mcp add --transport http keyframer-inspector http://127.0.0.1:8789/mcp
```

Settings shows the same for Cursor, VS Code, Codex, Windsurf and Zed. Clients that launch a command (Claude Desktop) run the app over stdio:

```sh
"/Applications/Keyframer Inspector.app/Contents/MacOS/keyframer-inspector" --mcp-stdio
```

### Without it

In a React Native or Expo app, the setup wizard, [@keyframerdev/wizard](../getting-started/wizard.md), writes this for you (`.mcp.json` for Claude Code, `.cursor/mcp.json` for Cursor) when you pick the agents, or with `--agents claude-code,cursor`.

The command in the npm package (Node 20.10 or later). For React Native on Metro, it finds the Metro the app is on (8081 to 8090) by itself. These use the project's installed copy; outside a project with the package, run `npx -y @keyframerdev/inspector mcp` instead:

```sh
claude mcp add keyframer-inspector -- npx keyframer-inspect mcp
claude mcp add keyframer-inspector -- npx keyframer-inspect mcp --metro http://localhost:8082
```

- `--relay ws://127.0.0.1:8790` joins the desktop app's relay instead. Through the relay, `select_app` picks which connected app the tools inspect.
- `--http <port>` serves Streamable HTTP on `http://127.0.0.1:<port>/mcp` instead of stdio. It is this machine only, and requests from web pages are refused.
- `--code ABC234` joins a pairing room on the Keyframer API, for an app this machine cannot reach. See [Cloud simulators](simulator-agents.md#cloud-simulators-and-device-farms).

### Check that it works

Call `inspector_status`. It names the connected app, its scenarios, its values, and its display rate, Reduce Motion and speed when it reports them. No app? Start it (Metro, or the desktop app) first.

## Tools

| Tool | Arguments | Does |
|---|---|---|
| `inspector_status` | | The connected app, its scenarios, the recorded sessions, its values and the render hints its SDK reported |
| `select_app` | `app` | Through the desktop relay: which connected app the tools inspect. Omit `app` to follow the newest |
| `record` | `durationMs` (default 4000, at most 60000), `signals`, `replay` | Records for a fixed time while a person uses the app (or runs its replay), then reports the problems |
| `start_recording` | `signals` | Starts recording and returns at once, so another tool can drive the app |
| `stop_recording` | | Ends that recording and reports as `record` does |
| `run_scenario` | `name`, `settleMs` (default 800) | Records while one of the app's scenarios runs, and reports the problems |
| `compare` | `before`, `after` (default the last two sessions) | Frame rates, frames lost, longest frames, rendering, JS and worklet time, and problems fixed, still there and new |
| `get_trace` | `session`, `fromMs`, `toMs`, `libraryFrames` | A session as a timeline: drops, JS tasks, worklet frames, commits with why, animations with stacks, logs |
| `scrub` | `atMs` | Shows a moment of the last recording in the app |
| `play` | `fromMs` | Plays the last recording back in real time |
| `capture_frame` | `atMs`, `width` (default 390) | A screenshot of the app, optionally at a moment of the recording |
| `export_recording` | `format` (`gif` or `mp4`), `fps`, `width`, `touches`, `path`, `fromMs`, `toMs` | Renders the last recording; MP4 needs ffmpeg on the PATH |
| `replay` | | Runs the app's registered replay |
| `set_time` | `scale` (0 to 1), `step` (1 to 120, with `scale: 0`) | Slows down, pauses or steps the app's animations; answers with the speed the app runs at |
| `list_recordings` | | The recordings in the library, newest first |
| `open_recording` | `path`, `sourceMap` | Reads a `.kfrec.json`; every other tool then works on it |
| `save_recording` | `path` | Keeps the last recording for good in the library, or writes a copy elsewhere |
| `get_screenshot` | `atMs` | A screenshot a device recording took |
| `check` | `scenarios`, `recording`, `sourceMap`, `scenarioStub`, `runs`, `warmup`, `reload`, `settleMs`, `field` | Starts the fix loop: measures and keeps the result as the baseline. With `field` (a Motion Vitals problem, `SHOP-12`), also says whether that call site dropped frames here |
| `recheck` | | Measures again and sorts Fixed, Still there, New, Removed and Not verifiable |
| `field_problems` | `project`, `version`, `os`, `status`, `limit` | A [Motion Vitals](../vitals/fixing.md) project's top field problems, in the dashboard's words. Needs `KEYFRAMER_VITALS_READ_KEY` |
| `field_compare` | `project`, `from`, `to` | Two versions of a Motion Vitals project, problem by problem. Needs `KEYFRAMER_VITALS_READ_KEY` |

The server also has one prompt, `fix-motion-problems` (in Claude Code: `/mcp__keyframer-inspector__fix-motion-problems`). See [Fix loop](fix-loop.md).

The desktop app's built-in server and the npm package's give the same answers to the same calls.

## Record while an agent drives

When the agent drives the app itself with a simulator agent, `record` does not fit: it blocks for its whole duration. Use the pair:

```text
start_recording
  (drive the app: taps, swipes, a Maestro flow)
stop_recording
```

- One recording runs at a time; `record`, `run_scenario` and `check` wait their turn.
- It stops by itself after 5 minutes.
- The report says when it stopped early: the app restarted, left the relay or the room, or the connection went away. What came before is kept.
- A recording whose last seconds brought nothing from the app says so (backgrounded, closed or disconnected).

## Compare before and after

```text
run_scenario { "name": "sheet: open" }     # before
  (change the code, let Fast Refresh apply it)
run_scenario { "name": "sheet: open" }     # after
compare                                     # the last two sessions
```

Use the same steps at the same speed, or the numbers do not compare.

## Slow motion

`set_time` with `scale: 0.25` slows the app's animations on the device, `scale: 0` pauses, and `step: 1` advances a frame; `capture_frame` shows each one. A recording made slowed keeps time markers, and its durations are stretched by 1 / speed in the trace. Call `set_time` with `scale: 1` again before measuring.

## Evidence for a pull request

- `save_recording` writes a `.kfrec.json` the panel opens.
- `export_recording` with `format: "gif"` renders it, touches drawn.
- Paste `compare`'s text.
