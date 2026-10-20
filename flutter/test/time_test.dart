// The animation clock on real controllers: slow motion through timeDilation, pause and step through the
// scheduler's frame time stamps, and back to normal with no jump.

import 'dart:ui' as ui;

import 'package:flutter/scheduler.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:keyframer_inspector/keyframer_inspector.dart';

void main() {
  testWidgets('slow motion is timeDilation, and speed 1 puts back what the app had', (tester) async {
    final clock = KfClock.forTesting(read: () => null, write: (_) {});
    final c = AnimationController(vsync: const TestVSync(), duration: const Duration(milliseconds: 1000));
    expect(clock.setScale(0.25), 0.25);
    expect(timeDilation, 4);
    c.forward();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(c.value, closeTo(0.1, 1e-6));
    expect(clock.setScale(1), 1);
    expect(timeDilation, 1);
    // The first frame after a change of speed shows the same moment (the scheduler starts a new epoch
    // there), then time runs at the new speed.
    await tester.pump(const Duration(milliseconds: 16));
    expect(c.value, closeTo(0.1, 1e-6));
    await tester.pump(const Duration(milliseconds: 100));
    expect(c.value, closeTo(0.2, 1e-6));
    c.dispose();
  });

  testWidgets('speeds out of range are clamped to 0.01..1; a bad one changes nothing', (tester) async {
    final clock = KfClock.forTesting(read: () => null, write: (_) {});
    expect(clock.setScale(100), 1);
    expect(clock.setScale(0.001), 0.01);
    expect(clock.setScale(double.nan), 0.01);
    expect(clock.setScale(-2), 0.01);
    expect(clock.setScale(double.infinity), 0.01);
    expect(clock.setScale(1), 1);
    expect(timeDilation, 1);
  });

  testWidgets('a pause holds every animation and a step advances it by frames at the display rate', (tester) async {
    final binding = tester.binding;
    // The slot the engine calls each frame, with the binding's handler in it.
    ui.FrameCallback? slot = binding.handleBeginFrame;
    final clock = KfClock.forTesting(read: () => slot, write: (h) => slot = h);
    final c = AnimationController(vsync: const TestVSync(), duration: const Duration(milliseconds: 1000))..forward();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(c.value, closeTo(0.1, 1e-6));

    // Frames from here come the engine's way, through the slot.
    var raw = binding.currentSystemFrameTimeStamp;
    void frame([Duration gap = const Duration(microseconds: 16667)]) {
      raw += gap;
      slot!(raw);
      binding.handleDrawFrame();
    }

    expect(clock.setScale(0, hz: 60), 0);
    expect(clock.holding, isTrue);
    frame();
    frame(const Duration(milliseconds: 500));
    expect(c.value, closeTo(0.1, 1e-6));
    clock.step(3);
    for (var i = 0; i < 5; i++) {
      frame();
    }
    // Three frames of 16.667 ms, then held again.
    expect(c.value, closeTo(0.1 + 3 * 0.016667, 1e-4));

    // Back to normal from where it stood: the engine's handler is back in the slot, and no jump.
    expect(clock.setScale(1), 1);
    expect(slot, binding.handleBeginFrame);
    expect(clock.holding, isFalse);
    frame();
    expect(c.value, closeTo(0.15, 1e-3));
    frame(const Duration(milliseconds: 100));
    expect(c.value, closeTo(0.25, 1e-3));
    c.dispose();
  });

  testWidgets('without a frame handler to stand in front of, a pause still holds time', (tester) async {
    final clock = KfClock.forTesting(read: () => null, write: (_) {});
    final c = AnimationController(vsync: const TestVSync(), duration: const Duration(milliseconds: 1000))..forward();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    clock.setScale(0);
    expect(clock.holding, isFalse);
    await tester.pump(const Duration(seconds: 5));
    expect(c.value, closeTo(0.1, 1e-3));
    clock.setScale(1);
    expect(timeDilation, 1);
    await tester.pump(const Duration(milliseconds: 16));
    await tester.pump(const Duration(milliseconds: 100));
    expect(c.value, closeTo(0.2, 1e-3));
    c.dispose();
  });

  testWidgets('FlutterKfHost runs the clock: time is a capability, with the display and motion settings', (
    tester,
  ) async {
    final host = FlutterKfHost();
    expect(host.display, isNotNull);
    expect(host.display!.hz, greaterThan(0));
    expect(host.accessibility, const KfAccessibility(reduceMotion: false));
    tester.platformDispatcher.accessibilityFeaturesTestValue = const FakeAccessibilityFeatures(disableAnimations: true);
    expect(host.accessibility, const KfAccessibility(reduceMotion: true));
    var changes = 0;
    final unwatch = host.watchDevice(() => changes++);
    tester.platformDispatcher.accessibilityFeaturesTestValue = const FakeAccessibilityFeatures(reduceMotion: true);
    expect(changes, greaterThan(0));
    unwatch();
    tester.platformDispatcher.clearAccessibilityFeaturesTestValue();
    expect(host.setTimeScale(0.5), 0.5);
    expect(timeDilation, 2);
    expect(host.setTimeScale(1), 1);
    expect(timeDilation, 1);
  });
}
