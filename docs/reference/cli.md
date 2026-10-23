---
title: CLI
description: Every keyframer-inspect command and flag.
order: 1
section: Reference
---

# CLI

`keyframer-inspect` comes with the npm package. It needs Node 22 or later (or Bun): a runtime with a global WebSocket.

```sh
npx keyframer-inspect <command> [options]
```

| Command | Does |
|---|---|
| `keyframer-inspect mcp` | The MCP server |
| `keyframer-inspect ci` | Runs scenarios and check files against a baseline |
| `keyframer-inspect fix` | The fix loop with Claude Code, Codex or another agent |
| `keyframer-inspect lint` | Worklet crashes and motion mistakes in React Native code, without running the app |
| `keyframer-inspect symbolicate <file> --map <map>` | Maps a preview build's raw stacks to source lines |
| `keyframer-inspect --code <code>` | Joins a pairing room and writes the Keyframer editor's edits to disk |

`ci --help` and `fix --help` print their flags.

## keyframer-inspect mcp

```sh
npx keyframer-inspect mcp [--metro <url> | --relay <url> | --code <code> [--api <url>]] [--http <port>] [--root .] [--recordings <dir>]
```

| Flag | Default | |
|---|---|---|
| `--metro <url>` | looks on 8081 to 8090 | The Metro the app is on. With `--relay` or `--code`, only for symbolicating stacks |
| `--relay <url>` | | The desktop app's relay, `ws://127.0.0.1:8790` |
| `--code <code>` | | A pairing room on the Keyframer API: 6 characters, letters and digits, no 0, O, 1 or I |
| `--api <url>` | `https://api.keyframer.dev` | With `--code`: another API |
| `--http <port>` | stdio | Serve Streamable HTTP on `http://127.0.0.1:<port>/mcp` instead |
| `--root <dir>` | `.` | The project root |
| `--recordings <dir>` | `<root>/.keyframer/recordings` | The recordings library |
| `--exit-with-stdin` | | Exit when stdin closes |

## keyframer-inspect ci

```sh
npx keyframer-inspect ci [options]
```

| Flag | Default | |
|---|---|---|
| `--metro <url>` | looks on 8081 to 8090 | The Metro the app is on |
| `--relay <url>` | | The desktop app's relay instead (Flutter, iOS and Android apps) |
| `--root <dir>` | `.` | The app's project root |
| `--scenarios a,b` | all | Which scenarios and checks to run, by name (a name with a comma cannot be listed) |
| `--checks <dir or file,...>` | `<root>/.keyframer/checks` | Check files to run |
| `--device <name, udid or serial>` | | The simulator or emulator flows run on |
| `--platform ios or android` | | Its platform, when the name does not say |
| `--maestro-driver maestro or agent-device` | `maestro` | What runs `flow: maestro` |
| `--launch <url, app id or app>` | | With `--relay`: open this on every target of checks that list `targets`, and run them side by side |
| `--runs N` | 3 | Runs per scenario; the median counts |
| `--warmup N` | 1 | Runs per scenario thrown away first |
| `--no-reload` | | Do not reload the app before each scenario |
| `--baseline <file>` | `<root>/.keyframer/baseline.json` | |
| `--update-baseline` | | Record instead of compare |
| `--max-new-problems N` | 0 | New problems allowed |
| `--min-severity low, medium or high` | `low` | Only new problems this severe count |
| `--frames-lost-tolerance 25%` | | Growth allowed in frames lost per thread |
| `--frames-lost-slack N` | 3 | Frames lost may always grow this much |
| `--longest-frame-tolerance 25%` | | Growth allowed in the longest frame |
| `--longest-frame-slack MS` | 50 | The longest frame may always grow this much |
| `--format text, json, github or junit` | `text` | See [Output formats](../ci/output.md) |
| `--out <file>` | stdout | Where the report goes |
| `--timeout S` | 120 | Seconds to wait for the app to connect |
| `--settle MS` | 800 | Keep recording after each scenario |

Exit codes: 0 no regression, 1 a regression or a failed scenario, 2 a setup error.

## keyframer-inspect fix

```sh
npx keyframer-inspect fix --agent claude --scenario "sheet: open" --max-rounds 3
```

| Flag | Default | |
|---|---|---|
| `--agent claude or codex` | `claude` | The coding agent that changes the code |
| `--agent-cmd "<cmd>"` | | Any other agent: a shell command that gets the prompt on stdin and in `$KEYFRAMER_FIX_PROMPT_FILE` |
| `--scenario <name>` | all | A scenario to check; repeat for more |
| `--scenarios a,b` | | Scenarios as a list |
| `--recording <file>` | | Check a `.kfrec.json` recording instead |
| `--map <file>` | | With `--recording` from a preview build: its source map |
| `--save-scenario <file>` | | With `--recording`: write a scenario stub made from it |
| `--max-rounds N` | 5 | Most change-and-recheck rounds |
| `--runs N` | 3 | Measured runs per scenario; the median counts |
| `--warmup N` | 1 | Runs thrown away first |
| `--no-reload` | | Do not reload the app before each scenario |
| `--rebuild "<cmd>"` | | Run after each change (native apps), then wait for the app to reconnect |
| `--wait MS` | 3000 | After a change, before rechecking (Fast Refresh) |
| `--metro <url>` or `--relay <url>` | Metro on 8081 to 8090 | Where the app is |
| `--root <dir>` | `.` | The project root |
| `--allow-bash` | | Let Claude Code run shell commands too |
| `--timeout S` | 120 | Seconds to wait for the app to connect |
| `--settle MS` | 800 | Keep recording after each run |

Exit codes: 0 done, 1 not done, 2 a setup error.

## keyframer-inspect lint

The [static checks](../problems/static-checks.md) the Babel plugin runs, over a React Native project's source, without running it. For coding agents and CI.

```sh
npx keyframer-inspect lint [paths…] [--root .] [--json] [--severity info] [--fail-on error]
```

| Flag | Default | |
|---|---|---|
| `paths` | the whole root | Files or folders under the root |
| `--root <dir>` | `.` | The project root: paths in findings are relative to it, and the installed Reanimated and React Compiler are read from it |
| `--json` | | `{ files, unreadable, issues, motion }`: `issues` are the worklet crashes, `motion` the motion findings |
| `--severity info, warning or error` | `info` | The least severe motion finding listed |
| `--fail-on error, warning or info` | `error` | The least severe motion finding that fails the run |

`node_modules`, build output and native folders are skipped, and so are files that touch none of Reanimated, worklets, Gesture Handler or the React Native APIs the checks read.

Exit codes: 0 nothing to fail on, 1 a worklet crash or a motion finding at `--fail-on` or above, 2 bad arguments.

The MCP server has the same as a tool, `lint_project` (see [MCP server](../agents/mcp-server.md#static-checks)).

## keyframer-inspect symbolicate

```sh
npx keyframer-inspect symbolicate glitch.kfrec.json --map index.android.bundle.map [--out file]
```

Writes `glitch.symbolicated.kfrec.json` by default, with files and lines in every stack. Use the source map of the exact build that made the recording.

## Join a pairing room

For the Keyframer editor's Inspector panel. Run it from the project root:

```sh
npx keyframer-inspect --code ABC234 --root .
```

| Flag | Default | |
|---|---|---|
| `--code <code>` | | The 6-character code the editor shows |
| `--api <url>` | `https://api.keyframer.dev` | Another API, such as `http://localhost:8787` |
| `--root <dir>` | `.` | Where edits are written; the Babel plugin's root |

"Apply to code" in the editor sends the tuned values, and it rewrites only those number literals. On "Open as nodes" it sends the source files the editor asks for. See [Privacy](privacy.md#pairing-rooms).
