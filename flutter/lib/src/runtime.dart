import 'call_site.dart';
import 'protocol.dart';

/// What a connected inspector receives from the instrumented code (the Dart side of React Native's
/// `__KF_INSPECTOR__` hook).
abstract interface class KfSink {
  void anim(KfCallSite site, List<Object?> args, {List<KfStackFrame>? frames, num? durationMs});
  void signal(KfSignal signal);
  void unsignal(String id);
}

/// One animated value the inspector can sample and write: an AnimationController, a ValueNotifier.
class KfSignal {
  KfSignal({
    required this.read,
    required this.write,
    this.name,
    this.frame,
    this.fallbackKey,
    this.beginPlayback,
    this.endPlayback,
  });

  final double Function() read;
  final void Function(double v) write;
  final String? name;

  /// Where it was created, when the stack trace said.
  final KfStackFrame? frame;

  /// Stands in for the location when there is no frame (split debug info): the name, or a counter.
  final String? fallbackKey;

  /// Playback takes the value over: stop what drives it. [endPlayback] hands it back.
  final void Function()? beginPlayback;
  final void Function()? endPlayback;

  /// The instance id once registered: the site id, then `<site>#2`, `<site>#3` for more instances.
  String? id;
  int _slot = 0;
  KfSignalSite? _site;

  /// The call site's own key, before instances are told apart.
  String get baseKey => frame != null ? '${frame!.uri}:${frame!.line}:${frame!.column}' : 'value:${fallbackKey ?? 'unnamed'}';

  /// Built on first report, so the runtime's appPackage and root are known by then.
  KfSignalSite site(KfRuntime rt) => _site ??= _buildSite(rt);

  KfSignalSite _buildSite(KfRuntime rt) {
    final f = frame;
    final file = f != null ? sourceFile(f.uri, appPackage: rt.appPackage, root: rt.root) : 'unknown';
    final base = f != null ? '$file:${f.line}:${f.column}' : 'value:${fallbackKey ?? 'unnamed'}';
    final n = _slot + 1;
    return KfSignalSite(
      id: n == 1 ? base : '$base#$n',
      file: file,
      line: f?.line ?? 0,
      // AOT frames have no column (parsed as 0).
      column: f != null && f.column > 0 ? f.column : null,
      component: f != null ? componentOf(f.member) : null,
      name: name == null ? null : (n == 1 ? name : '$name #$n'),
    );
  }
}

typedef KfNavigator = bool Function(String route, Map<String, Object?>? params);
typedef KfScenario = Future<void> Function();

/// Process-wide state the instrumented code reports into, whether or not an inspector is connected
/// yet: one connected later still gets every value that exists.
class KfRuntime {
  KfRuntime();

  static final KfRuntime instance = KfRuntime();

  /// The app's package name: `package:<appPackage>/x.dart` is reported as `lib/x.dart`.
  String? appPackage;

  /// The project root on disk, for `file://` frames.
  String? root;

  KfSink? _sink;
  KfSink? get sink => _sink;

  /// True while an inspector is connected: the instrumented code only does work then.
  bool get active => _sink != null;

  final Map<String, KfSignal> signals = {};
  final Map<String, Set<int>> _slots = {};

  /// Live edits by call site id, param path → value (`InspectorOverrides`).
  Map<String, Map<String, num>> overrides = {};

  void install(KfSink sink) {
    _sink = sink;
    // Values created before appPackage and root were set get their ids again.
    final all = signals.values.toList();
    signals.clear();
    for (final s in all) {
      s._site = null;
      s.id = s.site(this).id;
      signals[s.id!] = s;
    }
    for (final s in all) {
      sink.signal(s);
    }
  }

  void uninstall(KfSink sink) {
    if (identical(_sink, sink)) _sink = null;
  }

  /// Registers a value under its call site, in the first free instance slot. Returns its id.
  String register(KfSignal s) {
    final taken = _slots.putIfAbsent(s.baseKey, () => <int>{});
    var n = 0;
    while (taken.contains(n)) {
      n++;
    }
    taken.add(n);
    s._slot = n;
    s._site = null;
    final id = s.site(this).id;
    s.id = id;
    signals[id] = s;
    _sink?.signal(s);
    return id;
  }

  void unregister(KfSignal s) {
    final id = s.id;
    if (id == null) return;
    if (identical(signals[id], s)) signals.remove(id);
    _slots[s.baseKey]?.remove(s._slot);
    s.id = null;
    _sink?.unsignal(id);
  }

  /// `durationMs`: how long it runs, delay included, when known (omitted for loops and physics).
  void reportAnim(KfCallSite site, List<Object?> args, {List<KfStackFrame>? frames, num? durationMs}) =>
      _sink?.anim(site, args, frames: frames, durationMs: durationMs);

  // ── Navigation ──────────────────────────────────────────────────────────
  KfRoute? _route;
  final Set<void Function(KfRoute)> _routeListeners = {};
  final Set<KfNavigator> _navigators = {};

  /// The screen the app is on (t is unused here: markers place it on the recording's clock).
  KfRoute? get currentRoute => _route;

  void emitNavigation(String route, [Map<String, Object?>? params]) {
    if (_route?.route == route) return;
    _route = KfRoute(0, route, params);
    for (final l in _routeListeners.toList()) {
      l(_route!);
    }
  }

  void Function() tapNavigation(void Function(KfRoute) fn) {
    _routeListeners.add(fn);
    return () => _routeListeners.remove(fn);
  }

  void Function() registerNavigator(KfNavigator go) {
    _navigators.add(go);
    return () => _navigators.remove(go);
  }

  /// Takes the app to `route` when it is on another screen. True when it navigated.
  bool navigateTo(String route, [Map<String, Object?>? params]) {
    if (_navigators.isEmpty || _route?.route == route) return false;
    var went = false;
    for (final go in _navigators.toList()) {
      try {
        went = go(route, params) || went;
      } catch (_) {
        // A navigator that does not know the route: the next one may.
      }
    }
    return went;
  }

  // ── Replay and scenarios ────────────────────────────────────────────────
  void Function()? replay;
  final Map<String, KfScenario> scenarios = {};
  final Set<void Function(List<String>)> _scenarioListeners = {};

  List<String> get scenarioNames => scenarios.keys.toList();

  void Function() registerScenario(String name, KfScenario run) {
    scenarios[name] = run;
    _notifyScenarios();
    return () {
      if (identical(scenarios[name], run)) {
        scenarios.remove(name);
        _notifyScenarios();
      }
    };
  }

  void Function() watchScenarios(void Function(List<String>) fn) {
    _scenarioListeners.add(fn);
    return () => _scenarioListeners.remove(fn);
  }

  void _notifyScenarios() {
    final names = scenarioNames;
    for (final l in _scenarioListeners.toList()) {
      l(names);
    }
  }

  /// Forgets everything (tests).
  void reset() {
    _sink = null;
    signals.clear();
    _slots.clear();
    overrides = {};
    _route = null;
    _routeListeners.clear();
    _navigators.clear();
    replay = null;
    scenarios.clear();
    _scenarioListeners.clear();
    appPackage = null;
    root = null;
  }
}
