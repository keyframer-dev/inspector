---
title: iOS (UIKit and SwiftUI)
description: Add the Swift package, start it in debug builds, and trace SwiftUI values.
order: 2
section: Getting started
---

# iOS (UIKit and SwiftUI)

`KeyframerInspector` is a Swift package. In UIKit it sees every Core Animation animation without code changes: `UIView.animate`, `UIViewPropertyAnimator`, `UIView.animateKeyframes` and hand-built `CABasicAnimation`, `CASpringAnimation` and `CAKeyframeAnimation`. SwiftUI is opt-in, per value, through a second product.

You need Xcode 16.3 or later (the package uses Swift tools 6.1) and iOS 15 or later, and the [desktop app](desktop.md) running.

## 1. Add the package

```swift
// Package.swift, or Xcode: File > Add Package Dependencies
.package(url: "https://github.com/keyframer-dev/inspector", from: "0.3.0")
```

## 2. Start it

Once the first window is up (in the SceneDelegate, or the App's init for a UIKit-hosted app):

```swift
import KeyframerInspector

KeyframerInspector.start(.init(onlyWhenAsked: true))    // only when launched with -keyframer YES
```

It connects to `ws://<host>:8790/app?name=<app name>&platform=ios`, sends its hello, and reconnects on its own.

Start it only when asked: the inspector costs the app something while it runs, and a debug build is also what goes on people's own phones. With `onlyWhenAsked: true` it starts when the launch asks for it, through launch arguments (the scheme's Arguments, `xcrun simctl launch`, `xcrun devicectl device process launch`) or the environment, which wins over them:

| Launch argument | Environment | |
|---|---|---|
| `-keyframer YES` (`NO`) | `KEYFRAMER_INSPECTOR=1` (`0`) | On, or off whatever the code says |
| `-keyframerHost 192.168.1.20` | `KEYFRAMER_INSPECTOR_HOST` | The relay's host (asks for it too) |
| `-keyframerPort 18797` | `KEYFRAMER_INSPECTOR_PORT` | The relay's port |
| `-keyframerSystem YES` | `KEYFRAMER_INSPECTOR_SYSTEM=1` | Report UIKit's own animations too |

Release builds compile the inspector out: the same API doing nothing, and none of its code in the binary, so the calls can stay without `#if DEBUG`. To measure an optimized build, turn on the package's `ReleaseBuilds` trait; it then starts with `allowInRelease: true` or `KEYFRAMER_INSPECTOR=1`.

## 3. A physical device

- The host is the Mac's address on the same network: the desktop app's status bar shows it, and a click copies the launch argument (`-keyframerHost 192.168.1.20`).
- `NSLocalNetworkUsageDescription`, for debug runs only: set `INFOPLIST_KEY_NSLocalNetworkUsageDescription` in the Debug configuration's build settings, and the shipping Info.plist stays as it is.
- No App Transport Security exception is needed for `ws://` to an IP address. `NSAllowsLocalNetworking` is for host names (the Mac's `.local` name).
- `CADisableMinimumFrameDurationOnPhone = YES`, for 120 Hz frame measurements on ProMotion iPhones (without it, frames are counted against 60 Hz).

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
| `registerNavigator { route, params in ... }` | How playback reaches a recorded screen (a route is the view controller's type name, or a `.keyframerScreen` name) |
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

SettingsView().keyframerScreen("Settings")
```

- Put `.keyframerTrace` before the `.animation` modifiers that animate the same value, so it sees their animation.
- In a list, give each row its own name: `"card#\(index)"`.
- While recording, what a `withKeyframerAnimation` moves on screen is recorded even when nothing is traced: the layers SwiftUI moved become signals of that call site (`SidePage.NavigationStack/position.x`), and its event points at the first of them.
- Name your screens with `.keyframerScreen`: a SwiftUI app lives in one hosting controller, so recordings otherwise only know `App`. The route is the latest named screen still shown; when it goes, the one under it.
- A helper of yours that wraps `.keyframerTrace` or `withKeyframerAnimation` should pass its caller's `file`, `filePath`, `line` and `column` on, or every signal is named after the helper's file. `owner:` names the component instead.
- With the inspector off, `withKeyframerAnimation` is `withAnimation`; in a release build all of it is compiled out.

Without the module you still get frames, touches, scenarios, navigation markers for hosting controllers (`App` for the window's root), and time control for whatever SwiftUI hands to Core Animation.

## Limits

- No `ui` thread: the render server is another process. A hitch there while the main thread is idle is not seen.
- Slow motion does not reach SwiftUI's own animations (except traced ones), `UIScrollView` deceleration, UIKit Dynamics, or the app's own display links and timers.
- SwiftUI: values outside a trace are seen only as the layers a `withKeyframerAnimation` moved (not a plain `withAnimation` or an implicit `.animation`); traced values cannot be played back; pause and step reach Core Animation only; `keyframeAnimator`, `phaseAnimator`, `matchedGeometryEffect` and screens not named with `.keyframerScreen` are not covered.
- `covered` visibility (another screen on top) is not detected; a pushed screen shows as `detached`.
- No device recordings, no React-style commits or tasks.
