---
title: How it works
description: How apps, the relay, the panel, the MCP server and CI connect.
order: 2
section: Introduction
---

# How it works

An SDK inside the app reports what moves. A panel, an MCP server or a CI run connects as an editor and asks the app to record, play back, capture a frame or change its speed. Every message is JSON in one shared [protocol](../reference/protocol.md).

## The three ways to connect

| Connection | Who uses it | Address |
|---|---|---|
| Metro (Expo dev tools) | React Native in development | Metro's own connection, ports 8081 to 8090 |
| The desktop relay | Flutter, iOS, Android, and React Native if you choose | `ws://127.0.0.1:8790` |
| A pairing room | An app this machine cannot reach, such as a cloud simulator or a device farm | `https://api.keyframer.dev` with a 6-character code |

Over Metro, nothing leaves your machine and there is no code to pair. The desktop relay is also local. A pairing room goes through Keyframer's API and needs a signed-in Keyframer account.

## The relay

The desktop app runs a relay on `ws://127.0.0.1:8790`. Apps connect to `/app?name=<app name>&platform=<os>`, and panels and CLIs connect to `/editor`. Several apps can be connected at once. The panel has an app picker, and each app keeps its own timeline.

- Simulators and macOS apps use localhost.
- The Android emulator reaches the Mac at `10.0.2.2:8790`, which is the SDK default. `adb reverse tcp:8790 tcp:8790` also works.
- Physical devices use the Mac's LAN address, which the desktop app shows in its status bar.

## What an app reports

Each app starts with a `hello` that says what it is: its framework, OS version, SDK, display rate, Reduce Motion setting, the device it runs on, and its capabilities (capture, playback, scrub, overrides, replay, reload, scenarios, time). Tools only offer what an app says it can do.

Then it reports:

- **Values** (signals): shared values on React Native, animation controllers on Flutter, layer properties on iOS, animators on Android. They are sampled every frame while recording.
- **Animations**: each start, with its call site, its parameters and how long it runs.
- **Frames**: frame rates and long frames on two threads, named by role.
- **Markers**: touches, screen changes, app state, the keyboard, logs, display and Reduce Motion changes, visibility, and speed changes.
- **Render hints**: what the SDK saw about how a moving view is drawn.

## Two threads, by role

`js` is the app thread and `ui` the frame thread.

| Framework | `js` | `ui` |
|---|---|---|
| React Native | JS | UI |
| Flutter | UI isolate | Raster |
| iOS (UIKit, SwiftUI) | Main | not measured (the render server is out of reach) |
| Android (Views, Compose) | Main | not measured yet (RenderThread) |

## From a recording to problems

The recording is read by an analysis core that the panel, the MCP server and `ci` share. It traces each long frame to what ran in it, groups drops with the same cause into one problem, ranks problems by the frames they cost, and words each fix for the app's framework. See [Problems](../problems/index.md).

Frame budgets follow the display: a frame is 8.3 ms at 120 Hz. Durations are read on the app's own clock, so an animation recorded at a quarter of the speed is measured at its real length.
