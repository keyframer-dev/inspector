---
title: Flutter
description: Add the Dart package, wrap the app, and swap AnimationController for KfAnimationController.
order: 4
section: Getting started
---

# Flutter

`keyframer_inspector` reports a Flutter app's animated values and animations with their call sites, samples values every frame while recording, and measures frames on the UI and raster threads. Implicit animations and Hero flights are found on their own.

You need Flutter 3.29 or later. It runs on iOS, Android, macOS, Windows, Linux and the web, with the [desktop app](desktop.md) running.

## 1. Add the package

```yaml
# pubspec.yaml
dependencies:
  keyframer_inspector: ^0.3.0
```

## 2. Wrap the app

```dart
import 'package:keyframer_inspector/keyframer_inspector.dart';

void main() => runApp(const KeyframerInspector(
      app: 'My app',
      appPackage: 'my_app', // your pubspec name: call sites read lib/x.dart
      child: MyApp(),
    ));
```

`KeyframerInspector` connects in debug and profile builds and is a plain `RepaintBoundary` in release. `--dart-define=KEYFRAMER_INSPECTOR=true` turns it on in any build, and `=false` off in any build (no connection, and controllers capture no call sites). `enabled:` decides over both.

### Start it only when asked

The inspector costs the app something while it runs (every animation start takes its call stack, printed between frames, and a recording samples every frame), and a debug build is also what people install on their own phone. Put `--dart-define=KEYFRAMER_INSPECTOR=false` in your run configuration by default, or pass `enabled:` from a flag of your own.

## 3. Add the navigator observer and rename controllers

```dart
MaterialApp(navigatorObservers: [kfNavigatorObserver], routes: {...});

// AnimationController( becomes KfAnimationController(
late final card = KfAnimationController(vsync: this, duration: const Duration(milliseconds: 400), name: 'card');
```

That is all the app needs. Optional:

- `controller.kfTrack('name')` for a controller you do not construct (call `kfUntrack()` in dispose).
- `valueNotifier.kfTrack('name')` for a `ValueNotifier<double>`, such as a drag offset.
- `registerReplay(() => ...)` for what the panel's replay runs.
- `registerScenario('drag card', () async {...})` for an interaction an editor or agent can run.

Name the screens the navigator cannot name (a page pushed without a name, a tab, a pager's page, a custom router's screen):

```dart
KeyframerScreen(name: 'Settings', child: SettingsPage()) // the screen while it is shown
KeyframerInspector.setScreen('Feed')                     // from code, such as a pager's onPageChanged
```

The latest `KeyframerScreen` still shown names the screen. When it goes, the one under it does again, else the navigator's page. A pager that keeps its pages alive has them all mounted, so name its pages with `setScreen` from `onPageChanged`. A nested navigator (a tab's own stack) needs a `KfNavigatorObserver()` of its own: one observer watches one navigator.

## 4. Reach the relay

- Simulators and desktop apps use localhost.
- The Android emulator reaches the Mac at `10.0.2.2`, the default on Android.
- A physical device uses the Mac's LAN address: `flutter run --dart-define=KEYFRAMER_HOST=192.168.1.20`.
- On the web, the page connects to the relay on the host it was served from when that is this machine or the local network, else 127.0.0.1.
- `--dart-define=KEYFRAMER_PORT=<port>` moves it off 8790.

```sh
flutter run --dart-define=KEYFRAMER_HOST=192.168.1.20
```

Allow local networking on iOS (`Info.plist`), cleartext on Android (the debug manifest), and outgoing connections on macOS (entitlements), as the example app does.

## Check that it works

- The desktop app's status bar shows your app as connected.
- Your `KfAnimationController`s appear in the panel's Values list as they are created.
- Implicit animations need widget creation tracking. It is on in `flutter run`, `flutter test` and `flutter build apk|macos --debug`, and off in `flutter build ios --debug`. Without it, a debug build says so once in the console: run it with `flutter run`.

## Call sites

Stack traces give `file:line:column` in debug builds and `file:line` in profile and release. Built with `--split-debug-info` or `--obfuscate`, sites fall back to the value's name (`value:card`). On the web, a debug build's stacks are mapped to source; a profile or release build's sites are names.

A helper of yours that creates or starts controllers gives all of them its own call site (its line is the first app frame): give each value a `name`.

## Limits

- Implicit animations are found in debug builds only. `AnimatedSwitcher`, `AnimatedCrossFade` and `AnimatedSize` are not tracked.
- Hero flights driven by a back swipe are not reported.
- Build and layout cost per widget is not reported.
- No recordings made on the device.
- Profile builds are not yet verified on a device.
- Capture is always PNG.
