# Keyframer Inspector plugin

Give your coding agent eyes for motion. This plugin connects Claude Code or Cursor to the
[Keyframer Inspector](https://keyframer.dev/inspector) MCP server and adds five skills, so the agent can
record a running app, slow it down to 0.1x and step it frame by frame, read the motion problems ranked by
the frames they cost, fix them in your code, prove the fix with a before and after, and keep it fixed in CI.

It works with React Native and Expo, Flutter, iOS (UIKit and SwiftUI) and Android (Views and Compose),
on simulators, emulators and devices.

## Install

**Claude Code**

```text
/plugin marketplace add keyframer-dev/inspector
/plugin install keyframer-inspector@keyframer
```

**Cursor**: install Keyframer Inspector from the Cursor Marketplace, or add this repository's
`plugins/keyframer-inspector` folder as a local plugin.

The MCP server runs with `npx -y @keyframerdev/inspector mcp`, so it needs Node 20.10 or later. In a
project that has `@keyframerdev/inspector` installed, npx uses that copy.

## What you get

| Skill | Use it to |
|---|---|
| `keyframer-inspector-setup` | Install the inspector in an app and check that it connects |
| `keyframer-inspector-motion` | Debug an animation: reproduce, record, read the problems, fix, compare |
| `keyframer-inspector-fix` | Fix one reported problem in the right framework, then verify it |
| `keyframer-inspector-ci` | Write check files and run `keyframer-inspect ci` on pull requests |
| `keyframer-vitals` | Set up Motion Vitals, upload symbols, and fix a production field problem |

The MCP server gives the agent 21 tools, among them `inspector_status`, `record`, `run_scenario`,
`compare`, `set_time` (slow motion, pause, step), `capture_frame`, `check` and `recheck`. The full list
is in the [MCP server docs](https://keyframer.dev/inspector/docs/agents/mcp-server).

Try: "The card expand on the Feed screen stutters. Record it, find why, and fix it."

## Motion Vitals

`field_problems` and `field_compare` read your production slow frames from
[Motion Vitals](https://keyframer.dev/vitals). They need a read key in the environment the editor
starts from: `KEYFRAMER_VITALS_READ_KEY` (a `kfw_` workspace read key, from Motion Vitals, Keys). Every
other tool works without one.

## Privacy

The server runs on your machine and talks to your app over your local network or the desktop app's
relay. Nothing is sent to Keyframer unless you use the Motion Vitals tools or a pairing room for a cloud
simulator. The plugin's code is MIT.
