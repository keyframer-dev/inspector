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
const String kfSdkVersion = '0.2.0';

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
    this.writable = true,
    this.prop,
  });

  final String id;
  final String file;
  final int line;

  /// Absent when the stack had none (AOT prints file:line only).
  final int? column;
  final String? component;
  final String? name;

  /// The property it animates, when known: an implicit animation's ('opacity', 'scale', 'position').
  final String? prop;

  /// False for a value playback cannot write back (an implicit animation's progress, a Hero flight).
  final bool writable;

  Map<String, Object?> toJson() => {
    'id': id,
    'file': file,
    'line': line,
    if (column != null) 'column': column,
    'component': component,
    'name': name,
    if (prop != null) 'prop': prop,
    if (!writable) 'writable': false,
  };
}

/// The screen the app draws on (`InspectorDisplay`): its refresh rate is the frame budget.
class KfDisplay {
  const KfDisplay(this.hz, {this.adaptive = false});

  final num hz;

  /// The rate follows the content (ProMotion, Android's variable refresh): `hz` is the highest it runs at.
  final bool adaptive;

  Map<String, Object?> toJson() => {'hz': hz, if (adaptive) 'adaptive': true};

  @override
  bool operator ==(Object other) => other is KfDisplay && other.hz == hz && other.adaptive == adaptive;

  @override
  int get hashCode => Object.hash(hz, adaptive);
}

/// The person's motion settings (`InspectorAccessibility`): Flutter's `disableAnimations`, or Reduce
/// Motion where the platform reports it.
class KfAccessibility {
  const KfAccessibility({required this.reduceMotion});

  final bool reduceMotion;

  Map<String, Object?> toJson() => {'reduceMotion': reduceMotion};

  @override
  bool operator ==(Object other) => other is KfAccessibility && other.reduceMotion == reduceMotion;

  @override
  int get hashCode => reduceMotion.hashCode;
}

/// The device the app runs on (`InspectorDevice`), so a relay or a CI run can tell two apps apart.
///
/// `id` and `name` are only ever a simulator's or an emulator's (SIMULATOR_UDID and the simulator's
/// name, the AVD's name). A physical device says its `model` and `simulator: false`, never the name its
/// owner gave it: recordings get shared.
class KfDevice {
  const KfDevice({this.name, this.model, this.id, this.simulator});

  final String? name;

  /// `iPhone17,1` (hw.machine), `Pixel 8` (Build.MODEL), `Mac15,3` (hw.model).
  final String? model;
  final String? id;
  final bool? simulator;

  bool get isEmpty => name == null && model == null && id == null && simulator == null;

  Map<String, Object?> toJson() => {
    if (name != null) 'name': name,
    if (model != null) 'model': model,
    if (id != null) 'id': id,
    if (simulator != null) 'simulator': simulator,
  };

  @override
  bool operator ==(Object other) =>
      other is KfDevice && other.name == name && other.model == model && other.id == id && other.simulator == simulator;

  @override
  int get hashCode => Object.hash(name, model, id, simulator);

  @override
  String toString() => 'KfDevice(${toJson()})';
}

/// How an animated widget is drawn, when it costs more than it needs to (`InspectorRenderHint`).
///
/// `hint` is a stable key the problems engine words a fix for. This SDK sends `opacity-widget` (an
/// Opacity whose opacity animates), `blur` (a BackdropFilter or ImageFiltered blur over moving
/// content), `mask` (ClipPath or ShaderMask over animated children) and `save-layer` (a clip with
/// Clip.antiAliasWithSaveLayer over animated children). `id` is the value it belongs to, or the
/// widget's own location when no value is known.
class KfRenderHint {
  const KfRenderHint(this.id, this.hint, [this.detail]);

  final String id;
  final String hint;
  final String? detail;

  Map<String, Object?> toJson() => {'id': id, 'hint': hint, if (detail != null) 'detail': detail};
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

/// `InspectorMarker`: the kinds a Flutter app sends.
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

  /// The person's motion settings changed while recording.
  static Map<String, Object?> accessibility({required num t, required bool reduceMotion}) => {
    'kind': 'accessibility',
    't': t,
    'reduceMotion': reduceMotion,
  };

  /// The display's refresh rate changed while recording.
  static Map<String, Object?> display({required num t, required num hz}) => {'kind': 'display', 't': t, 'hz': hz};

  /// A value's widgets left the screen or came back. `reason`: offscreen, hidden, detached or covered.
  static Map<String, Object?> visibility({required num t, required String id, required bool visible, String? reason}) =>
      {'kind': 'visibility', 't': t, 'id': id, 'visible': visible, if (reason != null) 'reason': reason};

  /// The editor changed the animation speed while recording (0: paused), or, with `step`, advanced that
  /// many frames while paused.
  static Map<String, Object?> time({required num t, required num scale, int? step}) => {
    'kind': 'time',
    't': t,
    'scale': scale,
    if (step != null) 'step': step,
  };
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

  /// `t`, while recording: when it was registered (a screen that mounts again starts a new history).
  static Map<String, Object?> signal(KfSignalSite site, {num? t}) => {
    'kind': 'signal',
    'site': site.toJson(),
    if (t != null) 't': t,
  };

  /// `t`, while recording: when it went away.
  static Map<String, Object?> unsignal(String id, {num? t}) => {'kind': 'unsignal', 'id': id, if (t != null) 't': t};

  static Map<String, Object?> renderHint(KfRenderHint hint) => {'kind': 'renderHint', ...hint.toJson()};
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
    KfDisplay? display,
    KfAccessibility? accessibility,
    KfDevice? device,
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
    if (display != null) 'display': display.toJson(),
    if (accessibility != null) 'accessibility': accessibility.toJson(),
    if (device != null && !device.isEmpty) 'device': device.toJson(),
  };

  /// The app's animation speed now (1 normal, 0 paused): the answer to every `time` message, and sent
  /// after hello when it is not 1.
  static Map<String, Object?> time(num scale) => {'type': 'time', 'scale': scale};

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
