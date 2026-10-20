import 'package:flutter/scheduler.dart';
import 'package:flutter/widgets.dart';

import 'heroes.dart';
import 'runtime.dart';

/// Reports the screen the app is on (navigation markers) and takes it back to a recorded screen during
/// playback, scrubbing and export. Add it to your app: `navigatorObservers: [kfNavigatorObserver]`.
///
/// Screens are page routes, named by `RouteSettings.name` (or the route's type when it has none).
/// Dialogs and popups are not screens.
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
  // While popping back several screens at once: only where it lands is a change.
  bool _jumping = false;

  static String routeName(Route<dynamic> r) => r.settings.name ?? r.runtimeType.toString();

  @override
  void didPush(Route<dynamic> route, Route<dynamic>? previousRoute) {
    if (route is PageRoute) _stack.add(route);
    _changed();
    _flights(previousRoute, route, push: true);
  }

  @override
  void didPop(Route<dynamic> route, Route<dynamic>? previousRoute) {
    _stack.remove(route);
    _changed();
    _flights(route, previousRoute, push: false);
  }

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
    SchedulerBinding.instance.addPostFrameCallback((_) {
      try {
        reportHeroFlights(
          runtime,
          from: from,
          to: to,
          fromName: routeName(from),
          toName: routeName(to),
          animation: animation,
          duration: duration,
          push: push,
        );
      } catch (_) {
        // Flights are extra: a tree in an unexpected state is skipped, never thrown into the app.
      }
    });
  }

  @override
  void didRemove(Route<dynamic> route, Route<dynamic>? previousRoute) {
    _stack.remove(route);
    _changed();
  }

  @override
  void didReplace({Route<dynamic>? newRoute, Route<dynamic>? oldRoute}) {
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
    if (_stack.isEmpty || _jumping) return;
    final top = _stack.last;
    runtime.emitNavigation(routeName(top), _params(top.settings.arguments));
  }

  /// Back to a screen still in the stack, else pushed by name (needs `routes` or `onGenerateRoute`).
  bool _navigate(String route, Map<String, Object?>? params) {
    final nav = navigator;
    if (nav == null) return false;
    if (_stack.any((r) => routeName(r) == route)) {
      _jumping = true;
      try {
        nav.popUntil((r) => r is PageRoute && routeName(r) == route);
      } finally {
        _jumping = false;
      }
      _changed();
      return true;
    }
    nav.pushNamed(route, arguments: params);
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
