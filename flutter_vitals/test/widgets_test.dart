import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:keyframer_vitals/keyframer_vitals.dart';
import 'package:keyframer_vitals/src/recorder.dart';
import 'package:keyframer_vitals/src/reporter.dart';
import 'package:keyframer_vitals/src/transport.dart';

import 'support.dart';

class _Card extends StatefulWidget {
  const _Card({this.name});
  final String? name;
  @override
  State<_Card> createState() => _CardState();
}

class _CardState extends State<_Card> with SingleTickerProviderStateMixin {
  late final controller = VitalsAnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 300),
    name: widget.name,
  );

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) =>
      FadeTransition(opacity: controller, child: const SizedBox(width: 10, height: 10));
}

void main() {
  late FakeTransport transport;
  var now = 0.0;

  Future<void> start(WidgetTester tester, {double rate = 1}) async {
    transport = FakeTransport();
    now = 0;
    await KeyframerVitals.startWith(
      VitalsOptions(key: 'kfp_live_test', appVersion: '1.0.0', sampleRate: rate),
      storage: MemoryVitalsStorage(),
      transport: transport,
      facts: const PlatformFacts(os: 'ios', osVersion: 'Version 18.1 (Build 22B83)'),
      clock: () => now,
      releaseBuild: true,
      random: math.Random(1),
    );
  }

  /// testWidgets with the reporter reset before the test's pending-timer check.
  void vitalsTest(String name, Future<void> Function(WidgetTester) body) => testWidgets(name, (tester) async {
    try {
      await body(tester);
    } finally {
      KeyframerVitals.reset();
    }
  });

  vitalsTest('a named controller is a site; its runs end when it stops', (tester) async {
    await start(tester);
    expect(KeyframerVitals.isMeasuring, isTrue);
    await tester.pumpWidget(const MaterialApp(home: _Card(name: 'card-expand')));
    final state = tester.state<_CardState>(find.byType(_Card));
    now = 1000;
    state.controller.forward();
    now = 1100;
    state.controller.stop();
    now = 1200;
    state.controller.reverse(from: 1);
    await tester.pumpAndSettle();
    now = 2000;
    final body = KeyframerVitals.reporter!.recorder!.snapshot(now);
    final site = body.sites.single;
    expect(site['ref'], {'kind': 'name', 'name': 'card-expand', 'type': '_CardState'});
    expect(site['component'], 'Card');
    expect(site['runs'], 2);
    // 100 ms until stopped, then the estimated 300 ms of the reverse (the clock here does not move
    // while it runs, so its completion lands at the same instant).
    expect(site['activeMs'], 100);
  });

  vitalsTest('an unnamed controller in a test is not an app source: named after its State', (tester) async {
    await start(tester);
    await tester.pumpWidget(const MaterialApp(home: _Card()));
    tester.state<_CardState>(find.byType(_Card)).controller.forward();
    await tester.pumpAndSettle();
    final site = KeyframerVitals.reporter!.recorder!.snapshot(now).sites.single;
    expect(site['ref'], {'kind': 'name', 'name': 'Card', 'type': '_CardState'});
  });

  vitalsTest('nothing is tracked in an unsampled session', (tester) async {
    await start(tester, rate: 0);
    expect(KeyframerVitals.isMeasuring, isFalse);
    await tester.pumpWidget(const MaterialApp(home: _Card(name: 'x')));
    tester.state<_CardState>(find.byType(_Card)).controller.forward();
    await tester.pumpAndSettle();
    expect(KeyframerVitals.reporter!.recorder, isNull);
  });

  vitalsTest('screens from route names, masked; transitions and Hero flights are sites', (tester) async {
    await start(tester);
    final key = GlobalKey<NavigatorState>();
    await tester.pumpWidget(
      MaterialApp(
        navigatorKey: key,
        navigatorObservers: [KeyframerVitals.navigatorObserver],
        initialRoute: '/',
        onGenerateRoute:
            (s) => MaterialPageRoute<void>(
              settings: s,
              builder:
                  (_) =>
                      Hero(tag: s.name == '/' ? 'avatar-7' : 'avatar-7', child: const SizedBox(width: 20, height: 20)),
            ),
      ),
    );
    expect(KeyframerVitals.reporter!.screen, '/');
    now = 1000;
    key.currentState!.pushNamed('/users/12345');
    await tester.pumpAndSettle();
    expect(KeyframerVitals.reporter!.screen, '/users/[number]');
    final body = KeyframerVitals.reporter!.recorder!.snapshot(2000);
    final names = body.sites.map((s) => (s['ref'] as Map)['name']).toList();
    expect(names, containsAll(['route /users/[number]', 'Hero(avatar-#)']));
    final route = body.sites.firstWhere((s) => (s['ref'] as Map)['name'] == 'route /users/[number]');
    expect(route['fn'], 'Navigator.push');
    // The route's own transition duration (MaterialPageRoute's depends on the platform's builder).
    expect(route['activeMs'], greaterThan(0));
    final hero = body.sites.firstWhere((s) => (s['ref'] as Map)['name'] == 'Hero(avatar-#)');
    expect(hero['fn'], 'Hero');
    expect(hero['activeMs'], route['activeMs']);
    expect(body.screens.map((s) => s['name']), containsAll(['/', '/users/[number]']));
  });

  vitalsTest('setScreen masks; setEnabled(false) stops measuring', (tester) async {
    await start(tester);
    KeyframerVitals.setScreen('Profile ada@example.com');
    expect(KeyframerVitals.reporter!.screen, 'Profile [email]');
    await KeyframerVitals.setEnabled(false);
    expect(KeyframerVitals.isMeasuring, isFalse);
    await KeyframerVitals.setEnabled(true);
    expect(KeyframerVitals.isMeasuring, isTrue);
  });

  vitalsTest('scroll windows from VitalsScrollListener', (tester) async {
    await start(tester);
    await tester.pumpWidget(
      MaterialApp(
        home: VitalsScrollListener(
          child: ListView(children: [for (var i = 0; i < 50; i++) SizedBox(height: 80, child: Text('$i'))]),
        ),
      ),
    );
    final rec = KeyframerVitals.reporter!.recorder!;
    now = 500;
    await tester.drag(find.byType(ListView), const Offset(0, -300));
    now = 600;
    await tester.pumpAndSettle();
    now = 5000;
    final (cause, _) = rec.causeOf(const VitalsFrame(start: 495, end: 505, buildMs: 1, rasterMs: 1));
    expect(cause, 'scroll');
  });
}
