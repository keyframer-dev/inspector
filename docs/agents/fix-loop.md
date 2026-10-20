---
title: Fix loop
description: Let an agent fix motion problems and check every fix by measuring again, with check, recheck or keyframer-inspect fix.
order: 2
section: Coding agents
---

# Fix loop

The inspector can drive a coding agent through fixing what it finds, and check every fix by measuring again. There are three ways in: the MCP prompt, the two MCP tools it uses, and the `keyframer-inspect fix` command.

## The prompt

`fix-motion-problems` walks the agent through the loop: `check`, take the top problem, open its `where`, change the code, let Fast Refresh (or hot reload, or a rebuild) apply it, `recheck`, repeat. In Claude Code:

```text
/mcp__keyframer-inspector__fix-motion-problems
```

It stops when recheck says done, after 2 rounds without progress, or after `maxRounds` (5). Its rules: never delete or disable an animation to make a problem go away, and never touch the inspector's own setup. Arguments: `scenarios`, `recording`, `maxRounds`.

## The tools

`check` measures the app and keeps the result as the loop's baseline: the app's scenarios (all, or `scenarios`), or a recording (`recording`: a `.kfrec.json`, or `current` for the last one). It returns the problems ranked, each with a ref (`P1`...), `where`, evidence, the fix, how it will be verified, and the motion that must keep working.

`recheck` measures the same thing the same way and returns:

| Result | Meaning |
|---|---|
| Fixed | Gone, and its animations still start and its values still move |
| Still there | Not fixed |
| New | Appeared since `check` |
| Removed | Gone because its animation or value stopped: not a fix |
| Not verifiable | No way to measure it again, with why |

It also returns the numbers before and after, and `done: true` or `false` with the reason.

```json
{ "name": "check", "arguments": { "scenarios": ["sheet: open"], "runs": 3 } }
```

## The command

`keyframer-inspect fix` runs the whole loop with Claude Code or Codex, without a person at the keyboard:

```sh
npx keyframer-inspect fix --agent claude --scenario "glitch lab: block the JS thread" --max-rounds 3
npx keyframer-inspect fix --agent codex --recording .keyframer/recordings/x.kfrec.json --map main.map
npx keyframer-inspect fix --agent claude --relay ws://127.0.0.1:8790 --rebuild "flutter build ios --simulator && ..."
```

Each round it checks, hands the agent a prompt with the problems, waits (`--wait`, 3 s, for Fast Refresh, or runs `--rebuild` and waits for the app to reconnect), and rechecks. It ends with a summary and `git diff --stat`.

- Claude Code runs as `claude -p` with Read, Edit, Write, Glob and Grep only, and `--permission-mode acceptEdits`. `--allow-bash` adds the shell.
- Codex runs as `codex exec --sandbox workspace-write`: it has a shell inside its sandbox (the project only, no network).
- `--agent-cmd "<cmd>"` runs any other agent: the prompt arrives on stdin and in `$KEYFRAMER_FIX_PROMPT_FILE`.

Exit codes: 0 done, 1 not done, 2 a setup error. All flags are in the [CLI reference](../reference/cli.md#keyframer-inspect-fix).

Metro must watch files for a change to reach the app: `CI=1 npx expo start` turns watching off, so a fix loop against it measures the old code forever.

## Checking a recording

A recording's problems are read straight from the file. Each is then verified the best way there is, and never claimed further:

1. A registered scenario that reproduces it is measured and re-run by recheck.
2. Otherwise, for UI-thread, rendering and layout problems, the recording is played back into the app while recording again. Playback writes values and presses nothing, so a handler that blocked the app thread does not run again.
3. Otherwise it is Not verifiable. A loop can be done with problems left Not verifiable: it says so, and they are for a person to check.

When problems have no scenario, `check` offers a stub (`scenarioStub`, or `--save-scenario`): the screen the recording opened on and each gesture with the handler it ran, in order. A recording does not know testIDs: the TODOs say which views need one.

## Guards

- **Removed, not fixed.** A problem counts as Fixed only when its animations still start and its values still move. If they stopped, it is Removed, which keeps `done` false and goes back to the agent first.
- **Noise.** Every measurement is `ci`'s: the median of N runs, problems seen in at least half the runs, one warm-up run thrown away, and a reload before each scenario.
- **Build type.** A debug build's frame slack is doubled.
- **Its own setup.** `fix` stops when the agent changes the inspector's setup: its imports, `connectDevTools`, `registerScenario`, the Babel config, `.keyframer/`.
- **Review.** `fix` never commits, pushes or branches. It prints the diff stat and says to review it.
