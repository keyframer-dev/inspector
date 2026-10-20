// The encoder against the golden fixture (inspector/packages/protocol/fixtures/vitals/report-flutter.json)
// and the shared validator (protocol/src/vitals-validate.ts, run with bun when it is installed).

import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:keyframer_vitals/src/controller.dart';
import 'package:keyframer_vitals/src/recorder.dart';
import 'package:keyframer_vitals/src/reporter.dart';
import 'package:keyframer_vitals/src/storage.dart';
import 'package:keyframer_vitals/src/transport.dart';

import 'support.dart';

/// Fields the fixture has that a report may leave out: what this reporter cannot know without plugins
/// (battery, thermal state), and `afterNavMs`, which only `screen-mount` frames carry.
const notMeasured = {'state.lowPower', 'state.thermal', 'worst.afterNavMs'};

/// Fields this reporter may send that the fixture happens not to show.
const mayAdd = {'state.reduceMotion', 'site.runsReduceMotion', 'worst.afterNavMs'};

/// A report like the fixture's: Flutter on a 120 Hz Android screen running at 60, a name, a source and
/// a native site in one ELF image, sent on the next launch from a checkpoint (`ended: 'unknown'`).
Map<String, Object?> encodeLikeTheFixture() {
  late Map<String, Object?> out;
  fakeAsync((async) {
    final storage = PersistentMemoryStorage();
    final transport = FakeTransport();
    VitalsReporter launch() => VitalsReporter(
      options: const VitalsOptions(
        key: 'kfp_live_test',
        appVersion: '3.4.0',
        build: '412',
        sampleRate: 0.1,
        appId: 'com.acme.shop',
        device: VitalsDevice(model: 'SM-G991B', memoryGb: 8, osMajor: 13, tier: 'mid'),
      ),
      store: VitalsStore(storage),
      transport: transport,
      facts: const PlatformFacts(os: 'android', osVersion: 'Linux 5.10.43'),
      clock: () => async.elapsed.inMicroseconds / 1000,
      releaseBuild: true,
      display: () => (120.0, true),
      // Below 0.1 on the first draw: sampled.
      random: _Fixed(0.05),
    );
    final r = launch()..start();
    async.flushMicrotasks();
    final rec = r.recorder!;
    double now() => async.elapsed.inMicroseconds / 1000;
    r.setScreen('/feed');

    final named = siteFor(name: 'hero-image', fn: 'AnimationController', owner: '_HeroImageState', created: null);
    final source = siteFor(
      name: null,
      fn: 'AnimationController',
      owner: '_FeedCardState',
      created: StackTrace.fromString('#1      _FeedCardState.initState (package:shop/feed/card.dart:57:12)'),
      appPackage: 'shop',
    );
    final native = siteFor(
      name: null,
      fn: 'AnimationController',
      owner: '_FeedListState',
      created: StackTrace.fromString(File('test/fixtures/trace-android-arm64.txt').readAsStringSync()),
    );

    void draw(int n, {double raster = 6, double build = 4}) {
      final t = now();
      for (var i = 0; i < n; i++) {
        final s = t + i * 1000 / 60;
        rec.frame(VitalsFrame(start: s, end: s + build + raster, buildMs: build, rasterMs: raster));
      }
      async.elapse(Duration(microseconds: (n * 1000000 / 60).round()));
    }

    draw(120);
    rec.runStart(source, now(), end: now() + 300);
    draw(18, raster: 30);
    rec.pointerDown(now());
    rec.pointerUp(now() + 20);
    draw(3, build: 80);
    rec.runStart(native, now(), end: now() + 300);
    draw(18, raster: 70);
    async.elapse(const Duration(seconds: 5));
    r.setScreen('/users/[id]');
    rec.navigation(now());
    rec.runStart(named, now(), end: now() + 400);
    draw(1, raster: 300);
    draw(24, raster: 20);
    async.elapse(const Duration(seconds: 55));
    // Checkpointed at 60 s; the process dies.
    r.dispose();
    final next = launch()..start();
    async.elapse(const Duration(seconds: 10));
    next.dispose();
    out = transport.reports.single;
  });
  return out;
}

class _Fixed implements math.Random {
  _Fixed(this.v);
  final double v;
  @override
  double nextDouble() => v;
  @override
  int nextInt(int max) => 3 % max;
  @override
  bool nextBool() => false;
}

void main() {
  final ours = encodeLikeTheFixture();
  final theirs = jsonDecode(fixture('report-flutter.json')) as Map<String, Object?>;
  // VITALS_DUMP=path writes the report, to read or to post to a local ingest.
  final dump = Platform.environment['VITALS_DUMP'];
  if (dump != null) File(dump).writeAsStringSync(const JsonEncoder.withIndent('  ').convert(ours));

  test('the encoder makes the fixture\'s shape', () {
    final errors = <String>[];
    _sameShape(ours, theirs, '', errors);
    expect(errors, isEmpty);
    expect((ours['session'] as Map)['ended'], 'unknown');
    expect((ours['sites'] as List).map((s) => (s['ref'] as Map)['kind']).toSet(), {'name', 'source', 'native'});
    expect((ours['images'] as List).single, {
      'debugId': '8d2f61c0b7e94a3c5f1e08d9a6b4c27e',
      'kind': 'elf',
      'name': 'libapp.so',
      'arch': 'arm64',
    });
    expect((ours['worst'] as List).map((w) => w['cause']).toSet(), containsAll(['screen-mount', 'gesture']));
  });

  test('the shared validator accepts the report (bun)', () async {
    final bun = Process.runSync('which', ['bun']).stdout.toString().trim();
    if (bun.isEmpty) {
      markTestSkipped('bun is not installed');
      return;
    }
    final dir = Directory.systemTemp.createTempSync('keyframer_vitals');
    try {
      final file = File('${dir.path}/report.json')..writeAsStringSync(jsonEncode(ours));
      final res = Process.runSync(bun, [
        'tool/validate.ts',
        file.path,
        '$protocolDir/fixtures/vitals/report-flutter.json',
      ]);
      expect(res.exitCode, 0, reason: '${res.stdout}${res.stderr}');
    } finally {
      dir.deleteSync(recursive: true);
    }
  });
}

String _kind(Object? v) => switch (v) {
  null => 'null',
  num() => 'number',
  String() => 'string',
  bool() => 'bool',
  List() => 'list',
  Map() => 'map',
  _ => v.runtimeType.toString(),
};

/// Same keys (bar the documented differences) and the same value types, recursively. Sites are
/// compared with the fixture's site of the same ref kind; list items with the fixture's first.
void _sameShape(Object? ours, Object? theirs, String path, List<String> errors) {
  final scope = switch (path) {
    final p when p.startsWith('.sites[') && p.split('.').length == 2 => 'site',
    final p when p.startsWith('.worst[') && p.split('.').length == 2 => 'worst',
    final p => p.replaceFirst('.', ''),
  };
  if (theirs is Map && ours is Map) {
    for (final k in theirs.keys) {
      if (!ours.containsKey(k) && !notMeasured.contains('$scope.$k')) errors.add('$path.$k: missing');
    }
    for (final k in ours.keys) {
      if (!theirs.containsKey(k)) {
        if (!mayAdd.contains('$scope.$k')) errors.add('$path.$k: not in the fixture');
        continue;
      }
      _sameShape(ours[k], theirs[k], '$path.$k', errors);
    }
    return;
  }
  if (theirs is List && ours is List) {
    if (theirs.isEmpty) return;
    for (var i = 0; i < ours.length; i++) {
      var match = theirs.first;
      if (path == '.sites') {
        final kind = ((ours[i] as Map)['ref'] as Map)['kind'];
        match = theirs.firstWhere((s) => ((s as Map)['ref'] as Map)['kind'] == kind, orElse: () => theirs.first);
      }
      _sameShape(ours[i], match, '$path[$i]', errors);
    }
    return;
  }
  final a = _kind(ours), b = _kind(theirs);
  // component and prop are string or null.
  final nullable = path.endsWith('.component') || path.endsWith('.prop');
  if (a != b && !(nullable && {a, b}.difference({'null', 'string'}).isEmpty)) errors.add('$path: $a, fixture $b');
}
