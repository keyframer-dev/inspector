import 'package:flutter/animation.dart';

import 'recorder.dart';
import 'stack.dart';
import 'vitals.dart';

/// An AnimationController Motion Vitals sees: every run (forward, reverse, animateTo, animateBack,
/// repeat, fling, animateWith) is an animation of one call site, from its start to its end, and the
/// frames drawn and missed meanwhile are counted against it. A drop-in replacement:
/// `AnimationController(` → `VitalsAnimationController(name: 'card-expand', `.
///
/// `name` is what the dashboard calls it, in every build. Without one, the site is where the
/// controller was constructed: `lib/card.dart:42` when the build prints source positions, an address in
/// the app's snapshot when it was built with `--split-debug-info` or `--obfuscate` (named on the
/// server once its symbols are uploaded).
///
/// The stack is taken once, here, and read only when the controller first runs in a measured session.
class VitalsAnimationController extends AnimationController {
  /// An [AnimationController] whose runs are measured as the animation [name].
  // Never inlined: frame 0 of the stack is this constructor, frame 1 the code that called it.
  @pragma('vm:never-inline')
  VitalsAnimationController({
    super.value,
    super.duration,
    super.reverseDuration,
    super.debugLabel,
    super.lowerBound,
    super.upperBound,
    super.animationBehavior,
    required super.vsync,
    this.name,
  }) : _owner = vsync.runtimeType.toString() {
    if (KeyframerVitals.started) _created = StackTrace.current;
  }

  /// The animation's name in reports.
  final String? name;
  final String _owner;
  StackTrace? _created;
  VitalsSiteSpec? _site;
  MotionRun? _run;

  @override
  TickerFuture forward({double? from}) {
    final f = super.forward(from: from);
    _began(_span(duration, value, upperBound));
    return f;
  }

  @override
  TickerFuture reverse({double? from}) {
    final f = super.reverse(from: from);
    _began(_span(reverseDuration ?? duration, value, lowerBound));
    return f;
  }

  @override
  TickerFuture animateTo(double target, {Duration? duration, Curve curve = Curves.linear}) {
    final from = value;
    final f = super.animateTo(target, duration: duration, curve: curve);
    _began(duration != null ? _ms(duration) : _span(this.duration, from, target));
    return f;
  }

  @override
  TickerFuture animateBack(double target, {Duration? duration, Curve curve = Curves.linear}) {
    final from = value;
    final f = super.animateBack(target, duration: duration, curve: curve);
    _began(duration != null ? _ms(duration) : _span(reverseDuration ?? this.duration, from, target));
    return f;
  }

  @override
  TickerFuture repeat({double? min, double? max, bool reverse = false, Duration? period, int? count}) {
    final f = super.repeat(min: min, max: max, reverse: reverse, period: period, count: count);
    final p = period ?? duration;
    // A loop runs until stopped; a counted one for its periods.
    _began(count == null || p == null ? null : _ms(p)! * count);
    return f;
  }

  @override
  TickerFuture fling({
    double velocity = 1.0,
    SpringDescription? springDescription,
    AnimationBehavior? animationBehavior,
  }) {
    final f = super.fling(
      velocity: velocity,
      springDescription: springDescription,
      animationBehavior: animationBehavior,
    );
    _began(null);
    return f;
  }

  @override
  TickerFuture animateWith(Simulation simulation) {
    final f = super.animateWith(simulation);
    _began(_settleMs(simulation));
    return f;
  }

  /// Every run ends here: when it completes (the controller stops itself), when the app stops it, and
  /// when a new run replaces it.
  @override
  void stop({bool canceled = true}) {
    _ended();
    super.stop(canceled: canceled);
  }

  @override
  void dispose() {
    _ended();
    super.dispose();
  }

  void _began(num? ms) {
    if (!isAnimating) return;
    final reporter = KeyframerVitals.reporter;
    final r = reporter?.recorder;
    if (r == null) return;
    final t = reporter!.clock();
    _site ??= siteFor(
      name: name,
      fn: 'AnimationController',
      owner: _owner,
      created: _created,
      appPackage: KeyframerVitals.appPackage,
      imageName: KeyframerVitals.imageName,
      imageKind: KeyframerVitals.imageKind,
    );
    _run = r.runStart(_site!, t, end: ms == null ? double.infinity : t + ms, reduceMotion: reporter.reduceMotion);
  }

  void _ended() {
    final run = _run;
    if (run == null) return;
    _run = null;
    final t = KeyframerVitals.reporter?.clock();
    if (t != null) run.stop(t);
  }

  /// What forward, reverse and animateTo without a duration run for: the duration scaled by the share
  /// of the range left, as AnimationController computes it.
  num? _span(Duration? d, double from, double to) {
    if (d == null) return null;
    final range = upperBound - lowerBound;
    final fraction = range.isFinite && range > 0 ? (to - from).abs() / range : 1.0;
    return d.inMicroseconds / 1000 * fraction;
  }
}

/// Tracks a controller you do not construct (a library's): its runs are seen through status changes,
/// so a run's length is a guess from the controller's duration. Call [vitalsUntrack] in dispose.
extension VitalsTrackController on AnimationController {
  @pragma('vm:never-inline')
  AnimationController vitalsTrack(String name) {
    if (this is VitalsAnimationController || _tracked[this] != null) return this;
    _tracked[this] = _StatusTracker(this, name);
    return this;
  }

  void vitalsUntrack() {
    _tracked[this]?.dispose();
    _tracked[this] = null;
  }
}

final _tracked = Expando<_StatusTracker>('vitalsTracked');

class _StatusTracker {
  _StatusTracker(this.controller, this.name) {
    controller.addStatusListener(_onStatus);
  }

  final AnimationController controller;
  final String name;
  VitalsSiteSpec? _site;
  MotionRun? _run;

  void _onStatus(AnimationStatus status) {
    final reporter = KeyframerVitals.reporter;
    final t = reporter?.clock();
    if (status == AnimationStatus.completed || status == AnimationStatus.dismissed) {
      if (t != null) _run?.stop(t);
      _run = null;
      return;
    }
    final r = reporter?.recorder;
    if (r == null || t == null) return;
    _run?.stop(t);
    final d =
        status == AnimationStatus.reverse ? (controller.reverseDuration ?? controller.duration) : controller.duration;
    _site ??= siteFor(name: name, fn: 'AnimationController', owner: null, created: null);
    _run = r.runStart(_site!, t, end: d == null ? double.infinity : t + _ms(d)!, reduceMotion: reporter!.reduceMotion);
  }

  void dispose() {
    controller.removeStatusListener(_onStatus);
    final t = KeyframerVitals.reporter?.clock();
    if (t != null) _run?.stop(t);
  }
}

/// The site of an animation: its name when it has one, else where it was created (source or native),
/// else the type of the State that owns it.
VitalsSiteSpec siteFor({
  required String? name,
  required String fn,
  required String? owner,
  required StackTrace? created,
  String? appPackage,
  String imageName = 'libapp.so',
  String imageKind = 'elf',
}) {
  final type = owner == null ? null : _trim(owner);
  final component = type == null ? null : componentOf(type);
  if (name != null && name.isNotEmpty) {
    final n = _trim(name)!;
    return VitalsSiteSpec(
      id: 'n:$n',
      ref: {'kind': 'name', 'name': n, if (type != null) 'type': type},
      key: n,
      fn: fn,
      component: component,
    );
  }
  final origin = created == null ? null : originOf(created.toString(), appPackage: appPackage);
  switch (origin) {
    case SourceOrigin(:final file, :final line, :final column, :final member):
      final at = _trim(file)!;
      return VitalsSiteSpec(
        id: 's:$at:$line:$column',
        ref: {'kind': 'source', 'file': at, 'line': line, if (column > 0) 'column': column},
        // Stable across versions while the code around it moves: the file and the function, no line.
        key: _trim('$at#$member#$fn'),
        fn: fn,
        component: origin.component ?? component,
      );
    case NativeOrigin(:final buildId, :final offset, :final arch):
      return VitalsSiteSpec(
        id: 'v:$buildId:$offset',
        ref: {'kind': 'native', 'offset': offset, if (type != null) 'type': type},
        fn: fn,
        component: component,
        image: VitalsImageSpec(debugId: buildId, name: imageName, kind: imageKind, arch: normalArch(arch)),
      );
    case null:
      final n = component ?? type ?? 'AnimationController';
      return VitalsSiteSpec(
        id: 'n:$n',
        ref: {'kind': 'name', 'name': n, if (type != null) 'type': type},
        key: n,
        fn: fn,
        component: component,
      );
  }
}

String? _trim(String? s) => s == null ? null : (s.length <= 160 ? s : s.substring(0, 160));

num? _ms(Duration? d) => d == null ? null : d.inMicroseconds / 1000;

/// When a simulation comes to rest, stepped at 60 Hz for up to 10 s; null when it does not.
num? _settleMs(Simulation s) {
  for (var i = 0; i <= 600; i++) {
    if (s.isDone(i / 60)) return i * 1000 / 60;
  }
  return null;
}
