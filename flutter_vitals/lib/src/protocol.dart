// The parts of inspector/protocol/vitals.ts this reporter needs, mirrored by hand (that file
// is import-free so every SDK can do this). The golden test checks the encoder against the fixtures.

const String vitalsFormat = 'keyframer-vitals';
const int vitalsProtocolVersion = 1;
const String vitalsEndpoint = 'https://vitals.keyframer.dev';

/// This package, as reports name it. A test checks the version matches pubspec.yaml.
const String vitalsSdkName = 'keyframer_vitals';
const String vitalsSdkVersion = '0.1.1';

/// Histogram buckets of frames missed per frame, by lower bound: 0, 1, 2, 3-4, 5-8, 9-16, 17-32, 33+.
const List<int> vitalsBuckets = [0, 1, 2, 3, 5, 9, 17, 33];

/// A frame this long or longer is frozen, in absolute time.
const double vitalsFrozenMs = 700;

/// A session window is at most this much foreground time.
const int vitalsWindowMs = 10 * 60 * 1000;

/// A session ends after this long in the background.
const int vitalsSessionGapMs = 30 * 1000;

/// Caps per report (VITALS_LIMITS).
const int vitalsMaxScreens = 40;
const int vitalsMaxSites = 200;
const int vitalsMaxImages = 64;
const int vitalsMaxBytes = 32 * 1024;
const int vitalsScreenNameMax = 64;

/// The SDKs send this many worst frames (the protocol accepts up to 10).
const int vitalsWorstFrames = 5;

const int vitalsMaxSessionsPerDay = 3;
const double vitalsDefaultSampleRate = 0.1;

/// Index into [vitalsBuckets] for a frame that missed `missed` vsyncs.
int bucketOf(int missed) {
  for (var i = vitalsBuckets.length - 1; i > 0; i--) {
    if (missed >= vitalsBuckets[i]) return i;
  }
  return 0;
}

/// Per-project settings, from upload responses and `GET /v1/config/<key>` (VitalsConfig).
class VitalsConfig {
  const VitalsConfig({
    this.enabled = true,
    this.sampleRate = vitalsDefaultSampleRate,
    this.boostUntil,
    this.minSdk,
    this.collectReduceMotion = false,
    this.collectDeviceModel = true,
    this.collectDevelopment = false,
    this.stop = false,
    this.ttlSec = 86400,
  });

  final bool enabled;
  final double sampleRate;
  final String? boostUntil;

  /// `minSdk.flutter`: versions of this package below it stop reporting.
  final String? minSdk;
  final bool collectReduceMotion;
  final bool collectDeviceModel;
  final bool collectDevelopment;
  final bool stop;
  final int ttlSec;

  /// Reads a config; anything malformed keeps the default for that field.
  static VitalsConfig? fromJson(Object? json) {
    if (json is! Map) return null;
    final collect = json['collect'] is Map ? json['collect'] as Map : const {};
    final minSdk = json['minSdk'] is Map ? (json['minSdk'] as Map)['flutter'] : null;
    final rate = json['sampleRate'];
    final ttl = json['ttlSec'];
    return VitalsConfig(
      enabled: json['enabled'] is bool ? json['enabled'] as bool : true,
      sampleRate: rate is num && rate >= 0 && rate <= 1 ? rate.toDouble() : vitalsDefaultSampleRate,
      boostUntil: json['boostUntil'] is String ? json['boostUntil'] as String : null,
      minSdk: minSdk is String ? minSdk : null,
      collectReduceMotion: collect['reduceMotion'] == true,
      collectDeviceModel: collect['deviceModel'] is bool ? collect['deviceModel'] as bool : true,
      collectDevelopment: collect['development'] == true,
      stop: json['stop'] == true,
      ttlSec: ttl is num && ttl > 0 ? ttl.toInt() : 86400,
    );
  }

  Map<String, Object?> toJson() => {
    'enabled': enabled,
    'sampleRate': sampleRate,
    if (boostUntil != null) 'boostUntil': boostUntil,
    if (minSdk != null) 'minSdk': {'flutter': minSdk},
    'collect': {
      'reduceMotion': collectReduceMotion,
      'deviceModel': collectDeviceModel,
      'development': collectDevelopment,
    },
    if (stop) 'stop': true,
    'ttlSec': ttlSec,
  };
}

/// -1, 0 or 1, comparing dotted versions numerically (`0.10.0` > `0.9.2`); a pre-release suffix is
/// ignored.
int compareVersions(String a, String b) {
  List<int> parts(String v) => v.split(RegExp(r'[-+]')).first.split('.').map((p) => int.tryParse(p) ?? 0).toList();
  final x = parts(a), y = parts(b);
  for (var i = 0; i < 3; i++) {
    final p = i < x.length ? x[i] : 0, q = i < y.length ? y[i] : 0;
    if (p != q) return p < q ? -1 : 1;
  }
  return 0;
}
