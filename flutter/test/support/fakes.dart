import 'dart:async';
import 'dart:convert';

import 'package:keyframer_inspector/keyframer_inspector.dart';

/// A socket the test drives: what the app sent, and messages delivered as if from an editor.
class FakeSocket implements KfSocket {
  FakeSocket(this.url);

  final Uri url;
  final List<Map<String, Object?>> sent = [];
  final _incoming = StreamController<String>();
  bool closed = false;

  @override
  Stream<String> get messages => _incoming.stream;

  @override
  void send(String data) => sent.add((jsonDecode(data) as Map).cast<String, Object?>());

  @override
  Future<void> close() async {
    closed = true;
    await _incoming.close();
  }

  void receive(Map<String, Object?> msg) => _incoming.add(jsonEncode(msg));

  /// The relay went away.
  void drop() => _incoming.close();

  List<Map<String, Object?>> ofType(String type) => sent.where((m) => m['type'] == type).toList();

  List<Map<String, Object?>> get events => [
    for (final m in ofType('events')) ...(m['events'] as List).cast<Map<String, Object?>>(),
  ];
}

class FakeConnector {
  final List<FakeSocket> sockets = [];
  bool fail = false;

  Future<KfSocket> call(Uri url) async {
    if (fail) throw StateError('relay down');
    final s = FakeSocket(url);
    sockets.add(s);
    return s;
  }

  FakeSocket get last => sockets.last;
}

/// A host the test drives: frames, timings and touches happen when the test says.
class FakeHost implements KfHost {
  void Function()? onFrame;
  void Function(List<KfTiming>)? onTimings;
  void Function(KfTouch)? onTouch;
  int captures = 0;

  @override
  KfScreen? get screen => const KfScreen(390, 844, 3);

  @override
  bool get canCapture => true;

  @override
  double get refreshRate => 60;

  @override
  void Function() frames(void Function() fn) {
    onFrame = fn;
    return () => onFrame = null;
  }

  @override
  void Function() timings(void Function(List<KfTiming>) fn) {
    onTimings = fn;
    return () => onTimings = null;
  }

  @override
  void Function() touches(void Function(KfTouch) fn) {
    onTouch = fn;
    return () => onTouch = null;
  }

  @override
  Future<void> nextFrame() => Future.value();

  @override
  Future<String> capture({double? width}) async {
    captures++;
    return 'iVBORw0KGgo=';
  }
}

/// A signal backed by a plain variable, with playback hooks counted.
class TestValue {
  TestValue(
    String name, {
    String uri = 'package:demo/main.dart',
    int line = 10,
    String member = '_CardState.initState',
  }) {
    signal = KfSignal(
      read: () => value,
      write: (v) {
        value = v;
        writes.add(v);
      },
      name: name,
      frame: KfStackFrame(member, uri, line, 5),
      beginPlayback: () => began++,
      endPlayback: () => ended++,
    );
  }

  double value = 0;
  final List<double> writes = [];
  int began = 0;
  int ended = 0;
  late final KfSignal signal;
}

/// A host with what newer SDK versions ask of it: the display and motion settings, the animation clock
/// and the widget tree. [FakeHost] alone stands for a host written before them.
class FakeFullHost extends FakeHost implements KfDeviceHost, KfTimeHost, KfSceneHost {
  KfDisplay? displayNow = const KfDisplay(120, adaptive: true);
  KfAccessibility? accessibilityNow = const KfAccessibility(reduceMotion: false);
  String? appStateNow = 'active';
  void Function()? onDeviceChange;

  double scale = 1;
  final List<double> scales = [];
  final List<int> steps = [];

  void Function(String id, bool visible, String? reason)? onVisibility;
  void Function(KfRenderHint hint)? onHint;
  int scenes = 0;
  bool sites = true;

  @override
  bool get widgetSites => sites;

  @override
  KfDisplay? get display => displayNow;

  @override
  KfAccessibility? get accessibility => accessibilityNow;

  @override
  String? get appState => appStateNow;

  @override
  void Function() watchDevice(void Function() onChange) {
    onDeviceChange = onChange;
    return () => onDeviceChange = null;
  }

  @override
  double setTimeScale(double s) {
    scale = s < 0 ? 1 : s;
    scales.add(scale);
    return scale;
  }

  @override
  void stepFrames(int frames) => steps.add(frames);

  @override
  void Function() watchScene(
    KfRuntime runtime, {
    required void Function(String id, bool visible, String? reason) onVisibility,
    required void Function(KfRenderHint hint) onHint,
  }) {
    this.onVisibility = onVisibility;
    this.onHint = onHint;
    scenes++;
    return () {
      this.onVisibility = null;
      this.onHint = null;
    };
  }
}
