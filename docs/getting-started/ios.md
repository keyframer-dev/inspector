---
title: iOS (UIKit and SwiftUI)
description: Add the Swift package, start it in debug builds, and trace SwiftUI values.
order: 2
section: Getting started
---

# iOS (UIKit and SwiftUI)

`KeyframerInspector` is a Swift package. In UIKit it sees every Core Animation animation without code changes: `UIView.animate`, `UIViewPropertyAnimator`, `UIView.animateKeyframes` and hand-built `CABasicAnimation`, `CASpringAnimation` and `CAKeyframeAnimation`. SwiftUI is opt-in, per value, through a second product.

You need Xcode 16 or later and iOS 15 or later, and the [desktop app](desktop.md) running.

## 1. Add the package

```swift
// Package.swift, or Xcode: File > Add Package Dependencies
.package(url: "https://github.com/keyframer-dev/inspector", from: "0.1.0")
```

## 2. Start it

Once the first window is up (in the SceneDelegate, or the App's init for a UIKit-hosted app):

```swift
import KeyframerInspector

#if DEBUG
KeyframerInspector.start()                              // simulator: ws://127.0.0.1:8790
KeyframerInspector.start(.init(host: "192.168.1.20"))   // a device: the Mac's LAN address
#endif
```

It connects to `ws://<host>:8790/app?name=<app name>&platform=ios`, sends its hello, and reconnects on its own. Release builds do nothing unless you pass `allowInRelease: true`.

The environment wins over code: `KEYFRAMER_INSPECTOR_HOST`, `KEYFRAMER_INSPECTOR_PORT`, and `KEYFRAMER_INSPECTOR=0` (off) or `1` (on, even in release). Set them in the scheme's environment.

## 3. A physical device

Add these to the app's Info.plist:

- `NSLocalNetworkUsageDescription`
- `NSAppTransportSecurity` with `NSAllowsLocalNetworking = YES`, for plain `ws://`
- `CADisableMinimumFrameDurationOnPhone = YES`, for 120 Hz frame measurements on ProMotion iPhones (without it, frames are counted against 60 Hz)

## Check that it works

- The desktop app's status bar shows your app as connected.
- Animate something on screen. Layers show up in the panel's Values list as soon as something animates.
- Record, then drag the playhead: Core Animation's own timeline follows.

## Exact call sites with trace

Native frames carry no line numbers at runtime, so an animation without help is reported at its function (`closure #1 in CardsViewController.bounce()`). Wrap it in `trace` for the exact file, line and column:

```swift
KeyframerInspector.trace("card") {
  UIView.animate(withDuration: 0.4) { card.center.y -= 120 }
}
```

## The rest of the API

| Call | What it does |
|---|---|
| `start(_:)` and `stop()` | Connect and watch, or stop and hand every layer back |
| `trace("card") { ... }` | Animations started inside get this exact call site and target name |
| `track(view, as: "card")` | Records a view the app moves itself (a drag setting `center`) |
| `registerScenario("bounce") { ... }` | An interaction the panel or an agent can run |
| `tap("bounce")` | Fires the control with that accessibility identifier, for scenarios |
| `registerReplay { ... }` | What replay runs |
| `registerNavigator { route, params in ... }` | How playback reaches a recorded screen (a route is the view controller's type name) |
| `note(_:)` | A note marker on the recording |

## SwiftUI

SwiftUI runs its animations itself and has no public hook that sees every one, so it is opt-in per value. Add the second product:

```swift
.product(name: "KeyframerInspectorSwiftUI", package: "inspector")
```

Then use `withKeyframerAnimation` where you would use `withAnimation`, and trace the values you want to see:

```swift
import KeyframerInspectorSwiftUI

withKeyframerAnimation(.spring(response: 0.5, dampingFraction: 0.6)) { cardOffset = -120 }

RoundedRectangle(cornerRadius: 24)
    .offset(y: cardOffset)
    .keyframerTrace("card", value: cardOffset)
```

- Put `.keyframerTrace` before the `.animation` modifiers that animate the same value, so it sees their animation.
- In a list, give each row its own name: `"card#\(index)"`.
- With the inspector off or in a release build, `withKeyframerAnimation` is `withAnimation`.

Without the module you still get frames, touches, scenarios, navigation markers for `UIHostingController`s, and time control for whatever SwiftUI hands to Core Animation.

## Limits

- No `ui` thread: the render server is another process. A hitch there while the main thread is idle is not seen.
- Slow motion does not reach SwiftUI's own animations (except traced ones), `UIScrollView` deceleration, UIKit Dynamics, or the app's own display links and timers.
- SwiftUI: values outside a trace are not seen; traced values cannot be played back; pause and step reach Core Animation only; `keyframeAnimator`, `phaseAnimator`, `matchedGeometryEffect` and `NavigationStack` paths are not covered.
- `covered` visibility (another screen on top) is not detected; a pushed screen shows as `detached`.
- No device recordings, no React-style commits or tasks.
