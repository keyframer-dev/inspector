import 'package:flutter/scheduler.dart';
import 'package:flutter/widgets.dart';

import 'mask.dart';
import 'recorder.dart';
import 'vitals.dart';

/// Screens, route transitions and Hero flights from a navigator.
///
/// Screens are page routes, named by `RouteSettings.name` (or the route's type when it has none),
/// masked and cut to 64 characters. Dialogs and popups are not screens. A push or pop between two
/// page routes is an animation (`Navigator.push`/`Navigator.pop`, named after the screen that moves),
/// and so is each Hero flight between them (named `Hero(<tag>)`, numbers in the tag folded).
class VitalsNavigatorObserver extends NavigatorObserver {
  final List<Route<dynamic>> _stack = [];

  /// The top page route's screen name, masked.
  String? get currentScreen => _stack.isEmpty ? null : screenName(routeName(_stack.last));

  static String routeName(Route<dynamic> r) =>
      r.settings.name ?? r.runtimeType.toString().replaceAll(RegExp(r'<.*>$'), '');

  @override
  void didPush(Route<dynamic> route, Route<dynamic>? previousRoute) {
    if (route is PageRoute) _stack.add(route);
    _changed();
    _transition(previousRoute, route, push: true);
  }

  @override
  void didPop(Route<dynamic> route, Route<dynamic>? previousRoute) {
    _stack.remove(route);
    _changed();
    _transition(route, previousRoute, push: false);
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
    final name = currentScreen;
    final reporter = KeyframerVitals.reporter;
    if (name == null || reporter == null) return;
    final t = KeyframerVitals.now();
    if (name != reporter.screen) {
      reporter.setScreen(name);
      if (t != null) reporter.recorder?.navigation(t);
    }
  }

  /// The route transition, and the Hero flights it carries once the incoming screen is built (when
  /// HeroController starts them). Only while measuring: otherwise this costs nothing.
  void _transition(Route<dynamic>? from, Route<dynamic>? to, {required bool push}) {
    final t = KeyframerVitals.now();
    if (t == null || from is! PageRoute || to is! PageRoute) return;
    // A back swipe follows the finger: a gesture, not a timed animation.
    if (navigator?.userGestureInProgress ?? false) return;
    final moving = push ? to : from;
    final duration = push ? moving.transitionDuration : moving.reverseTransitionDuration;
    if (duration == Duration.zero) return;
    final ms = duration.inMicroseconds / 1000;
    final screen = screenName(routeName(moving));
    final fn = push ? 'Navigator.push' : 'Navigator.pop';
    final type = moving.runtimeType.toString().replaceAll(RegExp(r'<.*>$'), '');
    _run(
      VitalsSiteSpec(
        id: 'r:$fn:$screen',
        ref: {'kind': 'name', 'name': 'route $screen', 'type': type},
        key: 'route:$screen:${push ? 'push' : 'pop'}',
        fn: fn,
        component: null,
      ),
      t,
      ms,
    );
    SchedulerBinding.instance.addPostFrameCallback((_) {
      try {
        _heroes(from, to, ms);
      } catch (_) {
        // Flights are extra: a tree in an unexpected state is skipped, never thrown into the app.
      }
    });
  }

  void _heroes(PageRoute<dynamic> from, PageRoute<dynamic> to, double ms) {
    final t = KeyframerVitals.now();
    final fromContext = from.subtreeContext, toContext = to.subtreeContext;
    if (t == null || fromContext is! Element || toContext is! Element) return;
    final departing = _tags(fromContext);
    if (departing.isEmpty) return;
    for (final tag in _tags(toContext)) {
      if (!departing.contains(tag)) continue;
      final name = heroName(tag);
      _run(VitalsSiteSpec(id: 'h:$name', ref: {'kind': 'name', 'name': name}, key: name, fn: 'Hero'), t, ms);
    }
  }

  void _run(VitalsSiteSpec spec, double t, double ms) {
    final reporter = KeyframerVitals.reporter;
    reporter?.recorder?.runStart(spec, t, end: t + ms, reduceMotion: reporter.reduceMotion);
  }
}

/// The Hero tags of a screen, minus those under HeroMode(enabled: false) (they do not fly).
Set<Object> _tags(Element root) {
  final out = <Object>{};
  void visit(Element e) {
    final w = e.widget;
    if (w is HeroMode && !w.enabled) return;
    if (w is Hero) out.add(w.tag);
    e.visitChildElements(visit);
  }

  visit(root);
  return out;
}
