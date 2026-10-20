import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:keyframer_inspector/keyframer_inspector.dart';

import 'support/fakes.dart';

const site = KfCallSite(
  id: 'lib/main.dart:42:15',
  file: 'lib/main.dart',
  line: 42,
  column: 15,
  fn: 'forward',
  component: 'HomeScreen',
  target: 'entrance',
  params: [KfParam('1.duration', 700)],
);

void main() {
  late KfRuntime rt;
  late FakeConnector connector;
  late FakeHost host;

  setUp(() {
    rt = KfRuntime();
    rt.appPackage = 'demo';
    connector = FakeConnector();
    host = FakeHost();
  });

  KfInspectorClient makeClient(FakeAsync async, {KfHost? withHost}) => KfInspectorClient(
    url: relayAppUrl(app: 'Demo', platform: 'ios'),
    connector: connector.call,
    app: 'Demo',
    platform: 'ios',
    osVersion: '18.6',
    host: withHost ?? host,
    runtime: rt,
    now: () => async.elapsed.inMicroseconds / 1000,
    wallClock: () => 1700000000000 + async.elapsed.inMilliseconds,
  )..start();

  test('joins the relay as the app, says hello, then sends the catalog', () {
    fakeAsync((async) {
      final card = TestValue('cardX');
      rt.register(card.signal);
      final client = makeClient(async);
      async.flushMicrotasks();
      final s = connector.last;
      expect(s.url.toString(), 'ws://127.0.0.1:8790/app?name=Demo&platform=ios');
      expect(s.sent.first, {
        'type': 'hello',
        'role': 'app',
        'app': 'Demo',
        'platform': 'ios',
        'capture': true,
        'screen': {'width': 390, 'height': 844, 'scale': 3},
        'scenarios': <String>[],
        'protocol': 1,
        'sdk': {'name': 'keyframer_inspector', 'version': '0.1.1'},
        'framework': 'flutter',
        'osVersion': '18.6',
        'build': 'debug',
        'threads': {
          'js': {'label': 'UI isolate', 'animates': true},
          'ui': {'label': 'Raster'},
        },
        'capabilities': ['playback', 'overrides', 'replay', 'scenarios', 'capture'],
      });
      expect(s.sent[1], {
        'type': 'events',
        'events': [
          {
            'kind': 'signal',
            'site': {
              'id': 'lib/main.dart:10:5',
              'file': 'lib/main.dart',
              'line': 10,
              'column': 5,
              'component': 'Card',
              'name': 'cardX',
            },
          },
        ],
      });
      client.dispose();
    });
  });

  test('batches anim events every 100 ms and strips what JSON cannot carry', () {
    fakeAsync((async) {
      final client = makeClient(async);
      async.flushMicrotasks();
      rt.reportAnim(site, [
        1.0,
        {'duration': 700, 'curve': () {}},
        double.nan,
      ]);
      expect(connector.last.ofType('events'), isEmpty);
      async.elapse(const Duration(milliseconds: 100));
      final [event] = connector.last.events;
      expect(event['kind'], 'anim');
      expect(event['eid'], 1);
      expect(event['thread'], 'js');
      expect(event['args'], [
        1.0,
        // Like client.ts: a function field is dropped, a function argument becomes '[function]'.
        {'duration': 700},
        null,
      ]);
      // Not recording: no recording clock, no stack.
      expect(event.containsKey('t'), isFalse);
      expect(event.containsKey('stack'), isFalse);
      client.dispose();
    });
  });

  test('re-sends the catalog to an editor that joins later', () {
    fakeAsync((async) {
      rt.register(TestValue('a').signal);
      final client = makeClient(async);
      async.flushMicrotasks();
      final s = connector.last;
      s.sent.clear();
      s.receive({'type': 'presence', 'app': true, 'editors': 1, 'cli': false});
      async.flushMicrotasks();
      expect(s.ofType('events'), hasLength(1));
      // The same count again (a cli joined): nothing new to send.
      s.receive({'type': 'presence', 'app': true, 'editors': 1, 'cli': true});
      async.flushMicrotasks();
      expect(s.ofType('events'), hasLength(1));
      // A relay that forwards the editor's hello gets hello and catalog back.
      s.receive({'type': 'hello', 'role': 'editor'});
      async.flushMicrotasks();
      expect(s.ofType('hello'), hasLength(1));
      expect(s.ofType('events'), hasLength(2));
      client.dispose();
    });
  });

  test('records every value each frame, with frame stats, touches and navigation', () {
    fakeAsync((async) {
      final a = TestValue('a');
      rt.register(a.signal);
      rt.emitNavigation('/');
      final client = makeClient(async);
      async.flushMicrotasks();
      final s = connector.last;
      s.receive({
        'type': 'record',
        'signalIds': ['*'],
        'on': true,
      });
      async.flushMicrotasks();
      expect(host.onFrame, isNotNull);

      // 20 steady frames at 60 Hz, then one that took 50 ms.
      for (var i = 0; i < 20; i++) {
        a.value = i / 20;
        async.elapse(const Duration(microseconds: 16667));
        host.onFrame!();
      }
      async.elapse(const Duration(milliseconds: 50));
      host.onFrame!();

      // Raster timings on the engine's clock (offset by 5 s), one slow frame among them.
      host.onTimings!([
        for (var i = 1; i <= 20; i++) KfTiming(rasterEnd: 5000 + i * 16.667, rasterMs: i == 10 ? 40 : 4, buildMs: 3),
      ]);

      // A touch, timed by its own stamp.
      host.onTouch!(const KfTouch('start', 1, 100, 200, 9000));
      async.elapse(const Duration(milliseconds: 4));
      host.onTouch!(const KfTouch('move', 1, 101, 200, 9004));
      async.elapse(const Duration(milliseconds: 6));
      host.onTouch!(const KfTouch('move', 1, 110, 200, 9010));
      async.elapse(const Duration(milliseconds: 10));
      host.onTouch!(const KfTouch('end', 1, 110, 200, 9020));
      rt.emitNavigation('/details', {'id': 7});
      async.elapse(const Duration(milliseconds: 100));

      final batches = s.ofType('samples');
      final samples = [for (final b in batches) ...(b['samples'] as List).cast<Map>()];
      expect(samples, hasLength(21));
      expect(samples.first, {'id': 'lib/main.dart:10:5', 't': 17, 'v': 0.0});
      final frames = [for (final b in batches) ...((b['frames'] as List?) ?? const []).cast<Map>()];
      final drops = [for (final b in batches) ...((b['drops'] as List?) ?? const []).cast<Map>()];
      expect(frames.where((f) => f['thread'] == 'js').first, containsPair('fps', 60));
      expect(drops.where((d) => d['thread'] == 'js'), [
        {'t': 383, 'thread': 'js', 'ms': 50.0, 'dropped': 2},
      ]);
      // The slow raster frame, on the recording's clock: the batch arrived when its last frame ended.
      expect(drops.where((d) => d['thread'] == 'ui'), [
        {'t': 217, 'thread': 'ui', 'ms': 40.0, 'dropped': 2},
      ]);
      final markers = [for (final b in batches) ...((b['markers'] as List?) ?? const []).cast<Map>()];
      expect(markers.where((m) => m['kind'] == 'navigation').map((m) => m['route']), ['/', '/details']);
      expect(markers.last, {
        'kind': 'navigation',
        't': 403,
        'route': '/details',
        'params': {'id': 7},
      });
      // The second move came 4 ms after the first: dropped (one per 120 Hz frame).
      final touches = markers.where((m) => m['kind'] == 'touch').toList();
      expect(touches.map((m) => m['phase']), ['start', 'move', 'end']);
      expect(touches.first, {'kind': 'touch', 't': 383, 'phase': 'start', 'id': 1, 'x': 100, 'y': 200});
      expect(touches.last['t'], 403);

      // Stopping detaches from the host.
      s.receive({
        'type': 'record',
        'signalIds': ['*'],
        'on': false,
      });
      async.flushMicrotasks();
      expect(host.onFrame, isNull);
      expect(host.onTouch, isNull);
      client.dispose();
    });
  });

  test('anims started while recording carry the recording clock and their stack', () {
    fakeAsync((async) {
      final client = makeClient(async);
      async.flushMicrotasks();
      connector.last.receive({
        'type': 'record',
        'signalIds': ['*'],
        'on': true,
      });
      async.flushMicrotasks();
      async.elapse(const Duration(milliseconds: 250));
      rt.reportAnim(
        site,
        [1.0],
        durationMs: 699.6,
        frames: parseStackTrace('''
#0      KfAnimationController.forward (package:keyframer_inspector/src/controller.dart:38:7)
#1      _HomeScreenState.initState (package:demo/main.dart:42:15)
#2      StatefulElement._firstBuild (package:flutter/src/widgets/framework.dart:5602:5)
'''),
      );
      async.elapse(const Duration(milliseconds: 100));
      final event = connector.last.events.singleWhere((e) => e['kind'] == 'anim');
      expect(event['t'], 250);
      expect(event['durationMs'], 700);
      expect(event['stack'], '    at _HomeScreenState.initState (lib/main.dart:42:15)');
      // Already mapped to source: the inspector's own frame dropped, Flutter's collapsed.
      expect(event['frames'], [
        {'methodName': '_HomeScreenState.initState', 'file': 'lib/main.dart', 'lineNumber': 42, 'column': 15},
        {
          'methodName': 'StatefulElement._firstBuild',
          'file': 'package:flutter/src/widgets/framework.dart',
          'lineNumber': 5602,
          'column': 5,
          'collapse': true,
        },
      ]);
      client.dispose();
    });
  });

  test('a value created while recording everything joins the recording', () {
    fakeAsync((async) {
      final client = makeClient(async);
      async.flushMicrotasks();
      connector.last.receive({
        'type': 'record',
        'signalIds': ['*'],
        'on': true,
      });
      async.flushMicrotasks();
      final late = TestValue('late', line: 99)..value = 3;
      rt.register(late.signal);
      async.elapse(const Duration(milliseconds: 16));
      host.onFrame!();
      async.elapse(const Duration(milliseconds: 100));
      final samples = [for (final b in connector.last.ofType('samples')) ...(b['samples'] as List).cast<Map>()];
      expect(samples.map((s) => s['id']), ['lib/main.dart:99:5']);
      client.dispose();
    });
  });

  test('two instances of one call site get their own ids', () {
    final a = TestValue('row'), b = TestValue('row');
    expect(rt.register(a.signal), 'lib/main.dart:10:5');
    expect(rt.register(b.signal), 'lib/main.dart:10:5#2');
    expect(b.signal.site(rt).name, 'row #2');
    rt.unregister(a.signal);
    final c = TestValue('row');
    expect(rt.register(c.signal), 'lib/main.dart:10:5');
  });

  test('instances of one call site with names of their own keep them (no "row1 #2")', () {
    final a = TestValue('row1'), b = TestValue('row2'), c = TestValue('row2');
    expect(rt.register(a.signal), 'lib/main.dart:10:5');
    expect(rt.register(b.signal), 'lib/main.dart:10:5#2');
    expect(rt.register(c.signal), 'lib/main.dart:10:5#3');
    expect([a.signal.site(rt).name, b.signal.site(rt).name, c.signal.site(rt).name], ['row1', 'row2', 'row2 #3']);
  });

  test('playback writes samples in time order, navigates, and hands values back at the end', () {
    fakeAsync((async) {
      final a = TestValue('a');
      rt.register(a.signal);
      final went = <String>[];
      rt.registerNavigator((route, params) {
        went.add(route);
        rt.emitNavigation(route, params);
        return true;
      });
      rt.emitNavigation('/details');
      final client = makeClient(async);
      async.flushMicrotasks();
      connector.last.receive({
        'type': 'playback',
        'samples': [
          {'id': 'lib/main.dart:10:5', 't': 1032, 'v': 0.5},
          {'id': 'lib/main.dart:10:5', 't': 1000, 'v': 0.1},
          {'id': 'lib/main.dart:10:5', 't': 1100, 'v': 0.9},
          {'id': 'unknown', 't': 1010, 'v': 4},
        ],
        'routes': [
          {'t': 1000, 'route': '/'},
          {
            't': 1050,
            'route': '/details',
            'params': {'id': 7},
          },
        ],
      });
      async.flushMicrotasks();
      expect(a.began, 1);
      expect(a.writes, [0.1]);
      expect(went, ['/']);
      async.elapse(const Duration(milliseconds: 40));
      expect(a.writes, [0.1, 0.5]);
      expect(a.ended, 0);
      async.elapse(const Duration(milliseconds: 80));
      expect(a.writes, [0.1, 0.5, 0.9]);
      expect(went, ['/', '/details']);
      expect(a.ended, 1);
      expect(client.playing, isFalse);
      client.dispose();
    });
  });

  test('capture shows the values, snapshots the screen and answers with the same id', () {
    fakeAsync((async) {
      final a = TestValue('a');
      rt.register(a.signal);
      final client = makeClient(async);
      async.flushMicrotasks();
      connector.last.receive({
        'type': 'capture',
        'id': 'f1',
        'samples': [
          {'id': 'lib/main.dart:10:5', 't': 0, 'v': 0.25},
        ],
        'format': 'jpg',
        'width': 320,
      });
      async.flushMicrotasks();
      expect(a.value, 0.25);
      expect(connector.last.ofType('frame'), [
        {'type': 'frame', 'id': 'f1', 'data': 'iVBORw0KGgo=', 'format': 'png'},
      ]);
      expect(a.ended, 0);
      // Shortly after the last capture the value is the app's again, as it was before.
      async.elapse(const Duration(milliseconds: 600));
      expect(a.ended, 1);
      expect(a.value, 0);
      client.dispose();
    });
  });

  test('scenarios: listed in hello, announced when they change, run on request', () {
    fakeAsync((async) {
      rt.registerScenario('drag card', () async {
        await Future<void>.delayed(const Duration(milliseconds: 300));
      });
      final client = makeClient(async);
      async.flushMicrotasks();
      final s = connector.last;
      expect(s.sent.first['scenarios'], ['drag card']);
      final off = rt.registerScenario('boom', () async => throw StateError('no card'));
      expect(s.ofType('scenarios').last, {
        'type': 'scenarios',
        'names': ['drag card', 'boom'],
      });
      s.receive({'type': 'scenario', 'name': 'drag card'});
      s.receive({'type': 'scenario', 'name': 'boom'});
      s.receive({'type': 'scenario', 'name': 'nope'});
      async.elapse(const Duration(milliseconds: 300));
      expect(s.ofType('scenarioDone'), [
        {'type': 'scenarioDone', 'name': 'boom', 'ms': 0, 'error': 'Bad state: no card'},
        {
          'type': 'scenarioDone',
          'name': 'nope',
          'ms': 0,
          'error': 'No scenario named "nope". Registered: drag card, boom.',
        },
        {'type': 'scenarioDone', 'name': 'drag card', 'ms': 300},
      ]);
      off();
      client.dispose();
    });
  });

  test('overrides and replay from an editor', () {
    fakeAsync((async) {
      var replays = 0;
      rt.replay = () => replays++;
      final client = makeClient(async);
      async.flushMicrotasks();
      connector.last.receive({
        'type': 'overrides',
        'overrides': {
          'lib/main.dart:42:15': {'1.duration': 350, 'bad': 'x'},
        },
      });
      connector.last.receive({'type': 'replay'});
      async.flushMicrotasks();
      expect(rt.overrides, {
        'lib/main.dart:42:15': {'1.duration': 350},
      });
      expect(replays, 1);
      client.dispose();
    });
  });

  test('reconnects with backoff when the relay goes away, and says hello again', () {
    fakeAsync((async) {
      final client = makeClient(async);
      async.flushMicrotasks();
      expect(connector.sockets, hasLength(1));
      connector.fail = true;
      connector.last.drop();
      async.flushMicrotasks();
      async.elapse(const Duration(milliseconds: 500));
      async.elapse(const Duration(milliseconds: 1000));
      expect(connector.sockets, hasLength(1));
      connector.fail = false;
      async.elapse(const Duration(milliseconds: 2000));
      expect(connector.sockets, hasLength(2));
      expect(connector.last.sent.first['type'], 'hello');
      client.dispose();
      async.flushMicrotasks();
      expect(connector.last.closed, isTrue);
    });
  });

  test('without a host it samples on a timer and captures nothing', () {
    fakeAsync((async) {
      final a = TestValue('a')..value = 2;
      rt.register(a.signal);
      final client = KfInspectorClient(
        url: relayAppUrl(app: 'Demo', platform: 'android'),
        connector: connector.call,
        app: 'Demo',
        platform: 'android',
        runtime: rt,
        now: () => async.elapsed.inMicroseconds / 1000,
      )..start();
      async.flushMicrotasks();
      expect(connector.last.sent.first['capture'], false);
      expect(connector.last.sent.first['capabilities'], ['playback', 'overrides', 'replay', 'scenarios']);
      expect(connector.last.sent.first.containsKey('osVersion'), isFalse);
      connector.last.receive({
        'type': 'record',
        'signalIds': ['lib/main.dart:10:5'],
        'on': true,
      });
      async.elapse(const Duration(milliseconds: 100));
      final samples = [for (final b in connector.last.ofType('samples')) ...(b['samples'] as List)];
      expect(samples, hasLength(6));
      connector.last.receive({'type': 'capture', 'id': 'x', 'samples': []});
      async.flushMicrotasks();
      expect(connector.last.ofType('frame').single['error'], contains('KeyframerInspector'));
      client.dispose();
    });
  });

  test('a value that goes away is unsignalled and leaves the catalog; its id keeps recording', () {
    fakeAsync((async) {
      final a = TestValue('a');
      rt.register(a.signal);
      final client = makeClient(async);
      async.flushMicrotasks();
      final s = connector.last;
      s.receive({
        'type': 'record',
        'signalIds': ['lib/main.dart:10:5'],
        'on': true,
      });
      rt.unregister(a.signal);
      async.elapse(const Duration(milliseconds: 100));
      expect(s.events.last, {'kind': 'unsignal', 'id': 'lib/main.dart:10:5'});
      s.sent.clear();
      s.receive({'type': 'presence', 'app': true, 'editors': 1, 'cli': false});
      async.flushMicrotasks();
      expect(s.ofType('events'), isEmpty);
      // The screen opens again: the same call site is sampled again.
      final again = TestValue('a')..value = 7;
      rt.register(again.signal);
      async.elapse(const Duration(milliseconds: 16));
      host.onFrame!();
      async.elapse(const Duration(milliseconds: 100));
      final samples = [for (final b in s.ofType('samples')) ...(b['samples'] as List).cast<Map>()];
      expect(samples.single, containsPair('v', 7.0));
      client.dispose();
    });
  });

  test('a scrub holds its values until the next recording hands them back', () {
    fakeAsync((async) {
      final a = TestValue('a');
      rt.register(a.signal);
      final client = makeClient(async);
      async.flushMicrotasks();
      final s = connector.last;
      for (final v in [0.2, 0.6]) {
        s.receive({
          'type': 'playback',
          'samples': [
            {'id': 'lib/main.dart:10:5', 't': 500, 'v': v},
          ],
        });
        async.elapse(const Duration(milliseconds: 50));
      }
      expect(a.writes, [0.2, 0.6]);
      // Held across both scrubs: taken over once, never handed back in between.
      expect(a.began, 1);
      expect(a.ended, 0);
      expect(client.playing, isTrue);
      s.receive({
        'type': 'record',
        'signalIds': ['*'],
        'on': true,
      });
      async.flushMicrotasks();
      expect(a.ended, 1);
      expect(client.playing, isFalse);
      client.dispose();
    });
  });

  test('frame meter: 60 fps from steady frames, a long one counted as dropped frames', () {
    final m = FrameMeter('js');
    var t = 0.0;
    for (var i = 0; i <= 30; i++) {
      m.tick(t = i * (1000 / 60));
    }
    expect(m.stats.first.toJson(), {'t': 250, 'thread': 'js', 'fps': 60, 'dropped': 0});
    expect(m.drops, isEmpty);
    m.tick(t += 50);
    expect(
      [for (final d in m.drops) d.toJson()],
      [
        {'t': 550, 'thread': 'js', 'ms': 50.0, 'dropped': 2},
      ],
    );
    // 120 Hz is learned from most frames, not from one short gap.
    final fast = FrameMeter('ui');
    for (var i = 0; i <= 40; i++) {
      fast.tick(i * (1000 / 120));
    }
    expect(fast.interval, closeTo(1000 / 120, 0.001));
    final jitter = FrameMeter('ui');
    var j = 0.0;
    for (var i = 0; i < 20; i++) {
      jitter.tick(j += i == 5 ? 4 : 1000 / 60);
    }
    expect(jitter.interval, closeTo(1000 / 60, 0.001));
    expect(jitter.drops, isEmpty);
  });

  List<Map> markersOf(FakeSocket s) => [
    for (final b in s.ofType('samples')) ...((b['markers'] as List?) ?? const []).cast<Map>(),
  ];

  test('a host with the display, motion settings and clock says so in its hello', () {
    fakeAsync((async) {
      final full = FakeFullHost();
      final client = makeClient(async, withHost: full);
      async.flushMicrotasks();
      final hello = connector.last.sent.first;
      expect(hello['capabilities'], [
        'playback',
        'overrides',
        'replay',
        'scenarios',
        'capture',
        'time',
        'widget-sites',
      ]);
      expect(hello['display'], {'hz': 120, 'adaptive': true});
      expect(hello['accessibility'], {'reduceMotion': false});
      client.dispose();
    });
  });

  test('time: speed, pause and step through the host, every message answered, marked while recording', () {
    fakeAsync((async) {
      final full = FakeFullHost();
      final client = makeClient(async, withHost: full);
      async.flushMicrotasks();
      final s = connector.last;
      s.receive({'type': 'presence', 'app': true, 'editors': 1, 'cli': false});
      s.receive({'type': 'time', 'scale': 0.25});
      async.flushMicrotasks();
      expect(full.scales, [0.25]);
      expect(s.ofType('time'), [
        {'type': 'time', 'scale': 0.25},
      ]);
      // Recording from a slowed app: the recording's clock says so from its start.
      s.receive({
        'type': 'record',
        'signalIds': ['*'],
        'on': true,
      });
      async.elapse(const Duration(milliseconds: 40));
      s.receive({'type': 'time', 'scale': 0, 'step': 2});
      async.elapse(const Duration(milliseconds: 20));
      s.receive({'type': 'time', 'scale': 0, 'step': 1});
      async.flushMicrotasks();
      expect(full.scales, [0.25, 0]);
      expect(full.steps, [2, 1]);
      s.receive({'type': 'time', 'scale': 1, 'step': 5});
      async.elapse(const Duration(milliseconds: 100));
      // Steps only count while paused.
      expect(full.steps, [2, 1]);
      expect(s.ofType('time').map((m) => m['scale']), [0.25, 0, 0, 1]);
      expect(markersOf(s).where((m) => m['kind'] == 'time'), [
        {'kind': 'time', 't': 0, 'scale': 0.25},
        {'kind': 'time', 't': 40, 'scale': 0},
        // Each step, with the frames it advanced.
        {'kind': 'time', 't': 40, 'scale': 0, 'step': 2},
        {'kind': 'time', 't': 60, 'scale': 0, 'step': 1},
        {'kind': 'time', 't': 60, 'scale': 1},
      ]);
      expect(client.timeScale, 1);
      client.dispose();
    });
  });

  test('time goes back to normal when the last editor leaves or the relay goes away', () {
    fakeAsync((async) {
      final full = FakeFullHost();
      final client = makeClient(async, withHost: full);
      async.flushMicrotasks();
      var s = connector.last;
      s.receive({'type': 'presence', 'app': true, 'editors': 2, 'cli': false});
      s.receive({'type': 'time', 'scale': 0.5});
      async.flushMicrotasks();
      // An editor that joins later is told the speed with the catalog.
      s.sent.clear();
      s.receive({'type': 'hello', 'role': 'editor'});
      async.flushMicrotasks();
      expect(s.ofType('time').single, {'type': 'time', 'scale': 0.5});
      s.receive({'type': 'presence', 'app': true, 'editors': 1, 'cli': false});
      async.flushMicrotasks();
      expect(full.scale, 0.5);
      s.sent.clear();
      s.receive({'type': 'presence', 'app': true, 'editors': 0, 'cli': false});
      async.flushMicrotasks();
      expect(full.scale, 1);
      // And says so.
      expect(s.ofType('time'), [
        {'type': 'time', 'scale': 1},
      ]);
      // Every reset is announced, at normal speed already too.
      s.receive({'type': 'presence', 'app': true, 'editors': 1, 'cli': false});
      s.receive({'type': 'presence', 'app': true, 'editors': 0, 'cli': false});
      async.flushMicrotasks();
      expect(s.ofType('time'), [
        {'type': 'time', 'scale': 1},
        {'type': 'time', 'scale': 1},
      ]);
      s.receive({'type': 'time', 'scale': 0});
      async.flushMicrotasks();
      expect(full.scale, 0);
      s.drop();
      async.flushMicrotasks();
      expect(full.scale, 1);
      async.elapse(const Duration(seconds: 1));
      s = connector.last;
      // Reset while disconnected: said right after the next hello.
      expect(s.sent.map((m) => m['type']).take(2), ['hello', 'time']);
      expect(s.ofType('time').single, {'type': 'time', 'scale': 1});
      s.receive({'type': 'time', 'scale': 0.1});
      async.flushMicrotasks();
      client.dispose();
      async.flushMicrotasks();
      expect(full.scales.last, 1);
    });
  });

  test('time follows the rules every SDK shares', () {
    fakeAsync((async) {
      final full = FakeFullHost();
      final client = makeClient(async, withHost: full);
      async.flushMicrotasks();
      final s = connector.last;
      Object? answer(Map<String, Object?> msg) {
        s.sent.clear();
        s.receive({'type': 'time', ...msg});
        async.flushMicrotasks();
        return s.ofType('time').single['scale'];
      }

      // Above 1 is 1 (the speed already: the host is not asked), between 0 and 0.01 is 0.01.
      expect(answer({'scale': 9}), 1);
      expect(answer({'scale': 0.5}), 0.5);
      expect(answer({'scale': 0.001}), 0.01);
      // Not a speed: nothing changes, and it is still answered.
      expect(answer({'scale': -1}), 0.01);
      expect(answer({'scale': 'fast'}), 0.01);
      expect(answer({}), 0.01);
      expect(full.scales, [0.5, 0.01]);
      // Not paused: a step does nothing.
      expect(answer({'step': 3}), 0.01);
      // Paused: whole frames from 1 to 120; a step that is not a positive number is none.
      expect(answer({'scale': 0, 'step': 2.7}), 0);
      expect(answer({'scale': 0, 'step': 500}), 0);
      expect(answer({'scale': 0, 'step': 0.4}), 0);
      expect(answer({'step': 2}), 0);
      expect(answer({'scale': 0, 'step': 0}), 0);
      expect(answer({'scale': 0, 'step': -3}), 0);
      expect(answer({'scale': 'x', 'step': 'two'}), 0);
      // A step with a speed: the speed first, so not paused any more and no step.
      expect(answer({'scale': 0.5, 'step': 3}), 0.5);
      expect(full.steps, [3, 120, 1, 2]);
      // Disposed while slowed: back to normal, and it says so before the socket closes.
      s.sent.clear();
      client.dispose();
      async.flushMicrotasks();
      expect(s.ofType('time'), [
        {'type': 'time', 'scale': 1},
      ]);
    });
  });

  test('an app whose host has no clock answers time with speed 1 and does not offer it', () {
    fakeAsync((async) {
      final client = makeClient(async);
      async.flushMicrotasks();
      final s = connector.last;
      expect(s.sent.first['capabilities'], isNot(contains('time')));
      expect(s.sent.first.containsKey('display'), isFalse);
      s.receive({'type': 'time', 'scale': 0.25});
      async.flushMicrotasks();
      expect(s.ofType('time').single, {'type': 'time', 'scale': 1});
      client.dispose();
    });
  });

  test('display, motion settings and lifecycle changes while recording are markers', () {
    fakeAsync((async) {
      final full = FakeFullHost()..displayNow = const KfDisplay(120);
      final client = makeClient(async, withHost: full);
      async.flushMicrotasks();
      final s = connector.last;
      s.receive({
        'type': 'record',
        'signalIds': ['*'],
        'on': true,
      });
      async.elapse(const Duration(milliseconds: 50));
      full.displayNow = const KfDisplay(60);
      full.onDeviceChange!();
      async.elapse(const Duration(milliseconds: 10));
      full.accessibilityNow = const KfAccessibility(reduceMotion: true);
      full.appStateNow = 'background';
      full.onDeviceChange!();
      // The same again: nothing new.
      full.onDeviceChange!();
      async.elapse(const Duration(milliseconds: 100));
      expect(markersOf(s).where((m) => m['kind'] != 'navigation'), [
        {'kind': 'display', 't': 50, 'hz': 60},
        {'kind': 'accessibility', 't': 60, 'reduceMotion': true},
        {'kind': 'appState', 't': 60, 'state': 'background'},
      ]);
      // The hello an editor gets from now on says what the device says now.
      expect(client.hello()['display'], {'hz': 60});
      expect(client.hello()['accessibility'], {'reduceMotion': true});
      client.dispose();
    });
  });

  test('frames are counted against the display: a fixed 120 Hz budget, then 60 Hz after a change', () {
    fakeAsync((async) {
      final full = FakeFullHost()..displayNow = const KfDisplay(120);
      final client = makeClient(async, withHost: full);
      async.flushMicrotasks();
      final s = connector.last;
      s.receive({
        'type': 'record',
        'signalIds': ['*'],
        'on': true,
      });
      async.flushMicrotasks();
      // 60 fps on a fixed 120 Hz display: every frame misses a refresh.
      for (var i = 0; i < 20; i++) {
        async.elapse(const Duration(microseconds: 16667));
        full.onFrame!();
      }
      full.displayNow = const KfDisplay(60);
      full.onDeviceChange!();
      for (var i = 0; i < 20; i++) {
        async.elapse(const Duration(microseconds: 16667));
        full.onFrame!();
      }
      async.elapse(const Duration(milliseconds: 100));
      final drops = [
        for (final b in s.ofType('samples')) ...((b['drops'] as List?) ?? const []).cast<Map>(),
      ].where((d) => d['thread'] == 'js');
      expect(drops, hasLength(19));
      expect(drops.every((d) => (d['t'] as int) <= 334), isTrue);
      client.dispose();
    });
  });

  test('the scene: watched while recording, visibility as markers, render hints once and in the catalog', () {
    fakeAsync((async) {
      final full = FakeFullHost();
      final client = makeClient(async, withHost: full);
      async.flushMicrotasks();
      final s = connector.last;
      expect(full.onVisibility, isNull);
      s.receive({
        'type': 'record',
        'signalIds': ['*'],
        'on': true,
      });
      async.elapse(const Duration(milliseconds: 30));
      full.onVisibility!('lib/main.dart:10:5', false, 'offscreen');
      full.onHint!(const KfRenderHint('lib/main.dart:10:5', 'opacity-widget', 'Opacity at lib/main.dart:40'));
      full.onHint!(const KfRenderHint('lib/main.dart:10:5', 'opacity-widget', 'again'));
      async.elapse(const Duration(milliseconds: 100));
      expect(markersOf(s).where((m) => m['kind'] == 'visibility'), [
        {'kind': 'visibility', 't': 30, 'id': 'lib/main.dart:10:5', 'visible': false, 'reason': 'offscreen'},
      ]);
      expect(s.events.where((e) => e['kind'] == 'renderHint'), [
        {
          'kind': 'renderHint',
          'id': 'lib/main.dart:10:5',
          'hint': 'opacity-widget',
          'detail': 'Opacity at lib/main.dart:40',
        },
      ]);
      s.receive({
        'type': 'record',
        'signalIds': ['*'],
        'on': false,
      });
      async.flushMicrotasks();
      expect(full.onVisibility, isNull);
      // An editor that joins later gets the hint with the catalog.
      s.sent.clear();
      s.receive({'type': 'presence', 'app': true, 'editors': 1, 'cli': false});
      async.flushMicrotasks();
      expect(s.events.where((e) => e['kind'] == 'renderHint'), hasLength(1));
      client.dispose();
    });
  });

  test('frame meter with a display: fixed rates are the budget, adaptive ones are learned up to the display', () {
    // A fixed 120 Hz display: a 16.7 ms frame missed one refresh.
    final fixed = FrameMeter('js', display: const KfDisplay(120));
    for (var i = 0; i <= 30; i++) {
      fixed.tick(i * (1000 / 60));
    }
    expect(fixed.interval, closeTo(1000 / 120, 1e-9));
    expect(fixed.drops, hasLength(30));
    // ProMotion running at 60: learned, no drops.
    final adaptive = FrameMeter('js', display: const KfDisplay(120, adaptive: true));
    for (var i = 0; i <= 30; i++) {
      adaptive.tick(i * (1000 / 60));
    }
    expect(adaptive.interval, closeTo(1000 / 60, 1e-9));
    // A 90 Hz adaptive display never learns 120 Hz.
    final ninety = FrameMeter('js', display: const KfDisplay(90, adaptive: true));
    for (var i = 0; i <= 40; i++) {
      ninety.tick(i * (1000 / 120));
    }
    expect(ninety.interval, closeTo(1000 / 90, 1e-9));
    // A 30 Hz display: 33 ms frames are on time.
    final slow = FrameMeter('js', display: const KfDisplay(30));
    for (var i = 0; i <= 20; i++) {
      slow.tick(i * (1000 / 30));
    }
    expect(slow.drops, isEmpty);
    // The rate changes mid-recording.
    fixed.display = const KfDisplay(60);
    expect(fixed.interval, closeTo(1000 / 60, 1e-9));
  });

  test('the hello names the device, once it is known (at most 2 s)', () {
    fakeAsync((async) {
      final known = Completer<KfDevice?>();
      final client = KfInspectorClient(
        url: relayAppUrl(app: 'Demo', platform: 'android'),
        connector: connector.call,
        app: 'Demo',
        platform: 'android',
        host: host,
        runtime: rt,
        device: known.future,
        now: () => async.elapsed.inMicroseconds / 1000,
      )..start();
      async.elapse(const Duration(milliseconds: 50));
      expect(connector.sockets, isEmpty);
      known.complete(
        const KfDevice(id: 'Pixel_8_API_35', name: 'Pixel_8_API_35', model: 'sdk_gphone64_arm64', simulator: true),
      );
      async.flushMicrotasks();
      expect(connector.last.sent.first['device'], {
        'name': 'Pixel_8_API_35',
        'model': 'sdk_gphone64_arm64',
        'id': 'Pixel_8_API_35',
        'simulator': true,
      });
      client.dispose();
    });
  });

  test('a device that never says goes unnamed, and the hello waits no longer than 2 s', () {
    fakeAsync((async) {
      final client = KfInspectorClient(
        url: relayAppUrl(app: 'Demo', platform: 'ios'),
        connector: connector.call,
        app: 'Demo',
        platform: 'ios',
        host: host,
        runtime: rt,
        device: Completer<KfDevice?>().future,
      )..start();
      async.elapse(const Duration(milliseconds: 1900));
      expect(connector.sockets, isEmpty);
      async.elapse(const Duration(milliseconds: 200));
      expect(connector.last.sent.first['type'], 'hello');
      expect(connector.last.sent.first.containsKey('device'), isFalse);
      client.dispose();
    });
  });

  test('recorders: two editors record at once, and one stopping leaves the other recording', () {
    fakeAsync((async) {
      final a = TestValue('a'), b = TestValue('b', line: 20);
      rt.register(a.signal);
      rt.register(b.signal);
      final client = makeClient(async);
      async.flushMicrotasks();
      final s = connector.last;
      void record(List<String> ids, bool on, [String? recorder]) {
        s.receive({'type': 'record', 'signalIds': ids, 'on': on, if (recorder != null) 'recorder': recorder});
        async.flushMicrotasks();
      }

      s.receive({'type': 'presence', 'app': true, 'editors': 2, 'cli': false});
      record(['lib/main.dart:10:5'], true, 'panel');
      async.elapse(const Duration(milliseconds: 100));
      record(['*'], true, 'ci');
      // The second recorder does not restart the recording's clock.
      expect(host.onFrame, isNotNull);
      async.elapse(const Duration(milliseconds: 16));
      host.onFrame!();
      async.elapse(const Duration(milliseconds: 100));
      final both = (s.ofType('samples').last['samples'] as List).cast<Map>();
      expect(both.map((x) => x['id']).toSet(), {'lib/main.dart:10:5', 'lib/main.dart:20:5'});
      expect(both.first['t'], 116);
      // An editor with no id stops only the anonymous recorder: there is none.
      record(['*'], false);
      // ci stops: the panel's value is still recorded, ci's other one is not.
      record(['*'], false, 'ci');
      expect(client.recording, isTrue);
      s.sent.clear();
      async.elapse(const Duration(milliseconds: 16));
      host.onFrame!();
      async.elapse(const Duration(milliseconds: 100));
      final one = [for (final m in s.ofType('samples')) ...(m['samples'] as List).cast<Map>()];
      expect(one.map((x) => x['id']).toSet(), {'lib/main.dart:10:5'});
      // The last editor leaves: every recorder goes.
      s.receive({'type': 'presence', 'app': true, 'editors': 0, 'cli': false});
      async.flushMicrotasks();
      expect(client.recording, isFalse);
      expect(host.onFrame, isNull);
      client.dispose();
    });
  });

  test('recorders: a dropped connection clears them all', () {
    fakeAsync((async) {
      final client = makeClient(async);
      async.flushMicrotasks();
      final s = connector.last;
      for (final r in ['panel', 'mcp', null]) {
        s.receive({
          'type': 'record',
          'signalIds': ['*'],
          'on': true,
          if (r != null) 'recorder': r,
        });
      }
      async.flushMicrotasks();
      expect(client.recording, isTrue);
      s.drop();
      async.flushMicrotasks();
      expect(client.recording, isFalse);
      expect(host.onFrame, isNull);
      // The next connection starts with no recorder: one stopping does not leave others behind.
      async.elapse(const Duration(seconds: 1));
      final next = connector.last;
      next.receive({
        'type': 'record',
        'signalIds': ['*'],
        'on': true,
        'recorder': 'ci',
      });
      next.receive({
        'type': 'record',
        'signalIds': ['*'],
        'on': false,
        'recorder': 'ci',
      });
      async.flushMicrotasks();
      expect(client.recording, isFalse);
      client.dispose();
    });
  });

  test('editors without a recorder id share one anonymous recorder, as before', () {
    fakeAsync((async) {
      final client = makeClient(async);
      async.flushMicrotasks();
      final s = connector.last;
      s.receive({
        'type': 'record',
        'signalIds': ['*'],
        'on': true,
      });
      s.receive({
        'type': 'record',
        'signalIds': ['*'],
        'on': true,
        'recorder': 'mcp',
      });
      s.receive({
        'type': 'record',
        'signalIds': ['*'],
        'on': false,
      });
      async.flushMicrotasks();
      expect(client.recording, isTrue);
      s.receive({
        'type': 'record',
        'signalIds': ['*'],
        'on': false,
        'recorder': 'mcp',
      });
      async.flushMicrotasks();
      expect(client.recording, isFalse);
      client.dispose();
    });
  });

  test('values that mount or go while recording say when; the catalog stays timeless', () {
    fakeAsync((async) {
      final client = makeClient(async);
      async.flushMicrotasks();
      final s = connector.last;
      final before = TestValue('before');
      rt.register(before.signal);
      async.elapse(const Duration(milliseconds: 100));
      expect(s.events.single.containsKey('t'), isFalse);
      s.receive({
        'type': 'record',
        'signalIds': ['*'],
        'on': true,
      });
      async.elapse(const Duration(milliseconds: 40));
      final late = TestValue('late', line: 30);
      rt.register(late.signal);
      async.elapse(const Duration(milliseconds: 60));
      rt.unregister(late.signal);
      async.elapse(const Duration(milliseconds: 100));
      final events = s.events.skip(1).toList();
      expect(events.map((e) => [e['kind'], e['t']]), [
        ['signal', 40],
        ['unsignal', 100],
      ]);
      // An editor joining later gets the catalog without recording times.
      rt.register(late.signal);
      s.sent.clear();
      s.receive({'type': 'presence', 'app': true, 'editors': 1, 'cli': false});
      async.flushMicrotasks();
      expect(s.ofType('events').first['events'], everyElement(isNot(contains('t'))));
      client.dispose();
    });
  });

  test('without widget creation tracking the hello does not offer widget-sites', () {
    fakeAsync((async) {
      final full = FakeFullHost()..sites = false;
      final client = makeClient(async, withHost: full);
      async.flushMicrotasks();
      expect(connector.last.sent.first['capabilities'], isNot(contains('widget-sites')));
      client.dispose();
    });
  });
}
