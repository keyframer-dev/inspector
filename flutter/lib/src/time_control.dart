import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/scheduler.dart';

/// The app's animation clock, for the editor's `time` message: slow motion, pause and step.
///
/// Every ticker in Flutter reads its time from the scheduler's frame time stamp, so changing that clock
/// reaches every animation at once: tracked controllers, plain ones, implicit animations, Hero flights,
/// route transitions and scroll physics. Slow motion is [timeDilation] (what DevTools' "Slow
/// animations" sets). A pause cannot be a dilation (it must be above 0), so while paused the clock
/// stands in front of the scheduler's frame handler and gives every frame the same time stamp; a step
/// moves that time stamp on by one frame at the display's rate. Frames keep coming meanwhile, so the
/// app still builds, lays out and answers touches; only time stands still.
///
/// Process-wide (timeDilation is a global): one per app.
class KfClock {
  KfClock._() : _read = _dispatcherHandler, _write = _setDispatcherHandler;

  /// A clock over another frame handler slot than the platform dispatcher's (tests: Flutter's test
  /// binding drives frames itself and keeps the dispatcher's handler empty).
  @visibleForTesting
  KfClock.forTesting({required ui.FrameCallback? Function() read, required void Function(ui.FrameCallback?) write})
    : _read = read,
      _write = write;

  static final KfClock instance = KfClock._();

  static ui.FrameCallback? _dispatcherHandler() => SchedulerBinding.instance.platformDispatcher.onBeginFrame;
  static void _setDispatcherHandler(ui.FrameCallback? handler) =>
      SchedulerBinding.instance.platformDispatcher.onBeginFrame = handler;

  final ui.FrameCallback? Function() _read;
  final void Function(ui.FrameCallback?) _write;

  double _scale = 1;

  /// timeDilation before the inspector first changed it (DevTools may have set one): put back at 1.
  double? _dilationBefore;

  // While paused: the binding's own frame handler, and the one in front of it.
  ui.FrameCallback? _handler;
  ui.FrameCallback? _front;
  Duration _held = Duration.zero;
  int _steps = 0;
  Duration _frame = const Duration(microseconds: 16667);

  /// The speed now: 1 normal, 0 paused.
  double get scale => _scale;

  /// True while paused with the scheduler's time stamps held (stepping works).
  bool get holding => _front != null;

  /// Runs animations at `scale` (1 normal, 0.25 a quarter of the speed, 0 paused) and returns the
  /// speed now in effect. As the protocol's `time` rules say: below 0.01 is 0.01, above 1 is 1, and a
  /// scale that is not a finite number of at least 0 changes nothing. `hz` is the display's rate, what a
  /// step advances by.
  double setScale(double scale, {double hz = 60}) {
    if (!scale.isFinite || scale < 0) return _scale;
    final next = scale == 0 ? 0.0 : scale.clamp(0.01, 1.0).toDouble();
    if (hz > 0 && hz.isFinite) _frame = Duration(microseconds: (1e6 / hz).round());
    if (next == _scale) return _scale;
    if (next == 0) {
      // Steps advance by whole frames at the display's rate, so no dilation while paused.
      _dilate(1);
      if (!_hold()) {
        // The binding's frame handler could not be reached: a dilation so large that time barely moves
        // stands in for the pause (no stepping then).
        _dilate(1e9);
      }
    } else {
      _release();
      if (next == 1) {
        _restoreDilation();
      } else {
        _dilate(1 / next);
      }
    }
    _scale = next;
    return _scale;
  }

  /// While paused: advances `frames` frames at the display's rate (at most 120), one per frame drawn,
  /// then holds again.
  void step(int frames) {
    if (_front == null || frames < 1) return;
    _steps += frames > 120 ? 120 : frames;
    SchedulerBinding.instance.scheduleFrame();
  }

  void _dilate(double value) {
    _dilationBefore ??= timeDilation;
    if (timeDilation != value) timeDilation = value;
  }

  void _restoreDilation() {
    final before = _dilationBefore;
    _dilationBefore = null;
    if (before != null && timeDilation != before) timeDilation = before;
  }

  bool _hold() {
    if (_front != null) return true;
    final binding = SchedulerBinding.instance;
    // Scheduling a frame registers the binding's frame handlers when they are not yet.
    binding.scheduleFrame();
    final handler = _read();
    if (handler == null) return false;
    // From the last frame's time stamp: the next frame shows the moment the pause began.
    _held = binding.currentSystemFrameTimeStamp;
    _steps = 0;
    _handler = handler;
    _front = _beginFrame;
    _write(_front);
    return true;
  }

  void _beginFrame(Duration raw) {
    final handler = _handler;
    if (handler == null) return;
    var more = false;
    if (_steps > 0) {
      _steps--;
      _held += _frame;
      more = _steps > 0;
    }
    handler(_held);
    if (more) SchedulerBinding.instance.scheduleFrame();
  }

  void _release() {
    final front = _front;
    if (front == null) return;
    final binding = SchedulerBinding.instance;
    // Another handler put in front since (a tool) stays: only ours is taken away.
    if (identical(_read(), front)) _write(_handler);
    _front = null;
    _handler = null;
    _steps = 0;
    // The engine's time stamps again, counted from where the held clock stopped: no jump forward.
    binding.resetEpoch();
    binding.scheduleFrame();
  }
}
