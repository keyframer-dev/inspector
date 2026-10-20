---
title: React Native and Expo
description: Add the Babel plugin, connect the app, and open the panel in Expo's dev tools or the desktop app.
order: 1
section: Getting started
---

# React Native and Expo

The npm package `@keyframerdev/inspector` has a development-only Babel plugin that tags every Reanimated animation, shared value, gesture callback and handler with where it is written, and a runtime that reports it. With nothing connected, the instrumented calls are a straight pass-through.

You need Reanimated 4 with `react-native-worklets`, and Node 22 or later for the `keyframer-inspect` command. It works in Expo Go: JavaScript only, no native module, no config plugin.

## 1. Install

```sh
npm i -D @keyframerdev/inspector
```

## 2. Add the Babel plugin

It must run before `react-native-worklets/plugin`, and only in development.

Expo. `babel-preset-expo` adds the worklets plugin itself, after yours:

```js
// babel.config.js
module.exports = function (api) {
  api.cache.using(() => process.env.NODE_ENV)
  const dev = process.env.NODE_ENV !== 'production'
  return {
    presets: ['babel-preset-expo'],
    plugins: dev ? ['@keyframerdev/inspector/babel'] : [],
  }
}
```

A new Expo app has no `babel.config.js`, and `babel-preset-expo` is only installed inside `expo`. Install it at the top level when you add the file, or Metro fails to start with `Cannot read properties of undefined (reading 'transformFile')`:

```sh
npx expo install -- --save-dev babel-preset-expo
```

Bare React Native. List the worklets plugin yourself, last:

```js
// babel.config.js
module.exports = function (api) {
  const dev = api.env('development')
  return {
    presets: ['module:@react-native/babel-preset'],
    plugins: [...(dev ? ['@keyframerdev/inspector/babel'] : []), 'react-native-worklets/plugin'],
  }
}
```

Call site ids are file paths relative to Babel's `cwd`, the project root. To use another root, pass it:

```js
plugins: [['@keyframerdev/inspector/babel', { root: '/abs/path' }]]
```

## 3. Connect

In your root layout, in development only:

```ts
if (__DEV__) {
  const { connectDevTools, registerReplay } = require('@keyframerdev/inspector/devtools')
  connectDevTools({ app: 'MyApp' })
  // Optional: what Replay runs (re-mount a screen, re-fire an entrance).
  registerReplay(() => setReplayKey((k) => k + 1))
}
```

## 4. Open the panel

Start Metro, press **shift+m** and open **@keyframerdev/inspector**. Expo finds the panel through the package's `expo-module.config.json`, so restart Metro after installing.

## Check that it works

- The panel's header names your app, with its framework and OS.
- The Values list fills with your shared values once their components render. If it says "No shared values yet", the Babel plugin is not in the build: check `babel.config.js` and restart Metro with a clean cache.
- Press **Record**, use the app, press it again, then drag the playhead. The app should follow.

## Use the desktop app instead

Point `connectInspector` at the desktop app's relay. The example app does it with an environment variable:

```ts
if (__DEV__) {
  const { connectInspector, registerReplay } = require('@keyframerdev/inspector/native')
  connectInspector({ apiUrl: 'http://127.0.0.1:8790', code: 'DESKTOP', app: 'MyApp' })
  registerReplay(() => setReplayKey((k) => k + 1))
}
```

On a physical device, use the Mac's LAN address the desktop app shows in its status bar. On an Android emulator, `adb reverse` maps Metro's and the relay's ports.

## Optional setup

### Screen capture

GIF and MP4 export, captured frames and the device recorder's screenshots use what the app has installed: `react-native-view-shot` (it ships in Expo Go), else Skia (`@shopify/react-native-skia` in a development build) drawing the view inside `<MotionScan>`. Pass `captureScreen` to `connectDevTools` or `connectInspector` to choose one, or `captureScreen: null` to turn capture off.

```sh
npx expo install react-native-view-shot
```

### Screen changes

Track your navigation container so playback, scrubbing and export go back to the screen that was open:

```ts
import { trackNavigation } from '@keyframerdev/inspector/record'
trackNavigation(navigationRef) // React Navigation's ref, or expo-router's useNavigationContainerRef()
```

### Scenarios

A scenario is an interaction the app can replay on demand, so a problem can be reproduced and a fix checked. It opens its screen and presses the same buttons a person would, found by `testID`:

```ts
import { press, registerScenario, waitForTestId } from '@keyframerdev/inspector/devtools'
import { router } from 'expo-router'

registerScenario('glitch lab: block the JS thread', async () => {
  router.navigate('/glitches')
  await waitForTestId('glitch-block-js')
  press('glitch-block-js')
})
```

`fire(testID, 'onValueChange', true)` calls any other handler. The panel's **Run scenario** menu, the MCP server and `ci` all run them.

### Device name

The app's hello says which device it runs on. Installing `expo-device` (Expo Go always has it) adds a simulator's name and a phone's model. A physical device never sends the name its owner gave it. Pass `device` to `connectInspector` to say it yourself.

### A record button for testers

See [Recording on the device](../panel/library.md#recording-on-the-device).

## Limits

- React Native cannot read an Android emulator's AVD name or an iOS simulator's model identifier from JavaScript.
- React Native Web is not checked end to end.
- A debug build's frame times are inflated: the problems are real, the milliseconds are not a release build's.
