import 'call_site.dart';
import 'own_time.dart';
import 'protocol.dart';

/// What a connected inspector receives from the instrumented code (the Dart side of React Native's
/// `__KF_INSPECTOR__` hook).
abstract interface class KfSink {
  /// An animation started. A start's `site` and `frames` come from its stack, printed when they are
  /// first read: a sink that reads them later (the client, when it sends) keeps that work out of the
  /// frame the animation started in.
  void anim(KfCallSite site, List<Object?> args, {List<KfStackFrame>? frames, num? durationMs});
  void signal(KfSignal signal);
  void unsignal(String id);
}

/// One animated value the inspector can sample and write: an AnimationController, a ValueNotifier.
class KfSignal {
  /// `frame` is where it was created when that is known already; `created`, the stack trace taken
  /// where it was created, to be read for it only when [frame] is first asked (see [KfRuntime.register]).
  KfSignal({
    required this.read,
    required this.write,
    this.name,
    KfStackFrame? frame,
    StackTrace? created,
    this.fallbackKey,
    this.beginPlayback,
    this.endPlayback,
    this.source,
    this.owner,
    this.writable = true,
    this.prop,
  }) : _frame = frame,
       _created = created;

  final double Function() read;
  final void Function(double v) write;
  final String? name;

  /// The object behind the value (an AnimationController, a ValueNotifier): how the widget tree's
  /// animated widgets that listen to it are found (visibility, render hints).
  final Object? source;

  /// What created it, when the platform says (a controller's vsync State): where its widgets are when no
  /// animated widget listens to it directly (a `setState` in a listener).
  Object? owner;

  /// False when playback cannot write it back (`InspectorSignalSite.writable`).
  final bool writable;

  /// The property it animates, when known (`InspectorSignalSite.prop`).
  final String? prop;

  /// Where it was created, when the stack trace said. A creation stack trace is read here, once, the
  /// first time it is asked: printing a trace costs far more than taking it, and a value made while no
  /// inspector is installed never needs it.
  KfStackFrame? get frame {
    final trace = _created;
    if (trace != null) {
      _created = null;
      _frame = KfLazyStack.of(trace).appFrame;
    }
    return _frame;
  }

  KfStackFrame? _frame;
  StackTrace? _created;

  /// False while [frame] is a stack trace not read yet.
  bool get located => _created == null;

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
  String get baseKey =>
      frame != null ? '${frame!.uri}:${frame!.line}:${frame!.column}' : 'value:${fallbackKey ?? 'unnamed'}';

  /// Built on first report, so the runtime's appPackage and root are known by then.
  KfSignalSite site(KfRuntime rt) => _site ??= _buildSite(rt);

  KfSignalSite _buildSite(KfRuntime rt) {
    final f = frame;
    final file = f != null ? sourceFile(f.uri, appPackage: rt.appPackage, root: rt.root) : 'unknown';
    final base = f != null ? '$file:${f.line}:${f.column}' : 'value:${fallbackKey ?? 'unnamed'}';
    final n = _slot + 1;
    // A second instance is told apart by number only when it would read the same as another one
    // (two rows from one builder, both "row"); values with names of their own keep them.
    final same = n > 1 && rt.signals.values.any((o) => !identical(o, this) && o.baseKey == baseKey && o.name == name);
    return KfSignalSite(
      id: n == 1 ? base : '$base#$n',
      file: file,
      line: f?.line ?? 0,
      // AOT frames have no column (parsed as 0).
      column: f != null && f.column > 0 ? f.column : null,
      component: f != null ? componentOf(f.member) : null,
      name: name == null || !same ? name : '$name #$n',
      writable: writable,
      prop: prop,
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

  /// True once an inspector is installed (connectKeyframerInspector does it right away, before its
  /// socket connects, and it stays installed while the socket reconnects): the instrumented code only
  /// does work then, including reading the stacks of animation starts.
  bool get active => _sink != null;

  final Map<String, KfSignal> signals = {};
  final Map<String, Set<int>> _slots = {};

  /// Values registered while no inspector is installed whose creation stack is not read yet: they get
  /// their ids, and read their stacks, when one is.
  final List<KfSignal> _unplaced = [];

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
    final waiting = List.of(_unplaced);
    _unplaced.clear();
    for (final s in waiting) {
      _place(s);
    }
    for (final s in [...all, ...waiting]) {
      sink.signal(s);
    }
  }

  void uninstall(KfSink sink) {
    if (identical(_sink, sink)) _sink = null;
  }

  /// Registers a value under its call site, in the first free instance slot, and returns its id. While
  /// no inspector is installed, a value whose creation stack is not read yet waits instead (null): it
  /// is placed by [install], so an app that never connects never reads a creation stack.
  String? register(KfSignal s) {
    if (_sink == null && !s.located) {
      _unplaced.add(s);
      return null;
    }
    return KfOwnTime.measure(() {
      final id = _place(s);
      _sink?.signal(s);
      return id;
    });
  }

  String _place(KfSignal s) {
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
    return id;
  }

  void unregister(KfSignal s) {
    if (_unplaced.remove(s)) return;
    final id = s.id;
    if (id == null) return;
    KfOwnTime.measure(() {
      if (identical(signals[id], s)) signals.remove(id);
      _slots[s.baseKey]?.remove(s._slot);
      s.id = null;
      _sink?.unsignal(id);
    });
  }

  /// `durationMs`: how long it runs, delay included, when known (omitted for loops and physics). `site`
  /// may be worked out only when it is first read (an animation start's, see KfAnimationController).
  void reportAnim(KfCallSite site, List<Object?> args, {List<KfStackFrame>? frames, num? durationMs}) {
    final sink = _sink;
    if (sink != null) KfOwnTime.measure(() => sink.anim(site, args, frames: frames, durationMs: durationMs));
  }

  // ── Navigation ──────────────────────────────────────────────────────────
  KfRoute? _route;
  Object? _screen;
  final Set<void Function(KfRoute)> _routeListeners = {};
  final Set<KfNavigator> _navigators = {};

  /// The screen the app is on (t is unused here: markers place it on the recording's clock).
  KfRoute? get currentRoute => _route;

  /// The app is on `route` now: a navigation marker while recording. `screen` is the screen itself
  /// (KfNavigatorObserver passes the Route): another screen under the same name (two pages without a
  /// name, one route pushed again) is a change too, as are other `params`; the same screen reported
  /// again is not.
  void emitNavigation(String route, [Map<String, Object?>? params, Object? screen]) {
    final was = _route;
    if (was != null && was.route == route && identical(_screen, screen) && _sameParams(was.params, params)) return;
    _route = KfRoute(0, route, params);
    _screen = screen;
    for (final l in _routeListeners.toList()) {
      l(_route!);
    }
  }

  static bool _sameParams(Map<String, Object?>? a, Map<String, Object?>? b) {
    if (a == null || b == null) return a == b;
    if (a.length != b.length) return false;
    for (final e in a.entries) {
      if (!b.containsKey(e.key) || b[e.key] != e.value) return false;
    }
    return true;
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
    _unplaced.clear();
    overrides = {};
    _route = null;
    _screen = null;
    _routeListeners.clear();
    _navigators.clear();
    replay = null;
    scenarios.clear();
    _scenarioListeners.clear();
    appPackage = null;
    root = null;
  }
}
