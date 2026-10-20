# keyframer_vitals (Flutter)

Motion Vitals for Flutter apps: slow frames from production, per screen and per animation, reported to
[Keyframer](https://keyframer.dev/vitals). A share of sessions counts its frames (a histogram of frames
missed, hitch time, frozen frames), charges slow ones to the animations that were running, and sends a
small report (1 to 3 KB gzipped) when the app goes to the background.

The reporter is MIT, has no plugin dependencies, and sends no personal data: no screenshots, text,
values, touches, identifiers or timestamps. You can read every byte it sends in `lib/src/reporter.dart`.

## Setup

Flutter 3.29 or later. Reports come from iOS and Android; on the web and on desktop the reporter does
nothing in this version.

```yaml
# pubspec.yaml
dependencies:
  keyframer_vitals: ^0.1.0
```

```dart
import 'package:keyframer_vitals/keyframer_vitals.dart';

void main() {
  KeyframerVitals.start(
    key: 'kfp_live_…',            // the project's field key, from the dashboard (public by design)
    appVersion: '3.4.0',           // package_info_plus: info.version
    build: '412',                  // package_info_plus: info.buildNumber
    appPackage: 'shop',            // your pubspec name: call sites read lib/x.dart
  );
  runApp(MaterialApp(
    navigatorObservers: [KeyframerVitals.navigatorObserver],
    // …
  ));
}
```

That is all an app needs. Then, as you like:

- `KeyframerVitals.setScreen('Checkout')` where the navigator does not see screens (tabs, a custom
  router). Screen names are masked like the inspector's redaction (`/users/42` becomes
  `/users/[number]`, emails `[email]`) and cut to 64 characters before they leave the device.
- A further navigator takes its own `VitalsNavigatorObserver()` (a navigator observer instance belongs
  to one navigator).
- `VitalsScrollListener(child: …)` around the app, so slow frames during long flings read `scroll`.
- `device: VitalsDevice(model: …, memoryGb: …, osMajor: …)` from device_info_plus. This package reads no
  model itself. On Android pass `osMajor` too: Dart's `Platform.operatingSystemVersion` is the kernel's
  version there, so without it reports say `osMajor: 0`.

```dart
final info = await DeviceInfoPlugin().androidInfo;
KeyframerVitals.start(
  …,
  device: VitalsDevice(
    model: info.model,
    memoryGb: info.physicalRamSize / 1024,
    osMajor: int.tryParse(info.version.release.split('.').first),
  ),
);
```

### Consent

Like Sentry: reporting starts when the app calls `start`, nothing runs before it. An app that needs
consent first calls `start` after it. `KeyframerVitals.setEnabled(false)` stops at once and drops what was
measured and not sent; `setEnabled(true)` starts again with a new session. The setting is not
remembered, so call it on every launch where it applies.

### Builds

Release builds report as `production`. Debug and profile builds report nothing unless you pass
`environment: VitalsEnvironment.development`; their reports land in a separate environment the
dashboard hides by default (debug frame times are inflated), and only when the project collects them.

## Naming animations

`AnimationController(` becomes `VitalsAnimationController(name: …, `. Every run (forward, reverse,
animateTo, animateBack, repeat, fling, animateWith) is an animation of that site, from its start to its
end, and the frames drawn and missed meanwhile are counted against it.

```dart
late final expand = VitalsAnimationController(
  vsync: this,
  duration: const Duration(milliseconds: 400),
  name: 'card-expand',
);
```

- With a `name`, the dashboard shows that name in every build, plus the type of the State that owns it.
- Without one, the site is where the controller was constructed: `lib/feed/card.dart:57` when the build
  prints source positions, or an address in the app's snapshot when it was built with
  `--split-debug-info` or `--obfuscate` (named on the server once the symbols are uploaded, below).
- A controller you do not construct (a library's): `controller.vitalsTrack('name')`, and
  `controller.vitalsUntrack()` in dispose. Its runs are seen through status changes, so their length is
  estimated from the controller's duration.

Route transitions between page routes (`Navigator.push`, `Navigator.pop`) and Hero flights are
animations too, found on their own by the navigator observer.

## Uploading symbols

Built with `--split-debug-info` (or `--obfuscate`), a release app's stack traces are addresses only.
The reporter sends the address of each unnamed controller's creation with the snapshot's build id (the
ELF build id on Android, the same id as the Mach-O UUID on iOS); the dashboard names it once the symbol
files are uploaded. After each release build:

```sh
# Android: ELF symbol files, one per architecture you ship, or the whole folder (--elf build/symbols)
flutter build appbundle --release --split-debug-info=build/symbols --obfuscate
npx @keyframerdev/vitals-cli symbols upload --elf build/symbols/app.android-arm64.symbols

# iOS: Flutter builds App.framework as a Mach-O library, and its symbol file is Mach-O too
flutter build ipa --release --split-debug-info=build/symbols --obfuscate
npx @keyframerdev/vitals-cli symbols upload --dsym build/symbols/app.ios-arm64.symbols
```

The CLI takes the project's CI upload key (`kft_…`, from the dashboard) from `--key` or
`KEYFRAMER_VITALS_UPLOAD_KEY`. It extracts the line tables on your machine and uploads those; the
symbol file itself never leaves it.

Builds without `--split-debug-info` need no upload: their traces carry file and line.

## Storage

The reporter remembers a few things between launches: the project's config, the 7-day kill switch, how
many sessions reported today (at most 3 per device a day), failed uploads waiting for a retry (at most 5
reports, 100 KB, 7 days) and a checkpoint of the open window every 60 seconds.

By default it keeps them in memory, for the running process only. That means: the config is fetched
again each launch, the daily cap counts one launch's sessions, failed uploads are retried within the
launch only, and **there are no checkpoints**: a session that ends in a crash or a kill (often the worst
jank there is) is not sent. To keep them, pass a persistent `storage`:

```dart
import 'package:shared_preferences/shared_preferences.dart';

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

KeyframerVitals.start(…, storage: PrefsVitalsStorage(await SharedPreferences.getInstance()));
```

Nothing stored identifies the person or the device; the session nonce is never stored.

## What it does, and what it costs

- **Frames** come from Flutter's own `FrameTiming` reports (`SchedulerBinding.addTimingsCallback`),
  delivered in batches about once a second in release. Nothing is scheduled while nothing draws: no frame
  loop, no timer but a 10-minute window timer and, with persistent storage, the 60-second checkpoint.
- **Threads**: build time on the UI isolate is the `js` role, raster time the `ui` role, as in the
  inspector. Each frame is counted against the rate the app actually runs at (learned from the frames,
  60, 90 or 120 Hz, never faster than the display): `missed = ceil((cost - 1) / budget) - 1`.
- **Attribution**: a frame counts for every animation running in it (named controllers from start to
  estimated end or stop, route transitions, Hero flights). Frames while none ran are the screen's
  baseline. The five slowest frames of a window carry a cause: `screen-mount` (within 500 ms after a
  navigation), `burst` (6 or more animations started in it), `scroll`, `gesture` (a touch, until 1.5 s
  after the last finger lifts), or `unknown`.
- **Sessions**: a session ends after 30 s in the background; a window is at most 10 minutes of foreground
  time and is sent when the app goes to the background (`AppLifecycleState.paused`). Whether a session
  is measured is decided once, at its start, with the sample rate (default 0.1; the project's config
  overrides it).
- **Config** is fetched 10 s after launch, at most about daily, and comes back with every upload. A 401,
  a 410 or `stop` turns reporting off on the device for 7 days; a `minSdk` above this version turns it
  off until the app updates the package.

## Development

```sh
flutter test          # current stable Flutter; the golden test runs the shared validator when bun is installed
dart analyze
```

`test/golden_test.dart` checks the encoder against `packages/protocol/fixtures/vitals/report-flutter.json`
and validates its output with `protocol/vitals-validate.ts` (`bun tool/validate.ts`).
`VITALS_DUMP=/tmp/report.json flutter test test/golden_test.dart` writes the report it makes.

The protocol is `protocol/vitals.ts`; `lib/src/protocol.dart` mirrors the parts this
package needs, and a test checks the constants still match.
