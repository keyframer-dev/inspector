---
title: React Native and Expo
description: Add @keyframerdev/vitals to a React Native or Expo app, name screens, and get call sites with file and line in release builds.
order: 2
section: Motion Vitals
---

# Motion Vitals for React Native and Expo

`@keyframerdev/vitals` is the production reporter for React Native. It is its own MIT package, separate from `@keyframerdev/inspector`, small, and safe for store builds: it never connects to Metro or a relay, never changes an animation, and does no work while nothing moves.

You need Reanimated 4 with `react-native-worklets`. It works in Expo apps, Expo Go included: JavaScript only, no native module, no config plugin.

## Set up with the wizard

In your app's folder:

```sh
npx @keyframerdev/wizard --products vitals
```

It finds your project's field key (sign in through the browser, or paste it), installs the package, adds the Babel plugin, starts the reporter with your navigation ref so screens are named, and waits for the first session. Every change is shown as a diff before it is written. With the key already in hand, it asks nothing:

```sh
npx @keyframerdev/wizard --yes --products vitals --key kfp_live_7Hq2xR…
```

[@keyframerdev/wizard](../getting-started/wizard.md) has every step, option and message. The steps below are what it does, by hand.

## 1. Install

```sh
npm i @keyframerdev/vitals
```

It is a regular dependency, not a dev dependency: it ships in your release build.

## 2. Start it

At the app's entry:

```ts
import { startVitals } from '@keyframerdev/vitals'
import AsyncStorage from '@react-native-async-storage/async-storage'
import Constants from 'expo-constants'
import { Platform } from 'react-native'

const build = Platform.OS === 'ios' ? Constants.platform?.ios?.buildNumber : Constants.expoConfig?.android?.versionCode

startVitals({
  key: 'kfp_live_7Hq2xR…',                            // the project's field key
  appVersion: Constants.expoConfig?.version ?? '0',
  build: build == null ? undefined : String(build),
  navigationRef,                                      // screen names from React Navigation or expo-router
  storage: AsyncStorage,                              // optional: checkpoints, retries, the daily cap
})
```

Reporting starts at `startVitals`. Until then nothing is measured or sent. If your app asks for consent first, call it after: see [Consent and privacy](consent.md).

Version and build come from `expo-constants`, which every Expo app already has. `expo-application` gives the same numbers, but it is a native module: added to an app that ships EAS Updates, the update crashes every installed binary built without it. Use it only once your binaries include it. On iOS the build number is the binary's own; on Android it is `android.versionCode` from your app config, and `build` is optional, so without one reports group by version alone. Without Expo, take both from `react-native-device-info` (`getVersion()` and `getBuildNumber()`) or your own constants.

| Option | Default | What it does |
|---|---|---|
| `key` | required | The project's field key, `kfp_live_…` |
| `appVersion` | required | The version people see (`2.4.1`). Versions are how the dashboard compares releases |
| `build` | none | The build number (`812`) |
| `environment` | `'development'` when `__DEV__`, else `'production'` | Development reports show in the dashboard's Development view, and only while the project keeps development builds (its setup's "Development builds" switch). When it does not, a development build says so once in the log and sends nothing |
| `sampleRate` | `0.1` | The share of sessions that report. Release builds use it until the project's settings arrive, then the project's rate. Development builds always use it, and report every session when you leave it out (no daily cap either: someone is testing) |
| `navigationRef` | none | A React Navigation `createNavigationContainerRef()` or expo-router `useNavigationContainerRef()`: screens are named from its routes |
| `screenName` | the route's name | `(route) => string`, to name routes yourself (still masked) |
| `storage` | none | Anything with `getItem`, `setItem` and `removeItem` (AsyncStorage, an MMKV wrapper). Without it, nothing is kept between launches: no checkpoints, no retries after a restart, and the 3-a-day cap counts one launch only |
| `device` | none | Device details the app reads itself (below) |
| `appId` | none | The bundle id or package name |
| `endpoint` | `https://vitals.keyframer.dev` | The ingest server |
| `debug` | `false` | Logs what the SDK decides, measures and sends: the session and its sampling, frames a second per thread, each report against the server's limits. Lines are tagged `[Keyframer.dev]` and go through `console.debug`, so Metro shows them as `DEBUG` (a note for you, such as development builds being off, is `INFO`; a refused report is `WARN`). For development builds |

`startVitals` is safe to call again with new options.

## 3. Call sites with file and line

Add the Babel plugin. It tags each Reanimated animation (and layout animations and animated scroll handlers) with where it is written, so the dashboard shows `app/feed.tsx:42:9 withSpring` instead of only the screen.

```js
// babel.config.js
module.exports = function (api) {
  api.cache.using(() => process.env.NODE_ENV)
  const dev = process.env.NODE_ENV !== 'production'
  return {
    presets: ['babel-preset-expo'],
    plugins: [...(dev ? ['@keyframerdev/inspector/babel'] : []), '@keyframerdev/vitals/babel'],
  }
}
```

It can sit beside the inspector's development plugin, in any order: with both in a build, each sees every animation. The release plugin adds one pass-through call per site and nothing else: no handler, effect, commit or worklet timing, no values. Without it, the reporter still counts frames per screen, with no call sites. Dependencies in `node_modules` are left alone unless you pass `includeNodeModules: true`.

Restart Metro with a clean cache after changing Babel: `npx expo start -c`.

An Expo app with no `babel.config.js` yet, installed with pnpm or Bun's isolated linker, cannot reach the `babel-preset-expo` that comes with `expo` from a new config file. Add it as your own dev dependency first: `npx expo install babel-preset-expo -- --dev`.

### Hide file paths

Call sites are your source locations, not data about the people using the app, so they are sent as written. If you would rather not ship relative file paths in your bundle, hash them:

```js
['@keyframerdev/vitals/babel', { hashSites: true, salt: 'kfp_live_7Hq2xR…' }]
```

Each site becomes a 12-character id, and the build writes `.keyframer/sites-<version>+<build>.json` (version and build from `KEYFRAMER_APP_VERSION` and `KEYFRAMER_APP_BUILD`, else `app.json`, else `package.json`). Babel only sees files it transforms, so the manifest is complete only after a build with a clean cache (`--reset-cache`, or `expo export -c`). Upload it and the dashboard names the sites for your team only: see [Symbols](symbols.md#react-native).

## 4. Screens

With `navigationRef`, each route name is a screen (`users/[id]` with expo-router). Elsewhere, name screens yourself:

```ts
import { setVitalsScreen } from '@keyframerdev/vitals'

setVitalsScreen('Checkout')
```

Before a screen name leaves the device, ids, emails, long numbers and tokens are masked (`/users/42` becomes `/users/[number]`), and it is cut to 64 characters.

## 5. Touches and lists (optional)

Wrap the app in `VitalsRoot` and touches open motion windows, so a list without scroll handlers is measured while it scrolls. It only listens: it never takes the touch and reads no coordinates.

```tsx
import { VitalsRoot } from '@keyframerdev/vitals'

export default function App() {
  return <VitalsRoot>{/* your app */}</VitalsRoot>
}
```

## 6. Device details (optional)

Plain React Native cannot read the device model, memory or display rate from JavaScript. Pass them from `expo-device` when you have it, and the dashboard can show tiers and models:

```ts
import * as Device from 'expo-device'
import { Platform } from 'react-native'

startVitals({
  // ...
  device: { model: Platform.OS === 'ios' ? Device.modelId : Device.modelName, memoryBytes: Device.totalMemory },
})
```

`device` also takes `memoryGb`, `tier` (`'low' | 'mid' | 'high'`) and `displayHz`.

## 7. Stop or pause reporting

```ts
import { setVitalsEnabled } from '@keyframerdev/vitals'

setVitalsEnabled(false)   // stops now, and drops the open window, the checkpoint and unsent reports
setVitalsEnabled(true)    // starts again with the options of startVitals, as a new session
```

The choice is not remembered: call it on every launch your app needs it.

## Check that it works

1. Build a release build (`eas build --profile production`, or `npx expo run:ios --configuration Release`).
2. To be sure the session is sampled while testing, pass `sampleRate: 1` in that build, or raise the project's rate in its settings.
3. Use the app for a few seconds, animate something, then send it to the background.
4. The project's setup page shows the first report within a few minutes.

Testing in a development build instead: turn on "Development builds" in the project's setup, reload, and the reports show in the dashboard's Development view. Debug builds run slower than release builds, so use them to check the setup, not to judge performance.

## Before your store release

The reporter is JavaScript inside your app, so it ships no privacy manifest of its own: the stores' privacy forms are yours to fill in.

- **App Store**: in App Privacy, Diagnostics > Performance Data, not linked to the user, not used for tracking.
- **Google Play**: in Data safety, App info and performance > Diagnostics.
- **Your privacy policy**: one sentence, [ready to adapt](consent.md#a-sentence-for-your-privacy-policy).

Every answer, field by field: [App Store and Google Play answers](store-privacy.md).

## What it costs on the device

No loop or timer runs while nothing moves. Frame meters run only inside motion windows (from an animation's start to its end, from a touch to 1.5 s after it, while a scroll handler fires), plus 250 ms. One request per sampled session window, sent when the app goes to the background, 4 to 8 KB of plain JSON (Hermes cannot gzip).
