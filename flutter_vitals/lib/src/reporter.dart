// Sessions, sampling, windows, uploads, config and the kill switch: everything but the Flutter bindings,
// so tests drive it with a fake clock, transport and storage.

import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'protocol.dart';
import 'recorder.dart';
import 'storage.dart';
import 'transport.dart';

/// Where reports are allowed to land. Debug and profile builds report only as `development`, which the
/// dashboard keeps apart and ingest accepts only when the project collects it.
enum VitalsEnvironment { production, development }

/// What the app knows about the device and passes in (from device_info_plus, for example). This
/// package has no plugin dependencies, so it reads none of these itself. `model` and `memoryGb` are
/// sent only while the project collects device models.
class VitalsDevice {
  /// Every field is optional: pass what the app reads.
  const VitalsDevice({this.model, this.memoryGb, this.osMajor, this.tier});

  /// The raw model identifier: `iPhone15,3` (iosInfo.utsname.machine), `SM-A146B` (androidInfo.model).
  final String? model;

  /// Physical memory in GB.
  final double? memoryGb;

  /// The OS major version. iOS reads it from Platform.operatingSystemVersion; Android prints the
  /// kernel's version there, so pass `int.parse(androidInfo.version.release.split('.').first)`.
  final int? osMajor;

  /// `low`, `mid` or `high`, when the app knows better than the server's model table.
  final String? tier;
}

/// What `start` was given.
class VitalsOptions {
  const VitalsOptions({
    required this.key,
    required this.appVersion,
    this.build,
    this.environment,
    this.sampleRate,
    this.device,
    this.endpoint = vitalsEndpoint,
    this.appId,
    this.appPackage,
  });

  final String key;
  final String appVersion;
  final String? build;
  final VitalsEnvironment? environment;
  final double? sampleRate;
  final VitalsDevice? device;
  final String endpoint;
  final String? appId;
  final String? appPackage;
}

/// The display as the reporter reads it when a window starts and when a report is made.
typedef DisplayReader = (double hz, bool adaptive) Function();

/// When failed uploads are tried again, after start: 10 s, then 1, 5 and 30 minutes.
const List<Duration> retrySchedule = [
  Duration(seconds: 10),
  Duration(minutes: 1),
  Duration(minutes: 5),
  Duration(minutes: 30),
];

/// How often the open window is checkpointed, with persistent storage only.
const Duration checkpointEvery = Duration(seconds: 60);

class VitalsReporter {
  VitalsReporter({
    required this.options,
    required this.store,
    required this.transport,
    required this.facts,
    required this.clock,
    required this.releaseBuild,
    DisplayReader? display,
    this.reduceMotionNow,
    math.Random? random,
  }) : _display = display ?? (() => (60.0, false)),
       _random = random ?? math.Random.secure();

  final VitalsOptions options;
  final VitalsStore store;
  final VitalsTransport transport;
  final PlatformFacts facts;

  /// Milliseconds on the monotonic clock FrameTiming uses.
  final double Function() clock;
  final bool releaseBuild;
  final bool Function()? reduceMotionNow;
  final DisplayReader _display;
  final math.Random _random;

  /// Called when measuring turns on or off: the binding attaches its frame and pointer callbacks only
  /// while it is on.
  void Function(bool measuring)? onMeasuring;

  VitalsConfig? _config;
  int _configAt = 0;
  bool _off = false;
  bool _enabled = true;
  bool _started = false;

  /// 10 s after start: the first config fetch is due, and later ones may follow on resume.
  bool _launched = false;
  bool _fetching = false;
  bool _foreground = true;
  double? _backgroundAt;
  String _screen = '(none)';

  _Session? _session;
  VitalsRecorder? _recorder;
  Timer? _windowTimer;
  Timer? _checkpointTimer;
  final List<Timer> _timers = [];
  Future<void> _sending = Future.value();

  VitalsConfig get config => _config ?? VitalsConfig(sampleRate: options.sampleRate ?? vitalsDefaultSampleRate);

  /// The recorder of the open window while this session is sampled and in the foreground, else null.
  VitalsRecorder? get recorder => _foreground ? _recorder : null;
  bool get measuring => recorder != null;
  bool get started => _started;
  String get screen => _screen;

  /// Whether reduce motion is collected and on: runs started now count in `runsReduceMotion`.
  bool get reduceMotion => config.collectReduceMotion && (reduceMotionNow?.call() ?? false);

  /// The environment reports go to, or null when this build does not report.
  VitalsEnvironment? get environment {
    final e = options.environment;
    if (releaseBuild) return e ?? VitalsEnvironment.production;
    return e == VitalsEnvironment.development ? e : null;
  }

  Future<void> start({bool foreground = true}) async {
    if (_started) return;
    _started = true;
    _foreground = foreground;
    final cached = await store.config();
    if (cached != null) {
      _config = cached.$1;
      _configAt = cached.$2;
    }
    _off = await store.isOff();
    // A window checkpointed when the last process died: sent as it was, ended `unknown`.
    final cp = await store.checkpoint();
    if (cp != null) {
      await store.saveCheckpoint(null);
      if (_enabled && !_off) await store.addPending(cp);
    }
    for (final d in retrySchedule) {
      _timers.add(Timer(d, () => _flushIfForeground()));
    }
    _timers.add(
      Timer(retrySchedule.first, () {
        _launched = true;
        _fetchConfigIfStale();
      }),
    );
    if (_foreground && _enabled) await _beginSession(clock());
  }

  /// Consent, the Sentry way: false stops at once and drops what was measured and not yet sent.
  Future<void> setEnabled(bool on) async {
    if (on == _enabled) return;
    _enabled = on;
    if (!on) {
      _endSession();
      await store.dropData();
    } else if (_started && _foreground) {
      await _beginSession(clock());
    }
  }

  /// The app's lifecycle: `paused` is background.
  Future<void> background() async {
    if (!_foreground) return;
    final t = clock();
    _foreground = false;
    _backgroundAt = t;
    if (_recorder != null) {
      _stopTimers();
      onMeasuring?.call(false);
      await _closeWindow(t, 'background');
    }
  }

  Future<void> foreground() async {
    if (_foreground) return;
    final t = clock();
    _foreground = true;
    // An app left running for days still refreshes its config about daily.
    if (_launched) unawaited(_fetchConfigIfStale());
    final away = _backgroundAt == null ? double.infinity : t - _backgroundAt!;
    if (_session == null || away > vitalsSessionGapMs) {
      _endSession();
      if (_enabled) await _beginSession(t);
    } else if (_recorder != null) {
      _recorder!.reset(t);
      _openWindow(t);
    }
  }

  /// The screen the app is on now (already masked by the caller).
  void setScreen(String name) {
    _screen = name;
    _recorder?.screen(name, clock());
  }

  Future<void> _beginSession(double t) async {
    final c = config;
    final rate = c.sampleRate;
    var sampled =
        environment != null &&
        !_off &&
        c.enabled &&
        !c.stop &&
        (c.minSdk == null || compareVersions(vitalsSdkVersion, c.minSdk!) >= 0) &&
        rate > 0 &&
        _random.nextDouble() < rate;
    if (sampled && await store.sessionsToday() >= vitalsMaxSessionsPerDay) sampled = false;
    // Decided once: an unsampled session sends nothing at all and measures nothing.
    _session = _Session(_nonce(), sampled ? rate : 0);
    if (!sampled || !_enabled || !_foreground) return;
    await store.countSession();
    final (hz, adaptive) = _display();
    _recorder = VitalsRecorder(displayHz: hz, adaptive: adaptive, now: t, screen: _screen);
    _openWindow(t);
  }

  void _openWindow(double t) {
    if (reduceMotion) _recorder!.reduceMotionSeen = true;
    final left = vitalsWindowMs - 1;
    _windowTimer = Timer(Duration(milliseconds: left), _windowFull);
    if (store.storage.persistent) _checkpointTimer = Timer.periodic(checkpointEvery, (_) => _checkpoint());
    onMeasuring?.call(true);
  }

  void _windowFull() {
    final r = _recorder;
    if (r == null || !_foreground) return;
    final t = clock();
    // Encoded and reset before its first await: the next window starts at `t`.
    unawaited(_closeWindow(t, 'window'));
    _windowTimer = Timer(const Duration(milliseconds: vitalsWindowMs - 1), _windowFull);
  }

  void _stopTimers() {
    _windowTimer?.cancel();
    _checkpointTimer?.cancel();
    _windowTimer = _checkpointTimer = null;
  }

  void _endSession() {
    _stopTimers();
    if (_recorder != null) onMeasuring?.call(false);
    _recorder = null;
    _session = null;
  }

  Future<void> _checkpoint() async {
    final r = _recorder;
    final s = _session;
    if (r == null || s == null || !r.dirty) return;
    r.markClean();
    await store.saveCheckpoint(_encode(r, s, clock(), 'unknown', reset: false));
  }

  Future<void> _closeWindow(double t, String ended) async {
    final r = _recorder;
    final s = _session;
    if (r == null || s == null) return;
    final body = r.snapshot(t);
    final empty = body.screens.every((x) => (x['threads'] as Map).isEmpty) && body.sites.isEmpty;
    // A sliver of a window with nothing in it is not worth a request; the session's first is always
    // sent, so the session is counted.
    if (s.seq > 0 && empty && body.foregroundMs < 1000) {
      r.reset(t);
      await store.saveCheckpoint(null);
      return;
    }
    final json = _encode(r, s, t, ended);
    s.seq += 1;
    await store.saveCheckpoint(null);
    await _send(json);
  }

  /// The report of the open window, as JSON within the 32 KB cap (sites with the fewest frames go first
  /// when it is over). With `reset`, the recorder starts the next window.
  String _encode(VitalsRecorder r, _Session s, double t, String ended, {bool reset = true}) {
    var maxSites = vitalsMaxSites;
    late String json;
    while (true) {
      json = jsonEncode(_report(r.snapshot(t, maxSites: maxSites), s, ended));
      if (utf8.encode(json).length <= vitalsMaxBytes || maxSites == 0) break;
      maxSites ~/= 2;
    }
    if (reset) r.reset(t);
    return json;
  }

  Map<String, Object?> _report(WindowBody b, _Session s, String ended) {
    final c = config;
    final d = options.device;
    final (hz, adaptive) = _display();
    final measured = math.min(b.measuredMs, b.foregroundMs);
    return {
      'format': vitalsFormat,
      'version': vitalsProtocolVersion,
      'app': {
        if (options.appId != null) 'id': options.appId,
        'version': options.appVersion,
        if (options.build != null) 'build': options.build,
        'platform': 'flutter',
        'framework': 'Flutter',
        'environment': (environment ?? VitalsEnvironment.development).name,
      },
      'sdk': {'name': vitalsSdkName, 'version': vitalsSdkVersion},
      'device': {
        'os': facts.os,
        'osMajor': d?.osMajor ?? osMajorOf(facts.osVersion) ?? 0,
        if (c.collectDeviceModel && d?.model != null) 'model': d!.model,
        if (d?.tier != null && const ['low', 'mid', 'high'].contains(d!.tier)) 'tier': d.tier,
        if (c.collectDeviceModel && d?.memoryGb != null) 'memoryGb': (d!.memoryGb! * 10).round() / 10,
      },
      'display': {'hz': hz.round().clamp(1, 240), 'adaptive': adaptive, 'targetHz': b.targetHz.clamp(1, 240)},
      'state': {if (c.collectReduceMotion) 'reduceMotion': b.reduceMotion},
      'session': {
        'nonce': s.nonce,
        'seq': s.seq,
        'sampleRate': s.sampleRate,
        'foregroundMs': b.foregroundMs.round(),
        'measuredMs': measured.round(),
        'ended': ended,
      },
      'screens': b.screens,
      'sites': b.sites,
      'worst': b.worst,
      if (b.images.isNotEmpty) 'images': b.images,
    };
  }

  // ── Uploads ─────────────────────────────────────────────────────────

  Uri get _reports => Uri.parse('${_base()}/v1/reports');
  Uri get _configUrl => Uri.parse('${_base()}/v1/config/${Uri.encodeComponent(options.key)}');
  String _base() =>
      options.endpoint.endsWith('/') ? options.endpoint.substring(0, options.endpoint.length - 1) : options.endpoint;

  /// Stored first, so a process killed mid-request keeps it for the next launch; removed once the
  /// server has answered for it.
  Future<void> _send(String json) =>
      _sending = _sending.then((_) async {
        if (_off || !_enabled) return;
        await store.addPending(json);
        await _post(json);
      });

  /// Sends what waits in the retry store, oldest first, stopping at the first failure.
  Future<void> flush() =>
      _sending = _sending.then((_) async {
        for (final p in await store.pending()) {
          if (_off || !_enabled || !await _post(p.body)) return;
        }
      });

  void _flushIfForeground() {
    if (_foreground && _enabled && !_off) unawaited(flush());
  }

  /// One attempt. False when it should be tried again later.
  Future<bool> _post(String json) async {
    final res = await transport.post(_reports, json, key: options.key);
    final st = res.status;
    if (st == 401 || st == 410) {
      await _kill();
      return false;
    }
    if (st >= 200 && st < 300) {
      await store.removePending(json);
      final body = _decode(res.body);
      if (body is Map) await _applyConfig(body['config']);
      return true;
    }
    if (st == 400 || st == 413) {
      // Never accepted, however often it is sent.
      await store.removePending(json);
      return true;
    }
    return false;
  }

  Future<void> _fetchConfigIfStale() async {
    if (_off || !_enabled) return;
    final age = store.now() - _configAt;
    final ttl = math.min(config.ttlSec, 86400) * 1000;
    if ((_config != null && age < ttl) || _fetching) return;
    _fetching = true;
    try {
      await fetchConfig();
    } finally {
      _fetching = false;
    }
  }

  Future<void> fetchConfig() async {
    final res = await transport.get(_configUrl);
    if (res.status == 401 || res.status == 410) return _kill();
    if (res.status >= 200 && res.status < 300) await _applyConfig(_decode(res.body));
  }

  Future<void> _applyConfig(Object? json) async {
    final c = VitalsConfig.fromJson(json);
    if (c == null) return;
    _config = c;
    _configAt = store.now();
    await store.saveConfig(c);
    if (c.stop) return _kill();
    final blocked = !c.enabled || (c.minSdk != null && compareVersions(vitalsSdkVersion, c.minSdk!) < 0);
    // Off for this project or this SDK version: the session stops now, what it measured stays here.
    if (blocked) _endSession();
  }

  /// 401, 410 or `stop`: off on this device for 7 days, nothing kept.
  Future<void> _kill() async {
    _off = true;
    _endSession();
    await store.turnOff();
    await store.dropData();
  }

  /// Cancels every timer. The binding calls this when the reporter is replaced (tests).
  void dispose() {
    _stopTimers();
    for (final t in _timers) {
      t.cancel();
    }
    _timers.clear();
    _recorder = null;
    _session = null;
  }

  String _nonce() {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    return String.fromCharCodes(List.generate(22, (_) => chars.codeUnitAt(_random.nextInt(chars.length))));
  }

  static Object? _decode(String body) {
    try {
      return jsonDecode(body);
    } catch (_) {
      return null;
    }
  }
}

class _Session {
  _Session(this.nonce, this.sampleRate);

  /// Random, in memory only: never written anywhere but the reports themselves.
  final String nonce;
  final double sampleRate;
  int seq = 0;
}

/// The major version in `Platform.operatingSystemVersion` on iOS (`Version 17.4.1 (Build 21E236)`).
/// Android prints the kernel there (`Linux 5.10.…`), which is not the OS version: null.
int? osMajorOf(String osVersion) {
  if (osVersion.startsWith('Linux')) return null;
  final m = RegExp(r'(\d+)(?:\.\d+)*').firstMatch(osVersion);
  return m == null ? null : int.tryParse(m[1]!);
}
