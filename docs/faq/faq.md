---
title: FAQ
description: Short answers to common questions about setup, numbers, platforms and limits.
order: 1
section: FAQ
---

# FAQ

## Do I need the desktop app?

Not for React Native: the panel opens inside Expo's dev tools (press shift+m in Metro), and `npx keyframer-inspect mcp` and `ci` find Metro on their own. Flutter, iOS and Android apps connect to the desktop app's relay.

## Do I need a Keyframer account?

No, for local use. You need one for pairing rooms (cloud simulators, device farms, the Keyframer editor) and for share links.

## Does it ship in my release build?

No. The Babel plugin is added in development only, iOS does nothing in release unless you allow it, Android release builds link a no-op artifact, and Flutter's widget is a plain `RepaintBoundary` in release. You can opt in for internal preview builds.

## Does it work in Expo Go?

Yes. It is JavaScript only, with no native module and no config plugin.

## The panel shows no values. Why?

- **React Native:** the Babel plugin is not in the build. Check `babel.config.js`, that it runs before `react-native-worklets/plugin`, and restart Metro.
- **Flutter:** values appear as controllers are created. Use `KfAnimationController`, or `kfTrack` on a controller you already have.
- **iOS:** layers appear once something on screen animates.
- **Android:** register animators with `kfTrack`, or other values with `Keyframer.signal`.

## Why are my frame times so high?

A debug build runs extra checks, so its frames are slower than a release build's. The problems are real; the milliseconds are not a release build's. `ci` doubles its frame slack for debug builds and says so.

## Why does CI flag problems on unchanged code?

Usually a loop or a component that keeps rendering on a screen the stack keeps mounted underneath. Run loops only while their screen is focused. Also record the baseline on the same kind of machine CI runs on.

## Why does a check say a value "did not move"?

The flow ran but the value never changed. Often the last run left the screen changed (a sheet left open), so the next tap did nothing. End each flow where it began.

## Can I slow down the simulator instead of using set_time?

Do not, for measuring. The simulator's slow animations slow everything, the inspector does not know, and the frame numbers are wrong. `set_time` slows the app on its own clock and every metric is read on that clock.

## Does Apply to code change my formatting?

No. It rewrites only the changed number literals. Formatting and comments stay, and files outside the project are refused.

## Does an iOS app report frames on the render thread?

No. The render server is another process and out of reach, so only the main thread is measured. Android's RenderThread is not measured yet either.

## What are the known limits?

- SwiftUI: animations not wrapped with the trace are not seen, traced values cannot be played back, and pause and step reach Core Animation only.
- Android: `ViewPropertyAnimator` and Transitions are not held when paused; Compose transitions are read only.
- Flutter: `AnimatedSwitcher`, `AnimatedCrossFade` and `AnimatedSize` are not tracked.
- Argent as a CI driver is unit tested, not run end to end yet. Expo's cloud simulators are untested.
- React Native Web is not checked end to end.
- agent-device's iOS runner needs a simulator on a current iOS: with Xcode 27, an iOS 18 simulator cannot start it.
- React Native cannot read an Android emulator's AVD name or an iOS simulator's model from JavaScript.
- The pairing room changes (`kf_` keys for CI and agents, late editors getting the app's hello and speed) need the API deployed.

## Where do I report a bug?

In the public repository's issues: [keyframer-dev/inspector](https://github.com/keyframer-dev/inspector/issues), for any platform, the desktop app and the npm package.

## What is the license?

The SDKs and everything that runs in your app are MIT. The npm package's tools (the `keyframer-inspect` CLI with MCP, `ci` and `fix`, the panel and the dev tools server) are under FSL-1.1-MIT: use them for anything except a competing product; each version becomes MIT two years after its release. The desktop app is free.
