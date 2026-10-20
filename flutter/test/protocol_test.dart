// The messages a Flutter app sends, produced by the real client and compared with golden JSON files.
// The goldens are also written into test/goldens/messages.ts, which `tsc` checks against the
// protocol's TypeScript types (protocol/inspector.ts) with `satisfies`: a missing field, an
// extra one or a wrong literal fails there. Update the goldens with:
//
//   KF_UPDATE_GOLDENS=1 flutter test test/protocol_test.dart

import 'dart:convert';
import 'dart:io';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:keyframer_inspector/keyframer_inspector.dart';

import 'support/fakes.dart';

const _update = bool.fromEnvironment('KF_UPDATE_GOLDENS') || String.fromEnvironment('KF_UPDATE_GOLDENS') == '1';
final _updateEnv = Platform.environment['KF_UPDATE_GOLDENS'] == '1';

/// Every message type a Flutter app sends, from one scripted session.
Map<String, Map<String, Object?>> session() {
  final out = <String, Map<String, Object?>>{};
  fakeAsync((async) {
    final rt = KfRuntime()..appPackage = 'demo';
    final connector = FakeConnector();
    final host = FakeFullHost();
    final card = TestValue('cardX', line: 31, member: '_HomeScreenState.initState');
    rt.register(card.signal);
    rt.emitNavigation('/');
    rt.registerScenario('drag card', () async {});
    final client = KfInspectorClient(
      url: relayAppUrl(app: 'Demo', platform: 'macos'),
      connector: connector.call,
      app: 'Demo',
      platform: 'macos',
      osVersion: '26.6.2',
      host: host,
      device: Future.value(const KfDevice(model: 'Mac15,3')),
      runtime: rt,
      // Flushed by hand below, so one batch holds a whole gesture.
      batch: const Duration(hours: 1),
      now: () => async.elapsed.inMicroseconds / 1000,
      wallClock: () => 1700000000000 + async.elapsed.inMilliseconds,
    )..start();
    async.flushMicrotasks();
    final s = connector.last;
    out['hello'] = s.sent[0];
    out['catalog'] = s.sent[1];

    s.receive({
      'type': 'record',
      'signalIds': ['*'],
      'on': true,
    });
    async.flushMicrotasks();
    s.sent.clear();
    for (var i = 0; i < 18; i++) {
      card.value = i / 17;
      async.elapse(const Duration(microseconds: 16667));
      host.onFrame!();
    }
    async.elapse(const Duration(milliseconds: 34));
    host.onFrame!();
    host.onTimings!([
      for (var i = 1; i <= 16; i++) KfTiming(rasterEnd: 9000 + i * 16.667, rasterMs: i == 8 ? 25 : 3.5, buildMs: 2),
    ]);
    host.onTouch!(const KfTouch('start', 1, 120, 300, 20000));
    async.elapse(const Duration(milliseconds: 16));
    host.onTouch!(const KfTouch('move', 1, 160, 300, 20016));
    async.elapse(const Duration(milliseconds: 16));
    host.onTouch!(const KfTouch('end', 1, 180, 300, 20032));
    rt.emitNavigation('/details', {'id': 7});
    rt.reportAnim(
      const KfCallSite(
        id: 'lib/main.dart:58:15',
        file: 'lib/main.dart',
        line: 58,
        column: 15,
        fn: 'animateTo',
        component: 'Details',
        target: 'bars',
        params: [KfParam('1.duration', 900)],
      ),
      [
        1.0,
        {'duration': 900, 'from': 0.0, 'curve': 'easeOutBack'},
      ],
      frames: parseStackTrace('''
#0      KfAnimationController.animateTo (package:keyframer_inspector/src/controller.dart:56:9)
#1      _DetailsState.initState (package:demo/main.dart:58:15)
#2      StatefulElement._firstBuild (package:flutter/src/widgets/framework.dart:5602:5)
'''),
      durationMs: 900,
    );
    client.flush();
    out['anim'] = s.ofType('events').single;
    // Keep the golden short: a few samples and frame windows.
    final batch = Map.of(s.ofType('samples').single);
    batch['samples'] = (batch['samples'] as List).take(3).toList();
    batch['frames'] = (batch['frames'] as List).take(2).toList();
    out['samples'] = batch;

    // What newer apps send: the speed an editor set, the markers for the device, the clock and the
    // widget tree, and a render hint.
    s.sent.clear();
    s.receive({'type': 'time', 'scale': 0.25});
    async.elapse(const Duration(milliseconds: 10));
    out['time'] = s.ofType('time').single;
    host.accessibilityNow = const KfAccessibility(reduceMotion: true);
    host.displayNow = const KfDisplay(60);
    host.appStateNow = 'background';
    host.onDeviceChange!();
    host.onVisibility!('lib/main.dart:31:5', false, 'covered');
    host.onVisibility!('lib/main.dart:31:5', true, null);
    host.onHint!(
      const KfRenderHint(
        'lib/main.dart:31:5',
        'opacity-widget',
        'Opacity at lib/main.dart:120 is rebuilt with a new opacity (0.40, then 0.57)',
      ),
    );
    client.flush();
    out['markers'] = s.ofType('samples').single;
    out['renderHint'] = s.ofType('events').single;
    s.receive({'type': 'time', 'scale': 1});
    async.flushMicrotasks();

    s.receive({'type': 'scenario', 'name': 'drag card'});
    s.receive({'type': 'scenario', 'name': 'missing'});
    s.receive({
      'type': 'capture',
      'id': 'frame-1',
      'samples': [
        {'id': 'lib/main.dart:31:5', 't': 120, 'v': 0.5},
      ],
    });
    async.elapse(const Duration(milliseconds: 10));
    client.flush();
    out['scenarioDone'] = s.ofType('scenarioDone').first;
    out['scenarioDoneError'] = s.ofType('scenarioDone').last;
    out['frame'] = s.ofType('frame').single;
    rt.registerScenario('open details', () async {});
    out['scenarios'] = s.ofType('scenarios').last;
    s.sent.clear();
    rt.unregister(card.signal);
    client.flush();
    out['unsignal'] = s.ofType('events').single;
    client.dispose();
    async.flushMicrotasks();
  });
  out['frameError'] = KfAppMessage.frame(
    id: 'frame-2',
    error: 'Nothing to capture: KeyframerInspector is not mounted.',
  );
  return out;
}

String _pretty(Object? json) => '${const JsonEncoder.withIndent('  ').convert(json)}\n';

/// [importLine] is kept from the file on disk: the public repository lays the protocol types out
/// elsewhere, and its copy of this file points there.
String _typescript(Map<String, Map<String, Object?>> goldens, {String? importLine}) {
  final b =
      StringBuffer()
        ..writeln('// Generated by test/protocol_test.dart from test/goldens/*.json: do not edit.')
        ..writeln('// `tsc -p tool/tsconfig.goldens.json` checks every message against the protocol types.')
        ..writeln(
          importLine ?? "import type { InspectorAppMessage } from '../../protocol/inspector'",
        )
        ..writeln()
        ..writeln('export const goldens = {');
  for (final e in goldens.entries) {
    b.writeln('  ${e.key}: ${const JsonEncoder.withIndent('  ').convert(e.value).replaceAll('\n', '\n  ')},');
  }
  b.writeln('} satisfies Record<string, InspectorAppMessage>');
  return b.toString();
}

void main() {
  final goldens = session();
  final dir = Directory('test/goldens');

  for (final name in goldens.keys) {
    test('$name matches its golden', () {
      final file = File('${dir.path}/$name.json');
      final actual = _pretty(goldens[name]);
      if (_update || _updateEnv) file.writeAsStringSync(actual);
      expect(actual, file.readAsStringSync());
    });
  }

  test('hello names the SDK version pubspec.yaml publishes', () {
    final version = RegExp(r'^version: (\S+)', multiLine: true).firstMatch(File('pubspec.yaml').readAsStringSync())![1];
    expect(kfSdkVersion, version);
  });

  test('messages.ts is in sync with the goldens', () {
    final file = File('${dir.path}/messages.ts');
    final existing =
        file.existsSync() ? file.readAsLinesSync().where((l) => l.startsWith('import type ')) : const <String>[];
    final actual = _typescript(goldens, importLine: existing.isEmpty ? null : existing.first);
    if (_update || _updateEnv) file.writeAsStringSync(actual);
    expect(actual, file.readAsStringSync());
  });

  // Runs when the workspace's TypeScript is installed (it is wherever the inspector is developed): the
  // inspector's own node_modules, or Keyframer's when the inspector is its subtree.
  final tsc = [
    '../../node_modules/.bin/tsc',
    '../../../node_modules/.bin/tsc',
  ].map(File.new).firstWhere((f) => f.existsSync(), orElse: () => File('../../node_modules/.bin/tsc'));
  test('the goldens type-check against protocol/inspector.ts', () {
    final r = Process.runSync(tsc.path, ['-p', 'tool/tsconfig.goldens.json']);
    expect(r.exitCode, 0, reason: '${r.stdout}${r.stderr}');
  }, skip: tsc.existsSync() ? false : 'no TypeScript in node_modules');
}
