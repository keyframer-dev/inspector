// Hero flights, which HeroController runs on its own (no controller the app could track): found by
// matching the Hero tags of the two screens a navigation moves between, as HeroController does, and
// reported as an animation each, with a value that follows the flight while it lasts.

import 'dart:async';

import 'package:flutter/widgets.dart';

import 'protocol.dart';
import 'runtime.dart';
import 'widget_site.dart';

/// Reports the flights of a navigation from `from` to `to`, driven by `animation` (the moving route's).
void reportHeroFlights(
  KfRuntime runtime, {
  required PageRoute<dynamic> from,
  required PageRoute<dynamic> to,
  required String fromName,
  required String toName,
  required Animation<double> animation,
  required Duration duration,
  required bool push,
}) {
  final fromContext = from.subtreeContext, toContext = to.subtreeContext;
  if (fromContext is! Element || toContext is! Element) return;
  final departing = _heroes(fromContext);
  if (departing.isEmpty) return;
  final arriving = _heroes(toContext);
  for (final MapEntry(key: tag, value: landing) in arriving.entries) {
    if (!departing.containsKey(tag)) continue;
    _Flight(
      runtime,
      tag: tag,
      landing: landing,
      animation: animation,
      duration: duration,
      push: push,
      fromName: fromName,
      toName: toName,
    );
  }
}

/// The Heroes of a screen by tag, minus those under HeroMode(enabled: false) (they do not fly).
Map<Object, Element> _heroes(Element root) {
  final out = <Object, Element>{};
  void visit(Element e) {
    final w = e.widget;
    if (w is HeroMode && !w.enabled) return;
    if (w is Hero) out[w.tag] = e;
    e.visitChildElements(visit);
  }

  visit(root);
  return out;
}

/// One flight: an anim event when it starts, and a value (the flight's progress) until it lands.
class _Flight {
  _Flight(
    this.runtime, {
    required Object tag,
    required Element landing,
    required this.animation,
    required Duration duration,
    required bool push,
    required String fromName,
    required String toName,
  }) {
    final label = 'Hero($tag)';
    // The landing Hero's own location, or the app's widget around it (a FloatingActionButton's Hero is
    // Flutter's, the button is the app's).
    final frame = nearestAppWidget(landing, runtime)?.$2;
    signal = KfSignal(
      source: animation,
      read: () => animation.value,
      write: (_) {},
      name: label,
      frame: frame,
      fallbackKey: label,
      writable: false,
    );
    runtime.register(signal);
    final site = signal.site(runtime);
    final ms = duration.inMicroseconds / 1000;
    runtime.reportAnim(
      KfCallSite(
        id: frame == null ? '${site.id}#Hero' : '${site.file}:${site.line}:${site.column ?? 0}',
        file: site.file,
        line: site.line,
        column: site.column ?? 0,
        fn: 'Hero',
        component: site.component,
        target: label,
      ),
      [
        push ? 1 : 0,
        {'duration': ms, 'tag': '$tag', 'from': fromName, 'to': toName},
      ],
      frames: frame == null ? null : [frame],
      durationMs: ms,
    );
    animation.addStatusListener(_onStatus);
    // A route torn down mid-flight never reports the end: the value goes anyway.
    _timeout = Timer(duration * 2 + const Duration(seconds: 1), _land);
  }

  final KfRuntime runtime;
  final Animation<double> animation;
  late final KfSignal signal;
  Timer? _timeout;
  bool _landed = false;

  void _onStatus(AnimationStatus status) {
    if (status == AnimationStatus.completed || status == AnimationStatus.dismissed) _land();
  }

  void _land() {
    if (_landed) return;
    _landed = true;
    _timeout?.cancel();
    animation.removeStatusListener(_onStatus);
    runtime.unregister(signal);
  }
}
