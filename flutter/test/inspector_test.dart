// Turning the inspector on and off. The dart-define is read when the app is built, so this file also
// runs with it set, and its expectations follow:
//
//   flutter test --dart-define=KEYFRAMER_INSPECTOR=false test/inspector_test.dart

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:keyframer_inspector/keyframer_inspector.dart';
import 'package:keyframer_inspector/src/controller.dart' show kfInspectorEnabledBy;

const _define = String.fromEnvironment('KEYFRAMER_INSPECTOR');

class _Sink implements KfSink {
  final signals = <KfSignalSite>[];

  @override
  void anim(KfCallSite site, List<Object?> args, {List<KfStackFrame>? frames, num? durationMs}) {}

  @override
  void signal(KfSignal s) => signals.add(s.site(KfRuntime.instance));

  @override
  void unsignal(String id) {}
}

void main() {
  final rt = KfRuntime.instance;
  setUp(rt.reset);
  tearDown(rt.reset);

  test('KEYFRAMER_INSPECTOR: false is off and true is on in any build; unset, on except in release', () {
    expect(kfInspectorEnabledBy('', release: false), isTrue);
    expect(kfInspectorEnabledBy('', release: true), isFalse);
    expect(kfInspectorEnabledBy('false', release: false), isFalse);
    expect(kfInspectorEnabledBy('false', release: true), isFalse);
    expect(kfInspectorEnabledBy('true', release: false), isTrue);
    expect(kfInspectorEnabledBy('true', release: true), isTrue);
    expect(kfInspectorEnabledBy(' FALSE ', release: false), isFalse);
    // Anything else says nothing.
    expect(kfInspectorEnabledBy('maybe', release: false), isTrue);
  });

  test('this build: the define decides, and values capture their sites only when it is on', () {
    // Under flutter test (a debug build) it is on unless the define says false.
    final on = _define.trim().toLowerCase() != 'false';
    expect(kfInspectorDefaultEnabled, on);
    expect(kfCaptureSites, on);
    rt.install(_Sink());
    final c = KfAnimationController(vsync: const TestVSync(), name: 'card');
    expect(rt.signals.keys.single, on ? contains('test/inspector_test.dart:') : 'value:card');
    c.dispose();
  });

  test('turned off by the app (enabled: false): no connection, and no sites captured from then on', () {
    final before = kfCaptureSites;
    try {
      final connection = connectKeyframerInspector(app: 'Demo', enabled: false);
      expect(connection.enabled, isFalse);
      expect(rt.active, isFalse);
      expect(kfCaptureSites, isFalse);
      final sink = _Sink();
      rt.install(sink);
      final c = KfAnimationController(vsync: const TestVSync(), name: 'card');
      expect(sink.signals.single.id, 'value:card');
      c.dispose();
    } finally {
      kfCaptureSites = before;
    }
  });

  testWidgets(
    'KeyframerInspector built with KEYFRAMER_INSPECTOR=false connects to nothing',
    (tester) async {
      await tester.pumpWidget(const KeyframerInspector(app: 'Demo', child: SizedBox()));
      expect(rt.active, isFalse);
      expect(kfCaptureSites, isFalse);
    },
    // Unset, a debug build would connect to a relay: this one runs with the define only.
    skip: _define != 'false',
  );
}
