import 'dart:convert';
import 'dart:math' as math;

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:keyframer_vitals/src/protocol.dart';
import 'package:keyframer_vitals/src/recorder.dart';
import 'package:keyframer_vitals/src/reporter.dart';
import 'package:keyframer_vitals/src/storage.dart';
import 'package:keyframer_vitals/src/transport.dart';

import 'support.dart';

final _base = DateTime(2026, 10, 18, 10).millisecondsSinceEpoch;

class Launch {
  Launch(
    this.async, {
    VitalsStorage? storage,
    FakeTransport? transport,
    double sampleRate = 1,
    bool releaseBuild = true,
    VitalsEnvironment? environment,
    VitalsDevice? device,
    this.reduceMotionOn = false,
    this.dayOffset = 0,
  }) : storage = storage ?? MemoryVitalsStorage(),
       transport = transport ?? FakeTransport() {
    reporter = VitalsReporter(
      options: VitalsOptions(
        key: 'kfp_live_test',
        appVersion: '3.4.0',
        build: '412',
        sampleRate: sampleRate,
        environment: environment,
        device: device,
        appId: 'com.acme.shop',
      ),
      store: VitalsStore(this.storage, wallClock: () => _base + dayOffset * 86400000 + async.elapsed.inMilliseconds),
      transport: this.transport,
      facts: const PlatformFacts(os: 'android', osVersion: 'Linux 5.10.43-android12'),
      clock: () => async.elapsed.inMicroseconds / 1000,
      releaseBuild: releaseBuild,
      display: () => (120.0, true),
      reduceMotionNow: () => reduceMotionOn,
      random: math.Random(7),
    );
  }

  final FakeAsync async;
  final VitalsStorage storage;
  final FakeTransport transport;
  late final VitalsReporter reporter;
  bool reduceMotionOn;
  int dayOffset;

  double get now => async.elapsed.inMicroseconds / 1000;

  void start() {
    reporter.start();
    async.flushMicrotasks();
  }

  /// A second of 60 Hz frames, one of them slow, from now.
  void draw({int n = 60}) {
    final r = reporter.recorder;
    final t = now;
    if (r == null) return async.elapse(const Duration(seconds: 1));
    for (var i = 0; i < n; i++) {
      final s = t + i * 1000 / 60;
      r.frame(VitalsFrame(start: s, end: s + 10, buildMs: 4, rasterMs: i == 0 ? 30 : 6));
    }
    async.elapse(const Duration(seconds: 1));
  }

  void background() {
    reporter.background();
    async.flushMicrotasks();
  }

  void foreground() {
    reporter.foreground();
    async.flushMicrotasks();
  }
}

/// A future's value inside fake time.
T wait<T>(FakeAsync async, Future<T> f) {
  T? out;
  var done = false;
  f.then((v) {
    out = v;
    done = true;
  });
  async.flushMicrotasks();
  expect(done, isTrue, reason: 'the future did not complete');
  return out as T;
}

void main() {
  test('a sampled session reports its window when the app goes to the background', () {
    fakeAsync((async) {
      final l = Launch(async)..start();
      expect(l.reporter.measuring, isTrue);
      l.reporter.setScreen('/feed');
      l.draw();
      l.background();
      expect(l.reporter.measuring, isFalse);
      final r = l.transport.reports.single;
      expect(r['format'], 'keyframer-vitals');
      expect(r['app'], {
        'id': 'com.acme.shop',
        'version': '3.4.0',
        'build': '412',
        'platform': 'flutter',
        'framework': 'Flutter',
        'environment': 'production',
      });
      expect(r['sdk'], {'name': 'keyframer_vitals', 'version': vitalsSdkVersion});
      final s = r['session'] as Map;
      expect(s['seq'], 0);
      expect(s['ended'], 'background');
      expect(s['sampleRate'], 1);
      expect(s['foregroundMs'], 1000);
      expect(s['nonce'], matches(RegExp(r'^[A-Za-z0-9_-]{8,64}$')));
      expect(r['display'], {'hz': 120, 'adaptive': true, 'targetHz': 60});
      // Android prints the kernel in operatingSystemVersion: no OS version unless the app passes one.
      expect((r['device'] as Map)['osMajor'], 0);
      final screens = r['screens'] as List;
      expect(screens.single['name'], '/feed');
      expect(((screens.single['threads'] as Map)['ui'] as Map)['hist'], [59, 1, 0, 0, 0, 0, 0, 0]);
      // Sent: nothing left to retry.
      expect(wait(async, l.storage.read('keyframer_vitals.retry')), isNull);
    });
  });

  test('sampling is decided once per session', () {
    fakeAsync((async) {
      final l = Launch(async, sampleRate: 0)..start();
      expect(l.reporter.measuring, isFalse);
      // The config fetched 10 s after start raises the rate: this session stays unsampled.
      async.elapse(const Duration(seconds: 11));
      expect(l.transport.gets, hasLength(1));
      expect(l.reporter.config.sampleRate, 1);
      expect(l.reporter.measuring, isFalse);
      l.background();
      expect(l.transport.posts, isEmpty);
      // Back within 30 s: the same session, still unsampled.
      async.elapse(const Duration(seconds: 20));
      l.foreground();
      expect(l.reporter.measuring, isFalse);
      l.background();
      // Back after 30 s: a new session, sampled at the new rate.
      async.elapse(const Duration(seconds: 31));
      l.foreground();
      expect(l.reporter.measuring, isTrue);
    });
  });

  test('windows of one session share the nonce; a new session gets a new one', () {
    fakeAsync((async) {
      final l = Launch(async)..start();
      l.draw();
      l.background();
      async.elapse(const Duration(seconds: 10));
      l.foreground();
      l.draw();
      l.background();
      async.elapse(const Duration(seconds: 31));
      l.foreground();
      l.draw();
      l.background();
      final s = [for (final r in l.transport.reports) r['session'] as Map];
      expect(s.map((x) => x['seq']), [0, 1, 0]);
      expect(s[0]['nonce'], s[1]['nonce']);
      expect(s[2]['nonce'], isNot(s[0]['nonce']));
    });
  });

  test('at most 3 reported sessions per device per day', () {
    fakeAsync((async) {
      final l = Launch(async)..start();
      for (var i = 0; i < 5; i++) {
        l.draw();
        l.background();
        async.elapse(const Duration(seconds: 31));
        l.foreground();
      }
      expect({for (final r in l.transport.reports) (r['session'] as Map)['nonce']}, hasLength(3));
      expect(l.reporter.measuring, isFalse);
      // The next day.
      l.background();
      l.dayOffset = 1;
      async.elapse(const Duration(seconds: 31));
      l.foreground();
      expect(l.reporter.measuring, isTrue);
    });
  });

  test('a window holds at most 10 minutes of foreground time', () {
    fakeAsync((async) {
      final l = Launch(async)..start();
      l.draw();
      async.elapse(const Duration(minutes: 10));
      expect(l.transport.reports, hasLength(1));
      final first = l.transport.reports.single['session'] as Map;
      expect(first['ended'], 'window');
      expect(first['foregroundMs'], lessThanOrEqualTo(vitalsWindowMs));
      l.draw();
      l.background();
      final second = l.transport.reports.last['session'] as Map;
      expect(second['seq'], 1);
      expect(second['ended'], 'background');
      expect(second['nonce'], first['nonce']);
    });
  });

  test('a failed upload waits in the retry store and goes out on the schedule, in the foreground only', () {
    fakeAsync((async) {
      final l = Launch(async)..start();
      l.transport.script.add(503);
      l.draw();
      l.background();
      expect(l.transport.posts, hasLength(1));
      expect(wait(async, VitalsStore(l.storage).pending()), hasLength(1));
      // The 10 s retry fires while in the background: nothing is sent.
      async.elapse(const Duration(seconds: 15));
      expect(l.transport.posts, hasLength(1));
      l.foreground();
      // The 1 minute retry.
      async.elapse(const Duration(minutes: 1));
      expect(l.transport.posts, hasLength(2));
      expect(l.transport.posts[1], l.transport.posts[0]);
      expect(wait(async, VitalsStore(l.storage).pending()), isEmpty);
    });
  });

  test('400 and 413 are dropped, never retried', () {
    fakeAsync((async) {
      final l = Launch(async)..start();
      l.transport.script.add(413);
      l.draw();
      l.background();
      expect(wait(async, VitalsStore(l.storage).pending()), isEmpty);
    });
  });

  test('401 or 410: off on this device for 7 days, nothing kept', () {
    fakeAsync((async) {
      final storage = MemoryVitalsStorage();
      final l = Launch(async, storage: storage)..start();
      l.transport.script.add(410);
      l.draw();
      l.background();
      expect(wait(async, VitalsStore(storage).pending()), isEmpty);
      async.elapse(const Duration(seconds: 31));
      l.foreground();
      expect(l.reporter.measuring, isFalse);
      // The next launch, 6 days later, is still off; 8 days later it reports again.
      l.reporter.dispose();
      final again = Launch(async, storage: storage, dayOffset: 6)..start();
      expect(again.reporter.measuring, isFalse);
      again.reporter.dispose();
      final later = Launch(async, storage: storage, dayOffset: 8)..start();
      expect(later.reporter.measuring, isTrue);
    });
  });

  test('stop in an upload response turns it off', () {
    fakeAsync((async) {
      final l = Launch(async)..start();
      l.transport.body = fixture('ingest-response-stop.json');
      l.draw();
      l.background();
      expect(wait(async, VitalsStore(l.storage).isOff()), isTrue);
      async.elapse(const Duration(seconds: 31));
      l.foreground();
      expect(l.reporter.measuring, isFalse);
    });
  });

  test('a minSdk above this version stops it', () {
    fakeAsync((async) {
      final storage = MemoryVitalsStorage();
      // The fixture config, asking for keyframer_vitals 1.0.0; this is 0.1.0.
      final json = jsonDecode(fixture('config.json')) as Map<String, dynamic>;
      json['minSdk'] = {...(json['minSdk'] as Map), 'flutter': '1.0.0'};
      VitalsStore(storage).saveConfig(VitalsConfig.fromJson(json)!);
      async.flushMicrotasks();
      final l = Launch(async, storage: storage)..start();
      expect(l.reporter.measuring, isFalse);
    });
  });

  test('a config that disables the project ends the session at once', () {
    fakeAsync((async) {
      final l = Launch(async)..start();
      l.transport.configBody = '{"enabled":false,"sampleRate":1,"collect":{},"ttlSec":86400}';
      async.elapse(const Duration(seconds: 11));
      expect(l.reporter.measuring, isFalse);
      l.background();
      expect(l.transport.posts, isEmpty);
    });
  });

  test('setEnabled(false) stops and drops pending data; true starts a new session', () {
    fakeAsync((async) {
      final l = Launch(async)..start();
      l.transport.script.add(503);
      l.draw();
      l.background();
      l.foreground();
      expect(wait(async, VitalsStore(l.storage).pending()), hasLength(1));
      final nonce = (l.transport.reports.single['session'] as Map)['nonce'];
      l.reporter.setEnabled(false);
      async.flushMicrotasks();
      expect(l.reporter.measuring, isFalse);
      expect(wait(async, VitalsStore(l.storage).pending()), isEmpty);
      async.elapse(const Duration(minutes: 2));
      expect(l.transport.posts, hasLength(1));
      l.reporter.setEnabled(true);
      async.flushMicrotasks();
      expect(l.reporter.measuring, isTrue);
      l.draw();
      l.background();
      expect((l.transport.reports.last['session'] as Map)['nonce'], isNot(nonce));
    });
  });

  test('debug and profile builds report only as development', () {
    fakeAsync((async) {
      final debug = Launch(async, releaseBuild: false)..start();
      expect(debug.reporter.measuring, isFalse);
      debug.reporter.dispose();
      final prod = Launch(async, releaseBuild: false, environment: VitalsEnvironment.production)..start();
      expect(prod.reporter.measuring, isFalse);
      prod.reporter.dispose();
      final dev = Launch(async, releaseBuild: false, environment: VitalsEnvironment.development)..start();
      dev.draw();
      dev.background();
      expect((dev.transport.reports.single['app'] as Map)['environment'], 'development');
    });
  });

  test('a window checkpointed before the process died is sent on the next launch, ended unknown', () {
    fakeAsync((async) {
      final storage = PersistentMemoryStorage();
      final l = Launch(async, storage: storage)..start();
      l.draw();
      async.elapse(const Duration(seconds: 60));
      expect(wait(async, storage.read('keyframer_vitals.checkpoint')), isNotNull);
      final nonce = l.reporter.recorder != null;
      expect(nonce, isTrue);
      // Killed: no background, no upload.
      l.reporter.dispose();
      expect(l.transport.posts, isEmpty);
      final next = Launch(async, storage: storage)..start();
      expect(wait(async, storage.read('keyframer_vitals.checkpoint')), isNull);
      async.elapse(const Duration(seconds: 10));
      final r = next.transport.reports.first;
      expect((r['session'] as Map)['ended'], 'unknown');
      expect((r['session'] as Map)['seq'], 0);
    });
  });

  test('without persistent storage there are no checkpoints', () {
    fakeAsync((async) {
      final l = Launch(async)..start();
      l.draw();
      async.elapse(const Duration(seconds: 61));
      expect(wait(async, l.storage.read('keyframer_vitals.checkpoint')), isNull);
    });
  });

  test('the config is fetched 10 s after start, then kept for its ttl', () {
    fakeAsync((async) {
      final storage = MemoryVitalsStorage();
      final l = Launch(async, storage: storage)..start();
      expect(l.transport.gets, isEmpty);
      async.elapse(const Duration(seconds: 10));
      expect(l.transport.gets.single.toString(), 'https://vitals.keyframer.dev/v1/config/kfp_live_test');
      l.reporter.dispose();
      final next = Launch(async, storage: storage)..start();
      async.elapse(const Duration(seconds: 10));
      expect(next.transport.gets, isEmpty);
    });
  });

  test('device models and memory only while collected; Reduce Motion only when the project collects it', () {
    fakeAsync((async) {
      final l = Launch(
        async,
        device: const VitalsDevice(model: 'SM-G991B', memoryGb: 7.6, osMajor: 13),
        reduceMotionOn: true,
      )..start();
      l.reporter.recorder!.runStart(
        VitalsSiteSpec(id: 'n:a', ref: {'kind': 'name', 'name': 'a'}, fn: 'AnimationController'),
        l.now,
        end: l.now + 100,
        reduceMotion: l.reporter.reduceMotion,
      );
      l.draw();
      l.background();
      var r = l.transport.reports.last;
      expect(r['device'], {'os': 'android', 'osMajor': 13, 'model': 'SM-G991B', 'memoryGb': 7.6});
      // Not collected by default.
      expect(r['state'], isEmpty);
      expect((r['sites'] as List).single.containsKey('runsReduceMotion'), isFalse);
      // The upload's config collects Reduce Motion and turns models off.
      l.transport.body =
          '{"ok":true,"config":{"enabled":true,"sampleRate":1,"collect":{"reduceMotion":true,"deviceModel":false},"ttlSec":86400}}';
      l.foreground();
      l.draw();
      l.background();
      l.foreground();
      l.reporter.recorder!.runStart(
        VitalsSiteSpec(id: 'n:a', ref: {'kind': 'name', 'name': 'a'}, fn: 'AnimationController'),
        l.now,
        end: l.now + 100,
        reduceMotion: l.reporter.reduceMotion,
      );
      l.draw();
      l.background();
      r = l.transport.reports.last;
      expect(r['device'], {'os': 'android', 'osMajor': 13});
      expect(r['state'], {'reduceMotion': true});
      expect((r['sites'] as List).single['runsReduceMotion'], 1);
    });
  });

  test('a sliver of an empty later window is not sent', () {
    fakeAsync((async) {
      final l = Launch(async)..start();
      l.draw();
      l.background();
      l.foreground();
      async.elapse(const Duration(milliseconds: 200));
      l.background();
      expect(l.transport.posts, hasLength(1));
    });
  });

  test('osMajor from Platform.operatingSystemVersion', () {
    expect(osMajorOf('Version 17.4.1 (Build 21E236)'), 17);
    expect(osMajorOf('Linux 5.10.43-android12-9 #1 SMP PREEMPT'), isNull);
  });

  test('the retry store keeps the newest 5 reports, 100 KB and 7 days', () async {
    var now = _base;
    final store = VitalsStore(MemoryVitalsStorage(), wallClock: () => now);
    for (var i = 0; i < 7; i++) {
      await store.addPending('{"n":$i}');
    }
    expect((await store.pending()).map((p) => p.body), ['{"n":2}', '{"n":3}', '{"n":4}', '{"n":5}', '{"n":6}']);
    await store.clearPending();
    final big = 'x' * (40 * 1024);
    for (var i = 0; i < 3; i++) {
      await store.addPending('$i$big');
    }
    expect((await store.pending()).map((p) => p.body[0]), ['1', '2']);
    now += 8 * 86400000;
    expect(await store.pending(), isEmpty);
  });
}
