---
title: Flutter
description: Add keyframer_vitals, start it before runApp, name screens and animations, and upload split debug info.
order: 5
section: Motion Vitals
---

# Motion Vitals for Flutter

`keyframer_vitals` is the production reporter for Flutter, on Android and iOS. It reads frame timings that Flutter already collects (`FrameTiming`), so it never forces a frame and costs about 0.01% of CPU by Flutter's own estimate. On the web, on desktop and in tests, `start` does nothing.

## 1. Add the package

```sh
flutter pub add keyframer_vitals
```

## 2. Start it

```dart
import 'dart:io';
import 'package:device_info_plus/device_info_plus.dart';
import 'package:flutter/widgets.dart';
import 'package:keyframer_vitals/keyframer_vitals.dart';
import 'package:package_info_plus/package_info_plus.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final info = await PackageInfo.fromPlatform();
  final device = await _device();
  await KeyframerVitals.start(
    key: 'kfp_live_7Hq2xR…',
    appVersion: info.version,
    build: info.buildNumber,
    device: device,
    appPackage: 'my_app',           // your pubspec name: sites read lib/x.dart
  );
  runApp(const MyApp());
}

Future<VitalsDevice> _device() async {
  final plugin = DeviceInfoPlugin();
  if (Platform.isAndroid) {
    final a = await plugin.androidInfo;
    return VitalsDevice(model: a.model, osMajor: int.parse(a.version.release.split('.').first));
  }
  final i = await plugin.iosInfo;
  return VitalsDevice(model: i.utsname.machine);
}
```

Reporting starts at `start`. If your app asks for consent first, call it after: see [Consent and privacy](consent.md).

| Parameter | Default | What it does |
|---|---|---|
| `key` | required | The project's field key, `kfp_live_…` |
| `appVersion` | required | The version the dashboard groups by |
| `build` | none | The build number |
| `environment` | production in release builds | Debug and profile builds report only with `VitalsEnvironment.development`, into an environment the dashboard hides by default |
| `sampleRate` | `0.1` | The share of sessions that report, until the project's settings say otherwise |
| `device` | none | `VitalsDevice(model:, memoryGb:, osMajor:, tier:)`, read by the app (device_info_plus). On Android, pass `osMajor`: Flutter's own OS string is the kernel's version |
| `storage` | in memory | Where the config, the daily count, unsent reports and checkpoints are kept (below) |
| `appId` | none | The bundle id or package name |
| `appPackage` | none | Your pubspec `name`, so call sites read `lib/feed.dart` instead of `package:my_app/feed.dart` |

### Storage

By default everything is kept in memory for one launch: the config is fetched again each launch, the 3-a-day cap counts one launch only, unsent reports are retried within the launch, and there are no checkpoints, so a session that ends in a freeze the person kills is not sent. To keep them, pass a `VitalsStorage`, two methods over any key-value store:

```dart
class PrefsVitalsStorage implements VitalsStorage {
  PrefsVitalsStorage(this.prefs);
  final SharedPreferences prefs;

  @override
  Future<String?> read(String key) async => prefs.getString(key);

  @override
  Future<void> write(String key, String? value) =>
      value == null ? prefs.remove(key) : prefs.setString(key, value);

  @override
  bool get persistent => true;
}

// KeyframerVitals.start(..., storage: PrefsVitalsStorage(await SharedPreferences.getInstance()));
```

## 3. Screens

Add the observer, and each route's `RouteSettings.name` is a screen; route transitions and Hero flights count as animations:

```dart
MaterialApp(navigatorObservers: [KeyframerVitals.navigatorObserver], ...)
```

A navigator takes one observer instance: create a `VitalsNavigatorObserver()` for each further navigator. For tabs or a custom router, name screens with `KeyframerVitals.setScreen('Checkout')`. Names are masked (ids, emails, long numbers, tokens) and cut to 64 characters before they leave the device, so `/users/42` arrives as `/users/[number]`.

## 4. Name animations

Use `VitalsAnimationController` where you construct an `AnimationController`, with a name:

```dart
final controller = VitalsAnimationController(
  vsync: this,
  duration: const Duration(milliseconds: 300),
  name: 'card-expand',
);
```

For a controller you do not construct (a library's), track it and untrack it in `dispose`:

```dart
controller.vitalsTrack('sheet');
// dispose(): controller.vitalsUntrack();
```

Named sites show up by name in every build. Unnamed ones are reported at their creation stack; a build with `--split-debug-info` or `--obfuscate` prints addresses only, so upload the symbols and the dashboard turns them into files and lines: see [Symbols](symbols.md#flutter).

## 5. Scrolling (optional)

Touches already keep the meters on until 1.5 s after the last finger lifts. Wrap the app or a screen in `VitalsScrollListener` and long flings and scrolls the app drives itself are measured too, with `scroll` as their cause:

```dart
VitalsScrollListener(child: MyApp())
```

## 6. Stop or pause reporting

```dart
await KeyframerVitals.setEnabled(false); // stops now, and drops the open window, the checkpoint and unsent reports
await KeyframerVitals.setEnabled(true);  // starts again, as a new session
```

The choice is not remembered: call it on every launch your app needs it.

## How it measures

- Build time on the UI isolate is the `js` thread on the dashboard (the app thread); raster time is the `ui` thread.
- Frame timings arrive in batches about once a second in release. Nothing runs when Flutter draws nothing.
- Reduce Motion is the platform's disable animations or reduce motion setting (only if the project collects it); the display rate is the view's refresh rate. Flutter reports no low power or thermal state.
- Uploads use `dart:io`'s `HttpClient` when the app goes to the background.

## Check that it works

1. `flutter run --release` on a device or simulator.
2. Pass `sampleRate: 1.0` in that build (or raise the project's rate) so the session is sampled.
3. Animate something, then send the app to the background.
4. The project's setup page shows the first report within a few minutes.
