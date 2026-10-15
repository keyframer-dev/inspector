# Keyframer Inspector example (React Native)

An Expo app with the inspector installed, and screens that animate the way real apps do: entrance
springs, a collapsing header, a bottom sheet on a pan gesture, a carousel, long presses, CSS
animations, and a glitch lab that drops frames on purpose (a blocked JS thread, a render storm, a busy
UI thread, errors). Record any of them, scrub the recording, and see what each animation cost and why
frames dropped.

## Run it

```bash
npm install
npx expo start          # then i (iOS simulator), a (Android emulator) or w (web)
```

Then connect it one of two ways, in `.env.local` (restart Metro after changing it):

- **Expo dev tools** (nothing to set): press **shift+m** in Metro and open **@keyframerdev/inspector**.
- **The desktop app**, Keyframer Inspector (download it from this repository's Releases):
  `EXPO_PUBLIC_INSPECTOR_RELAY=http://127.0.0.1:8790`. On a physical device, use the Mac's LAN address
  the app shows in its status bar.

## What is set up

- `babel.config.js` adds `@keyframerdev/inspector/babel` in development, which records every Reanimated
  call with the file and line it was written on. `babel-preset-expo` adds the worklets plugin after
  it, which is the order the inspector needs.
- `inspector.ts` connects (`connectDevTools` or `connectInspector`) and registers a replay, so the panel
  can run a screen's animations again.
- `components/scenarios.ts` names a scenario per screen, so the panel (and coding agents over MCP) can
  run one and measure it: the glitch lab's scenarios are the ones that should come back with problems.
