import 'protocol.dart';

/// Counts one thread's frames while a recording runs: its frame rate per window and every long frame.
/// A port of react-native/src/frameMeter.ts, so both runtimes judge frames the same way.
///
/// [tick] is the React Native meter: a frame loop calls it every frame, and a gap of more than one
/// refresh interval is a long frame. [tickCost] is for the raster thread, whose FrameTiming says how
/// long each frame took to draw: a frame is long when drawing it took more than an interval, whatever
/// the gap before it (a gap there means the UI thread had nothing ready, which the UI meter reports).
///
/// Without a [display] the interval is learned from the frames (60, 90 or 120 Hz), as React Native's
/// meter does. With one, frames are counted against its rate: a fixed rate is the budget (8.3 ms at
/// 120 Hz), and an adaptive one (ProMotion) is learned but never faster than the display runs.
class FrameMeter {
  FrameMeter(this.thread, {this.windowMs = 250, double refreshRate = 60, KfDisplay? display})
    : interval = 1000 / (display == null || display.hz <= 0 ? refreshRate : _startRate(display)),
      _display = display;

  /// A fixed display's own rate; an adaptive one starts at 60 Hz (or lower, when it runs slower) and
  /// learns upward, as React Native's meter does, so its first window is not judged against 120 Hz.
  static double _startRate(KfDisplay d) => !d.adaptive || d.hz < 60 ? d.hz.toDouble() : 60;

  final String thread;
  final double windowMs;
  double interval;
  KfDisplay? _display;

  /// The display frames are counted against; set when its rate changes while recording.
  KfDisplay? get display => _display;
  set display(KfDisplay? d) {
    _display = d;
    if (d != null && d.hz > 0 && (!d.adaptive || interval < 1000 / d.hz)) interval = 1000 / d.hz;
  }

  double _last = -1;
  double _windowStart = -1;
  int _frames = 0;
  int _dropped = 0;
  int _fast = 0;
  int _mid = 0;
  final List<KfFrameStat> stats = [];
  final List<KfFrameDrop> drops = [];

  /// A frame of the frame loop was handled at `t` (ms).
  void tick(double t) {
    final last = _last;
    _last = t;
    if (last < 0) {
      _windowStart = t;
      return;
    }
    final dt = t - last;
    if (dt <= 0) return;
    _classify(dt);
    final lost = (dt / interval).round() - 1;
    if (lost > 0) {
      _dropped += lost;
      drops.add(KfFrameDrop(t: _round(t), thread: thread, ms: _tenth(dt), dropped: lost));
    }
    _count(t);
  }

  /// A frame finished drawing at `t` (ms) after `costMs` of work on this thread.
  void tickCost(double t, double costMs) {
    final last = _last;
    _last = t;
    if (last < 0) {
      _windowStart = t;
    } else {
      final dt = t - last;
      if (dt <= 0) return;
      _classify(dt);
    }
    // 1 ms of slack: a frame that takes exactly its budget still makes its vsync.
    final lost = ((costMs - 1) / interval).ceil() - 1;
    if (lost > 0) {
      _dropped += lost;
      drops.add(KfFrameDrop(t: _round(t), thread: thread, ms: _tenth(costMs), dropped: lost));
    }
    if (last >= 0) _count(t);
  }

  void _classify(double dt) {
    if (dt < 10.5) {
      _fast += 1;
    } else if (dt < 13) {
      _mid += 1;
    }
  }

  void _count(double t) {
    _frames += 1;
    final span = t - _windowStart;
    if (span >= windowMs) {
      stats.add(KfFrameStat(t: _round(t), thread: thread, fps: (_frames * 1000 / span).round(), dropped: _dropped));
      final n = _frames;
      final d = _display;
      if (d == null || d.adaptive || d.hz <= 0) {
        // The refresh interval is what most frames of the window took, snapped to 60/90/120 Hz, and no
        // shorter than the display's own.
        final learned =
            _fast * 2 > n
                ? 1000 / 120
                : (_fast + _mid) * 2 > n
                ? 1000 / 90
                : 1000 / 60;
        interval = d != null && d.hz > 0 && learned < 1000 / d.hz ? 1000 / d.hz : learned;
      }
      _frames = 0;
      _dropped = 0;
      _fast = 0;
      _mid = 0;
      _windowStart = t;
    }
  }

  /// Takes what finished since the last call.
  (List<KfFrameStat>, List<KfFrameDrop>) drain() {
    final out = (List.of(stats), List.of(drops));
    stats.clear();
    drops.clear();
    return out;
  }
}

num _round(double t) => t.round();
num _tenth(double ms) => (ms * 10).round() / 10;
