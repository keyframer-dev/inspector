import 'dart:async';
import 'dart:convert';

import 'protocol.dart';

/// Where the reporter keeps the little it remembers between launches: the cached config, the kill
/// switch, today's count of reported sessions, failed uploads waiting for a retry, and the checkpoint of
/// the open window. Strings by key; `null` deletes.
///
/// The default, [MemoryVitalsStorage], keeps them for this process only: the config is fetched again
/// each launch, the daily cap counts this launch's sessions only, failed uploads are retried within the
/// launch, and there are no checkpoints, so a session that ends in a crash or a kill is not sent. Pass a
/// persistent adapter (shared_preferences, a file) to keep them; see the README.
abstract class VitalsStorage {
  Future<String?> read(String key);
  Future<void> write(String key, String? value);

  /// Whether what is written survives the process. Checkpoints are written only when it does.
  bool get persistent;
}

/// Keeps everything in memory, for this process only. No checkpoints.
class MemoryVitalsStorage implements VitalsStorage {
  final Map<String, String> _values = {};

  @override
  Future<String?> read(String key) async => _values[key];

  @override
  Future<void> write(String key, String? value) async {
    if (value == null) {
      _values.remove(key);
    } else {
      _values[key] = value;
    }
  }

  @override
  bool get persistent => false;
}

/// Limits of the retry store (production.md 2.1).
const int retryMaxReports = 5;
const int retryMaxBytes = 100 * 1024;
const int retryMaxAgeMs = 7 * 24 * 60 * 60 * 1000;

/// How long a 401, a 410 or `stop` turns reporting off on this device.
const int killMs = 7 * 24 * 60 * 60 * 1000;

/// One report waiting to be sent: its JSON and when it was first stored (wall clock, never sent).
class PendingReport {
  const PendingReport(this.body, this.savedAt);

  final String body;
  final int savedAt;
}

/// The reporter's records over a [VitalsStorage]. Wall-clock times here stay on the device.
class VitalsStore {
  VitalsStore(this.storage, {int Function()? wallClock})
    : _now = wallClock ?? (() => DateTime.now().millisecondsSinceEpoch);

  final VitalsStorage storage;
  final int Function() _now;

  /// The wall clock the records are kept by: a config's age is measured on the clock that stamped it.
  int now() => _now();

  static const _config = 'keyframer_vitals.config';
  static const _off = 'keyframer_vitals.off';
  static const _day = 'keyframer_vitals.day';
  static const _retry = 'keyframer_vitals.retry';
  static const _checkpoint = 'keyframer_vitals.checkpoint';

  // ── Config ──────────────────────────────────────────────────────────
  Future<(VitalsConfig, int)?> config() async {
    final raw = await _json(_config);
    if (raw is! Map || raw['fetchedAt'] is! int) return null;
    final c = VitalsConfig.fromJson(raw['config']);
    return c == null ? null : (c, raw['fetchedAt'] as int);
  }

  Future<void> saveConfig(VitalsConfig c) =>
      storage.write(_config, jsonEncode({'config': c.toJson(), 'fetchedAt': _now()}));

  // ── Kill switch ─────────────────────────────────────────────────────
  Future<bool> isOff() async {
    final until = int.tryParse(await storage.read(_off) ?? '');
    return until != null && until > _now();
  }

  Future<void> turnOff() => storage.write(_off, '${_now() + killMs}');

  // ── Sessions reported today (local date) ────────────────────────────
  String _today() {
    final d = DateTime.fromMillisecondsSinceEpoch(_now());
    return '${d.year}-${d.month}-${d.day}';
  }

  Future<int> sessionsToday() async {
    final raw = await storage.read(_day) ?? '';
    final i = raw.lastIndexOf(':');
    if (i < 0 || raw.substring(0, i) != _today()) return 0;
    return int.tryParse(raw.substring(i + 1)) ?? 0;
  }

  Future<void> countSession() async => storage.write(_day, '${_today()}:${await sessionsToday() + 1}');

  // ── Retry store ─────────────────────────────────────────────────────
  Future<List<PendingReport>> pending() async {
    final raw = await _json(_retry);
    if (raw is! List) return [];
    final now = _now();
    return [
      for (final e in raw)
        if (e is Map && e['body'] is String && e['at'] is int && now - (e['at'] as int) < retryMaxAgeMs)
          PendingReport(e['body'] as String, e['at'] as int),
    ];
  }

  /// Adds a report, then keeps the newest that fit: 5 reports, 100 KB, 7 days.
  Future<void> addPending(String body) async {
    final list = [...await pending(), PendingReport(body, _now())];
    await _savePending(list);
  }

  Future<void> removePending(String body) async {
    final list = await pending();
    final i = list.indexWhere((p) => p.body == body);
    if (i < 0) return;
    list.removeAt(i);
    await _savePending(list);
  }

  Future<void> clearPending() => storage.write(_retry, null);

  Future<void> _savePending(List<PendingReport> list) async {
    final kept = <PendingReport>[];
    var bytes = 0;
    for (final p in list.reversed) {
      final size = utf8.encode(p.body).length;
      if (kept.length >= retryMaxReports || bytes + size > retryMaxBytes) break;
      kept.insert(0, p);
      bytes += size;
    }
    await storage.write(
      _retry,
      kept.isEmpty
          ? null
          : jsonEncode([
            for (final p in kept) {'at': p.savedAt, 'body': p.body},
          ]),
    );
  }

  // ── Checkpoint of the open window ───────────────────────────────────
  Future<String?> checkpoint() => storage.read(_checkpoint);

  Future<void> saveCheckpoint(String? body) => storage.write(_checkpoint, body);

  /// Everything, for setEnabled(false): nothing measured stays behind.
  Future<void> dropData() async {
    await storage.write(_retry, null);
    await storage.write(_checkpoint, null);
  }

  Future<Object?> _json(String key) async {
    final raw = await storage.read(key);
    if (raw == null) return null;
    try {
      return jsonDecode(raw);
    } catch (_) {
      return null;
    }
  }
}
