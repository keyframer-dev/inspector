// The widget tree while a recording runs: what the SDK learns from the widgets instead of from the
// app's calls. Three things, from one walk of the element tree about once a second and a look at the
// values that moved every 200 ms, so a recording pays a fraction of a millisecond for it:
//
// - Implicit animations (AnimatedContainer, AnimatedOpacity, TweenAnimationBuilder and the other
//   ImplicitlyAnimatedWidgets the app wrote) become values, with an animation reported each time one
//   starts, located where the widget was written (debug builds, which track widget creation).
// - Visibility: a value that moves while none of its widgets can be seen (detached, hidden by an
//   opacity of 0, Offstage or Visibility, scrolled out of its viewport or off the screen, on a screen
//   covered by another, or under TickerMode(enabled: false)) gets a `visibility` marker, and another
//   when it shows again.
// - Render hints: an Opacity whose opacity animates, a blur over moving content (BackdropFilter,
//   ImageFiltered), ClipPath and ShaderMask over animated children, clips that save a layer.
//
// A value's widgets are the animated widgets that listen to it (AnimatedBuilder and every
// AnimatedWidget, FadeTransition, ValueListenableBuilder), through CurvedAnimation, Tween.animate and
// the other wrappers, or else the State whose ticker drives it.

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/widgets.dart';

import 'call_site.dart';
import 'controller.dart' show curveName;
import 'navigation.dart';
import 'protocol.dart';
import 'runtime.dart';
import 'widget_site.dart';

/// Watches the widget tree for one recording. [start] it, [stop] it when the recording ends: the
/// implicit animations it registered leave the runtime then.
class KfScene {
  KfScene(
    this.runtime, {
    required this.onVisibility,
    required this.onHint,
    this.checkEvery = const Duration(milliseconds: 200),
    this.scanEvery = const Duration(seconds: 1),
  });

  final KfRuntime runtime;
  final void Function(String id, bool visible, String? reason) onVisibility;
  final void Function(KfRenderHint hint) onHint;
  final Duration checkEvery;
  final Duration scanEvery;

  Timer? _timer;
  final Stopwatch _clock = Stopwatch();
  int? _lastScan;
  bool _stopped = false;

  // From the last walk: the animated widgets by the object they listen to, Opacity widgets with the
  // value that animates them, backdrop blurs, and where each of those is in paint order.
  final Map<Object, List<Element>> _bySource = Map.identity();
  final List<(Element, String?)> _opacities = [];
  final List<Element> _backdrops = [];
  final Map<Element, int> _order = Map.identity();
  final Expando<double> _opacityBefore = Expando('kfOpacity');

  final Map<State, _Implicit> _implicit = Map.identity();
  final Set<State> _notApps = Set.identity();
  final Map<KfSignal, double> _last = Map.identity();
  final Map<String, bool> _visible = {};
  final Map<String, String> _pending = {};
  final Set<String> _seenWidgets = {};
  // Every source an animated widget was seen listening to, kept across walks: whether that widget sat
  // in a scrollable when last seen. Its widget gone, a value is off screen (a lazy list unmounts the
  // rows it scrolled away) or detached, never its State's (which is still there).
  final Map<Object, bool> _seenIn = Map.identity();
  bool _wantScan = false;
  bool _freshScan = false;
  final Set<String> _hinted = {};

  void start() {
    _clock.start();
    _timer = Timer.periodic(checkEvery, (_) => _tick());
    Timer.run(_tick);
  }

  void stop() {
    _stopped = true;
    _timer?.cancel();
    _timer = null;
    for (final i in _implicit.values) {
      i.dispose();
    }
    _implicit.clear();
    _notApps.clear();
    _bySource.clear();
    _opacities.clear();
    _backdrops.clear();
    _order.clear();
    _last.clear();
    _seenIn.clear();
  }

  /// One look: a walk when the last one is old, then the values that moved. Never throws into the app.
  void _tick() {
    if (_stopped) return;
    try {
      // Between frames only: a walk mid-frame would see a tree being rebuilt.
      if (SchedulerBinding.instance.schedulerPhase != SchedulerPhase.idle) return;
      final root = WidgetsBinding.instance.rootElement;
      if (root == null) return;
      final now = _clock.elapsedMilliseconds;
      final last = _lastScan;
      if (last == null || now - last >= scanEvery.inMilliseconds || _wantScan) {
        _lastScan = now;
        scan(root);
      }
      check();
    } catch (_) {
      // A tree in a state this code did not expect: skipped until the next look.
    }
  }

  // ── The walk ──────────────────────────────────────────────────────────
  /// Walks the element tree from `root`: finds the app's implicit animations, the animated widgets of
  /// every value, Opacity widgets and backdrop blurs.
  @visibleForTesting
  void scan(Element root) {
    _bySource.clear();
    _opacities.clear();
    _backdrops.clear();
    _order.clear();
    final signals = Map<Object, KfSignal>.identity();
    for (final s in runtime.signals.values) {
      final source = s.source;
      if (source != null) signals[source] = s;
    }
    final seen = Set<State>.identity();
    var index = 0;
    void visit(Element e, String? driver, bool scrolled) {
      index++;
      var id = driver;
      final inScroll = scrolled || e.widget is Scrollable;
      if (e is StatefulElement) {
        final state = e.state;
        if (state is ImplicitlyAnimatedWidgetState) {
          seen.add(state);
          final controller = _controllerOf(state);
          if (controller != null) {
            _discover(state, e, controller);
            _bind(controller, e, index, inScroll);
          }
        }
      }
      for (final source in _listened(e.widget)) {
        _bind(source, e, index, inScroll);
        id = signals[source]?.id ?? id;
      }
      final w = e.widget;
      if (w is Opacity) {
        _opacities.add((e, id));
      } else if (w is BackdropFilter) {
        _backdrops.add(e);
        _order[e] = index;
      }
      e.visitChildElements((c) => visit(c, id, inScroll));
    }

    visit(root, null, false);
    _wantScan = false;
    _freshScan = true;
    // Implicit animations whose widget went away (its screen closed) leave with it.
    for (final state in _implicit.keys.where((s) => !seen.contains(s)).toList()) {
      _implicit.remove(state)!.dispose();
    }
    _notApps.removeWhere((s) => !seen.contains(s));
  }

  void _bind(Object source, Element e, int index, bool scrolled) {
    (_bySource[source] ??= []).add(e);
    _order[e] = index;
    _seenIn[source] = scrolled;
  }

  void _discover(ImplicitlyAnimatedWidgetState state, Element e, AnimationController controller) {
    if (_implicit.containsKey(state) || _notApps.contains(state)) return;
    // Only what the app wrote: Flutter's own widgets animate implicitly too (every Material does).
    final frame = appWidgetFrame(e, runtime);
    if (frame == null) {
      _notApps.add(state);
      return;
    }
    _implicit[state] = _Implicit(runtime, state, controller, frame);
  }

  // ── The look ──────────────────────────────────────────────────────────
  /// For every value that moved since the last look: is any of its widgets visible, and how are they
  /// drawn. Then the Opacity widgets whose opacity changed.
  @visibleForTesting
  void check() {
    final pages = kfPageContents();
    for (final s in runtime.signals.values.toList()) {
      final id = s.id;
      if (id == null) continue;
      final v = s.read();
      final before = _last[s];
      _last[s] = v;
      if (before == null || before == v || !v.isFinite) {
        // Stopped: what it seemed to move behind is not confirmed.
        _pending.remove(id);
        continue;
      }
      final elements = _elementsOf(s);
      String? reason;
      final gone = elements.isEmpty ? _goneReason(s) : null;
      if (gone != null) {
        // Its animated widgets were seen and none is mounted now. A rebuild may have put new ones in
        // their place since the last walk: walk again before judging.
        if (!_freshScan) {
          _wantScan = true;
          continue;
        }
        reason = gone;
      } else if (elements.isEmpty) {
        // Its widgets were seen before and are all gone: it moves for nothing.
        if (!_seenWidgets.contains(id)) continue;
        reason = 'detached';
      } else {
        _seenWidgets.add(id);
        // Visible when one of its widgets is; not judged while its screen is in a transition.
        final reasons = [for (final e in elements) _hiddenBy(e, pages)];
        if (reasons.contains(null)) {
          reason = null;
        } else if (reasons.contains(_moving)) {
          continue;
        } else {
          reason = reasons.first;
        }
      }
      if (reason == null) {
        _pending.remove(id);
        if (_visible[id] == false) {
          _visible[id] = true;
          onVisibility(id, true, null);
        }
        _hints(s, elements, pages);
      } else if (_visible[id] != false) {
        // Hidden on two looks in a row while moving: what moved during a screen's last frames on show
        // (Flutter mutes a covered screen's tickers once it is covered) is not reported.
        if (_pending[id] == reason) {
          _pending.remove(id);
          _visible[id] = false;
          onVisibility(id, false, reason);
        } else {
          _pending[id] = reason;
        }
      }
    }
    _opacityHints();
    _freshScan = false;
  }

  /// For a value whose animated widgets were all seen once and are none of them mounted now: off screen
  /// when the last one sat in a scrollable, else detached. Null when none was ever seen.
  String? _goneReason(KfSignal s) {
    final source = s.source;
    if (source == null) return null;
    bool? scrolled;
    for (final root in _roots(source)) {
      final seen = _seenIn[root];
      if (seen != null) scrolled = (scrolled ?? false) || seen;
    }
    return scrolled == null ? null : (scrolled ? 'offscreen' : 'detached');
  }

  List<Element> _elementsOf(KfSignal s) {
    final out = <Element>[];
    final source = s.source;
    if (source != null) {
      for (final root in _roots(source)) {
        for (final e in _bySource[root] ?? const <Element>[]) {
          if (e.mounted) out.add(e);
        }
      }
    }
    // No animated widget ever listened to it (a listener calling setState): the State whose ticker drives
    // it. One that did and went away is not stood in for by its State (see _goneReason).
    if (out.isEmpty && _goneReason(s) == null) {
      final owner = s.owner;
      if (owner is State && owner.mounted) {
        final context = owner.context;
        if (context is Element) out.add(context);
      }
    }
    return out;
  }

  /// Why `e` cannot be seen, or null when it can; [_moving] while its screen slides in or out.
  String? _hiddenBy(Element e, Map<Element, KfPageState> pages) {
    if (!e.mounted) return 'detached';
    final ro = e.findRenderObject();
    if (ro == null || !ro.attached) return 'detached';
    String? hidden;
    var muted = false;
    KfPageState? page;
    e.visitAncestorElements((a) {
      final w = a.widget;
      if (w is Visibility && !w.visible) {
        hidden = 'hidden';
      } else if (w is TickerMode && !w.enabled) {
        muted = true;
      } else if (a is RenderObjectElement) {
        final r = a.renderObject;
        if ((r is RenderOpacity && r.opacity == 0) ||
            (r is RenderAnimatedOpacityMixin && r.opacity.value == 0) ||
            (r is RenderSliverOpacity && r.opacity == 0) ||
            (r is RenderOffstage && r.offstage) ||
            (r is RenderSliverOffstage && r.offstage)) {
          hidden = 'hidden';
        }
      }
      page ??= pages[a];
      return true;
    });
    if (page == KfPageState.moving) return _moving;
    // Under another screen: covered, whatever else hides it.
    if (page == KfPageState.covered) return 'covered';
    if (hidden != null) return hidden;
    if (muted) return 'hidden';
    final rect = _globalRect(ro);
    if (rect == null) return null;
    if (rect.isEmpty) return 'hidden';
    final root = ro.owner?.rootNode;
    if (root is RenderView && !rect.overlaps(Offset.zero & root.size)) return 'offscreen';
    final viewport = RenderAbstractViewport.maybeOf(ro);
    final area = viewport == null ? null : _globalRect(viewport);
    if (area != null && !rect.overlaps(area)) return 'offscreen';
    return null;
  }

  // ── Render hints ──────────────────────────────────────────────────────
  void _hints(KfSignal s, List<Element> elements, Map<Element, KfPageState> pages) {
    final id = s.id!;
    final name = s.name ?? id;
    for (final e in elements) {
      var depth = 0;
      e.visitAncestorElements((a) {
        final w = a.widget;
        if (w is ClipPath) {
          _hint(id, 'mask', a, 'ClipPath', 'clips $name while it moves');
        } else if (w is ShaderMask) {
          _hint(id, 'mask', a, 'ShaderMask', 'masks $name while it moves');
        } else if (w is ImageFiltered) {
          _hint(id, 'blur', a, 'ImageFiltered', 'filters $name while it moves');
        }
        if (_clipBehavior(w) == Clip.antiAliasWithSaveLayer) {
          _hint(id, 'save-layer', a, widgetTypeName(w), 'with Clip.antiAliasWithSaveLayer clips $name while it moves');
        }
        // What the screen's route wraps around every page is not the app's.
        return ++depth < 64 && !pages.containsKey(a);
      });
      // A backdrop blur drawn after it, over where it moves, blurs it again every frame.
      final at = _order[e];
      for (final b in _backdrops) {
        final bAt = _order[b];
        if (at == null || bAt == null || bAt <= at || !b.mounted) continue;
        final over = b.findRenderObject(), under = e.findRenderObject();
        final r1 = over == null ? null : _globalRect(over), r2 = under == null ? null : _globalRect(under);
        if (r1 != null && r2 != null && r1.overlaps(r2)) {
          _hint(id, 'blur', b, 'BackdropFilter', 'blurs $name behind it while it moves');
        }
      }
    }
  }

  /// An Opacity rebuilt with another opacity between 0 and 1 is an animation through the Opacity
  /// widget: each change rebuilds it and repaints its child into an offscreen layer.
  void _opacityHints() {
    for (final (e, driver) in _opacities) {
      if (!e.mounted) continue;
      final w = e.widget;
      if (w is! Opacity) continue;
      final v = w.opacity;
      final before = _opacityBefore[e];
      _opacityBefore[e] = v;
      if (before == null || before == v) continue;
      if ((v <= 0 || v >= 1) && (before <= 0 || before >= 1)) continue;
      final id = driver ?? _siteId(e) ?? 'Opacity';
      _hint(
        id,
        'opacity-widget',
        e,
        'Opacity',
        'is rebuilt with a new opacity (${before.toStringAsFixed(2)}, then ${v.toStringAsFixed(2)})',
      );
    }
  }

  void _hint(String id, String hint, Element at, String what, String saw) {
    if (!_hinted.add('$id|$hint')) return;
    final where = _where(at);
    onHint(KfRenderHint(id, hint, '$what${where == null ? '' : ' at $where'} $saw'));
  }

  /// `lib/main.dart:143` for the widget or the app's widget around it, when widget creation is tracked.
  String? _where(Element e) {
    final found = nearestAppWidget(e, runtime);
    if (found == null) return null;
    final f = found.$2;
    return '${sourceFile(f.uri, appPackage: runtime.appPackage, root: runtime.root)}:${f.line}';
  }

  String? _siteId(Element e) {
    final f = appWidgetFrame(e, runtime);
    if (f == null) return null;
    return '${sourceFile(f.uri, appPackage: runtime.appPackage, root: runtime.root)}:${f.line}:${f.column}';
  }
}

/// An implicit animation the app wrote, as a value: its progress through the current change (eased
/// by its curve), with an animation reported whenever a change starts it.
class _Implicit {
  _Implicit(this.runtime, this.state, this.controller, this.frame)
    : type = widgetTypeName(state.widget),
      _before = state.widget {
    signal = KfSignal(
      source: controller,
      owner: state,
      read: _read,
      write: (_) {},
      name: type,
      frame: frame,
      fallbackKey: type,
      writable: false,
      prop: _implicitProps[type],
    );
    runtime.register(signal);
    controller.addStatusListener(_onStatus);
    // Already under way when found (a TweenAnimationBuilder runs from its first build).
    if (controller.isAnimating) _report();
  }

  final KfRuntime runtime;
  final ImplicitlyAnimatedWidgetState state;
  final AnimationController controller;
  final KfStackFrame frame;
  final String type;
  late final KfSignal signal;
  double _value = 0;
  // The widget as the last change left it: what the next change is compared with.
  ImplicitlyAnimatedWidget _before;

  double _read() {
    if (state.mounted) _value = state.animation.value;
    return _value;
  }

  // Every change restarts it from 0: dismissed, then forward.
  void _onStatus(AnimationStatus status) {
    if (status == AnimationStatus.forward && state.mounted) _report();
  }

  void _report() {
    final w = state.widget;
    final before = _before;
    _before = w;
    final site = signal.site(runtime);
    final ms = w.duration.inMicroseconds / 1000;
    Object? to = 1;
    if (w is TweenAnimationBuilder) {
      final end = w.tween.end;
      if (end is num) to = end;
    }
    runtime.reportAnim(
      KfCallSite(
        id: '${site.file}:${site.line}:${site.column ?? 0}',
        file: site.file,
        line: site.line,
        column: site.column ?? 0,
        fn: type,
        component: site.component,
        target: site.name,
        prop:
            _implicitProps[type] ??
            (w is AnimatedContainer && before is AnimatedContainer ? _changed(before, w) : null),
      ),
      [
        to,
        {'duration': ms, 'curve': curveName(w.curve)},
      ],
      frames: [frame],
      durationMs: ms,
    );
  }

  void dispose() {
    controller.removeStatusListener(_onStatus);
    runtime.unregister(signal);
  }
}

/// Not a reason: the screen is in a transition, so visibility is not judged.
const _moving = 'moving';

/// What each implicit animation animates (`prop`): the problems engine reads 'opacity' and colors as
/// fades, which Reduce Motion allows, and anything else as motion. AnimatedContainer says what changed
/// (see _changed); TweenAnimationBuilder nothing, its builder decides.
const _implicitProps = {
  'AnimatedOpacity': 'opacity',
  'SliverAnimatedOpacity': 'opacity',
  'AnimatedScale': 'scale',
  'AnimatedRotation': 'rotate',
  'AnimatedSlide': 'translate',
  'AnimatedPositioned': 'position',
  'AnimatedPositionedDirectional': 'position',
  'AnimatedAlign': 'alignment',
  'AnimatedPadding': 'padding',
  'AnimatedFractionallySizedBox': 'size',
  'AnimatedPhysicalModel': 'elevation',
  'AnimatedDefaultTextStyle': 'textStyle',
  'AnimatedTheme': 'theme',
};

/// What an AnimatedContainer change animates, comma-joined ('size,color'), or null when nothing it
/// animates differs.
String? _changed(AnimatedContainer a, AnimatedContainer b) {
  final out = <String>[];
  void add(String p) {
    if (!out.contains(p)) out.add(p);
  }

  if (a.constraints != b.constraints) add('size');
  if (a.padding != b.padding) add('padding');
  if (a.margin != b.margin) add('margin');
  if (a.alignment != b.alignment) add('alignment');
  if (a.transform != b.transform || a.transformAlignment != b.transformAlignment) add('transform');
  for (final (x, y) in [(a.decoration, b.decoration), (a.foregroundDecoration, b.foregroundDecoration)]) {
    if (x == y) continue;
    if (x is BoxDecoration && y is BoxDecoration) {
      if (x.color != y.color) add('color');
      if (x.border != y.border) add('border');
      if (x.borderRadius != y.borderRadius) add('borderRadius');
      if (!listEquals(x.boxShadow, y.boxShadow)) add('shadow');
      if (x.gradient != y.gradient) add('gradient');
      if (x.image != y.image || x.shape != y.shape || x.backgroundBlendMode != y.backgroundBlendMode) {
        add('decoration');
      }
    } else if (x is BoxDecoration && y == null || x == null && y is BoxDecoration) {
      // Only a color on one side (AnimatedContainer(color:) builds a BoxDecoration of it).
      final d = (x ?? y)!;
      add(
        d is BoxDecoration && d.border == null && d.borderRadius == null && d.gradient == null ? 'color' : 'decoration',
      );
    } else {
      add('decoration');
    }
  }
  return out.isEmpty ? null : out.join(',');
}

/// The controller behind an implicit animation: its public `animation` is a CurvedAnimation of it.
AnimationController? _controllerOf(ImplicitlyAnimatedWidgetState state) {
  final a = state.animation;
  if (a is CurvedAnimation) {
    final parent = a.parent;
    if (parent is AnimationController) return parent;
  }
  return null;
}

/// What an animated widget listens to.
Iterable<Object> _listened(Widget w) {
  final Listenable? l = switch (w) {
    AnimatedWidget(:final listenable) => listenable,
    FadeTransition(:final opacity) => opacity,
    SliverFadeTransition(:final opacity) => opacity,
    ValueListenableBuilder(:final valueListenable) => valueListenable,
    _ => null,
  };
  return l == null ? const [] : _roots(l);
}

/// The values at the bottom of an animation: through CurvedAnimation, Tween.animate (drive), reversed,
/// proxied, train-hopping and compound animations, to the controllers and notifiers that move.
Iterable<Object> _roots(Object l, [int depth = 0]) sync* {
  if (depth > 8) return;
  switch (l) {
    case AnimationWithParentMixin<Object?>(:final parent):
      yield* _roots(parent, depth + 1);
    case ReverseAnimation(:final parent):
      yield* _roots(parent, depth + 1);
    case ProxyAnimation(:final parent?):
      yield* _roots(parent, depth + 1);
    case TrainHoppingAnimation(:final currentTrain?):
      yield* _roots(currentTrain, depth + 1);
    case CompoundAnimation<Object?>(:final first, :final next):
      yield* _roots(first, depth + 1);
      yield* _roots(next, depth + 1);
    default:
      yield l;
  }
}

Clip? _clipBehavior(Widget w) => switch (w) {
  ClipRect(:final clipBehavior) => clipBehavior,
  ClipRRect(:final clipBehavior) => clipBehavior,
  ClipOval(:final clipBehavior) => clipBehavior,
  ClipPath(:final clipBehavior) => clipBehavior,
  _ => null,
};

/// A render box's bounds on screen, in logical points; null when it has not been laid out.
Rect? _globalRect(RenderObject ro) {
  if (ro is! RenderBox || !ro.attached || !ro.hasSize) return null;
  return MatrixUtils.transformRect(ro.getTransformTo(null), Offset.zero & ro.size);
}
