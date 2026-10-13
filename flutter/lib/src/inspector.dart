import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';

import 'client.dart';
import 'controller.dart';
import 'flutter_host.dart';
import 'runtime.dart';
import 'transport.dart';

/// On in debug and profile builds. A release build connects only when built with
/// `--dart-define=KEYFRAMER_INSPECTOR=true` or when `enabled: true` is passed.
bool get kfInspectorDefaultEnabled => !kReleaseMode || const bool.fromEnvironment('KEYFRAMER_INSPECTOR');

/// Connects this app to the Keyframer relay (`ws://<host>:8790/app`) and returns what disconnects it.
/// [KeyframerInspector] calls it for you; call it yourself to connect without the widget (no capture).
///
/// `appPackage` is your pubspec `name`, so call sites read `lib/main.dart:42` instead of
/// `package:my_app/main.dart:42`.
KfInspectorConnection connectKeyframerInspector({
  required String app,
  String? appPackage,
  String? root,
  String? host,
  int? port,
  bool? enabled,
  GlobalKey? captureBoundary,
  KfConnector? connector,
}) {
  if (!(enabled ?? kfInspectorDefaultEnabled)) return const KfInspectorConnection._(null);
  // A release build that opted in reports call sites too (as far as its stacks allow).
  kfCaptureSites = true;
  final rt = KfRuntime.instance;
  if (appPackage != null) rt.appPackage = appPackage;
  if (root != null) rt.root = root;
  final os = currentOs();
  final url = relayAppUrl(host: host ?? defaultRelayHost(), port: port ?? defaultRelayPort(), app: app, platform: os);
  late final KfInspectorClient client;
  client = KfInspectorClient(
    url: url,
    app: app,
    platform: os,
    osVersion: currentOsVersion(),
    host: FlutterKfHost(boundary: captureBoundary),
    connector: connector ?? (u) => IoKfSocket.connect(u, pingInterval: client.pingInterval),
  )..start();
  return KfInspectorConnection._(client);
}

/// A live connection (or none, when the inspector is off).
class KfInspectorConnection {
  const KfInspectorConnection._(this.client);

  final KfInspectorClient? client;

  bool get enabled => client != null;
  Future<void> disconnect() async => client?.dispose();
}

/// Wrap your app in it: connects to the relay while mounted (debug and profile builds), and puts the
/// RepaintBoundary that exports snapshot around everything.
///
/// ```dart
/// runApp(KeyframerInspector(app: 'My app', appPackage: 'my_app', child: MyApp()));
/// ```
/// and add `navigatorObservers: [kfNavigatorObserver]` to your MaterialApp.
class KeyframerInspector extends StatefulWidget {
  const KeyframerInspector({
    super.key,
    required this.app,
    required this.child,
    this.appPackage,
    this.root,
    this.host,
    this.port,
    this.enabled,
  });

  final String app;
  final Widget child;
  final String? appPackage;
  final String? root;

  /// The relay's host: the Mac's LAN IP for a physical device. Defaults to `KEYFRAMER_HOST`, then
  /// 10.0.2.2 on Android, then 127.0.0.1.
  final String? host;
  final int? port;
  final bool? enabled;

  @override
  State<KeyframerInspector> createState() => _KeyframerInspectorState();
}

class _KeyframerInspectorState extends State<KeyframerInspector> {
  final _boundary = GlobalKey(debugLabel: 'keyframer capture');
  KfInspectorConnection? _connection;

  @override
  void initState() {
    super.initState();
    _connection = connectKeyframerInspector(
      app: widget.app,
      appPackage: widget.appPackage,
      root: widget.root,
      host: widget.host,
      port: widget.port,
      enabled: widget.enabled,
      captureBoundary: _boundary,
    );
  }

  @override
  void dispose() {
    _connection?.disconnect();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => RepaintBoundary(key: _boundary, child: widget.child);
}

/// What `replay` from an editor runs (re-mount a screen, re-fire an entrance). Returns the unregister.
void Function() registerReplay(void Function() fn) {
  final rt = KfRuntime.instance;
  rt.replay = fn;
  return () {
    if (identical(rt.replay, fn)) rt.replay = null;
  };
}

/// A named interaction an editor or agent can run to reproduce a problem. Returns the unregister.
void Function() registerScenario(String name, Future<void> Function() run) =>
    KfRuntime.instance.registerScenario(name, run);
