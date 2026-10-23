---
title: Keyframer Inspector docs
description: Set up the motion debugger, read what it finds, and run it from coding agents and CI.
order: 0
section: Overview
---

# Keyframer Inspector docs

Keyframer Inspector is a motion debugger for apps. It records every animation in a running app with the line of code that started it, measures what each one cost, and lets you scrub the recording like a video while the real app follows.

It works with React Native, Flutter, iOS (UIKit and SwiftUI) and Android (Views and Jetpack Compose).

## Start here

| I want to | Read |
|---|---|
| Know what it does and how | [Overview](introduction/overview.md), [How it works](introduction/how-it-works.md) |
| Install it, on any platform | [Installation](getting-started/index.md) |
| Set it up in a React Native or Expo app with one command | [@keyframerdev/wizard](getting-started/wizard.md) |
| Add it to a React Native or Expo app by hand | [React Native and Expo](getting-started/react-native.md) |
| Add it to an iOS app | [iOS](getting-started/ios.md) |
| Add it to an Android app | [Android](getting-started/android.md) |
| Add it to a Flutter app | [Flutter](getting-started/flutter.md) |
| Install the desktop app | [Desktop app](getting-started/desktop.md) |
| Record and scrub | [Recording and scrubbing](panel/recording.md) |
| Understand a problem it reported | [Problems](problems/index.md) |
| Catch worklet crashes and motion mistakes in React Native code before it runs | [Static checks](problems/static-checks.md) |
| Fail a pull request on a motion regression | [Running in CI](ci/running.md) |
| Let a coding agent use it | [MCP server](agents/mcp-server.md), [Agent skills](agents/skills.md) |
| Look up a command or a variable | [CLI](reference/cli.md), [Environment variables](reference/environment.md) |
| Know what leaves my machine | [Privacy](reference/privacy.md) |
| See slow frames from my users' phones in production | [Motion Vitals](vitals/index.md) |
| Answer the App Store and Google Play privacy forms for Motion Vitals | [App Store and Google Play answers](vitals/store-privacy.md) |

## The pieces

- **SDKs** that go into your app, in development builds: the npm package `@keyframerdev/inspector` (React Native), the Swift package `KeyframerInspector`, the Maven artifacts `dev.keyframer:*`, and the Dart package `keyframer_inspector`.
- **The panel**, where you record, scrub, read problems and tune numbers. React Native apps can open it inside Expo's dev tools. Every platform can open it inside the desktop app.
- **The desktop app**, Keyframer Inspector, which hosts the local relay the native SDKs connect to, the panel, a recordings library and an MCP server.
- **The `keyframer-inspect` command**, from the npm package: an MCP server, `ci`, `fix`, `lint` and `symbolicate`.
- **Motion Vitals**, for production: small MIT reporters that go into store builds (`@keyframerdev/vitals`, `KeyframerVitals`, `dev.keyframer:vitals`, `keyframer_vitals`) and a dashboard on keyframer.dev that groups slow frames by screen, animation, version and device. See [Motion Vitals](vitals/index.md).

## Status

Version 0.2.0 is being prepared and is not published yet. Where a feature has known limits, the page says so. The full list is in the [FAQ](faq/faq.md#what-are-the-known-limits).
