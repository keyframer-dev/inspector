// The wire protocol, mirrored from protocol/inspector.ts. Every class here serialises to
// exactly the JSON shape of its TypeScript counterpart (test/protocol_test.dart checks the goldens,
// and tool/check_goldens.ts type-checks those goldens against the TS types).

/// Threads are named by role (`InspectorThread`): `js` is the app thread, `ui` the frame thread. A
/// Flutter app's UI isolate (app code, build, animation ticks) is `js`, its raster thread `ui`.
const String kfDartThread = 'js';
const String kfRasterThread = 'ui';

/// The protocol version this SDK speaks, and the SDK itself (keep in step with pubspec.yaml).
const int kfProtocolVersion = 1;
const String kfSdkName = 'keyframer_inspector';
const String kfSdkVersion = '0.1.1';

/// What the two threads are called here (`InspectorThreads`): animations tick on the UI isolate.
const Map<String, Object?> kfThreads = {
  'js': {'label': 'UI isolate', 'animates': true},
  'ui': {'label': 'Raster'},
};

/// A numeric argument the panel can show and tune live (`InspectorParam`).
class KfParam {
  const KfParam(this.path, this.value);

  /// Argument index, then object keys: `1.duration` is the config's duration.
  final String path;
  final num value;

  Map<String, Object?> toJson() => {'path': path, 'value': value};
}

/// One animation call site (`InspectorCallSite`).
class KfCallSite {
  const KfCallSite({
    required this.id,
    required this.file,
    required this.line,
    required this.column,
    required this.fn,
    this.component,
    this.target,
    this.prop,
    this.params = const [],
  });

  final String id;
  final String file;
  final int line;
  final int column;

  /// forward, reverse, animateTo, animateBack, repeat, fling, animateWith.
  final String fn;
  final String? component;

  /// The animated value's name (the controller's).
  final String? target;
  final String? prop;
  final List<KfParam> params;

  Map<String, Object?> toJson() => {
    'id': id,
    'file': file,
    'line': line,
    'column': column,
    'fn': fn,
    'component': component,
    'target': target,
    'prop': prop,
    'params': [for (final p in params) p.toJson()],
  };
}

/// One animated value (`InspectorSignalSite`): what recording samples and playback writes.
class KfSignalSite {
  const KfSignalSite({
    required this.id,
    required this.file,
    required this.line,
    this.column,
    this.component,
    this.name,
  });

  final String id;
  final String file;
  final int line;

  /// Absent when the stack had none (AOT prints file:line only).
  final int? column;
  final String? component;
  final String? name;

  Map<String, Object?> toJson() => {
    'id': id,
    'file': file,
    'line': line,
    if (column != null) 'column': column,
    'component': component,
    'name': name,
  };
}

/// A value sampled while recording (`InspectorSample`). `t` is ms on the recording's clock.
class KfSample {
  const KfSample(this.id, this.t, this.v);

  final String id;
  final num t;
  final double v;

  Map<String, Object?> toJson() => {'id': id, 't': t, 'v': v};

  static KfSample? fromJson(Object? json) {
    if (json is! Map) return null;
    final id = json['id'], t = json['t'], v = json['v'];
    if (id is! String || t is! num || v is! num) return null;
    return KfSample(id, t, v.toDouble());
  }
}

/// How smoothly a thread ran over the window that ended at `t` (`InspectorFrameStat`).
class KfFrameStat {
  const KfFrameStat({required this.t, required this.thread, required this.fps, required this.dropped});

  final num t;
  final String thread;
  final int fps;
  final int dropped;

  KfFrameStat at(num t) => KfFrameStat(t: t, thread: thread, fps: fps, dropped: dropped);

  Map<String, Object?> toJson() => {'t': t, 'thread': thread, 'fps': fps, 'dropped': dropped};
}

/// One long frame (`InspectorFrameDrop`).
class KfFrameDrop {
  const KfFrameDrop({required this.t, required this.thread, required this.ms, required this.dropped});

  final num t;
  final String thread;
  final num ms;
  final int dropped;

  KfFrameDrop at(num t) => KfFrameDrop(t: t, thread: thread, ms: ms, dropped: dropped);

  Map<String, Object?> toJson() => {'t': t, 'thread': thread, 'ms': ms, 'dropped': dropped};
}

/// A screen the app was on (`InspectorRoute`).
class KfRoute {
  const KfRoute(this.t, this.route, [this.params]);

  final num t;
  final String route;
  final Map<String, Object?>? params;

  static KfRoute? fromJson(Object? json) {
    if (json is! Map) return null;
    final t = json['t'], route = json['route'], params = json['params'];
    if (t is! num || route is! String) return null;
    return KfRoute(t, route, params is Map ? params.cast<String, Object?>() : null);
  }
}

/// `InspectorMarker`: only the kinds a Flutter app sends today.
abstract final class KfMarker {
  static Map<String, Object?> touch({
    required num t,
    required String phase,
    required int id,
    required num x,
    required num y,
    bool lost = false,
  }) => {'kind': 'touch', 't': t, 'phase': phase, 'id': id, 'x': x, 'y': y, if (lost) 'lost': true};

  static Map<String, Object?> navigation({required num t, required String route, Map<String, Object?>? params}) => {
    'kind': 'navigation',
    't': t,
    'route': route,
    if (params != null) 'params': params,
  };

  static Map<String, Object?> appState({required num t, required String state}) => {
    'kind': 'appState',
    't': t,
    'state': state,
  };

  static Map<String, Object?> note({required num t, required String text}) => {'kind': 'note', 't': t, 'text': text};
}

/// `InspectorEvent`s, as JSON maps.
abstract final class KfEvent {
  static Map<String, Object?> anim({
    required int eid,
    required KfCallSite site,
    required int at,
    required List<Object?> args,
    String thread = kfDartThread,
    num? t,
    String? stack,
    List<Map<String, Object?>>? frames,
    num? durationMs,
  }) => {
    'kind': 'anim',
    'eid': eid,
    'site': site.toJson(),
    'at': at,
    'args': args,
    'thread': thread,
    if (t != null) 't': t,
    if (stack != null) 'stack': stack,
    if (frames != null) 'frames': frames,
    if (durationMs != null) 'durationMs': durationMs,
  };

  static Map<String, Object?> signal(KfSignalSite site) => {'kind': 'signal', 'site': site.toJson()};

  static Map<String, Object?> unsignal(String id) => {'kind': 'unsignal', 'id': id};
}

/// The screen in points and its pixel scale.
class KfScreen {
  const KfScreen(this.width, this.height, this.scale);

  final num width;
  final num height;
  final num scale;

  Map<String, Object?> toJson() => {'width': width, 'height': height, 'scale': scale};
}

/// `InspectorAppMessage`s, as JSON maps.
abstract final class KfAppMessage {
  /// `platform` is the OS ("macos", "ios", "android"); the framework is always flutter.
  static Map<String, Object?> hello({
    required String app,
    required String platform,
    String? osVersion,
    String? build,
    required bool capture,
    KfScreen? screen,
    required List<String> scenarios,
    required List<String> capabilities,
    String? root,
  }) => {
    'type': 'hello',
    'role': 'app',
    'app': app,
    'platform': platform,
    'capture': capture,
    if (screen != null) 'screen': screen.toJson(),
    'scenarios': scenarios,
    'protocol': kfProtocolVersion,
    'sdk': {'name': kfSdkName, 'version': kfSdkVersion},
    'framework': 'flutter',
    if (osVersion != null) 'osVersion': osVersion,
    if (build != null) 'build': build,
    'threads': kfThreads,
    'capabilities': capabilities,
    if (root != null && root.isNotEmpty) 'root': root,
  };

  static Map<String, Object?> events(List<Map<String, Object?>> events) => {'type': 'events', 'events': events};

  static Map<String, Object?> samples({
    required List<KfSample> samples,
    List<KfFrameStat> frames = const [],
    List<KfFrameDrop> drops = const [],
    List<Map<String, Object?>> markers = const [],
  }) => {
    'type': 'samples',
    'samples': [for (final s in samples) s.toJson()],
    if (frames.isNotEmpty) 'frames': [for (final f in frames) f.toJson()],
    if (drops.isNotEmpty) 'drops': [for (final d in drops) d.toJson()],
    if (markers.isNotEmpty) 'markers': markers,
  };

  static Map<String, Object?> scenarios(List<String> names) => {'type': 'scenarios', 'names': names};

  static Map<String, Object?> scenarioDone({required String name, required int ms, String? error}) => {
    'type': 'scenarioDone',
    'name': name,
    'ms': ms,
    if (error != null) 'error': error,
  };

  /// `format` says what `data` is, which may differ from what was asked (Flutter encodes PNG only).
  static Map<String, Object?> frame({required String id, String? data, String? format, String? error}) => {
    'type': 'frame',
    'id': id,
    if (data != null) 'data': data,
    if (format != null) 'format': format,
    if (error != null) 'error': error,
  };
}
