---
title: Recordings library
description: Where recordings are kept, how to save, rename and open them, and how testers record on the device.
order: 5
section: The panel
---

# Recordings library

A recording is a `.kfrec.json` file. It holds every animated value, both threads' frame rates and long frames, every animation with its source line and stack, React commits, touches, screen changes, app state, the keyboard, warnings and errors, and (from the device recorder) a screenshot every 1.5 s.

## Where it lives

| Where the panel runs | Library |
|---|---|
| Expo dev tools (Metro) | `.keyframer/recordings/` in your project, git-ignored by default |
| Desktop app, macOS | `~/Library/Application Support/dev.keyframer.inspector/recordings` |
| Desktop app, Windows | `%APPDATA%\dev.keyframer.inspector\recordings` |
| Desktop app, Linux | `~/.local/share/dev.keyframer.inspector/recordings` |

`KEYFRAMER_LIBRARY` moves the desktop app's folder.

## Kept automatically

Every recording is kept when it stops: the panel's, and an agent's (`record`, `run_scenario`, `stop_recording`). Only the newest 20 automatic ones stay by default. Change it in the panel's Open menu (Keep automatically) or in the desktop app's Settings, Recordings: a number, Off, or Keep all. Recordings you save or rename are never deleted.

## Save, rename, delete

- **Save** keeps a recording for good. Saving one the library already has keeps that copy instead of writing a second one.
- **Rename** with F2 in the Open menu. The title is kept as typed, and the file is renamed to its slug: `Sheet opens twice (#12)` becomes `sheet-opens-twice-12.kfrec.json`.
- **Delete** from the Open menu, after a confirmation in the menu.

A recording is recognized by what it recorded, not its file name, so the same recording is never stored twice.

## Open a recording

- In the panel: the Open menu, or drop a file anywhere on the panel.
- In the desktop app: double click a `.kfrec` file, Open With, or drag it onto the window.
- From an agent: `open_recording`. For a recording from a preview build, pass its source map:

```json
{ "name": "open_recording", "arguments": { "path": "glitch.kfrec.json", "sourceMap": "index.android.bundle.map" } }
```

## Recording on the device

React Native only. Give testers a record button: they tap it, use the app, tap again, and send one file or a link.

```tsx
import { isInstrumented, MotionScan } from '@keyframerdev/inspector/scan'
import { shareRecording } from '@keyframerdev/inspector/expo-share' // npx expo install expo-file-system expo-sharing

<MotionScan enabled={isInstrumented()} recorder={{ app: 'MyApp', share: shareRecording }}>
  <App />
</MotionScan>
```

- While Metro runs, a copy is saved under `.keyframer/recordings/` and the panel's Open menu lists it. With the panel open, it also lands there directly.
- `shareOnlyWithoutMetro: true` skips the share sheet when Metro is running, so it only shows for testers.
- `corner="bottom-left"` (or any corner) moves Motion Scan's pill.
- Without Motion Scan, use `startRecording()`, `stopRecording(note?)` and `configureRecorder()` from `@keyframerdev/inspector/record`.

## Preview builds for testers

Keep the plugin in an internal build with an environment variable:

```js
// babel.config.js
module.exports = function (api) {
  api.cache.using(() => `${process.env.NODE_ENV}:${process.env.KEYFRAMER_INSPECTOR}`)
  const inspect = process.env.NODE_ENV !== 'production' || process.env.KEYFRAMER_INSPECTOR === '1'
  return { presets: ['babel-preset-expo'], plugins: inspect ? ['@keyframerdev/inspector/babel'] : [] }
}
```

```json
{ "build": { "preview": { "distribution": "internal", "env": { "KEYFRAMER_INSPECTOR": "1" } } } }
```

That goes in `eas.json`: only the preview profile carries it, so store builds never do. `isInstrumented()` is true only when the plugin is in the build.

A recording made without Metro keeps its JS stacks raw. Map them with the source map of that exact build:

```sh
npx keyframer-inspect symbolicate glitch.kfrec.json --map index.android.bundle.map
```

With Hermes, use the map the native build composes: on Android `android/app/build/generated/sourcemaps/react/release/index.android.bundle.map`, on iOS the file `SOURCEMAP_FILE` names in the "Bundle React Native code and images" phase.
