/// The inspector's own time on the UI isolate, for the frame meter's `inspectorMs` (how long the
/// inspector worked during a long frame, so the analysis can tell its drops from the app's).
///
/// Each of the inspector's entry points (an animation start, a status listener, the per-frame sampling,
/// the scene's looks, the navigator observer, the editor's messages, the batches going out) runs inside
/// [measure]; only the outermost one is timed when they nest, and the app code an entry point calls
/// back into (the controller's own start, a replay, a value written during playback) is left out with
/// [notOurs]. The frame meter takes what built up over each frame with [take]. One isolate, one count:
/// Dart runs one section at a time, so a stack of what is running says whose time it is.
abstract final class KfOwnTime {
  static final Stopwatch _stopwatch = Stopwatch()..start();

  /// Microseconds on a monotonic clock. Tests put a fake one here.
  static int Function() clock = _elapsed;

  static int _elapsed() => _stopwatch.elapsedMicroseconds;

  // Whose time it is, innermost last: true for the inspector's, false for the app's inside it.
  static final List<bool> _sections = [];
  static int _since = 0;
  static int _total = 0;

  static bool get _ours => _sections.isNotEmpty && _sections.last;

  /// Runs `body`, counting its time as the inspector's.
  static T measure<T>(T Function() body) {
    _enter(true);
    try {
      return body();
    } finally {
      _exit();
    }
  }

  /// Runs `body`, the app's code called from inside [measure], without counting it.
  static T notOurs<T>(T Function() body) {
    if (_sections.isEmpty) return body();
    _enter(false);
    try {
      return body();
    } finally {
      _exit();
    }
  }

  // The clock is read only where whose time it is changes: a section inside one of its own kind costs
  // a list entry.
  static void _enter(bool ours) {
    if (ours != _ours) _switch();
    _sections.add(ours);
  }

  static void _exit() {
    final was = _sections.removeLast();
    if (was != _ours) _switch(counted: was);
  }

  static void _switch({bool? counted}) {
    final now = clock();
    if (counted ?? _ours) _total += now - _since;
    _since = now;
  }

  /// The inspector's time since the last call, in ms (a section still running counts up to now).
  static double take() {
    if (_ours) _switch();
    final us = _total;
    _total = 0;
    return us / 1000;
  }
}
