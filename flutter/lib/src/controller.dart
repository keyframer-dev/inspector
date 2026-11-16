import 'package:flutter/animation.dart';
import 'package:flutter/foundation.dart';

import 'call_site.dart';
import 'own_time.dart';
import 'protocol.dart';
import 'runtime.dart';

/// Whether the inspector runs when the app does not say (`enabled:`): in debug and profile builds, not
/// in release. `--dart-define=KEYFRAMER_INSPECTOR=true` turns it on in any build, and `=false` off in
/// any build (no connection, and no call sites captured).
bool get kfInspectorDefaultEnabled => kfInspectorEnabledBy(_kfInspectorDefine, release: kReleaseMode);

const _kfInspectorDefine = String.fromEnvironment('KEYFRAMER_INSPECTOR');

/// [kfInspectorDefaultEnabled] for a `KEYFRAMER_INSPECTOR` value (empty when it is not defined).
@visibleForTesting
bool kfInspectorEnabledBy(String define, {required bool release}) => switch (define.trim().toLowerCase()) {
  'true' => true,
  'false' => false,
  _ => !release,
};

/// Whether values capture where they were created (a stack trace each, read only once an inspector is
/// installed): when the inspector is on by default, and from when an app turns it on with `enabled:`.
/// Turned off with it.
bool kfCaptureSites = kfInspectorDefaultEnabled;

/// An AnimationController the inspector sees: its value is a signal (sampled while recording, written
/// by playback) located where it was constructed, and every start (forward, reverse, animateTo,
/// animateBack, repeat, fling, animateWith) is reported as an animation with its own call site,
/// duration and curve. A drop-in replacement: `AnimationController(` → `KfAnimationController(`.
///
/// `name` (or `debugLabel`) names the value in the panel.
class KfAnimationController extends AnimationController {
  KfAnimationController({
    super.value,
    super.duration,
    super.reverseDuration,
    super.debugLabel,
    super.lowerBound,
    super.upperBound,
    super.animationBehavior,
    required super.vsync,
    String? name,
  }) : _vsync = vsync {
    _kf = KfOwnTime.measure(
      () => _KfTracker(this, name ?? debugLabel, kfCaptureSites ? StackTrace.current : null, owner: _vsync),
    );
  }

  late final _KfTracker _kf;
  final TickerProvider _vsync;

  @override
  void resync(TickerProvider vsync) {
    super.resync(vsync);
    _kf.signal.owner = vsync;
  }

  @override
  TickerFuture forward({double? from}) => _kf.start(
    'forward',
    () => [upperBound, _cfg(duration, from)],
    duration,
    (d) => _withDuration(d, () => super.forward(from: from)),
    runMs: (d) => _span(d ?? duration, from ?? value, upperBound),
  );

  @override
  TickerFuture reverse({double? from}) => _kf.start(
    'reverse',
    () => [lowerBound, _cfg(reverseDuration ?? duration, from)],
    reverseDuration ?? duration,
    (d) => _withDuration(d, () => super.reverse(from: from), reverse: true),
    runMs: (d) => _span(d ?? reverseDuration ?? duration, from ?? value, lowerBound),
  );

  @override
  TickerFuture animateTo(double target, {Duration? duration, Curve curve = Curves.linear}) => _kf.start(
    'animateTo',
    () => [target, _cfg(duration ?? this.duration, null, curve)],
    duration ?? this.duration,
    (d) => super.animateTo(target, duration: d ?? duration, curve: curve),
    runMs: (d) => d != null || duration != null ? _ms(d ?? duration) : _span(this.duration, value, target),
  );

  @override
  TickerFuture animateBack(double target, {Duration? duration, Curve curve = Curves.linear}) => _kf.start(
    'animateBack',
    () => [target, _cfg(duration ?? reverseDuration ?? this.duration, null, curve)],
    duration ?? reverseDuration ?? this.duration,
    (d) => super.animateBack(target, duration: d ?? duration, curve: curve),
    runMs:
        (d) =>
            d != null || duration != null ? _ms(d ?? duration) : _span(reverseDuration ?? this.duration, value, target),
  );

  @override
  TickerFuture repeat({double? min, double? max, bool reverse = false, Duration? period, int? count}) => _kf.start(
    'repeat',
    () => [
      {
        'min': min ?? lowerBound,
        'max': max ?? upperBound,
        'reverse': reverse,
        'period': _ms(period ?? duration),
        if (count != null) 'count': count,
      },
    ],
    period ?? duration,
    (d) => super.repeat(min: min, max: max, reverse: reverse, period: d ?? period, count: count),
    loops: true,
  );

  @override
  TickerFuture fling({
    double velocity = 1.0,
    SpringDescription? springDescription,
    AnimationBehavior? animationBehavior,
  }) {
    // A spring passed in is tunable (`0.spring.stiffness`…): the panel's values replace it for this call.
    var spring = springDescription;
    return _kf.start(
      'fling',
      () => [
        {'velocity': velocity, 'from': value, if (spring != null) 'spring': _spring(spring!)},
      ],
      null,
      (_) => super.fling(velocity: velocity, springDescription: spring, animationBehavior: animationBehavior),
      params:
          springDescription == null
              ? const []
              : [
                KfParam('0.spring.mass', springDescription.mass),
                KfParam('0.spring.stiffness', springDescription.stiffness),
                KfParam('0.spring.damping', springDescription.damping),
              ],
      onPatch: springDescription == null ? null : (patch) => spring = _patchSpring(springDescription, patch),
    );
  }

  @override
  TickerFuture animateWith(Simulation simulation) => _kf.start(
    'animateWith',
    () => [
      {'simulation': simulation.toString(), 'from': value},
    ],
    null,
    (_) => super.animateWith(simulation),
    runMs: (_) => _settleMs(simulation),
  );

  @override
  void dispose() {
    _kf.dispose();
    super.dispose();
  }

  /// What forward, reverse and animateTo without a duration run for: the duration scaled by the share of
  /// the range left to cover, as AnimationController computes it.
  num? _span(Duration? d, double from, double to) {
    if (d == null) return null;
    final range = upperBound - lowerBound;
    final fraction = range.isFinite && range > 0 ? (to - from).abs() / range : 1.0;
    return d.inMicroseconds / 1000 * fraction;
  }

  Map<String, Object?> _cfg(Duration? d, double? from, [Curve curve = Curves.linear]) => {
    'duration': _ms(d),
    'from': from ?? value,
    'curve': curveName(curve),
  };

  // forward() and reverse() read the controller's duration when they start: an overridden one is set
  // for that call only.
  TickerFuture _withDuration(Duration? d, TickerFuture Function() run, {bool reverse = false}) {
    if (d == null) return run();
    if (reverse && reverseDuration != null) {
      final before = reverseDuration;
      reverseDuration = d;
      try {
        return run();
      } finally {
        reverseDuration = before;
      }
    }
    final before = duration;
    duration = d;
    try {
      return run();
    } finally {
      duration = before;
    }
  }
}

/// Tracks a controller you do not construct yourself (a library's, or one you would rather not
/// change): its value is sampled and played back like a [KfAnimationController]'s. Starts are seen
/// through status changes only (no call site, curve or exact command); call [kfUntrack] in dispose.
extension KfTrackController on AnimationController {
  AnimationController kfTrack([String? name]) {
    if (this is KfAnimationController || _tracked[this] != null) return this;
    _tracked[this] = _KfStatusTracker(this, name ?? debugLabel, kfCaptureSites ? StackTrace.current : null);
    return this;
  }

  void kfUntrack() {
    _tracked[this]?.dispose();
    _tracked[this] = null;
  }
}

/// A `ValueNotifier<double>` as a signal: a drag offset, a scroll fraction.
extension KfTrackNotifier on ValueNotifier<double> {
  ValueNotifier<double> kfTrack(String name) {
    if (_trackedNotifiers[this] != null) return this;
    final s = KfSignal(
      source: this,
      read: () => value,
      write: (v) => value = v,
      name: name,
      created: kfCaptureSites ? StackTrace.current : null,
      fallbackKey: name,
    );
    _trackedNotifiers[this] = s;
    KfRuntime.instance.register(s);
    return this;
  }

  void kfUntrack() {
    final s = _trackedNotifiers[this];
    if (s != null) KfRuntime.instance.unregister(s);
    _trackedNotifiers[this] = null;
  }
}

final _tracked = Expando<_KfStatusTracker>('kfTracked');
final _trackedNotifiers = Expando<KfSignal>('kfTrackedNotifier');
int _unnamed = 0;

class _KfTracker {
  _KfTracker(this.controller, this.name, StackTrace? created, {Object? owner}) {
    signal = KfSignal(
      source: controller,
      owner: owner,
      read: () => controller.value,
      // A disposed controller (its screen closed) is left alone by a playback still running.
      write: (v) {
        if (!_disposed) controller.value = v;
      },
      name: name,
      created: created,
      fallbackKey: name ?? 'controller${++_unnamed}',
      beginPlayback: _beginPlayback,
      endPlayback: _endPlayback,
    );
    KfRuntime.instance.register(signal);
  }

  final AnimationController controller;
  final String? name;
  late final KfSignal signal;

  bool _inPlayback = false;
  bool _wasAnimating = false;
  bool _disposed = false;
  TickerFuture Function()? _last;
  TickerFuture Function()? _deferred;

  // The start sites seen so far, by where their app frame is: a call that runs again (a loop
  // restarted, the same button tapped twice) works its id, file and component out once. Dropped
  // when the runtime's appPackage or root change, which they are relative to.
  final Map<String, (String, String, String?)> _starts = {};
  String? _startsPackage, _startsRoot;

  TickerFuture start(
    String fn,
    List<Object?> Function() args,
    Duration? duration,
    TickerFuture Function(Duration? overridden) run, {
    bool loops = false,
    num? Function(Duration? overridden)? runMs,
    List<KfParam> params = const [],
    void Function(Map<String, num> patch)? onPatch,
  }) {
    final rt = KfRuntime.instance;
    if (!rt.active) {
      _last = () => run(null);
      return run(null);
    }
    return KfOwnTime.measure(() {
      // The stack of this call: its first app frame is the call site, the frames past it are read only
      // for a recording. Taking it costs a few µs; printing it ten times that and more (every frame, 60
      // to 150 from a gesture handler or a build), so it is printed when the site is first read: by the
      // next batch, between frames (KfInspectorClient.flush), unless one of the panel's edits could apply
      // to this call, which needs its site now.
      final frames = KfLazyStack.of(StackTrace.current);
      final value = signal.id;
      KfCallSite locate() => _callSite(rt, fn, frames.appFrame, duration, params, value);
      final KfCallSite site;
      Map<String, num>? sitePatch;
      if (_mayOverride(rt.overrides, loops, params)) {
        site = locate();
        sitePatch = rt.overrides[site.id];
      } else {
        site = _LateCallSite(locate);
      }
      if (sitePatch != null) onPatch?.call(sitePatch);
      final patch = sitePatch?[loops ? '0.period' : '1.duration'];
      final overridden = patch != null ? Duration(microseconds: (patch * 1000).round()) : null;
      var reported = args();
      if (overridden != null) reported = _patchDuration(reported, _ms(overridden), loops);
      TickerFuture go() {
        // Measured when it starts (a deferred start runs from where playback left the value). Loops,
        // flings and unknown durations have none.
        rt.reportAnim(site, reported, frames: frames, durationMs: runMs?.call(overridden));
        // The controller's own start (and its status listeners) is the app's time, not the inspector's.
        return KfOwnTime.notOurs(() => run(overridden));
      }

      _last = go;
      // Playback owns the value: what the app starts meanwhile waits until it ends.
      if (_inPlayback) {
        _deferred = go;
        return TickerFuture.complete();
      }
      return go();
    });
  }

  /// `value`: the value's id when the call started (a site worked out later still names the instance
  /// that started it, when the stack has no app frame).
  KfCallSite _callSite(
    KfRuntime rt,
    String fn,
    KfStackFrame? at,
    Duration? duration,
    List<KfParam> extra,
    String? value,
  ) {
    final params = [
      if (duration != null) KfParam(fn == 'repeat' ? '0.period' : '1.duration', _ms(duration)!),
      ...extra,
    ];
    if (at == null) {
      // No symbolic stack (--split-debug-info, --obfuscate): one site per value and command.
      return KfCallSite(
        id: '${value ?? signal.baseKey}#$fn',
        file: signal.site(rt).file,
        line: signal.site(rt).line,
        column: 0,
        fn: fn,
        component: signal.site(rt).component,
        target: name,
        params: params,
      );
    }
    if (_startsPackage != rt.appPackage || _startsRoot != rt.root) {
      _starts.clear();
      _startsPackage = rt.appPackage;
      _startsRoot = rt.root;
    }
    final (id, file, component) =
        _starts['${at.uri}:${at.line}:${at.column}'] ??= () {
          final file = sourceFile(at.uri, appPackage: rt.appPackage, root: rt.root);
          return ('$file:${at.line}:${at.column}', file, componentOf(at.member));
        }();
    return KfCallSite(
      id: id,
      file: file,
      line: at.line,
      column: at.column,
      fn: fn,
      component: component,
      target: name,
      params: params,
    );
  }

  void _beginPlayback() {
    if (_inPlayback || _disposed) return;
    _inPlayback = true;
    _wasAnimating = controller.isAnimating;
    _deferred = null;
    controller.stop(canceled: false);
  }

  /// Hands the value back: whatever the app started during playback starts now, and an animation that
  /// was running when playback began (a loop) runs again from where playback left it.
  void _endPlayback() {
    if (!_inPlayback || _disposed) return;
    _inPlayback = false;
    final next = _deferred ?? (_wasAnimating ? _last : null);
    _deferred = null;
    _wasAnimating = false;
    next?.call();
  }

  void dispose() {
    _disposed = true;
    _inPlayback = false;
    _deferred = null;
    _last = null;
    KfRuntime.instance.unregister(signal);
  }
}

/// For a controller tracked with kfTrack: starts seen as status changes.
class _KfStatusTracker {
  _KfStatusTracker(this.controller, String? name, StackTrace? created) {
    signal = KfSignal(
      source: controller,
      read: () => controller.value,
      write: (v) {
        if (!_disposed) controller.value = v;
      },
      name: name,
      created: created,
      fallbackKey: name ?? 'controller${++_unnamed}',
      beginPlayback: () {
        if (!_disposed) controller.stop(canceled: false);
      },
    );
    KfRuntime.instance.register(signal);
    controller.addStatusListener(_onStatus);
  }

  final AnimationController controller;
  late final KfSignal signal;
  AnimationStatus? _status;
  bool _disposed = false;

  void _onStatus(AnimationStatus status) {
    final was = _status;
    _status = status;
    if (status != AnimationStatus.forward && status != AnimationStatus.reverse) return;
    if (was == status) return;
    final rt = KfRuntime.instance;
    if (!rt.active) return;
    KfOwnTime.measure(() => _report(rt, status));
  }

  void _report(KfRuntime rt, AnimationStatus status) {
    final s = signal.site(rt);
    final fn = status == AnimationStatus.forward ? 'forward' : 'reverse';
    final d =
        status == AnimationStatus.reverse ? (controller.reverseDuration ?? controller.duration) : controller.duration;
    final range = controller.upperBound - controller.lowerBound;
    final to = status == AnimationStatus.forward ? controller.upperBound : controller.lowerBound;
    rt.reportAnim(
      KfCallSite(
        id: '${s.id}#$fn',
        file: s.file,
        line: s.line,
        column: 0,
        fn: fn,
        component: s.component,
        target: s.name,
        params: [if (d != null) KfParam('1.duration', _ms(d)!)],
      ),
      [
        status == AnimationStatus.forward ? controller.upperBound : controller.lowerBound,
        {'duration': _ms(d), 'from': controller.value, 'curve': 'linear'},
      ],
      // A guess: the status says which way, not whether it is a forward, an animateTo or a loop.
      durationMs: d == null || !range.isFinite || range <= 0 ? null : _ms(d)! * (to - controller.value).abs() / range,
    );
  }

  void dispose() {
    _disposed = true;
    controller.removeStatusListener(_onStatus);
    KfRuntime.instance.unregister(signal);
  }
}

/// Whether one of the panel's edits holds a param this start reads (its duration or period, its own
/// params): only then is its site needed while it starts. Any other edit would change nothing here.
bool _mayOverride(Map<String, Map<String, num>> overrides, bool loops, List<KfParam> params) {
  if (overrides.isEmpty) return false;
  final key = loops ? '0.period' : '1.duration';
  for (final patch in overrides.values) {
    if (patch.containsKey(key)) return true;
    for (final p in params) {
      if (patch.containsKey(p.path)) return true;
    }
  }
  return false;
}

/// A start's call site, worked out from its stack when it is first read (see _KfTracker.start). The
/// same site, field for field, as one worked out at the start.
class _LateCallSite implements KfCallSite {
  _LateCallSite(this._locate);

  KfCallSite Function()? _locate;
  KfCallSite? _site;

  KfCallSite get _resolved {
    final site = _site;
    if (site != null) return site;
    final located = KfOwnTime.measure(_locate!);
    _locate = null;
    _site = located;
    return located;
  }

  @override
  String get id => _resolved.id;
  @override
  String get file => _resolved.file;
  @override
  int get line => _resolved.line;
  @override
  int get column => _resolved.column;
  @override
  String get fn => _resolved.fn;
  @override
  String? get component => _resolved.component;
  @override
  String? get target => _resolved.target;
  @override
  String? get prop => _resolved.prop;
  @override
  List<KfParam> get params => _resolved.params;
  @override
  Map<String, Object?> toJson() => _resolved.toJson();
}

List<Object?> _patchDuration(List<Object?> args, num? ms, bool loops) {
  final out = List<Object?>.of(args);
  final i = loops ? 0 : 1;
  final key = loops ? 'period' : 'duration';
  if (i < out.length && out[i] is Map) out[i] = {...(out[i] as Map), key: ms};
  return out;
}

num? _ms(Duration? d) => d == null ? null : d.inMicroseconds / 1000;

/// When a simulation comes to rest, stepped at 60 Hz for up to 10 s; null when it does not.
num? _settleMs(Simulation s) {
  for (var i = 0; i <= 600; i++) {
    if (s.isDone(i / 60)) return i * 1000 / 60;
  }
  return null;
}

Map<String, Object?> _spring(SpringDescription s) => {'mass': s.mass, 'stiffness': s.stiffness, 'damping': s.damping};

SpringDescription _patchSpring(SpringDescription s, Map<String, num> patch) {
  final next = SpringDescription(
    mass: (patch['0.spring.mass'] ?? s.mass).toDouble(),
    stiffness: (patch['0.spring.stiffness'] ?? s.stiffness).toDouble(),
    damping: (patch['0.spring.damping'] ?? s.damping).toDouble(),
  );
  // fling refuses a spring that would oscillate (an assert in debug builds): such values are not tried.
  return next.damping * next.damping < 4 * next.mass * next.stiffness ? s : next;
}

final Map<Curve, String> _curveNames = {
  Curves.linear: 'linear',
  Curves.ease: 'ease',
  Curves.easeIn: 'easeIn',
  Curves.easeOut: 'easeOut',
  Curves.easeInOut: 'easeInOut',
  Curves.fastOutSlowIn: 'fastOutSlowIn',
  Curves.easeOutCubic: 'easeOutCubic',
  Curves.easeInOutCubic: 'easeInOutCubic',
  Curves.easeOutBack: 'easeOutBack',
  Curves.easeInBack: 'easeInBack',
  Curves.elasticOut: 'elasticOut',
  Curves.elasticIn: 'elasticIn',
  Curves.bounceOut: 'bounceOut',
  Curves.bounceIn: 'bounceIn',
  Curves.decelerate: 'decelerate',
  Curves.easeOutQuart: 'easeOutQuart',
  Curves.easeOutExpo: 'easeOutExpo',
  Curves.fastLinearToSlowEaseIn: 'fastLinearToSlowEaseIn',
};

/// `Curves.easeOut` → `easeOut`; anything else as Flutter prints it (`Cubic(0.42, 0.00, 1.00, 1.00)`).
String curveName(Curve c) => _curveNames[c] ?? c.toString();
