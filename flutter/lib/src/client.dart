// The app's side of the live inspector, a port of react-native/src/client.ts: says hello,
// reports the catalog of animated values and every animation start, records samples, frame stats and
// markers while an editor asks, plays recordings back and captures frames for export.
//
// Pure Dart with the socket, the clock and the Flutter host injected, so it runs under `flutter test`
// with fake ones. lib/src/flutter_host.dart is the real host; lib/src/transport.dart the real socket.

import 'dart:async';
import 'dart:convert';

import 'call_site.dart';
import 'frame_meter.dart';
import 'protocol.dart';
import 'runtime.dart';

/// One connection to the relay: text frames in, text frames out.
abstract interface class KfSocket {
  Stream<String> get messages;
  void send(String data);
  Future<void> close();
}

typedef KfConnector = Future<KfSocket> Function(Uri url);

/// One frame's raster timing, on the engine's clock (ms).
class KfTiming {
  const KfTiming({required this.rasterEnd, required this.rasterMs, required this.buildMs});

  final double rasterEnd;
  final double rasterMs;
  final double buildMs;
}

/// A pointer event seen by the global pointer route. `stamp` is the event's own time (ms, engine clock).
class KfTouch {
  const KfTouch(this.phase, this.id, this.x, this.y, this.stamp);

  final String phase;
  final int id;
  final double x;
  final double y;
  final double? stamp;
}

/// What the client needs from Flutter. The real one lives in flutter_host.dart; tests pass a fake.
abstract interface class KfHost {
  KfScreen? get screen;
  bool get canCapture;
  double get refreshRate;

  /// Calls `onFrame` after every frame, keeping frames coming, until the returned function is called.
  void Function() frames(void Function() onFrame);

  /// Raster timings as the engine reports them (in batches), until the returned function is called.
  void Function() timings(void Function(List<KfTiming>) onTimings);

  /// Every pointer event, until the returned function is called.
  void Function() touches(void Function(KfTouch) onTouch);

  /// Completes once the next frame has been drawn.
  Future<void> nextFrame();

  /// The screen as a base64 PNG, `width` points wide when given.
  Future<String> capture({double? width});
}

const _maxQueued = 2000;
const _maxBackoff = Duration(seconds: 10);

class KfInspectorClient implements KfSink {
  KfInspectorClient({
    required this.url,
    required this.connector,
    required this.app,
    this.platform = 'unknown',
    this.osVersion,
    this.host,
    KfRuntime? runtime,
    this.batch = const Duration(milliseconds: 100),
    this.sampleInterval = const Duration(milliseconds: 16),
    this.pingInterval = const Duration(seconds: 10),
    double Function()? now,
    int Function()? wallClock,
  }) : runtime = runtime ?? KfRuntime.instance,
       _now = now ?? _stopwatchNow(),
       _wall = wallClock ?? (() => DateTime.now().millisecondsSinceEpoch);

  final Uri url;
  final KfConnector connector;
  final String app;

  /// The OS: "macos", "ios", "android" (`hello.platform`).
  final String platform;
  final String? osVersion;
  final KfHost? host;
  final KfRuntime runtime;
  final Duration batch;
  final Duration sampleInterval;

  /// Not a protocol message: the transport uses it as its WebSocket ping interval.
  final Duration pingInterval;
  final double Function() _now;
  final int Function() _wall;

  static double Function() _stopwatchNow() {
    final sw = Stopwatch()..start();
    return () => sw.elapsedMicroseconds / 1000;
  }

  // What waits for the next flush.
  List<Map<String, Object?>> _queue = [];
  List<KfSample> _samples = [];
  List<KfFrameStat> _frames = [];
  List<KfFrameDrop> _drops = [];
  List<Map<String, Object?>> _markers = [];

  // Signals are reported once; an editor that joins later gets the catalog again.
  final Map<String, Map<String, Object?>> _catalog = {};

  final Set<String> _recording = {};
  bool _recordAll = false;
  double _recordStart = 0;
  int _nextEid = 1;

  KfSocket? _socket;
  bool _disposed = false;
  Duration _backoff = const Duration(milliseconds: 500);
  int _editors = 0;
  Timer? _reconnect;
  Timer? _flushTimer;
  StreamSubscription<String>? _sub;
  void Function()? _unwatchScenarios;

  bool get connected => _socket != null;
  double get _elapsed => _now() - _recordStart;

  /// Installs the hook and starts connecting.
  void start() {
    runtime.install(this);
    _flushTimer = Timer.periodic(batch, (_) => flush());
    _unwatchScenarios = runtime.watchScenarios((names) => _send(KfAppMessage.scenarios(names)));
    _connect();
  }

  // ── KfSink ────────────────────────────────────────────────────────────
  @override
  void anim(KfCallSite site, List<Object?> args, {List<KfStackFrame>? frames, num? durationMs}) {
    final recording = this.recording;
    // Stacks only while recording, as client.ts does: what a frame drop is traced back to.
    final withStack = recording && frames != null && frames.isNotEmpty;
    _enqueue(
      KfEvent.anim(
        eid: _nextEid++,
        site: site,
        at: _wall(),
        args: sanitizeArgs(args),
        t: recording ? _elapsed.round() : null,
        stack: withStack ? _nonEmpty(formatStack(frames, appPackage: runtime.appPackage, root: runtime.root)) : null,
        frames: withStack ? inspectorFrames(frames, appPackage: runtime.appPackage, root: runtime.root) : null,
        durationMs: durationMs == null || !durationMs.isFinite ? null : durationMs.round(),
      ),
    );
  }

  @override
  void signal(KfSignal s) {
    final site = s.site(runtime);
    final event = KfEvent.signal(site);
    _catalog['signal:${site.id}'] = event;
    // A value created while recording everything joins the recording (a screen opened mid-recording).
    if (_recordAll) _recording.add(site.id);
    _enqueue(event);
  }

  /// The value went away (its screen closed): it leaves the catalog. A recording keeps its id, so a
  /// value re-created at the same call site (the screen opened again) is followed.
  @override
  void unsignal(String id) {
    if (_catalog.remove('signal:$id') == null) return;
    _enqueue(KfEvent.unsignal(id));
  }

  void _enqueue(Map<String, Object?> e) {
    _queue.add(e);
    if (_queue.length > _maxQueued) _queue = _queue.sublist(_queue.length - _maxQueued);
  }

  // ── Sending ───────────────────────────────────────────────────────────
  bool _send(Map<String, Object?> msg) {
    final s = _socket;
    if (s == null) return false;
    s.send(jsonEncode(msg));
    return true;
  }

  /// Sends what is queued. Runs every [batch].
  void flush() {
    if (_socket == null) return;
    if (_queue.isNotEmpty) {
      _send(KfAppMessage.events(_queue));
      _queue = [];
    }
    if (_samples.isNotEmpty || _frames.isNotEmpty || _drops.isNotEmpty || _markers.isNotEmpty) {
      _send(KfAppMessage.samples(samples: _samples, frames: _frames, drops: _drops, markers: _markers));
      _samples = [];
      _frames = [];
      _drops = [];
      _markers = [];
    }
  }

  /// How the app was built (debug frames are slower, so the inspector scales its thresholds):
  /// Flutter's kDebugMode / kProfileMode, from the same compile-time flags, so this file stays free
  /// of package:flutter.
  static const String kfBuild =
      bool.fromEnvironment('dart.vm.product')
          ? 'release'
          : bool.fromEnvironment('dart.vm.profile')
          ? 'profile'
          : 'debug';

  Map<String, Object?> hello() {
    final capture = host?.canCapture ?? false;
    return KfAppMessage.hello(
      app: app,
      platform: platform,
      osVersion: osVersion,
      build: kfBuild,
      capture: capture,
      screen: host?.screen,
      scenarios: runtime.scenarioNames,
      capabilities: ['playback', 'overrides', 'replay', 'scenarios', if (capture) 'capture'],
      // The project folder, so the panel can open call sites (`lib/main.dart`) in an editor:
      // `flutter run --dart-define=KEYFRAMER_ROOT=$PWD`.
      root: const String.fromEnvironment('KEYFRAMER_ROOT'),
    );
  }

  // ── Connection ────────────────────────────────────────────────────────
  Future<void> _connect() async {
    if (_disposed) return;
    KfSocket s;
    try {
      s = await connector(url);
    } catch (_) {
      _scheduleReconnect();
      return;
    }
    if (_disposed) {
      unawaited(s.close());
      return;
    }
    _socket = s;
    _backoff = const Duration(milliseconds: 500);
    _sub = s.messages.listen(_onMessage, onDone: () => _closed(s), onError: (_) => _closed(s), cancelOnError: true);
    _send(hello());
    flush();
  }

  void _closed(KfSocket s) {
    if (!identical(_socket, s)) return;
    _socket = null;
    _sub = null;
    _editors = 0;
    _scheduleReconnect();
  }

  void _scheduleReconnect() {
    if (_disposed) return;
    _reconnect?.cancel();
    _reconnect = Timer(_backoff, _connect);
    final next = _backoff * 2;
    _backoff = next > _maxBackoff ? _maxBackoff : next;
  }

  // ── Messages from editors ─────────────────────────────────────────────
  void _onMessage(String data) {
    if (data == 'pong' || data == 'ping') return;
    Object? decoded;
    try {
      decoded = jsonDecode(data);
    } catch (_) {
      return;
    }
    if (decoded is! Map) return;
    final msg = decoded.cast<String, Object?>();
    switch (msg['type']) {
      case 'overrides':
        runtime.overrides = _overrides(msg['overrides']);
      case 'replay':
        runtime.replay?.call();
      case 'record':
        final ids = (msg['signalIds'] as List?)?.whereType<String>().toList() ?? const [];
        setRecording(ids, msg['on'] == true);
      case 'playback':
        playback(
          _samplesOf(msg['samples']),
          ((msg['routes'] as List?) ?? const []).map(KfRoute.fromJson).whereType<KfRoute>().toList(),
        );
      case 'capture':
        _capture(msg);
      case 'scenario':
        final name = msg['name'];
        if (name is String) unawaited(_runScenario(name));
      case 'presence':
        // A new editor missed the one-off signal reports: send it the catalog.
        final editors = (msg['editors'] as num?)?.toInt() ?? 0;
        if (editors > _editors && _catalog.isNotEmpty) _send(KfAppMessage.events(_catalog.values.toList()));
        _editors = editors;
      case 'hello':
        // A relay that forwards an editor's hello instead of sending presence: the editor still needs
        // the app's hello and the catalog.
        if (msg['role'] == 'editor') {
          _send(hello());
          if (_catalog.isNotEmpty) _send(KfAppMessage.events(_catalog.values.toList()));
        }
    }
  }

  static Map<String, Map<String, num>> _overrides(Object? json) {
    final out = <String, Map<String, num>>{};
    if (json is! Map) return out;
    json.forEach((site, patch) {
      if (site is String && patch is Map) {
        out[site] = {
          for (final e in patch.entries)
            if (e.key is String && e.value is num) e.key as String: e.value as num,
        };
      }
    });
    return out;
  }

  static List<KfSample> _samplesOf(Object? json) =>
      ((json as List?) ?? const []).map(KfSample.fromJson).whereType<KfSample>().toList();

  // ── Recording ─────────────────────────────────────────────────────────
  void Function()? _stopFrames;
  void Function()? _stopTimings;
  void Function()? _stopTouches;
  void Function()? _stopNav;
  Timer? _sampleTimer;
  FrameMeter? _uiMeter;
  FrameMeter? _rasterMeter;
  double _rasterOffset = double.infinity;
  double _touchOffset = double.infinity;
  final Map<int, double> _lastMove = {};

  /// Recording everything counts before any value exists.
  bool get recording => _recording.isNotEmpty || _recordAll;

  void setRecording(List<String> ids, bool on) {
    final was = recording;
    final all = ids.contains('*');
    // A recording sees the app live: values held by a scrub go back to it first.
    if (on && !was) _stopPlayback();
    if (on) {
      if (!recording) _recordStart = _now();
      if (all) _recordAll = true;
      _recording.addAll(all ? runtime.signals.keys : ids);
    } else if (all) {
      _recordAll = false;
      _recording.clear();
    } else {
      _recording.removeAll(ids);
    }
    if (was != recording) _measure(recording);
  }

  void _measure(bool on) {
    if (on) {
      final h = host;
      _uiMeter = FrameMeter(kfDartThread, refreshRate: h?.refreshRate ?? 60);
      _rasterMeter = FrameMeter(kfRasterThread, refreshRate: h?.refreshRate ?? 60);
      _rasterOffset = double.infinity;
      _touchOffset = double.infinity;
      _lastMove.clear();
      if (h != null) {
        // Sampled once per frame, after the frame's animations ticked.
        _stopFrames = h.frames(_onFrame);
        _stopTimings = h.timings(_onTimings);
        _stopTouches = h.touches(_onTouch);
      } else {
        _sampleTimer = Timer.periodic(sampleInterval, (_) => _sampleOnce(_elapsed));
      }
      // The screen it starts on, then every screen change.
      final start = runtime.currentRoute;
      if (start != null) _marker(KfMarker.navigation(t: _elapsed.round(), route: start.route, params: start.params));
      _stopNav = runtime.tapNavigation(
        (r) => _marker(KfMarker.navigation(t: _elapsed.round(), route: r.route, params: r.params)),
      );
    } else {
      for (final stop in [_stopFrames, _stopTimings, _stopTouches, _stopNav]) {
        stop?.call();
      }
      _stopFrames = _stopTimings = _stopTouches = _stopNav = null;
      _sampleTimer?.cancel();
      _sampleTimer = null;
      _drainMeters();
      _uiMeter = _rasterMeter = null;
    }
  }

  void _onFrame() {
    if (!recording) return;
    final t = _elapsed;
    _uiMeter?.tick(t);
    _drainMeters();
    _sampleOnce(t);
  }

  void _sampleOnce(double t) {
    final at = t.round();
    for (final id in _recording) {
      final s = runtime.signals[id];
      if (s == null) continue;
      final v = s.read();
      if (v.isFinite) _samples.add(KfSample(id, at, v));
    }
  }

  /// Raster timings arrive in batches, timed by the engine's clock: mapped onto the recording's clock
  /// by the smallest offset seen (the batch that arrived with the least delay), as client.ts maps the
  /// UI thread's frames.
  void _onTimings(List<KfTiming> timings) {
    final m = _rasterMeter;
    if (m == null || timings.isEmpty) return;
    final latest = timings.map((t) => t.rasterEnd).reduce((a, b) => a > b ? a : b);
    final offset = _elapsed - latest;
    if (offset < _rasterOffset) _rasterOffset = offset;
    for (final t in timings) {
      final at = t.rasterEnd + _rasterOffset;
      if (at >= 0) m.tickCost(at, t.rasterMs);
    }
    _drainMeters();
  }

  void _drainMeters() {
    for (final m in [_uiMeter, _rasterMeter]) {
      if (m == null) continue;
      final (stats, drops) = m.drain();
      _frames.addAll(stats);
      _drops.addAll(drops);
    }
  }

  void _onTouch(KfTouch touch) {
    final now = _elapsed;
    var t = now;
    final stamp = touch.stamp;
    if (stamp != null) {
      final offset = now - stamp;
      if (offset < _touchOffset) _touchOffset = offset;
      t = stamp + _touchOffset;
    }
    // At most one move per finger per 120 Hz frame.
    if (touch.phase == 'move') {
      final last = _lastMove[touch.id];
      if (last != null && t - last < 8) return;
      _lastMove[touch.id] = t;
    } else if (touch.phase != 'start') {
      _lastMove.remove(touch.id);
    }
    _marker(KfMarker.touch(t: t.round(), phase: touch.phase, id: touch.id, x: _tenth(touch.x), y: _tenth(touch.y)));
  }

  void _marker(Map<String, Object?> m) {
    if (_markers.length < _maxQueued) _markers.add(m);
  }

  // ── Playback ──────────────────────────────────────────────────────────
  Timer? _playbackTimer;
  Set<KfSignal> _playing = {};
  // What capture changed: values go back to these when it hands them back. Playback keeps its last
  // frame instead, which is where the recorded interaction left the app.
  Map<KfSignal, double> _restore = {};

  /// Writes recorded samples back into the values in time order, navigating along `routes`. The values
  /// are the inspector's until it ends; then each goes back to the app (see KfSignal.endPlayback).
  /// A scrub (every sample at one moment) holds its values until the next playback, capture or
  /// recording, so a loop does not carry on from the moment the playhead shows.
  void playback(List<KfSample> recorded, [List<KfRoute> routes = const []]) {
    _release?.cancel();
    _stopPlayback(keep: recorded.map((x) => runtime.signals[x.id]).whereType<KfSignal>().toSet());
    final ordered = List.of(recorded)..sort((a, b) => a.t.compareTo(b.t));
    final screens = List.of(routes)..sort((a, b) => a.t.compareTo(b.t));
    if (ordered.isEmpty) {
      if (screens.isNotEmpty) runtime.navigateTo(screens.first.route, screens.first.params);
      return;
    }
    final t0 = screens.isNotEmpty && screens.first.t < ordered.first.t ? screens.first.t : ordered.first.t;
    final scrub = ordered.first.t == ordered.last.t && screens.every((s) => s.t <= ordered.first.t);
    final start = _now();
    var i = 0, r = 0;
    _takeOver(ordered.map((s) => s.id));
    void step() {
      final elapsed = _now() - start;
      while (r < screens.length && screens[r].t - t0 <= elapsed) {
        final s = screens[r++];
        runtime.navigateTo(s.route, s.params);
      }
      while (i < ordered.length && ordered[i].t - t0 <= elapsed) {
        final s = ordered[i++];
        final sig = runtime.signals[s.id];
        if (sig != null) {
          // A value that mounted mid-playback (the next screen's) is taken over when first written.
          if (_playing.add(sig)) sig.beginPlayback?.call();
          sig.write(s.v);
        }
      }
      if (i >= ordered.length && r >= screens.length) {
        if (scrub) {
          _playbackTimer?.cancel();
          _playbackTimer = null;
        } else {
          _stopPlayback();
        }
      }
    }

    step();
    if (i < ordered.length || r < screens.length) {
      _playbackTimer = Timer.periodic(sampleInterval, (_) => step());
    }
  }

  bool get playing => _playbackTimer != null || _playing.isNotEmpty;

  void _takeOver(Iterable<String> ids, {bool restore = false}) {
    for (final id in ids.toSet()) {
      final s = runtime.signals[id];
      if (s == null) continue;
      if (restore && !_playing.contains(s)) _restore[s] = s.read();
      if (_playing.add(s)) s.beginPlayback?.call();
    }
  }

  /// Hands the values back to the app, except `keep` (the next playback writes them again: a loop is
  /// not restarted between two scrubs).
  void _stopPlayback({Set<KfSignal> keep = const {}}) {
    _playbackTimer?.cancel();
    _playbackTimer = null;
    final done = _playing;
    final restore = _restore;
    _playing = {};
    _restore = {};
    for (final s in done) {
      if (keep.contains(s)) {
        _playing.add(s);
        if (restore.containsKey(s)) _restore[s] = restore[s]!;
        continue;
      }
      final v = restore[s];
      if (v != null) s.write(v);
      s.endPlayback?.call();
    }
  }

  // ── Capture ───────────────────────────────────────────────────────────
  // One at a time, in the order asked: an export waits for each frame before asking for the next.
  Future<void> _captures = Future.value();
  Timer? _release;

  void _capture(Map<String, Object?> msg) {
    final id = msg['id'];
    if (id is! String) return;
    _captures = _captures.then((_) => _captureOne(id, msg)).catchError((_) {});
  }

  Future<void> _captureOne(String id, Map<String, Object?> msg) async {
    final h = host;
    if (h == null || !h.canCapture) {
      _send(KfAppMessage.frame(id: id, error: 'This app does not capture its screen: wrap it in KeyframerInspector.'));
      return;
    }
    _playbackTimer?.cancel();
    _playbackTimer = null;
    _release?.cancel();
    final route = KfRoute.fromJson(msg['route']);
    // The screen this moment was on: navigate there and let the transition finish first.
    if (route != null && runtime.navigateTo(route.route, route.params)) {
      await Future<void>.delayed(const Duration(milliseconds: 700));
    }
    final samples = _samplesOf(msg['samples']);
    _takeOver(samples.map((s) => s.id), restore: true);
    for (final s in samples) {
      runtime.signals[s.id]?.write(s.v);
    }
    // Build, then draw: wait for the screen to show the values.
    await h.nextFrame();
    await h.nextFrame();
    try {
      final width = (msg['width'] as num?)?.toDouble();
      final data = await h.capture(width: width);
      // PNG whatever was asked: Flutter encodes no JPEG without a plugin. `format` says so.
      _send(KfAppMessage.frame(id: id, data: data, format: 'png'));
    } catch (e) {
      _send(KfAppMessage.frame(id: id, error: e.toString()));
    }
    // The values go back to the app shortly after the last capture of an export.
    _release = Timer(const Duration(milliseconds: 600), _stopPlayback);
  }

  // ── Scenarios ─────────────────────────────────────────────────────────
  Future<void> _runScenario(String name) async {
    final run = runtime.scenarios[name];
    final t0 = _now();
    if (run == null) {
      final names = runtime.scenarioNames;
      _send(
        KfAppMessage.scenarioDone(
          name: name,
          ms: 0,
          error: 'No scenario named "$name". Registered: ${names.isEmpty ? 'none' : names.join(', ')}.',
        ),
      );
      return;
    }
    String? error;
    try {
      await run();
    } catch (e) {
      error = e.toString();
    }
    _send(KfAppMessage.scenarioDone(name: name, ms: (_now() - t0).round(), error: error));
  }

  /// Sends a message to the connected editors. False when nothing is connected.
  bool sendToEditors(Map<String, Object?> msg) => _send(msg);

  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    runtime.uninstall(this);
    _unwatchScenarios?.call();
    _flushTimer?.cancel();
    _reconnect?.cancel();
    _release?.cancel();
    if (recording) {
      _recording.clear();
      _recordAll = false;
      _measure(false);
    }
    _stopPlayback();
    unawaited(_sub?.cancel());
    final s = _socket;
    _socket = null;
    await s?.close();
  }
}

/// A JSON-safe copy of animation arguments: numbers, strings, bools and plain maps and lists survive,
/// functions and other objects become their description. Mirrors client.ts sanitizeArgs.
List<Object?> sanitizeArgs(List<Object?> args) {
  Object? clean(Object? v, int depth) {
    if (v == null || v is num || v is String || v is bool) return v is double && !v.isFinite ? null : v;
    if (v is Function) return '[function]';
    if (v is List) return depth > 2 ? '[array]' : [for (final x in v) clean(x, depth + 1)];
    if (v is Map) {
      if (depth > 2) return '[object]';
      return {
        for (final e in v.entries)
          if (e.value is! Function) '${e.key}': clean(e.value, depth + 1),
      };
    }
    return v.toString();
  }

  return [for (final a in args) clean(a, 0)];
}

num _tenth(double v) => (v * 10).round() / 10;
String? _nonEmpty(String s) => s.isEmpty ? null : s;
