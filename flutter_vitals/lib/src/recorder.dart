// The counters of one session window, and the recent motion they are attributed to. Pure Dart: times are
// milliseconds on one monotonic clock (the engine's FrameTiming clock, which is Dart's Timeline clock),
// so tests drive it directly.
//
// FrameTiming arrives in batches (about once a second in release), after the frames it describes. So
// what was moving is kept as a short log of intervals (animation runs, pointer and scroll windows,
// navigations, screen changes) and each frame is matched against it when its timing arrives.

import 'dart:math' as math;

import 'protocol.dart';

/// A binary image `native` refs point into: the Dart AOT snapshot. An ELF shared library on Android
/// (`libapp.so`); on iOS current Flutter builds it straight into a Mach-O dylib (`App.framework/App`,
/// gen_snapshot's `app-aot-macho-dylib`) whose LC_UUID is the build id the stack traces print.
class VitalsImageSpec {
  const VitalsImageSpec({required this.debugId, required this.name, this.kind = 'elf', this.arch});

  final String debugId;
  final String name;

  /// `elf` or `macho`.
  final String kind;
  final String? arch;

  Map<String, Object?> toJson() => {'debugId': debugId, 'kind': kind, 'name': name, if (arch != null) 'arch': arch};
}

/// A call site: one per place in the code, however many controllers it creates.
class VitalsSiteSpec {
  VitalsSiteSpec({
    required this.id,
    required this.ref,
    required this.fn,
    this.key,
    this.component,
    this.prop,
    this.image,
  });

  /// Identity within the session: `n:card`, `s:lib/card.dart:42:7`, `v:<build id>:<offset>`.
  final String id;

  /// The `ref` as sent, minus the image index of a `native` ref (set when the report is encoded).
  final Map<String, Object?> ref;
  final String fn;
  final String? key;
  final String? component;
  final String? prop;
  final VitalsImageSpec? image;
}

/// One run of an animation: from its start to its estimated end, or until it is stopped.
class MotionRun {
  MotionRun(this.site, this.start, this.end, {this.reduceMotion = false}) : _credited = start;

  final VitalsSiteSpec site;
  final double start;

  /// Estimated end; infinite for loops and runs of unknown length, until [stop].
  double end;
  final bool reduceMotion;

  /// Active time up to here is already in a window's counters.
  double _credited;

  void stop(double t) {
    if (t < end) end = math.max(start, t);
  }
}

/// One frame from FrameTiming: when its vsync started and its raster finished, and each thread's cost.
class VitalsFrame {
  const VitalsFrame({required this.start, required this.end, required this.buildMs, required this.rasterMs});

  final double start;
  final double end;

  /// The UI isolate's work: the `js` role.
  final double buildMs;

  /// The raster thread's work: the `ui` role.
  final double rasterMs;
}

class _Thread {
  int frames = 0;
  final List<int> hist = List.filled(vitalsBuckets.length, 0);
  int frozen = 0;
  double hitchMs = 0;
  int idleFrames = 0;
  int idleMissed = 0;

  void add(double ms, int missed, double budget, bool idle) {
    frames += 1;
    hist[bucketOf(missed)] += 1;
    if (ms >= vitalsFrozenMs) frozen += 1;
    hitchMs += math.max(0, ms - budget);
    if (idle) {
      idleFrames += 1;
      idleMissed += missed;
    }
  }

  Map<String, Object?> toJson() => {
    'frames': frames,
    'hist': List.of(hist),
    'frozen': frozen,
    'hitchMs': _tenth(hitchMs),
    'idleFrames': idleFrames,
    'idleMissed': idleMissed,
  };
}

class _Screen {
  double ms = 0;
  final _Thread js = _Thread();
  final _Thread ui = _Thread();
}

class _Site {
  _Site(this.spec);

  final VitalsSiteSpec spec;
  int runs = 0;
  int runsReduceMotion = 0;
  double activeMs = 0;
  int frames = 0;
  int missed = 0;
  double hitchMs = 0;
  double worstMs = 0;
  final Map<String, double> msByScreen = {};
  String? firstScreen;
}

class _Worst {
  _Worst(this.thread, this.ms, this.missed, this.screen, this.sites, this.cause, this.afterNavMs);

  final String thread;
  final double ms;
  final int missed;
  final String screen;
  final List<String> sites;
  final String cause;
  final double? afterNavMs;
}

class _Span {
  _Span(this.start) : end = double.infinity;

  final double start;
  double end;
}

/// Learns the rate frames are counted against, as the inspector's FrameMeter does: from the gaps
/// between consecutive frames, snapped to 60, 90 or 120 Hz, never faster than the display. A fixed
/// display's own rate is the budget.
class RateLearner {
  RateLearner({required double hz, required this.adaptive}) : _hz = hz <= 0 ? 60 : hz {
    interval = 1000 / (adaptive && _hz >= 60 ? 60 : _hz);
  }

  double _hz;
  bool adaptive;
  late double interval;
  int _n = 0, _fast = 0, _mid = 0;
  double _last = -1;

  double get displayHz => _hz;

  void setDisplay(double hz, bool adaptive) {
    if (hz <= 0) return;
    _hz = hz;
    this.adaptive = adaptive;
    if (!adaptive || interval < 1000 / hz) interval = 1000 / hz;
  }

  /// A frame whose vsync started at `t`; returns the interval (ms) it is judged against.
  double feed(double t) {
    final last = _last;
    _last = t;
    if (!adaptive || last < 0) return interval;
    final dt = t - last;
    // Only consecutive frames say anything about the rate: a gap after idle time does not.
    if (dt <= 0 || dt > 40) return interval;
    _n += 1;
    if (dt < 10.5) {
      _fast += 1;
    } else if (dt < 13) {
      _mid += 1;
    }
    if (_n >= 15) {
      final learned =
          _fast * 2 > _n
              ? 1000 / 120
              : (_fast + _mid) * 2 > _n
              ? 1000 / 90
              : 1000 / 60;
      interval = learned < 1000 / _hz ? 1000 / _hz : learned;
      _n = _fast = _mid = 0;
    }
    return interval;
  }
}

/// Frames missed by a frame that cost `costMs` of a thread's time against `budget` (cost-based, with
/// 1 ms of slack: a frame that takes exactly its budget makes its vsync). The inspector's tickCost.
int missedByCost(double costMs, double budget) => math.max(0, ((costMs - 1) / budget).ceil() - 1);

/// How long a pointer window stays open after the last finger lifts (scroll deceleration).
const double pointerTailMs = 1500;

/// Frames this soon after a navigation are a `screen-mount` cause.
const double screenMountMs = 500;

/// Starts within a frame or this long before it count toward a `burst`.
const double burstLeadMs = 50;
const int burstCount = 6;

/// How long the log keeps what has ended: FrameTiming batches arrive within about a second.
const double logKeepMs = 10000;

class VitalsRecorder {
  VitalsRecorder({required double displayHz, bool adaptive = false, required double now, String screen = '(none)'})
    : _rate = RateLearner(hz: displayHz, adaptive: adaptive),
      _screens = [(double.negativeInfinity, screen)],
      _windowStart = now,
      _screenSince = now,
      _currentScreen = screen;

  final RateLearner _rate;

  // The log, kept across windows.
  final List<(double, String)> _screens;
  final List<double> _navs = [];
  final List<MotionRun> _runs = [];
  final List<_Span> _pointers = [];
  final List<_Span> _scrolls = [];
  int _down = 0;
  _Span? _pointer;
  int _scrolling = 0;
  _Span? _scroll;

  // The window's counters.
  double _windowStart;
  String _currentScreen;
  double _screenSince;
  final Map<String, _Screen> _screenStats = {};
  final Map<String, _Site> _sites = {};
  final List<_Worst> _worst = [];
  double _measuredMs = 0;
  double _lastFrameStart = -1;
  final Map<int, int> _targetHz = {};
  bool reduceMotionSeen = false;
  bool _dirty = false;

  double get windowStart => _windowStart;
  String get currentScreen => _currentScreen;
  RateLearner get rate => _rate;

  /// Whether anything was counted since the last [markClean]: the checkpoint skips an unchanged window.
  bool get dirty => _dirty;
  void markClean() => _dirty = false;

  /// The app is on `name` from `t`. Same name: nothing changes.
  void screen(String name, double t) {
    if (name == _currentScreen) return;
    _creditScreen(t);
    _currentScreen = name;
    _screens.add((t, name));
    _dirty = true;
  }

  /// A navigation happened at `t` (a push, a pop, a replace): frames within 500 ms are `screen-mount`.
  void navigation(double t) => _navs.add(t);

  /// An animation of `site` started at `t`, estimated to end at `end` (infinite when unknown).
  MotionRun runStart(VitalsSiteSpec site, double t, {double end = double.infinity, bool reduceMotion = false}) {
    final run = MotionRun(site, t, end, reduceMotion: reduceMotion);
    _runs.add(run);
    final s = _site(site);
    s.runs += 1;
    if (reduceMotion) s.runsReduceMotion += 1;
    _dirty = true;
    return run;
  }

  void pointerDown(double t) {
    _down += 1;
    if (_pointer == null || _pointer!.end < t) {
      _pointer = _Span(t);
      _pointers.add(_pointer!);
    } else {
      _pointer!.end = double.infinity;
    }
  }

  void pointerUp(double t) {
    if (_down > 0) _down -= 1;
    if (_down == 0 && _pointer != null) _pointer!.end = t + pointerTailMs;
  }

  void scrollStart(double t) {
    _scrolling += 1;
    if (_scroll == null || _scroll!.end < t) {
      _scroll = _Span(t);
      _scrolls.add(_scroll!);
    } else {
      _scroll!.end = double.infinity;
    }
  }

  void scrollEnd(double t) {
    if (_scrolling > 0) _scrolling -= 1;
    if (_scrolling == 0 && _scroll != null) _scroll!.end = t;
  }

  /// The display changed (another screen, a new rate).
  void display(double hz, bool adaptive) => _rate.setDisplay(hz, adaptive);

  /// One frame's timing.
  void frame(VitalsFrame f) {
    final budget = _rate.feed(f.start);
    final dt = _lastFrameStart < 0 ? -1 : f.start - _lastFrameStart;
    _lastFrameStart = f.start;
    _measuredMs += dt > 0 ? math.min(dt, 100) : budget;
    final hz = (1000 / budget).round();
    _targetHz[hz] = (_targetHz[hz] ?? 0) + 1;

    final screen = _screenAt(f.start);
    final stats = _screenStats.putIfAbsent(screen, _Screen.new);
    final active = <VitalsSiteSpec>{};
    for (final r in _runs) {
      if (r.start < f.end && r.end > f.start) active.add(r.site);
    }
    final idle = active.isEmpty;
    final jsMissed = missedByCost(f.buildMs, budget);
    final uiMissed = missedByCost(f.rasterMs, budget);
    stats.js.add(f.buildMs, jsMissed, budget, idle);
    stats.ui.add(f.rasterMs, uiMissed, budget, idle);

    final ui = f.rasterMs >= f.buildMs;
    final ms = ui ? f.rasterMs : f.buildMs;
    final missed = math.max(jsMissed, uiMissed);
    final hitch = math.max(0.0, ms - budget);
    for (final spec in active) {
      final s = _site(spec);
      s.frames += 1;
      s.missed += missed;
      s.hitchMs += hitch;
      if (ms > s.worstMs) s.worstMs = ms;
    }
    if (missed > 0) _considerWorst(f, ui ? 'ui' : 'js', ms, missed, screen, active);
    _dirty = true;
    _prune(f.end);
  }

  void _considerWorst(VitalsFrame f, String thread, double ms, int missed, String screen, Set<VitalsSiteSpec> active) {
    if (_worst.length >= vitalsWorstFrames && ms <= _worst.last.ms) return;
    final (cause, afterNav) = causeOf(f);
    _worst.add(_Worst(thread, ms, missed, screen, [for (final s in active) s.id], cause, afterNav));
    _worst.sort((a, b) => b.ms.compareTo(a.ms));
    if (_worst.length > vitalsWorstFrames) _worst.removeLast();
  }

  /// Why a slow frame was slow, with the light-mode rules of production.md 1: a navigation within
  /// 500 ms before it ended, then 6 or more animations starting in it or 50 ms before, then a scroll or
  /// a touch window with no animation starting.
  (String, double?) causeOf(VitalsFrame f) {
    double? afterNav;
    for (final n in _navs) {
      final d = f.end - n;
      if (d >= 0 && d <= screenMountMs && (afterNav == null || d < afterNav)) afterNav = d;
    }
    if (afterNav != null) return ('screen-mount', afterNav.roundToDouble());
    final started = <String>{};
    for (final r in _runs) {
      if (r.start >= f.start - burstLeadMs && r.start <= f.end) started.add(r.site.id);
    }
    if (started.length >= burstCount) return ('burst', null);
    if (started.isEmpty) {
      bool open(List<_Span> spans) => spans.any((s) => s.start <= f.end && s.end >= f.start);
      if (open(_scrolls)) return ('scroll', null);
      if (open(_pointers)) return ('gesture', null);
    }
    return ('unknown', null);
  }

  String _screenAt(double t) {
    for (var i = _screens.length - 1; i >= 0; i--) {
      if (_screens[i].$1 <= t) return _screens[i].$2;
    }
    return _screens.first.$2;
  }

  _Site _site(VitalsSiteSpec spec) => _sites.putIfAbsent(spec.id, () => _Site(spec)..firstScreen = _currentScreen);

  void _creditScreen(double t) {
    if (t > _screenSince) _screenStats.putIfAbsent(_currentScreen, _Screen.new).ms += t - _screenSince;
    _screenSince = math.max(_screenSince, t);
  }

  /// Active time of each run up to `t`, into the window's site counters, by the screen it started on.
  void _creditRuns(double t) {
    for (final r in _runs) {
      final from = math.max(r._credited, _windowStart);
      final to = math.min(r.end, t);
      if (to > from) {
        final s = _site(r.site);
        s.activeMs += to - from;
        final screen = _screenAt(r.start);
        s.msByScreen[screen] = (s.msByScreen[screen] ?? 0) + to - from;
      }
      if (to > r._credited) r._credited = to;
    }
  }

  /// Forgets what ended long enough ago that no frame still to arrive can fall in it.
  void _prune(double now) {
    final cutoff = now - logKeepMs;
    if (_runs.any((r) => r.end < cutoff)) {
      _creditRuns(cutoff);
      _runs.removeWhere((r) => r.end < cutoff);
    }
    _navs.removeWhere((n) => n < cutoff);
    _pointers.removeWhere((s) => s.end < cutoff);
    _scrolls.removeWhere((s) => s.end < cutoff);
    // The screen at the cutoff stays: frames after it still need it.
    while (_screens.length > 1 && _screens[1].$1 <= cutoff) {
      _screens.removeAt(0);
    }
  }

  /// The window's part of a report as of `t`, at most `maxSites` sites. Counters keep going: call
  /// [reset] when the window closes (a checkpoint does not).
  WindowBody snapshot(double t, {int maxSites = vitalsMaxSites}) {
    _creditScreen(t);
    _creditRuns(t);
    return _encode(t, maxSites);
  }

  /// A new window from `t`. The log stays: runs still going continue into it.
  void reset(double t) {
    _windowStart = t;
    _screenSince = t;
    _screenStats.clear();
    _sites.clear();
    _worst.clear();
    _measuredMs = 0;
    _lastFrameStart = -1;
    _targetHz.clear();
    reduceMotionSeen = false;
    _dirty = false;
  }

  WindowBody _encode(double t, int maxSites) {
    // Screens: the longest 40, the rest folded into one.
    final names = _screenStats.keys.toList()..sort((a, b) => _screenStats[b]!.ms.compareTo(_screenStats[a]!.ms));
    final index = <String, int>{};
    for (var i = 0; i < names.length; i++) {
      index[names[i]] = math.min(i, vitalsMaxScreens - 1);
    }
    final screens = <Map<String, Object?>>[];
    final merged = <int, _Screen>{};
    for (final n in names) {
      final i = index[n]!;
      final s = _screenStats[n]!;
      var into = merged[i];
      if (into == null) {
        // A copy: a checkpoint encodes without resetting, so the counters themselves stay as they are.
        into = merged[i] = _Screen();
        screens.add({'name': i == vitalsMaxScreens - 1 && names.length > vitalsMaxScreens ? '(other)' : n});
      }
      into.ms += s.ms;
      _mergeThread(into.js, s.js);
      _mergeThread(into.ui, s.ui);
    }
    for (var i = 0; i < screens.length; i++) {
      final s = merged[i]!;
      screens[i]['ms'] = s.ms.round();
      screens[i]['threads'] = {if (s.js.frames > 0) 'js': s.js.toJson(), if (s.ui.frames > 0) 'ui': s.ui.toJson()};
    }
    int screenIndex(String? name) {
      final i = name == null ? null : index[name];
      if (i != null) return i;
      if (screens.isEmpty) {
        screens.add({'name': _currentScreen, 'ms': 0, 'threads': <String, Object?>{}});
        index[_currentScreen] = 0;
      }
      return index[_currentScreen] ?? 0;
    }

    // Sites: those that ran or drew frames, the most frames first, at most 200.
    final sites =
        _sites.values.where((s) => s.runs > 0 || s.frames > 0 || s.activeMs > 0).toList()
          ..sort((a, b) => (b.frames + b.missed).compareTo(a.frames + a.missed));
    if (sites.length > maxSites) sites.removeRange(maxSites, sites.length);
    final images = <String, int>{};
    final imageList = <Map<String, Object?>>[];
    final siteIndex = <String, int>{};
    final siteJson = <Map<String, Object?>>[];
    for (final s in sites) {
      var ref = s.spec.ref;
      final img = s.spec.image;
      if (img != null) {
        final i = images.putIfAbsent(img.debugId, () {
          imageList.add(img.toJson());
          return imageList.length - 1;
        });
        ref = {...ref, 'image': i};
      }
      String? where;
      var most = -1.0;
      s.msByScreen.forEach((k, v) {
        if (v > most) {
          most = v;
          where = k;
        }
      });
      siteIndex[s.spec.id] = siteJson.length;
      siteJson.add({
        'ref': ref,
        if (s.spec.key != null) 'key': s.spec.key,
        'fn': s.spec.fn,
        'component': s.spec.component,
        'prop': s.spec.prop,
        'screen': screenIndex(where ?? s.firstScreen),
        'runs': s.runs,
        'activeMs': s.activeMs.round(),
        'frames': s.frames,
        'missed': s.missed,
        'hitchMs': _tenth(s.hitchMs),
        'worstMs': _tenth(s.worstMs),
        if (s.runsReduceMotion > 0) 'runsReduceMotion': s.runsReduceMotion,
      });
    }
    final worst = [
      for (final w in _worst)
        {
          'thread': w.thread,
          'ms': _tenth(w.ms),
          'missed': w.missed,
          'screen': screenIndex(w.screen),
          'sites': [
            for (final id in w.sites)
              if (siteIndex[id] != null) siteIndex[id]!,
          ],
          'cause': w.cause,
          if (w.afterNavMs != null) 'afterNavMs': w.afterNavMs!.round(),
        },
    ];
    var target = 0, most = -1;
    _targetHz.forEach((hz, n) {
      if (n > most) {
        most = n;
        target = hz;
      }
    });
    return WindowBody(
      screens: screens,
      sites: siteJson,
      worst: worst,
      images: imageList,
      foregroundMs: math.max(0, t - _windowStart),
      measuredMs: _measuredMs,
      targetHz: target > 0 ? target : (1000 / _rate.interval).round(),
      reduceMotion: reduceMotionSeen,
    );
  }

  static void _mergeThread(_Thread into, _Thread from) {
    into.frames += from.frames;
    for (var i = 0; i < into.hist.length; i++) {
      into.hist[i] += from.hist[i];
    }
    into.frozen += from.frozen;
    into.hitchMs += from.hitchMs;
    into.idleFrames += from.idleFrames;
    into.idleMissed += from.idleMissed;
  }
}

/// What a window contributes to a report.
class WindowBody {
  WindowBody({
    required this.screens,
    required this.sites,
    required this.worst,
    required this.images,
    required this.foregroundMs,
    required this.measuredMs,
    required this.targetHz,
    required this.reduceMotion,
  });

  final List<Map<String, Object?>> screens;
  final List<Map<String, Object?>> sites;
  final List<Map<String, Object?>> worst;
  final List<Map<String, Object?>> images;
  final double foregroundMs;
  final double measuredMs;
  final int targetHz;
  final bool reduceMotion;
}

num _tenth(double v) {
  final r = (v * 10).round() / 10;
  return r == r.roundToDouble() ? r.round() : r;
}
