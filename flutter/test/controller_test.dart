import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/physics.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:keyframer_inspector/keyframer_inspector.dart';

/// Collects what the instrumented code reports.
class Collect implements KfSink {
  final anims = <(KfCallSite, List<Object?>)>[];
  final durations = <num?>[];
  final signals = <KfSignalSite>[];
  final gone = <String>[];

  @override
  void anim(KfCallSite site, List<Object?> args, {List<KfStackFrame>? frames, num? durationMs}) {
    anims.add((site, args));
    durations.add(durationMs);
  }

  @override
  void signal(KfSignal s) => signals.add(s.site(KfRuntime.instance));

  @override
  void unsignal(String id) => gone.add(id);
}

class Demo extends StatefulWidget {
  const Demo({super.key, this.onReady});

  final void Function(DemoState)? onReady;

  @override
  State<Demo> createState() => DemoState();
}

class DemoState extends State<Demo> with TickerProviderStateMixin {
  late final KfAnimationController entrance;
  late final KfAnimationController loop;

  @override
  void initState() {
    super.initState();
    entrance = KfAnimationController(vsync: this, duration: const Duration(milliseconds: 300), name: 'entrance');
    loop = KfAnimationController(vsync: this, duration: const Duration(milliseconds: 1000), name: 'loop');
    entrance.forward();
    widget.onReady?.call(this);
  }

  @override
  void dispose() {
    entrance.dispose();
    loop.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => const SizedBox();
}

/// `file:line:column` of the first line holding `snippet`, at `at` within it (the snippet itself by
/// default): where the VM places that call. Keeps the tests independent of line numbers.
String siteOf(String snippet, {String? at}) {
  final lines = File('test/controller_test.dart').readAsLinesSync();
  final i = lines.indexWhere((l) => l.contains(snippet));
  final start = lines[i].indexOf(snippet);
  return 'test/controller_test.dart:${i + 1}:${start + (at == null ? 0 : snippet.indexOf(at)) + 1}';
}

int lineOf(String site) => int.parse(site.split(':')[1]);
int columnOf(String site) => int.parse(site.split(':')[2]);

void main() {
  final rt = KfRuntime.instance;
  final entranceSite = siteOf('KfAnimationController(vsync: this, duration: const Duration(milliseconds: 300)');
  final loopSite = siteOf('KfAnimationController(vsync: this, duration: const Duration(milliseconds: 1000)');
  final forwardSite = siteOf('entrance.forward();', at: 'forward');
  late Collect sink;

  setUp(() {
    rt.reset();
    rt.root = Directory.current.path;
    sink = Collect();
    rt.install(sink);
  });
  tearDown(rt.reset);

  testWidgets('a controller is a signal located where it was created, and forward is an anim at its call', (tester) async {
    await tester.pumpWidget(const Demo());
    expect([for (final s in sink.signals) s.toJson()], [
      {'id': entranceSite, 'file': 'test/controller_test.dart', 'line': lineOf(entranceSite), 'column': columnOf(entranceSite), 'component': 'Demo', 'name': 'entrance'},
      {'id': loopSite, 'file': 'test/controller_test.dart', 'line': lineOf(loopSite), 'column': columnOf(loopSite), 'component': 'Demo', 'name': 'loop'},
    ]);
    final (site, args) = sink.anims.single;
    expect(site.toJson(), {
      'id': forwardSite,
      'file': 'test/controller_test.dart',
      'line': lineOf(forwardSite),
      'column': columnOf(forwardSite),
      'fn': 'forward',
      'component': 'Demo',
      'target': 'entrance',
      'prop': null,
      'params': [
        {'path': '1.duration', 'value': 300},
      ],
    });
    expect(args, [
      1.0,
      {'duration': 300, 'from': 0.0, 'curve': 'linear'},
    ]);
    expect(sink.durations.single, 300);
    await tester.pumpAndSettle();
    await tester.pumpWidget(const SizedBox());
    expect(sink.gone, [entranceSite, loopSite]);
  });

  testWidgets('every kind of start is reported with what it was asked', (tester) async {
    late DemoState s;
    await tester.pumpWidget(Demo(onReady: (d) => s = d));
    sink.anims.clear();
    sink.durations.clear();
    s.loop.animateTo(0.5, duration: const Duration(milliseconds: 200), curve: Curves.easeOut);
    s.loop.repeat(reverse: true);
    s.loop.fling(velocity: 2);
    s.loop.animateWith(SpringSimulation(const SpringDescription(mass: 1, stiffness: 100, damping: 10), 0, 1, 0));
    s.loop.reverse();
    expect(sink.anims.map((a) => a.$1.fn), ['animateTo', 'repeat', 'fling', 'animateWith', 'reverse']);
    expect(sink.anims[0].$2, [
      0.5,
      {'duration': 200, 'from': 0.0, 'curve': 'easeOut'},
    ]);
    expect(sink.anims[1].$2, [
      {'min': 0.0, 'max': 1.0, 'reverse': true, 'period': 1000},
    ]);
    expect(sink.anims[1].$1.params.single.path, '0.period');
    expect((sink.anims[3].$2.single as Map)['simulation'], startsWith('SpringSimulation'));
    // An explicit duration as given; a loop and a fling have none; a spring until it rests; reverse
    // from where the value is (already at the bottom).
    expect(sink.durations[0], 200);
    expect(sink.durations[1], isNull);
    expect(sink.durations[2], isNull);
    expect(sink.durations[3], inInclusiveRange(500, 2000));
    expect(sink.durations[4], 0);
    sink.durations.clear();
    // forward without a duration covers what is left of the range: half of it here.
    s.loop.value = 0.5;
    s.loop.forward();
    expect(sink.durations.single, 500);
    s.loop.stop();
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('a duration override applies the next time that call runs, for that call only', (tester) async {
    rt.overrides = {
      forwardSite: {'1.duration': 100},
    };
    late DemoState s;
    await tester.pumpWidget(Demo(onReady: (d) => s = d));
    expect((sink.anims.single.$2[1] as Map)['duration'], 100);
    await tester.pump(const Duration(milliseconds: 101));
    expect(s.entrance.value, 1.0);
    expect(s.entrance.duration, const Duration(milliseconds: 300));
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('a fling with its own spring reports the spring as params and takes overrides', (tester) async {
    late DemoState s;
    await tester.pumpWidget(Demo(onReady: (d) => s = d));
    sink.anims.clear();
    const spring = SpringDescription(mass: 1, stiffness: 180, damping: 30);
    // One call site for every run: overrides are per call site.
    void fling() => s.loop.fling(velocity: 1, springDescription: spring);
    fling();
    final site = sink.anims.single.$1;
    expect(site.params.map((p) => '${p.path}=${p.value}'), ['0.spring.mass=1.0', '0.spring.stiffness=180.0', '0.spring.damping=30.0']);
    s.loop.stop();
    rt.overrides = {
      site.id: {'0.spring.stiffness': 200},
    };
    sink.anims.clear();
    s.loop.value = 0;
    fling();
    expect((sink.anims.single.$2.single as Map)['spring'], {'mass': 1.0, 'stiffness': 200.0, 'damping': 30.0});
    s.loop.stop();
    // Values that would make it oscillate are not tried: fling asserts on them.
    rt.overrides = {
      site.id: {'0.spring.stiffness': 900},
    };
    sink.anims.clear();
    s.loop.value = 0;
    fling();
    expect((sink.anims.single.$2.single as Map)['spring'], {'mass': 1.0, 'stiffness': 180.0, 'damping': 30.0});
    s.loop.stop();
    rt.overrides = {};
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('playback takes a looping value over and hands the loop back when it ends', (tester) async {
    late DemoState s;
    await tester.pumpWidget(Demo(onReady: (d) => s = d));
    s.loop.repeat();
    await tester.pump(const Duration(milliseconds: 100));
    final sig = rt.signals[loopSite]!;
    sig.beginPlayback!();
    expect(s.loop.isAnimating, isFalse);
    sig.write(0.8);
    // The app restarts it meanwhile: that waits for the end of playback.
    s.loop.forward();
    await tester.pump(const Duration(milliseconds: 100));
    expect(s.loop.value, 0.8);
    sink.anims.clear();
    sig.endPlayback!();
    expect(s.loop.isAnimating, isTrue);
    expect(sink.anims.single.$1.fn, 'forward');
    s.loop.stop();
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('a screen closed during playback is left alone when playback ends', (tester) async {
    late DemoState s;
    await tester.pumpWidget(Demo(onReady: (d) => s = d));
    s.loop.repeat();
    await tester.pump(const Duration(milliseconds: 100));
    final sig = rt.signals[loopSite]!;
    sig.beginPlayback!();
    // The screen goes away mid-playback: its controllers are disposed.
    await tester.pumpWidget(const SizedBox());
    sig.write(0.5);
    sig.endPlayback!();
    expect(tester.takeException(), isNull);
  });

  testWidgets('two mounted instances of one widget have their own ids', (tester) async {
    await tester.pumpWidget(const Column(children: [Demo(), Demo()]));
    expect(rt.signals.keys, containsAll([entranceSite, '$entranceSite#2']));
    await tester.pumpAndSettle();
    await tester.pumpWidget(const SizedBox());
    expect(rt.signals, isEmpty);
  });

  testWidgets('kfTrack follows a plain controller through its status', (tester) async {
    final c = AnimationController(vsync: const TestVSync(), duration: const Duration(milliseconds: 200)).kfTrack('plain');
    expect(sink.signals.last.name, 'plain');
    c.forward();
    expect(sink.anims.single.$1.fn, 'forward');
    expect(sink.anims.single.$1.id, endsWith('#forward'));
    await tester.pump(const Duration(milliseconds: 250));
    c.kfUntrack();
    c.dispose();
    expect(rt.signals, isEmpty);
  });

  testWidgets('the navigator observer reports screens and takes the app back to one', (tester) async {
    final observer = KfNavigatorObserver();
    final key = GlobalKey<NavigatorState>();
    final seen = <String>[];
    rt.tapNavigation((r) => seen.add(r.route));
    await tester.pumpWidget(MaterialApp(
      navigatorKey: key,
      navigatorObservers: [observer],
      routes: {
        '/': (_) => const Text('home'),
        '/details': (_) => const Text('details'),
        '/more': (_) => const Text('more'),
      },
    ));
    key.currentState!.pushNamed('/details', arguments: {'id': 7, 'skip': Object()});
    await tester.pumpAndSettle();
    expect(rt.currentRoute!.route, '/details');
    expect(rt.currentRoute!.params, {'id': 7});
    // A dialog is not a screen.
    showDialog<void>(context: key.currentContext!, builder: (_) => const Text('dialog'));
    await tester.pumpAndSettle();
    expect(rt.currentRoute!.route, '/details');
    Navigator.of(key.currentContext!).pop();
    await tester.pumpAndSettle();

    expect(rt.navigateTo('/more'), isTrue);
    await tester.pumpAndSettle();
    expect(find.text('more'), findsOneWidget);
    expect(rt.navigateTo('/'), isTrue);
    await tester.pumpAndSettle();
    expect(find.text('home'), findsOneWidget);
    expect(rt.navigateTo('/'), isFalse);
    expect(seen, ['/', '/details', '/more', '/']);
  });
}
