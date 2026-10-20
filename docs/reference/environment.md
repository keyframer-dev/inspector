---
title: Environment variables
description: Every environment variable the CLI, the desktop app and the SDKs read.
order: 2
section: Reference
---

# Environment variables

## keyframer-inspect

| Variable | Read by | |
|---|---|---|
| `KEYFRAMER_METRO_URL` | `mcp`, `ci` | The Metro the app is on, when `--metro` is not given |
| `KEYFRAMER_RELAY_URL` | `mcp`, `ci` | The desktop relay, when neither `--relay` nor a Metro URL is given |
| `KEYFRAMER_TOKEN` | `mcp --code` | A Keyframer session token or a `kf_` API key, so a pairing room lets it in at once |
| `KEYFRAMER_API_URL` | `mcp --code`, `--code` | Another Keyframer API, when `--api` is not given |
| `KEYFRAMER_DEBUG` | `ci` | `1` prints what each check run did and when |
| `KEYFRAMER_FIX_PROMPT_FILE` | set by `fix` | The prompt file, for an agent run with `--agent-cmd` |

```sh
KEYFRAMER_RELAY_URL=ws://127.0.0.1:8790 npx keyframer-inspect ci
```

## Desktop app

| Variable | Default | |
|---|---|---|
| `KEYFRAMER_RELAY_PORT` | `8790` | The relay's port. Wins over the port set in Settings |
| `KEYFRAMER_LIBRARY` | the platform's library folder | The recordings folder |
| `KEYFRAMER_CONFIG_DIR` | the platform's settings folder | Where `settings.json` and the log live. A copy with its own folder runs beside the installed one |

## React Native builds

| Variable | |
|---|---|
| `KEYFRAMER_INSPECTOR` | `1` keeps the Babel plugin in a non-development build, when your `babel.config.js` reads it (the preview build pattern) |

## iOS

Set in the scheme's environment. They win over code.

| Variable | |
|---|---|
| `KEYFRAMER_INSPECTOR_HOST` | The relay's host |
| `KEYFRAMER_INSPECTOR_PORT` | The relay's port |
| `KEYFRAMER_INSPECTOR` | `0` off, `1` on (even in release) |

## Android

Gradle properties at build time:

| Property | |
|---|---|
| `-Pkeyframer.host=<LAN IP>` | The relay's host on a device (also add it to `network_security_config.xml`) |
| `-Pkeyframer.port=<port>` | The relay's port |

## Flutter

Dart defines at build time:

| Define | |
|---|---|
| `--dart-define=KEYFRAMER_HOST=<ip>` | The relay's host |
| `--dart-define=KEYFRAMER_PORT=<port>` | The relay's port |
| `--dart-define=KEYFRAMER_INSPECTOR=true` | Connect in a release build too |
