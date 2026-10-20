import 'dart:async';
import 'dart:developer' show Timeline;
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/widgets.dart';

import 'mask.dart';
import 'navigation.dart';
import 'protocol.dart';
import 'recorder.dart';
import 'reporter.dart';
import 'storage.dart';
import 'transport.dart';

/// Motion Vitals for Flutter: slow frames from production, per screen and per animation.
///
/// ```dart
/// void main() {
///   KeyframerVitals.start(key: 'kfp_live_…', appVersion: '1.4.0', build: '212');
///   runApp(MaterialApp(navigatorObservers: [KeyframerVitals.navigatorObserver], …));
/// }
/// ```
///
/// Nothing runs before [start]. Then a share of sessions (the sample rate) is measured and reported;
/// [setEnabled] (false) stops at once and drops what was not sent yet. Nothing is measured while
/// nothing draws: frames come from Flutter's own FrameTiming reports.
abstract final class KeyframerVitals {
  static _VitalsBinding? _binding;

  /// Starts reporting. Call it once, early in `main` (it initializes the widgets binding). On the web,
  /// on desktop and in tests it does nothing.
  ///
  /// - `key`: the project's field key (`kfp_live_…`), public by design.
  /// - `appVersion`, `build`: what the dashboard groups by (package_info_plus has both).
  /// - `environment`: release builds report as production unless told otherwise; debug and profile
  ///   builds report only when this is [VitalsEnvironment.development].
  /// - `sampleRate`: the share of sessions measured until the project's config says otherwise (0.1).
  /// - `device`: the model, memory and OS version the app reads itself (device_info_plus).
  /// - `storage`: keeps config, retries and checkpoints between launches. In memory by default: see
  ///   [VitalsStorage].
  /// - `appPackage`: your pubspec name, so call sites read `lib/x.dart` instead of `package:app/x.dart`.
  static Future<void> start({
    required String key,
    required String appVersion,
    String? build,
    VitalsEnvironment? environment,
    double? sampleRate,
    VitalsDevice? device,
    VitalsStorage? storage,
    String endpoint = vitalsEndpoint,
    String? appId,
    String? appPackage,
  }) async {
    if (kIsWeb || _binding != null) return;
    final facts = PlatformFacts.current();
    final transport = VitalsTransport.platform();
    if (facts == null || transport == null) return;
    WidgetsFlutterBinding.ensureInitialized();
    await startWith(
      VitalsOptions(
        key: key,
        appVersion: appVersion,
        build: build,
        environment: environment,
        sampleRate: sampleRate,
        device: device,
        endpoint: endpoint,
        appId: appId,
        appPackage: appPackage,
      ),
      storage: storage ?? MemoryVitalsStorage(),
      transport: transport,
      facts: facts,
    );
  }

  /// [start] with every dependency given: for tests and for platforms the default does not cover.
  @visibleForTesting
  static Future<void> startWith(
    VitalsOptions options, {
    required VitalsStorage storage,
    required VitalsTransport transport,
    required PlatformFacts facts,
    double Function()? clock,
    bool? releaseBuild,
    math.Random? random,
  }) async {
    if (_binding != null) return;
    final b = _VitalsBinding(options.appPackage, facts.os);
    _binding = b;
    final reporter = VitalsReporter(
      options: options,
      store: VitalsStore(storage),
      transport: transport,
      facts: facts,
      clock: clock ?? _engineClock,
      releaseBuild: releaseBuild ?? kReleaseMode,
      display: _display,
      reduceMotionNow: _reduceMotion,
      random: random,
    );
    b.attach(reporter);
    final state = WidgetsBinding.instance.lifecycleState;
    await reporter.start(
      foreground: state == null || state == AppLifecycleState.resumed || state == AppLifecycleState.inactive,
    );
  }

  /// Stops everything and forgets the reporter: for tests.
  @visibleForTesting
  static void reset() {
    _binding?.detach();
    _binding = null;
  }

  /// Consent, the Sentry way: false stops measuring and drops what was not sent; true starts again
  /// (a new session, sampled afresh). Not remembered: call it on every launch the app needs it.
  static Future<void> setEnabled(bool enabled) async => _binding?.reporter.setEnabled(enabled);

  /// The screen the app is on, where [navigatorObserver] does not see it (tabs, a custom router).
  /// Masked like the inspector's redaction and cut to 64 characters before it leaves the device.
  static void setScreen(String name) => _binding?.setScreen(name);

  /// Add to your navigator: `navigatorObservers: [KeyframerVitals.navigatorObserver]`. Screens from
  /// `RouteSettings.name`, route transitions and Hero flights as animations. A navigator takes one
  /// observer instance: create a [VitalsNavigatorObserver] for each further navigator.
  static final VitalsNavigatorObserver navigatorObserver = VitalsNavigatorObserver();

  /// Whether this session is being measured now (sampled, enabled, in the foreground).
  static bool get isMeasuring => _binding?.reporter.measuring ?? false;

  /// Sends what waits in the retry store now. Reports are sent on their own when the app goes to the
  /// background; this is for tests and for apps that know a good moment.
  static Future<void> flush() async => _binding?.reporter.flush();

  /// The reporter, while started. For the package's own widgets and tests.
  static VitalsReporter? get reporter => _binding?.reporter;

  /// Whether [start] was called: controllers take their creation stack only from then on.
  static bool get started => _binding != null;

  /// The app's pubspec name, when [start] was given it.
  static String? get appPackage => _binding?.appPackage;

  /// `libapp.so` on Android, `App` (App.framework) on iOS: the image `native` sites point into.
  static String get imageName => _binding?.os == 'ios' ? 'App' : 'libapp.so';

  /// The snapshot's format: an ELF library on Android, a Mach-O dylib on iOS.
  static String get imageKind => _binding?.os == 'ios' ? 'macho' : 'elf';

  /// Now, on the clock frames are timed with, or null while not measuring.
  static double? now() {
    final r = _binding?.reporter;
    return r == null || !r.measuring ? null : r.clock();
  }
}

/// Engine timestamps (FrameTiming) and Dart's Timeline share one monotonic clock.
double _engineClock() => Timeline.now / 1000;

(double, bool) _display() {
  try {
    final d = WidgetsBinding.instance.platformDispatcher;
    final hz = d.implicitView?.display.refreshRate ?? (d.displays.isEmpty ? 60.0 : d.displays.first.refreshRate);
    final rate = hz > 0 ? hz : 60.0;
    // Adaptive where the platform varies the rate with the content (ProMotion, variable refresh).
    final adaptive =
        rate > 61 && (defaultTargetPlatform == TargetPlatform.iOS || defaultTargetPlatform == TargetPlatform.android);
    return (rate, adaptive);
  } catch (_) {
    return (60.0, false);
  }
}

bool _reduceMotion() {
  try {
    final f = WidgetsBinding.instance.platformDispatcher.accessibilityFeatures;
    return f.disableAnimations || f.reduceMotion;
  } catch (_) {
    return false;
  }
}

/// The Flutter side: lifecycle, frame timings and pointers, attached only while measuring.
class _VitalsBinding with WidgetsBindingObserver {
  _VitalsBinding(this.appPackage, this.os);

  final String? appPackage;
  final String os;
  late VitalsReporter reporter;
  bool _measuring = false;

  void attach(VitalsReporter r) {
    reporter = r;
    r.onMeasuring = _onMeasuring;
    WidgetsBinding.instance.addObserver(this);
    final name = KeyframerVitals.navigatorObserver.currentScreen;
    if (name != null) r.setScreen(name);
  }

  void detach() {
    WidgetsBinding.instance.removeObserver(this);
    _onMeasuring(false);
    reporter.dispose();
  }

  void setScreen(String name) => reporter.setScreen(screenName(name));

  void _onMeasuring(bool on) {
    if (on == _measuring) return;
    _measuring = on;
    if (on) {
      SchedulerBinding.instance.addTimingsCallback(_timings);
      GestureBinding.instance.pointerRouter.addGlobalRoute(_pointer);
    } else {
      SchedulerBinding.instance.removeTimingsCallback(_timings);
      GestureBinding.instance.pointerRouter.removeGlobalRoute(_pointer);
    }
  }

  void _timings(List<ui.FrameTiming> list) {
    final r = reporter.recorder;
    if (r == null || list.isEmpty) return;
    // FrameTiming and Timeline share the engine's clock. Should a platform ever differ, the batch's
    // last frame (delivered within about a second) anchors it.
    final now = reporter.clock();
    final last = list.last.timestampInMicroseconds(ui.FramePhase.rasterFinish) / 1000;
    final shift = (now - last).abs() > 10000 ? now - last : 0.0;
    for (final t in list) {
      r.frame(frameOf(t, shift));
    }
  }

  void _pointer(PointerEvent e) {
    final r = reporter.recorder;
    if (r == null) return;
    switch (e) {
      case PointerDownEvent():
        r.pointerDown(reporter.clock());
      case PointerUpEvent() || PointerCancelEvent():
        r.pointerUp(reporter.clock());
      default:
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    switch (state) {
      case AppLifecycleState.paused || AppLifecycleState.detached:
        unawaited(reporter.background());
      case AppLifecycleState.resumed:
        unawaited(reporter.foreground());
      default:
    }
  }

  @override
  void didChangeAccessibilityFeatures() {
    if (reporter.reduceMotion) reporter.recorder?.reduceMotionSeen = true;
  }

  @override
  void didChangeMetrics() {
    final (hz, adaptive) = _display();
    reporter.recorder?.display(hz, adaptive);
  }
}

/// A FrameTiming as the recorder reads it, `shift` ms later.
VitalsFrame frameOf(ui.FrameTiming t, [double shift = 0]) => VitalsFrame(
  start: t.timestampInMicroseconds(ui.FramePhase.vsyncStart) / 1000 + shift,
  end: t.timestampInMicroseconds(ui.FramePhase.rasterFinish) / 1000 + shift,
  buildMs: t.buildDuration.inMicroseconds / 1000,
  rasterMs: t.rasterDuration.inMicroseconds / 1000,
);
