import 'package:flutter/scheduler.dart';
import 'package:flutter/widgets.dart';

import 'heroes.dart';
import 'own_time.dart';
import 'protocol.dart';
import 'runtime.dart';

/// Reports the screen the app is on (navigation markers) and takes it back to a recorded screen during
/// playback, scrubbing and export. Add it to your app: `navigatorObservers: [kfNavigatorObserver]`.
///
/// Screens are page routes, named by `RouteSettings.name`, or by the route's type when it has none
/// (`MaterialPageRoute`); a [KeyframerScreen] in the page names it instead. Each page is a screen of
/// its own, so two pages under one name in a row are two markers. Dialogs and popups are not screens.
/// What changes within a frame is reported at its end, as one marker.
///
/// One observer watches one navigator: a nested navigator (a tab's own stack) needs a
/// `KfNavigatorObserver()` of its own.
///
/// It also reports Hero flights between two screens (an animation for each, with the destination
/// Hero's location), which the SDK cannot see otherwise, and tells the recording which screens are
/// covered by another one.
class KfNavigatorObserver extends NavigatorObserver {
  KfNavigatorObserver({KfRuntime? runtime}) : runtime = runtime ?? KfRuntime.instance {
    _live.add(WeakReference(this));
  }

  final KfRuntime runtime;
  final List<Route<dynamic>> _stack = [];
  void Function()? _unregister;

  /// `RouteSettings.name`, else the route's type without its type arguments: `MaterialPageRoute`, the
  /// same for every page pushed with `MaterialPageRoute(builder: ...)`.
  static String routeName(Route<dynamic> r) =>
      r.settings.name ?? r.runtimeType.toString().replaceFirst(_typeArguments, '');

  @override
  void didPush(Route<dynamic> route, Route<dynamic>? previousRoute) => KfOwnTime.measure(() {
    if (route is PageRoute) _stack.add(route);
    _changed();
    _flights(previousRoute, route, push: true);
  });

  @override
  void didPop(Route<dynamic> route, Route<dynamic>? previousRoute) => KfOwnTime.measure(() {
    _stack.remove(route);
    _changed();
    _flights(route, previousRoute, push: false);
  });

  /// Hero flights between two screens, reported once the incoming one is built (HeroController starts
  /// them at the same moment). Only while an inspector is connected.
  void _flights(Route<dynamic>? from, Route<dynamic>? to, {required bool push}) {
    if (!runtime.active || from is! PageRoute || to is! PageRoute) return;
    // A back swipe drives its flights by the finger: not a timed animation.
    if (navigator?.userGestureInProgress ?? false) return;
    final moving = push ? to : from;
    final duration = push ? moving.transitionDuration : moving.reverseTransitionDuration;
    final animation = moving.animation;
    if (animation == null || duration == Duration.zero) return;
    SchedulerBinding.instance.addPostFrameCallback(
      (_) => KfOwnTime.measure(() {
        try {
          final screens = _screensOf(runtime);
          reportHeroFlights(
            runtime,
            from: from,
            to: to,
            fromName: screens.nameOf(from),
            toName: screens.nameOf(to),
            animation: animation,
            duration: duration,
            push: push,
          );
        } catch (_) {
          // Flights are extra: a tree in an unexpected state is skipped, never thrown into the app.
        }
      }),
    );
  }

  @override
  void didRemove(Route<dynamic> route, Route<dynamic>? previousRoute) => KfOwnTime.measure(() {
    _stack.remove(route);
    _changed();
  });

  @override
  void didReplace({Route<dynamic>? newRoute, Route<dynamic>? oldRoute}) =>
      KfOwnTime.measure(() => _replaced(newRoute, oldRoute));

  void _replaced(Route<dynamic>? newRoute, Route<dynamic>? oldRoute) {
    final i = oldRoute == null ? -1 : _stack.indexOf(oldRoute);
    if (newRoute is PageRoute) {
      if (i >= 0) {
        _stack[i] = newRoute;
      } else {
        _stack.add(newRoute);
      }
    } else if (i >= 0) {
      _stack.removeAt(i);
    }
    _changed();
  }

  void _changed() {
    _unregister ??= runtime.registerNavigator(_navigate);
    _screensOf(runtime).observed(this);
  }

  /// Back to a screen still in the stack, by the name it was reported under, else pushed by name
  /// (needs `routes` or `onGenerateRoute`).
  bool _navigate(String route, Map<String, Object?>? params) {
    final nav = navigator;
    if (nav == null) return false;
    final screens = _screensOf(runtime);
    for (final r in _stack.reversed) {
      if (screens.nameOf(r) != route) continue;
      if (identical(r, _stack.last)) return false;
      nav.popUntil((x) => identical(x, r));
      // Reported now rather than at the end of the frame: a playback that navigates again before then
      // compares with where the app went.
      screens.flush();
      return true;
    }
    // A name the app gave a screen, or a route's type standing in for a name, is no route to push.
    if (screens.unnamed(route)) return false;
    nav.pushNamed(route, arguments: params);
    screens.flush();
    return true;
  }

  /// Route arguments when they are a JSON map; anything else is not sent.
  static Map<String, Object?>? _params(Object? args) {
    if (args is! Map) return null;
    final out = <String, Object?>{};
    args.forEach((k, v) {
      if (k is String && (v == null || v is num || v is String || v is bool)) out[k] = v;
    });
    return out.isEmpty ? null : out;
  }
}

/// The observer KeyframerInspector's apps add to their navigator.
final KfNavigatorObserver kfNavigatorObserver = KfNavigatorObserver();

final _typeArguments = RegExp(r'<.*>$');

/// Names the screen it is in while it is mounted and shown, for screens the navigator cannot name: a
/// page pushed without a name, a tab, a pager's page, a custom router's screen.
///
/// ```dart
/// KeyframerScreen(name: 'Settings', child: SettingsPage())
/// ```
///
/// The latest one mounted that is still shown is the screen in `navigation` markers, whatever the
/// navigator observer calls the page around it. When it goes, the one under it is the screen again,
/// else the observer's page. A new `name` renames it in place. Not shown: one in a page that another
/// page covers (or a page popped and leaving), in an IndexedStack child that is not selected, or under
/// `Visibility(visible: false)`. Changes within a frame are one marker (a page pushed with its own
/// KeyframerScreen is reported under that name only). A pager that keeps its pages alive keeps them all
/// mounted: name its page with [KeyframerInspector.setScreen] from `onPageChanged` instead.
class KeyframerScreen extends StatefulWidget {
  const KeyframerScreen({super.key, required this.name, required this.child});

  final String name;
  final Widget child;

  @override
  State<KeyframerScreen> createState() => _KeyframerScreenState();
}

class _KeyframerScreenState extends State<KeyframerScreen> {
  final _Screens _screens = _screensOf(KfRuntime.instance);
  ModalRoute<dynamic>? _route;
  bool _visible = true;

  @override
  void initState() {
    super.initState();
    _screens.declare(this);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // Called again when any of them changes: a page pushed over this one or popped, the tab holding it
    // hidden or shown.
    _route = ModalRoute.of(context);
    _visible = Visibility.of(context);
    _screens.changed();
  }

  @override
  void didUpdateWidget(KeyframerScreen old) {
    super.didUpdateWidget(old);
    if (old.name != widget.name) _screens.renamed(widget.name);
  }

  @override
  void dispose() {
    _screens.undeclare(this);
    super.dispose();
  }

  bool get _shown {
    if (!mounted || !_visible) return false;
    final route = _route;
    if (route == null) return true;
    // Popped, and still mounted while it leaves.
    if (!route.isActive) return false;
    // A navigator no KfNavigatorObserver watches: its top route only (a dialog over the page hides it).
    return !(_covered(context as Element, route) ?? !route.isCurrent);
  }

  /// The page's own route is the screen's identity: the same KeyframerScreen mounted again in it is not
  /// a new screen.
  _Screen get _screen => (
    name: widget.name,
    params: _route == null ? null : KfNavigatorObserver._params(_route!.settings.arguments),
    key: _route ?? this,
  );

  @override
  Widget build(BuildContext context) => widget.child;
}

typedef _Screen = ({String name, Map<String, Object?>? params, Object? key});

/// Where the app is, from everything that says: the [KeyframerScreen]s shown, [kfSetScreen], and the top
/// page of the navigator observer that changed last. Worked out at the end of the frame anything
/// changed in, so a page pushed with its own KeyframerScreen, or one KeyframerScreen swapped for
/// another, is one navigation marker.
class _Screens {
  _Screens(this.runtime);

  final KfRuntime runtime;

  // Mounted, oldest first: the latest one shown is the screen.
  final List<_KeyframerScreenState> _declared = [];
  KfNavigatorObserver? _observer;

  // What setScreen named, over which screen: once that one changes, so has the screen.
  String? _set;
  Object? _setOver;

  // Names that name no route: what KeyframerScreens and setScreen said, and route types standing in
  // for a name. Playback does not push them.
  final Set<String> _unnamed = {};

  // The runtime's route when this last reported (or set) one: another one there means another source
  // (or a reset) spoke since.
  KfRoute? _emitted;
  bool _scheduled = false;

  void declare(_KeyframerScreenState s) {
    _declared.add(s);
    _unnamed.add(s.widget.name);
    changed();
  }

  void undeclare(_KeyframerScreenState s) {
    _declared.remove(s);
    changed();
  }

  void renamed(String name) {
    _unnamed.add(name);
    changed();
  }

  void observed(KfNavigatorObserver o) {
    _observer = o;
    changed();
  }

  void set(String name) {
    _unnamed.add(name);
    _set = name;
    _setOver = _underlying()?.key;
    _emitted = runtime.currentRoute;
    changed();
  }

  bool unnamed(String route) => _unnamed.contains(route);

  /// A page's name as it is reported: its KeyframerScreen's (the latest, preferring one that is not a
  /// hidden tab), else [KfNavigatorObserver.routeName].
  String nameOf(Route<dynamic> r) {
    String? declared;
    for (final s in _declared.reversed) {
      if (!identical(s._route, r)) continue;
      if (s._visible) return s.widget.name;
      declared ??= s.widget.name;
    }
    return declared ?? _pageName(r);
  }

  /// [KfNavigatorObserver.routeName], remembering a route's type standing in for a name.
  String _pageName(Route<dynamic> r) {
    final name = KfNavigatorObserver.routeName(r);
    if (r.settings.name == null) _unnamed.add(name);
    return name;
  }

  /// Reports where the app is at the end of this frame, or of the next one when none is under way (a
  /// frame is asked for then).
  void changed() {
    if (_scheduled) return;
    _scheduled = true;
    final binding = SchedulerBinding.instance;
    binding.addPostFrameCallback((_) {
      _scheduled = false;
      KfOwnTime.measure(flush);
    });
    binding.ensureVisualUpdate();
  }

  /// Reports where the app is now.
  void flush() {
    final now = _current();
    if (now != null) runtime.emitNavigation(now.name, now.params, now.key);
    _emitted = runtime.currentRoute;
  }

  _Screen? _current() {
    final under = _underlying();
    final set = _set;
    if (set == null) return under;
    if (!identical(under?.key, _setOver) || !identical(runtime.currentRoute, _emitted)) {
      _set = null;
      return under;
    }
    return (name: set, params: null, key: under?.key);
  }

  _Screen? _underlying() {
    for (final s in _declared.reversed) {
      if (s._shown) return s._screen;
    }
    final top = _observer?._stack.lastOrNull;
    // A navigator gone (its routes disposed) says nothing any more.
    if (top == null || !top.isActive) return null;
    // The page's own name: a KeyframerScreen in it that is not shown (a hidden tab's) does not name it.
    return (name: _pageName(top), params: KfNavigatorObserver._params(top.settings.arguments), key: top);
  }
}

final _byRuntime = Expando<_Screens>('kfScreens');

_Screens _screensOf(KfRuntime runtime) => _byRuntime[runtime] ??= _Screens(runtime);

/// [KeyframerInspector.setScreen] for `runtime`. Not part of the package's API.
void kfSetScreen(KfRuntime runtime, String name) => _screensOf(runtime).set(name);

/// Whether a page covers the one `e` is in (`route`), or one around it (a nested navigator's page), in
/// the navigators KfNavigatorObservers watch. Null when none of them knows `route`.
bool? _covered(Element e, ModalRoute<dynamic> route) {
  _live.removeWhere((w) => w.target == null);
  Set<Element>? around;
  var known = false;
  for (final ref in _live) {
    final stack = ref.target?._stack ?? const <Route<dynamic>>[];
    for (var i = 0; i < stack.length; i++) {
      final r = stack[i];
      final top = i == stack.length - 1;
      if (identical(r, route)) {
        if (!top) return true;
        known = true;
      } else if (!top && r is ModalRoute) {
        final content = r.subtreeContext;
        if (content is! Element) continue;
        around ??= _ancestors(e);
        if (around.contains(content)) return true;
      }
    }
  }
  return known ? false : null;
}

Set<Element> _ancestors(Element e) {
  final out = Set<Element>.identity();
  e.visitAncestorElements((a) {
    out.add(a);
    return true;
  });
  return out;
}

/// Where a screen stands, for the scene's visibility checks.
enum KfPageState {
  /// On top, or under a page that does not hide it.
  shown,

  /// Sliding in or out: part of a transition, not judged.
  moving,

  /// An opaque page above it has finished arriving (Flutter mutes its tickers then).
  covered,
}

final List<WeakReference<KfNavigatorObserver>> _live = [];

/// The content element of every page route the live observers know, and where its screen stands. Not
/// part of the package's API: the scene reads it.
Map<Element, KfPageState> kfPageContents() {
  final out = <Element, KfPageState>{};
  _live.removeWhere((w) => w.target == null);
  for (final ref in _live) {
    final stack = ref.target?._stack ?? const <Route<dynamic>>[];
    var covered = false;
    for (var i = stack.length - 1; i >= 0; i--) {
      final r = stack[i];
      if (r is! ModalRoute) continue;
      final context = r.subtreeContext;
      if (context is Element) {
        out[context] =
            _animating(r.animation) || _animating(r.secondaryAnimation)
                ? KfPageState.moving
                : covered
                ? KfPageState.covered
                : KfPageState.shown;
      }
      if (r.opaque && r.animation?.status == AnimationStatus.completed) covered = true;
    }
  }
  return out;
}

bool _animating(Animation<double>? a) =>
    a != null && (a.status == AnimationStatus.forward || a.status == AnimationStatus.reverse);
