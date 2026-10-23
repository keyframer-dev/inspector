---
title: Motion Vitals
description: Slow frames and janky animations from your users' phones, grouped by screen, animation and app version.
order: 1
section: Motion Vitals
---

# Motion Vitals

Motion Vitals measures how smoothly your app moves in production, on your users' devices. It counts slow and frozen frames per screen and per animation, groups them by app version, OS and device class, and tells you which animations got worse in a release, which ones a fix really fixed, and on which phones they hurt most.

It works with React Native, iOS (SwiftUI and UIKit), Android (Compose and Views) and Flutter. The dashboard is at [keyframer.dev/app/vitals](https://keyframer.dev/app/vitals).

## How it differs from the inspector

The inspector and Motion Vitals answer different questions, and they are built to be used together.

| | Keyframer Inspector | Motion Vitals |
|---|---|---|
| Runs in | Development builds, on your simulator or test device | Store builds, on your users' devices |
| Records | Every animation, value and frame, with screenshots, as a recording you can scrub | Counters only: frame histograms per screen and per animation, and the 5 worst frames of a session with a cause |
| Tells you | Why a frame was slow, and whether your fix works on your device | Where frames are slow in the field, on which devices, since which version, and whether a release fixed it |
| Package | `@keyframerdev/inspector`, `KeyframerInspector`, `dev.keyframer:keyframer-inspector`, `keyframer_inspector` | `@keyframerdev/vitals`, `KeyframerVitals`, `dev.keyframer:vitals`, `keyframer_vitals` |
| License and price | MIT, free | MIT SDKs; the service is priced by sessions a month, with a free step |

The usual loop: Motion Vitals finds a problem (`SHOP-12: withSpring on Feed drops 9% of frames on low-tier Android since 2.4.1`), you reproduce and fix it with the inspector on a matching device, and the next version's numbers confirm it as Fixed. See [From a problem to a fix](fixing.md).

## What a report holds

One report per session window (a foreground period of up to 10 minutes). About 1 to 3 KB gzipped:

- frame counts per screen and thread, in eight buckets of frames missed, with hitch time and frozen frames;
- per animation call site: runs, time running, frames drawn and missed while it ran, worst frame;
- the 5 worst frames, what was moving in them and a cause (`screen-mount`, `burst`, `scroll`…);
- app version and build, OS and major version, device model and class, display rate, low power and thermal state.

Never screenshots, text, values, touches, identifiers or timestamps from the device. The full list is in [Consent and privacy](consent.md).

## The numbers

- **Hitch time**: milliseconds late per second of motion, Apple's hitch time ratio. Under 5 is good, 5 to 10 a warning, over 10 critical.
- **Slow frames**: the share of frames that missed at least one refresh of the display.
- **Frozen frames**: frames of 700 ms or more, per 1,000 sessions (Android vitals' definition).
- **Janky sessions**: sessions with over 10 ms/s of hitch time on any screen.

Each frame is counted against the rate the app runs at (60, 90 or 120 Hz), so devices with different screens add up.

## Problems

An animation call site becomes a problem when it drops clearly more frames while it runs than its screen does without it: at least 50 sessions, 1.5 times its screen's baseline, one point of drop rate above it, and 500 frames attributable. Problems get an id per project (`SHOP-12`) and a status:

| Status | Means |
|---|---|
| New | First seen in the latest version |
| Came back | Was fixed, and is a problem again in a later version |
| Worse | Its drop rate went up since the previous version, beyond the margin of error |
| Ongoing | Still there |
| Resolving | Someone marked it resolved; the next version with enough sessions decides |
| Fixed | A problem in the previous version, not in the latest one |
| Ignored | Someone ignored it; it never alerts |

Problems are ranked by frames attributable: the frames dropped above the screen's baseline while the animation ran. A spinner that runs the whole time a screen is open does not rise to the top just for being there. The dashboard says "dropped while this ran", never "caused".

### Restart storms

A second kind of problem, shown as **Restart storm**: one call site starting its animation again on nearly every frame in several views at once, so it never gets to play (a spring loses its velocity, a repeat starts again). It is usually `withSpring` or `withRepeat` inside a row's `useAnimatedStyle` that reads the scroll position. It is the inspector's [restart storm](../problems/frames.md#restart-storm), measured in the field: more than 3 starts a frame while it runs, over 60 frames a session or more on average, in at least 50 sessions. A list's rows each starting once as they mount last a few frames and do not count, and neither do layout animations (`entering`, `exiting`, `layout`) or one view following a value (one start a frame). Of calls nested on the same property (`withRepeat(withTiming(…))`), only the outermost is one.

Restart storms are information for now: they get an id, a status and a page like any problem, and the next version confirms them fixed, but they never alert and stay out of the digest and Needs attention. A call site can be both kinds at once, under two ids. Its page charts starts a frame per day against the line of 3.

## Set it up

In a React Native or Expo app, `npx @keyframerdev/wizard --products vitals` does steps 1 and 2 for you, and waits for the first session: see [@keyframerdev/wizard](../getting-started/wizard.md).

1. Create a project at [keyframer.dev/app/vitals](https://keyframer.dev/app/vitals), pick its platform and copy its field key (`kfp_live_…`). The key is public: it can only send reports to that project.
2. Add the SDK: [React Native](react-native.md), [iOS](ios.md), [Android](android.md) or [Flutter](flutter.md).
3. Decide when reporting starts: [Consent and privacy](consent.md), and fill in the [store privacy answers](store-privacy.md).
4. Upload symbols for native and Flutter release builds, so call sites have names: [Symbols](symbols.md).
5. Ship a release build. The project page shows the first report a few minutes after a sampled session goes to the background.

## Pages in this section

- [React Native](react-native.md), [iOS](ios.md), [Android](android.md), [Flutter](flutter.md)
- [Consent and privacy](consent.md)
- [App Store and Google Play answers](store-privacy.md)
- [Symbols](symbols.md)
- [Alerts, Slack and webhooks](alerts.md)
- [From a problem to a fix](fixing.md)
- [Pricing and sampling](pricing.md)
- [Retention and limits](limits.md)
