---
title: iOS (SwiftUI and UIKit)
description: Add the KeyframerVitals Swift product, start it in release builds, name SwiftUI screens and animations, and upload dSYMs.
order: 3
section: Motion Vitals
---

# Motion Vitals for iOS

`KeyframerVitals` is the production reporter for iOS, a library product of the same Swift package as the inspector. It is meant for release builds and never depends on `KeyframerInspector`. It works with UIKit and SwiftUI.

You need iOS 15 or later.

## 1. Add the package

```swift
// Package.swift, or Xcode: File > Add Package Dependencies
.package(url: "https://github.com/keyframer-dev/inspector", from: "0.2.0")
// target dependency
.product(name: "KeyframerVitals", package: "inspector")
```

Keep `KeyframerInspector` behind `#if DEBUG` as before. `KeyframerVitals` goes in every build.

## 2. Start it

Early, in the App's `init` or `application(_:didFinishLaunchingWithOptions:)`, on the main thread:

```swift
import KeyframerVitals

KeyframerVitals.start(key: "kfp_live_7Hq2xR…")
```

Reporting starts at `start`. If your app asks for consent first, call it after: see [Consent and privacy](consent.md).

| Parameter | Default | What it does |
|---|---|---|
| `key` | required | The project's field key, `kfp_live_…`. Any other key is refused |
| `appVersion`, `build` | `CFBundleShortVersionString`, `CFBundleVersion` | The version the dashboard groups by |
| `environment` | `.production` in release builds | Debug builds report nothing unless you pass `.development`; their reports land in an environment the dashboard hides by default |
| `sampleRate` | `0.1` | The share of sessions that report, until the project's settings say otherwise |
| `endpoint` | `https://vitals.keyframer.dev` | The ingest server |

`start` returns `false` when it did not start: a key that is not a field key, a debug build without `environment`, or a second call.

## 3. Name animations

UIKit and Core Animation animations are seen without code changes (`UIView.animate`, property animators, `CABasicAnimation` and the rest). Release binaries are stripped, so without help each one is reported at a code address; upload your dSYMs (see [Symbols](symbols.md#ios)) and the dashboard turns addresses into functions, files and lines. Or name the ones you care about, which works with or without symbols:

```swift
KeyframerVitals.trace("badge-pop") {
  UIView.animate(withDuration: 0.3) { badge.transform = .identity }
}
```

SwiftUI runs its animations itself, so SwiftUI animations are only seen when you name them. Wrap the change:

```swift
KeyframerVitals.trace("card-expand", duration: 0.4) {
  withAnimation(.spring) { expanded.toggle() }
}
```

Or put a modifier on the value an animation drives:

```swift
CardView(expanded: expanded)
  .vitalsTrace("card-expand", value: expanded)
```

For SwiftUI, each change opens a motion window of `duration` seconds (0.5 by default) charged to the name. Without either, frames are still counted per screen, with no site.

## 4. Screens

UIKit screens are named after the view controller type that appeared. SwiftUI screens hosted in one controller need names:

```swift
FeedView().vitalsScreen("Feed")
// or anywhere:
KeyframerVitals.setScreen("Checkout")
```

Names are masked (ids, emails, long numbers, tokens) and cut to 64 characters before they leave the device.

## 5. Stop or pause reporting

```swift
KeyframerVitals.setEnabled(false)   // stops now, and drops the open window, checkpoints and unsent reports
KeyframerVitals.setEnabled(true)    // starts again, as a new session
```

The choice is kept in memory only: call it on every launch your app needs it.

## How it measures

- A `CADisplayLink` runs only inside motion windows: from a Core Animation animation's start to its end, from a touch to 1.5 s after it, and for traced SwiftUI changes. It asks for 60 Hz and accepts more, so it never raises the display's rate it is measuring.
- It sees main-thread hitches. Hitches in the render server are out of reach for any in-app SDK.
- Device details: the model identifier (`iPhone15,3`), Low Power Mode, thermal state, Reduce Motion (only if the project collects it), and the screen's maximum rate.
- 120 Hz: an app without `CADisableMinimumFrameDurationOnPhone = YES` runs at 60 Hz on ProMotion iPhones, and its frames are counted against 60 Hz, as they should be.
- Uploads run in a background task when the app goes to the background. The cached config, the daily count, checkpoints and unsent reports live in `UserDefaults`.

## Privacy manifest

The SDK ships its own `PrivacyInfo.xcprivacy`, which Xcode merges into your app's privacy report. What it declares, and what to answer in App Store Connect, is in [App Store and Google Play answers](store-privacy.md).

## Check that it works

1. Run a Release configuration on a device or simulator (or a Debug build with `environment: .development`, if the project accepts development builds).
2. Pass `sampleRate: 1` in that build (or raise the project's rate) so the session is sampled.
3. Animate something, then send the app to the background.
4. The project's setup page shows the first report within a few minutes.
