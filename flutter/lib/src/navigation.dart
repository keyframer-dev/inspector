import 'package:flutter/widgets.dart';

import 'runtime.dart';

/// Reports the screen the app is on (navigation markers) and takes it back to a recorded screen during
/// playback, scrubbing and export. Add it to your app: `navigatorObservers: [kfNavigatorObserver]`.
///
/// Screens are page routes, named by `RouteSettings.name` (or the route's type when it has none).
/// Dialogs and popups are not screens.
class KfNavigatorObserver extends NavigatorObserver {
  KfNavigatorObserver({KfRuntime? runtime}) : runtime = runtime ?? KfRuntime.instance;

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
  }

  @override
  void didPop(Route<dynamic> route, Route<dynamic>? previousRoute) {
    _stack.remove(route);
    _changed();
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
