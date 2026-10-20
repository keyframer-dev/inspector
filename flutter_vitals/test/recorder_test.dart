import 'package:flutter_test/flutter_test.dart';
import 'package:keyframer_vitals/src/protocol.dart';
import 'package:keyframer_vitals/src/recorder.dart';

VitalsSiteSpec site(String name) =>
    VitalsSiteSpec(id: 'n:$name', ref: {'kind': 'name', 'name': name}, key: name, fn: 'AnimationController');

/// `n` frames 60 Hz apart from `t`, each costing `build` and `raster` ms.
double frames(VitalsRecorder r, double t, int n, {double build = 4, double raster = 6, double every = 1000 / 60}) {
  for (var i = 0; i < n; i++) {
    final start = t + i * every;
    r.frame(VitalsFrame(start: start, end: start + build + raster, buildMs: build, rasterMs: raster));
  }
  return t + n * every;
}

Map<String, Object?> thread(WindowBody b, int screen, String th) =>
    (b.screens[screen]['threads'] as Map)[th] as Map<String, Object?>;

void main() {
  test('cost-based counting: 1 ms of slack, then a missed vsync per budget', () {
    const b = 1000 / 60;
    expect(missedByCost(16.6, b), 0);
    expect(missedByCost(17.6, b), 0);
    expect(missedByCost(18, b), 1);
    expect(missedByCost(34, b), 1);
    expect(missedByCost(35, b), 2);
    expect(missedByCost(745.3, b), 44);
  });

  test('histogram, hitch time, frozen frames and idle baselines per screen and thread', () {
    final r = VitalsRecorder(displayHz: 60, now: 0, screen: '/feed');
    var t = frames(r, 0, 10);
    // One slow raster frame (3 missed), one slow build (1 missed), one frozen frame.
    r.frame(VitalsFrame(start: t, end: t + 70, buildMs: 5, rasterMs: 60));
    t += 70;
    r.frame(VitalsFrame(start: t, end: t + 30, buildMs: 25, rasterMs: 4));
    t += 30;
    r.frame(VitalsFrame(start: t, end: t + 800, buildMs: 790, rasterMs: 8));
    final body = r.snapshot(t + 800);
    final ui = thread(body, 0, 'ui'), js = thread(body, 0, 'js');
    expect(ui['frames'], 13);
    expect(ui['hist'], [12, 0, 0, 1, 0, 0, 0, 0]);
    expect(js['hist'], [11, 1, 0, 0, 0, 0, 0, 1]);
    expect(js['frozen'], 1);
    expect(ui['frozen'], 0);
    expect(ui['hitchMs'], closeTo(60 - 1000 / 60, 0.1));
    expect(js['hitchMs'], closeTo(25 - 1000 / 60 + 790 - 1000 / 60, 0.1));
    // Nothing tracked ran: every frame is idle.
    expect(ui['idleFrames'], 13);
    expect(ui['idleMissed'], 3);
    expect(js['idleMissed'], 1 + 47);
    expect(body.targetHz, 60);
  });

  test('frames are judged against the learned rate on an adaptive display', () {
    final r = VitalsRecorder(displayHz: 120, adaptive: true, now: 0);
    // At 120 Hz a 12 ms raster misses one vsync; until the rate is learned it is judged at 60.
    frames(r, 0, 40, raster: 3, every: 1000 / 120);
    expect(r.rate.interval, closeTo(1000 / 120, 0.01));
    r.frame(const VitalsFrame(start: 400, end: 412, buildMs: 2, rasterMs: 12));
    final body = r.snapshot(500);
    expect(thread(body, 0, 'ui')['hist'], [40, 1, 0, 0, 0, 0, 0, 0]);
    expect(body.targetHz, 120);
  });

  test('a 120 Hz screen running at 60 is judged at 60', () {
    final r = VitalsRecorder(displayHz: 120, adaptive: true, now: 0);
    frames(r, 0, 40, raster: 12);
    final body = r.snapshot(1000);
    expect((thread(body, 0, 'ui')['hist'] as List)[0], 40);
    expect(body.targetHz, 60);
  });

  test('a fixed display is its own budget', () {
    final r = VitalsRecorder(displayHz: 90, now: 0);
    frames(r, 0, 20, raster: 14, every: 1000 / 90);
    expect((thread(r.snapshot(400), 0, 'ui')['hist'] as List)[1], 20);
  });

  test('sites: frames, missed, hitch and worst while they ran, active time, runs', () {
    final r = VitalsRecorder(displayHz: 60, now: 0, screen: '/feed');
    final card = site('card');
    r.runStart(card, 100, end: 300);
    frames(r, 0, 6); // 0..100: idle
    frames(r, 100, 12, raster: 40); // 100..300: card runs, every frame misses 2
    frames(r, 300, 6); // after: idle
    final body = r.snapshot(400);
    final s = body.sites.single;
    expect(s['ref'], {'kind': 'name', 'name': 'card'});
    expect(s['key'], 'card');
    expect(s['runs'], 1);
    expect(s['activeMs'], 200);
    expect(s['frames'], 12);
    expect(s['missed'], 24);
    expect(s['worstMs'], 40);
    expect(s['hitchMs'], closeTo(12 * (40 - 1000 / 60), 0.2));
    expect(s['screen'], 0);
    final ui = thread(body, 0, 'ui');
    expect(ui['idleFrames'], 12);
    expect(ui['idleMissed'], 0);
  });

  test('a stopped run ends where it stopped; a loop runs until stopped', () {
    final r = VitalsRecorder(displayHz: 60, now: 0);
    final loop = r.runStart(site('spinner'), 0);
    final short = r.runStart(site('fade'), 0, end: 1000);
    short.stop(100);
    frames(r, 0, 30);
    loop.stop(400);
    final body = r.snapshot(500);
    final byName = {for (final s in body.sites) (s['ref'] as Map)['name']: s};
    expect(byName['spinner']!['activeMs'], 400);
    expect(byName['fade']!['activeMs'], 100);
    expect(byName['fade']!['frames'], lessThan(byName['spinner']!['frames'] as int));
  });

  test('five worst frames, longest first, with causes', () {
    final r = VitalsRecorder(displayHz: 60, now: 0, screen: '/feed');
    // gesture: a touch window, nothing starting.
    r.pointerDown(0);
    r.pointerUp(50);
    r.frame(const VitalsFrame(start: 1000, end: 1060, buildMs: 4, rasterMs: 60));
    // scroll beats gesture.
    r.scrollStart(2000);
    r.frame(const VitalsFrame(start: 2100, end: 2170, buildMs: 4, rasterMs: 70));
    r.scrollEnd(2200);
    // burst: 6 animations starting in the frame or 50 ms before.
    for (var i = 0; i < 6; i++) {
      r.runStart(site('b$i'), 2960.0 + i, end: 3200);
    }
    r.frame(const VitalsFrame(start: 3000, end: 3080, buildMs: 4, rasterMs: 80));
    // screen-mount: 300 ms after a navigation.
    r.screen('/users/[number]', 4000);
    r.navigation(4000);
    r.frame(const VitalsFrame(start: 4200, end: 4300, buildMs: 100, rasterMs: 5));
    // unknown, and a shorter one that falls off the top five.
    r.frame(const VitalsFrame(start: 6000, end: 6050, buildMs: 4, rasterMs: 50));
    r.frame(const VitalsFrame(start: 7000, end: 7040, buildMs: 4, rasterMs: 40));
    r.frame(const VitalsFrame(start: 8000, end: 8020, buildMs: 4, rasterMs: 20));
    final body = r.snapshot(9000);
    expect(body.worst.map((w) => w['ms']), [100, 80, 70, 60, 50]);
    expect(body.worst.map((w) => w['cause']), ['screen-mount', 'burst', 'scroll', 'gesture', 'unknown']);
    expect(body.worst[0]['thread'], 'js');
    expect(body.worst[0]['afterNavMs'], 300);
    expect(body.worst[0]['screen'], body.screens.indexWhere((s) => s['name'] == '/users/[number]'));
    expect(body.worst[1]['sites'], hasLength(6));
    expect(body.worst[1]['missed'], 4);
    expect(body.worst[2].containsKey('afterNavMs'), isFalse);
  });

  test('screens: foreground time on each, frames where they were drawn, even when timings arrive late', () {
    final r = VitalsRecorder(displayHz: 60, now: 0, screen: '/');
    r.screen('/detail', 3000);
    // The batch for frames before the navigation arrives after it.
    frames(r, 2000, 6);
    frames(r, 3100, 6);
    final body = r.snapshot(5000);
    final names = body.screens.map((s) => s['name']).toList();
    expect(body.screens[names.indexOf('/')]['ms'], 3000);
    expect(body.screens[names.indexOf('/detail')]['ms'], 2000);
    expect(thread(body, names.indexOf('/'), 'ui')['frames'], 6);
    expect(thread(body, names.indexOf('/detail'), 'ui')['frames'], 6);
    expect(body.foregroundMs, 5000);
  });

  test('a new window starts from zero; runs still going continue into it', () {
    final r = VitalsRecorder(displayHz: 60, now: 0);
    r.runStart(site('loop'), 0);
    frames(r, 0, 30);
    final first = r.snapshot(1000);
    r.reset(1000);
    frames(r, 1000, 30);
    final second = r.snapshot(2000);
    expect(first.sites.single['activeMs'], 1000);
    expect(second.sites.single['activeMs'], 1000);
    expect(second.sites.single['runs'], 0);
    expect(second.sites.single['frames'], 30);
    expect(second.foregroundMs, 1000);
    expect(thread(second, 0, 'ui')['frames'], 30);
  });

  test('a snapshot does not change the counters (checkpoints)', () {
    final r = VitalsRecorder(displayHz: 60, now: 0);
    r.runStart(site('a'), 0, end: 500);
    frames(r, 0, 30);
    final a = r.snapshot(500);
    final b = r.snapshot(500);
    expect(b.sites, a.sites);
    expect(b.screens.toString(), a.screens.toString());
  });

  test('measured time follows the frames, never the idle gaps', () {
    final r = VitalsRecorder(displayHz: 60, now: 0);
    frames(r, 0, 60); // ~1 s of drawing
    frames(r, 5000, 60); // after 4 s idle
    final body = r.snapshot(7000);
    expect(body.measuredMs, closeTo(2 * 1000 + 100 - 1000 / 60, 20));
  });

  test('the log forgets what ended more than 10 s ago', () {
    final r = VitalsRecorder(displayHz: 60, now: 0);
    r.runStart(site('old'), 0, end: 100);
    r.navigation(0);
    frames(r, 20000, 3, raster: 60);
    final body = r.snapshot(21000);
    expect(body.worst.every((w) => w['cause'] == 'unknown'), isTrue);
    final old = body.sites.single;
    expect(old['activeMs'], 100);
    expect(old['frames'], 0);
  });

  test('caps: 40 screens (the rest folded into one), 200 sites', () {
    final r = VitalsRecorder(displayHz: 60, now: 0, screen: 's0');
    for (var i = 1; i < 50; i++) {
      r.screen('s$i', i * 100.0);
      r.frame(VitalsFrame(start: i * 100.0 + 1, end: i * 100.0 + 10, buildMs: 2, rasterMs: 2));
    }
    for (var i = 0; i < 250; i++) {
      r.runStart(site('x$i'), 5000, end: 5001);
    }
    final body = r.snapshot(5000);
    expect(body.screens, hasLength(vitalsMaxScreens));
    expect(body.screens.last['name'], '(other)');
    final total = body.screens.fold<int>(
      0,
      (n, s) => n + (((s['threads'] as Map)['ui'] as Map?)?['frames'] as int? ?? 0),
    );
    expect(total, 49);
    expect(body.sites, hasLength(vitalsMaxSites));
    expect(r.snapshot(5000, maxSites: 10).sites, hasLength(10));
  });

  test('native sites share one image entry', () {
    final r = VitalsRecorder(displayHz: 60, now: 0);
    const img = VitalsImageSpec(debugId: '8d2f61c0b7e94a3c5f1e08d9a6b4c27e', name: 'libapp.so', arch: 'arm64');
    for (final off in [100, 200]) {
      r.runStart(
        VitalsSiteSpec(id: 'v:$off', ref: {'kind': 'native', 'offset': off}, fn: 'AnimationController', image: img),
        0,
        end: 10,
      );
    }
    final body = r.snapshot(100);
    expect(body.images, [img.toJson()]);
    expect(body.sites.map((s) => s['ref']), [
      {'kind': 'native', 'offset': 100, 'image': 0},
      {'kind': 'native', 'offset': 200, 'image': 0},
    ]);
  });
}
