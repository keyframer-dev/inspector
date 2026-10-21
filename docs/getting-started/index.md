---
title: Installation
description: Install the Inspector and Motion Vitals on every platform, with one command for React Native and Expo, plus the desktop app and the agent plugin.
order: 0
section: Getting started
---

# Installation

## React Native and Expo: one command

In your app's folder:

```sh
npx @keyframerdev/wizard
```

[@keyframerdev/wizard](wizard.md) installs the Inspector and Motion Vitals, adds the Babel plugins, wires your navigation, shows every change as a diff before writing it, and waits for your app's first message to prove it works. To do it by hand instead: [React Native and Expo](react-native.md).

## The Inspector, by platform

The Inspector is for development: record, scrub and find dropped frames.

| Platform | Install | Guide |
|---|---|---|
| React Native and Expo | `npx @keyframerdev/wizard`, or `npm i -D @keyframerdev/inspector` | [React Native and Expo](react-native.md) |
| iOS (UIKit, SwiftUI) | Swift Package Manager: `https://github.com/keyframer-dev/inspector` | [iOS](ios.md) |
| Android (Views, Compose) | `debugImplementation("dev.keyframer:keyframer-inspector:<version>")` | [Android](android.md) |
| Flutter | `flutter pub add keyframer_inspector` | [Flutter](flutter.md) |

## Motion Vitals, by platform

Motion Vitals reports slow frames and janky animations from production builds. It needs a project's field key from [keyframer.dev/app/vitals](https://keyframer.dev/app/vitals) (the wizard finds it for you in React Native and Expo apps).

| Platform | Install | Guide |
|---|---|---|
| React Native and Expo | `npx @keyframerdev/wizard --products vitals`, or `npm i @keyframerdev/vitals` | [React Native](../vitals/react-native.md) |
| iOS | Swift Package Manager: `https://github.com/keyframer-dev/inspector`, product `KeyframerVitals` | [iOS](../vitals/ios.md) |
| Android | `implementation("dev.keyframer:vitals:<version>")` and the `dev.keyframer.vitals` Gradle plugin | [Android](../vitals/android.md) |
| Flutter | `flutter pub add keyframer_vitals` | [Flutter](../vitals/flutter.md) |

## The desktop app

Keyframer Inspector for macOS, Windows and Linux: the relay native apps connect to, a recordings library, and an MCP server for agents. Download it from the [latest release](https://github.com/keyframer-dev/inspector/releases/latest). React Native apps can skip it and use the panel in Expo's dev tools. See [Desktop app](desktop.md).

## Coding agents

In Claude Code, the plugin adds the MCP server and the skills:

```sh
/plugin marketplace add keyframer-dev/inspector
/plugin install keyframer-inspector@keyframer
```

Cursor and other MCP clients: see [MCP server](../agents/mcp-server.md). The wizard can write the config for Claude Code and Cursor too.

## Versions

Each guide names the current version of its package. The desktop app's builds are on [GitHub Releases](https://github.com/keyframer-dev/inspector/releases).
