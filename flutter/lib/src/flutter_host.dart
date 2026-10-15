import 'dart:convert';
import 'dart:ui' as ui;

import 'package:flutter/gestures.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/widgets.dart';

import 'client.dart';
import 'protocol.dart';

/// The Flutter side of the client: frames, raster timings, pointers and screenshots.
class FlutterKfHost implements KfHost {
  FlutterKfHost({this.boundary});

  /// The RepaintBoundary around the app (KeyframerInspector puts it there): what capture snapshots.
  final GlobalKey? boundary;

  ui.FlutterView? get _view => WidgetsBinding.instance.platformDispatcher.implicitView;

  @override
  KfScreen? get screen {
    final v = _view;
    if (v == null) return null;
    final size = v.physicalSize / v.devicePixelRatio;
    return KfScreen(size.width.round(), size.height.round(), v.devicePixelRatio);
  }

  @override
  double get refreshRate {
    try {
      final r = _view?.display.refreshRate ?? 60;
      return r > 0 ? r : 60;
    } catch (_) {
      return 60;
    }
  }

  @override
  bool get canCapture => boundary != null;

  /// A frame callback that reschedules itself, as React Native's meter does with requestAnimationFrame:
  /// frames keep coming while recording, so a gap between two of them is a frame the UI thread missed.
  @override
  void Function() frames(void Function() onFrame) {
    var on = true;
    void schedule() {
      SchedulerBinding.instance.scheduleFrameCallback((_) {
        if (!on) return;
        // After this frame's animations ticked and it was built.
        SchedulerBinding.instance.addPostFrameCallback((_) {
          if (on) onFrame();
        });
        schedule();
      });
    }

    schedule();
    return () => on = false;
  }

  @override
  void Function() timings(void Function(List<KfTiming>) onTimings) {
    void cb(List<ui.FrameTiming> list) => onTimings([
      for (final t in list)
        KfTiming(
          rasterEnd: t.timestampInMicroseconds(ui.FramePhase.rasterFinish) / 1000,
          rasterMs: t.rasterDuration.inMicroseconds / 1000,
          buildMs: t.buildDuration.inMicroseconds / 1000,
        ),
    ]);
    SchedulerBinding.instance.addTimingsCallback(cb);
    return () => SchedulerBinding.instance.removeTimingsCallback(cb);
  }

  @override
  void Function() touches(void Function(KfTouch) onTouch) {
    void route(PointerEvent e) {
      final phase = switch (e) {
        PointerDownEvent() => 'start',
        PointerMoveEvent() => 'move',
        PointerUpEvent() => 'end',
        PointerCancelEvent() => 'cancel',
        _ => null,
      };
      if (phase == null) return;
      onTouch(KfTouch(phase, e.pointer, e.position.dx, e.position.dy, e.timeStamp.inMicroseconds / 1000));
    }

    GestureBinding.instance.pointerRouter.addGlobalRoute(route);
    return () => GestureBinding.instance.pointerRouter.removeGlobalRoute(route);
  }

  @override
  Future<void> nextFrame() {
    SchedulerBinding.instance.scheduleFrame();
    return SchedulerBinding.instance.endOfFrame;
  }

  @override
  Future<String> capture({double? width}) async {
    final ro = boundary?.currentContext?.findRenderObject();
    if (ro is! RenderRepaintBoundary) throw StateError('Nothing to capture: KeyframerInspector is not mounted.');
    final dpr = _view?.devicePixelRatio ?? 1;
    // `width` points wide when asked, else the screen's density capped at 2x to keep frames small.
    final ratio = width != null && ro.size.width > 0 ? width / ro.size.width : (dpr > 2 ? 2.0 : dpr);
    final image = await ro.toImage(pixelRatio: ratio);
    try {
      final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
      if (bytes == null) throw StateError('The screen could not be encoded.');
      return base64Encode(bytes.buffer.asUint8List());
    } finally {
      image.dispose();
    }
  }
}
