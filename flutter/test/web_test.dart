// What must hold on the web too, without dart:io: run it in a browser as well as on the VM,
//
//   flutter test --platform chrome test/web_test.dart
//
// The widget tree scan (implicit animations and their sites), the animation clock, and call sites
// from the stacks a web build prints.

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:keyframer_inspector/keyframer_inspector.dart';
import 'package:keyframer_inspector/src/scene.dart';

class _Sink implements KfSink {
  final anims = <KfCallSite>[];
  final signals = <KfSignalSite>[];

  @override
  void anim(KfCallSite site, List<Object?> args, {List<KfStackFrame>? frames, num? durationMs}) => anims.add(site);

  @override
  void signal(KfSignal s) => signals.add(s.site(KfRuntime.instance));

  @override
  void unsignal(String id) {}
}

class _Toggle extends StatefulWidget {
  const _Toggle({super.key});

  @override
  State<_Toggle> createState() => _ToggleState();
}

class _ToggleState extends State<_Toggle> {
  bool on = false;

  void toggle() => setState(() => on = !on);

  @override
  Widget build(BuildContext context) =>
      Center(child: AnimatedContainer(duration: const Duration(milliseconds: 200), width: on ? 100 : 50, height: 20));
}

void main() {
  final rt = KfRuntime.instance;
  late _Sink sink;
  setUp(() {
    rt.reset();
    rt.appPackage = 'keyframer_inspector';
    sink = _Sink();
    rt.install(sink);
  });
  tearDown(rt.reset);

  testWidgets('implicit animations are found and located where they were written', (tester) async {
    final key = GlobalKey<_ToggleState>();
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: _Toggle(key: key))));
    final scene = KfScene(rt, onVisibility: (_, _, _) {}, onHint: (_) {});
    scene.scan(tester.binding.rootElement!);
    expect(sink.signals.map((s) => s.name), ['AnimatedContainer']);
    final site = sink.signals.single;
    expect(site.file, endsWith('web_test.dart'));
    expect(site.component, 'Toggle');
    expect(site.writable, isFalse);
    key.currentState!.toggle();
    await tester.pump();
    expect(sink.anims.single.fn, 'AnimatedContainer');
    await tester.pumpAndSettle();
    scene.stop();
  });

  testWidgets('a started scene looks on its own, every 200 ms', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: _Toggle())));
    final scene = KfScene(rt, onVisibility: (_, _, _) {}, onHint: (_) {})..start();
    await tester.pump(const Duration(milliseconds: 250));
    expect(sink.signals.map((s) => s.name), ['AnimatedContainer']);
    scene.stop();
    expect(rt.signals, isEmpty);
  });

  testWidgets('the clock slows every animation', (tester) async {
    final clock = KfClock.forTesting(read: () => null, write: (_) {});
    final c = AnimationController(vsync: const TestVSync(), duration: const Duration(seconds: 1))..forward();
    clock.setScale(0.5);
    expect(timeDilation, 2);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 200));
    expect(c.value, closeTo(0.1, 1e-6));
    clock.setScale(1);
    c.dispose();
  });

  test('a call site is the app\'s frame, never the SDK\'s or a compiled file', () {
    // As a debug web build (DDC) prints a trace: the SDK's own patch first.
    final frames = parseStackTrace('''
dart-sdk/lib/_internal/js_dev_runtime/patch/core_patch.dart 749:28                 get current
packages/keyframer_inspector/src/controller.dart 41:68                             new
packages/demo/main.dart 42:26                                                      get [_entrance]
''');
    final app = appFrame(frames)!;
    expect(app.line, 42);
    expect(sourceFile(app.uri, appPackage: 'demo'), 'lib/main.dart');
    expect(appFrame(parseStackTrace('    at f (http://localhost:5000/main.dart.js:1:2)')), isNull);
  });

  test('the platform is the web in a browser, which names no device', () async {
    expect(currentOs(), kIsWeb ? 'web' : isNot('web'));
    if (kIsWeb) expect(await currentDevice(), isNull);
  });
}
