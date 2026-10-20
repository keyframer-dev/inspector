---
title: Privacy
description: What stays on your machine, what leaves it, and when.
order: 4
section: Reference
---

# Privacy

By default nothing leaves your machine. Data leaves it only when you use a pairing room or a share link, and the desktop app checks for updates.

## What stays local

| Connection | Where data goes |
|---|---|
| Expo dev tools (Metro) | Metro's own connection on your machine. No code to pair |
| The desktop relay | `ws://127.0.0.1:8790` on your machine, or your LAN for devices |
| The MCP server | `127.0.0.1` only. Requests from web pages, or with a foreign `Origin` or `Host`, are refused |
| Recordings | Your project's `.keyframer/recordings/` (git-ignored by default) or the desktop app's library folder |

The relay's editor endpoints, the panel and the library listing refuse other machines, and editor sockets refuse web pages from other origins. Uploading a recording to the relay is accepted from devices on the network but refused from web pages elsewhere.

Recordings can hold screenshots. Keep them out of git; the library inside a project's `.keyframer` folder gets a `.gitignore` that does this.

## Device names

The app's hello and its recordings say which device it runs on, so tools can tell two apps apart. Simulators and emulators send a name and an id. A physical device sends its model only (`iPhone17,1`, `Google Pixel 8`), never the name its owner gave it, since recordings get shared. On iOS, the simulator's folder path is read on the device but never sent: it holds the Mac's user name.

## Pairing rooms

A pairing room on `https://api.keyframer.dev` relays messages between an app, editors and `keyframer-inspect`. Use it for an app this machine cannot reach (a cloud simulator, a device farm) or for the Keyframer editor.

- Editors must be signed in. A room belongs to the first account that opens it as an editor; other accounts are refused. The claim lapses 24 hours after its owner leaves.
- The app and the CLI need only the code.
- The room drops messages over 256 KB.

`keyframer-inspect --code` writes the editor's edits to disk and sends source files the editor asks for on "Open as nodes":

- only `.ts`, `.tsx`, `.js` and `.jsx` files under `--root` (real paths, so a symlink cannot reach outside it);
- up to 200 KB each;
- only to the room's editor.

Nothing else in the project, such as `.env` or keys, is read.

## Share links

Share uploads a recording to your Keyframer account and gives you a `keyframer.dev/r/<id>` link that opens it read-only. Before anything leaves your machine it is redacted:

- log messages masked: emails, long numbers, tokens, secrets in URLs;
- navigation params dropped;
- screenshots downscaled;
- the focused text input blurred.

The dialog shows what goes, and lets you change it. Links expire after 30 days by default.

On the device, a tester's recorder can offer "Share link":

```ts
configureRecorder({ shareLinks: { token: () => SecureStore.getItemAsync('keyframer-token') } })
```

A `kf_` key built into an app is readable by anyone who has the build and can do everything its account can. Use one only in internal builds, or fetch it from your own backend for the person who is signed in.

## Desktop app updates

The desktop app reads `latest.json` from the public repository's latest release, without credentials, 10 seconds after launch and every six hours while "Update automatically" is on. Updates are signed, and one that does not verify is refused.

## Simulator agents

`DO_NOT_TRACK=1` is set when `ci` runs Argent.

## Release builds

The SDKs are for development builds. React Native builds without the Babel plugin have nothing to report. iOS does nothing in release unless allowed. Android release builds link a no-op. Flutter's widget is a plain `RepaintBoundary` in release unless enabled.
