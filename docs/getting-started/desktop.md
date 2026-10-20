---
title: Desktop app
description: Install Keyframer Inspector, connect apps to its relay, and turn on its MCP server.
order: 5
section: Getting started
---

# Desktop app

Keyframer Inspector is the desktop app every SDK connects to. It hosts the local relay, the same panel Expo's dev tools show, a recordings library, and an MCP server for coding agents. It is free.

## Install

Download it from the [Releases](https://github.com/keyframer-dev/inspector/releases/latest) of the public repository.

| | macOS | Windows | Linux |
|---|---|---|---|
| Installer | DMG, universal (Apple silicon and Intel), signed and notarized | NSIS `-setup.exe`, x64, per user, not code signed | AppImage and `.deb`, x64 |
| With no window | the menu bar | the tray | the tray (GNOME needs the AppIndicator extension) |
| Settings and library | `~/Library/Application Support/dev.keyframer.inspector` | `%APPDATA%\dev.keyframer.inspector` | `~/.config/dev.keyframer.inspector`, recordings in `~/.local/share/dev.keyframer.inspector/recordings` |

> The Windows installer is not code signed, so SmartScreen warns on first run.

## Connect an app

The relay listens on `ws://127.0.0.1:8790`, on every interface, so a phone on the same network reaches it at the address the status bar shows (`Devices: ws://<lan ip>:8790/app`).

- iOS, Android and Flutter SDKs connect to it by default. See [iOS](ios.md), [Android](android.md), [Flutter](flutter.md).
- React Native apps point `connectInspector` at it. See [React Native](react-native.md#use-the-desktop-app-instead).

Several apps can be connected at once. The panel's header switches between them, and the window title names the app or counts them. When an app reloads, the panel waits for an app with the same name and platform instead of jumping to another one.

## Check that it works

- The status bar shows the relay and the connected app.
- The menu bar (or tray) menu lists the connected apps; click one to show it.

## Turn on the MCP server

Open Settings (Cmd+, on macOS, or the gear in the status bar, or the menu bar or tray menu), go to MCP Server and turn it on. It serves `http://127.0.0.1:8789/mcp`. "Auto-start on launch" starts it with the app. Settings shows the setup for each client. For Claude Code:

```sh
claude mcp add --transport http keyframer-inspector http://127.0.0.1:8789/mcp
```

Clients that launch a command, such as Claude Desktop, run the app over stdio:

```sh
"/Applications/Keyframer Inspector.app/Contents/MacOS/keyframer-inspector" --mcp-stdio
```

See [MCP server](../agents/mcp-server.md) for the tools.

## Settings

- Launch at login.
- The relay port. `KEYFRAMER_RELAY_PORT` wins over it.
- The library, and how many recordings it keeps automatically.
- The editor used for "Open in editor".
- The MCP server, its port, and the setup steps per client.

## Recordings

The library is a folder of `.kfrec.json` files. Double click, Open With, or drop a file on the window to open it. `.kfrec` is the app's own file type on macOS; a `.kfrec.json` opens in your default JSON app on double click, so use Open With or drag it onto the window. See [Recordings library](../panel/library.md).

Links of the form `keyframer-inspector://open?url=<recording url>` (the web viewer's "Open in desktop app") download a recording and show it. Only https on keyframer.dev, or this machine.

## Updates

A release build checks 10 seconds after launch and every six hours while "Update automatically" is on (Settings, About). A newer version downloads in the background, then installs when you choose "Restart to Update" or when you quit. Updates are signed; an archive that does not verify is refused.

## Environment variables

| Variable | Default | |
|---|---|---|
| `KEYFRAMER_RELAY_PORT` | `8790` | The relay's port. Apps must use the same one |
| `KEYFRAMER_LIBRARY` | the library folder above | The recordings folder |
| `KEYFRAMER_CONFIG_DIR` | the settings folder above | Where `settings.json` and the log `keyframer-inspector.log` live |

The log records the relay's start and end, peers dropped for not reading, and panics, which stderr does not show for an app opened from Finder.
