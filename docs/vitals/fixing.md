---
title: From a problem to a fix
description: Read a field problem, reproduce it with the inspector on a matching device, fix it, and let the next release confirm it.
order: 10
section: Motion Vitals
---

# From a problem to a fix

Motion Vitals says where and on what. The [inspector](../introduction/overview.md) says why, and checks the fix on your device. The next release's numbers confirm it on your users' devices.

## 1. Read the problem

A problem page (`SHOP-12`) has:

- the call site (`app/feed.tsx:42:9 withSpring`, or a `trace` name), its component and screen;
- its drop rate while it runs, and the screen's baseline without it;
- where it hurts most: OS, device tier and models, side by side ("smooth on high, 14% dropped on low");
- the causes of its worst frames (40% `screen-mount`, 30% `burst`…);
- the version it started in, and its trend.

## 2. Hand it to your agent

**Copy for your agent** on the problem page gives a prompt with all of that, for a coding agent with the inspector's [MCP server](../agents/mcp-server.md):

> Field problem SHOP-12 in Acme Shop 2.4.1: withSpring (scale) in FeedCard at app/feed.tsx:42:9, on the Feed screen, drops 9.1% of frames while it runs on Android (the screen's baseline is 1.2%), and 14.2% on low-tier devices. Its worst frames come mostly right after a screen mounts (62%).

The agent can also read field problems itself. Give the MCP server a key in its environment: `KEYFRAMER_VITALS_READ_KEY` set to a workspace read key (`kfw_…`, from Motion Vitals, Keys) or your `kf_` API key. Then:

| Tool | Arguments | Returns |
| --- | --- | --- |
| `field_problems` | `project` (the code, `SHOP`, or the id), `version`, `os`, `status` (default `unresolved`, or `all`), `limit` (default 5) | The top problems, most frames lost first: where, drop rate against the screen's baseline, devices, causes, status, the check command and the prompt |
| `field_compare` | `project`, `from`, `to` (default the latest version against the one before it) | Hitch time, slow and frozen frames, janky sessions, and each problem call site as Worse, Came back, New, Still there, Better, Fixed or Ignored |
| `check` | `field: "SHOP-12"`, with `scenarios` or `recording` as usual | The fix loop's check, then whether that call site dropped frames here |

## 3. Reproduce on a matching device

Field jank on low-tier phones often does not happen on a fast simulator. Use a device of the tier the problem names, with a development build and the inspector connected, and run the check with the field problem:

```sh
keyframer-inspect check --field SHOP-12                     # the app's scenarios
keyframer-inspect check --field SHOP-12 --scenario "open feed"
keyframer-inspect check --field SHOP-12 --recording .keyframer/recordings/feed.kfrec.json
```

(The same key, `KEYFRAMER_VITALS_READ_KEY`, in the shell.) It prints the problem, the check's report, and one of:

- **Reproduced**: the local problems at that call site that dropped frames, by ref (`P2`). Fix them with the [fix loop](../agents/fix-loop.md): change the code, `recheck`.
- **Not reproduced**, the site ran and dropped no frames: try a slower device, the tier the problem names.
- **Not reproduced**, the site did not run: check a scenario or a recording that runs it.

For a [restart storm](index.md#restart-storms), **Reproduced** means the check found a local `restart-storm` at that call site (it counts without lost frames of its own). It shows on any device: run a scenario that scrolls or drags on its screen the way people do.

It never claims more than that. Field sites match local ones by file and line on React Native, and by the `trace`, `kfTrack` or controller name on native.

What the field causes point at:

- `screen-mount`: the frame ended within 500 ms of a navigation. Defer work and animations until the transition is done.
- `burst`: six or more animations started together. Stagger them, or animate a container.
- `busy-start` (React Native): an animation started while the JS thread was busy. Start it from a worklet, or move the work.
- `scroll` and `gesture`: frames dropped while scrolling or touching. Look at what renders per frame.

The inspector's [problems pages](../problems/index.md) explain each kind with fixes per framework.

## 4. Ship, and let the numbers decide

Mark the problem **Resolving** when the fix is in a release. When the next version has enough sessions, the problem becomes **Fixed** if its drop rate is back near its screen's baseline, or goes back to open if not. If it ever returns, it is **Came back**, and the rule of that name alerts you.

The Versions page compares any two versions: every site and screen as Fixed, Still there, New or Worse, with the margin of error. `field_compare` gives an agent the same comparison.
