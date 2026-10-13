import 'dart:async';
import 'dart:io';

import 'client.dart';

/// The relay's default port (the desktop app hosts it).
const int kfRelayPort = 8790;

/// `ws://<host>:<port>/app?name=<app>&platform=<os>`: where an app joins the local relay.
Uri relayAppUrl({String host = '127.0.0.1', int port = kfRelayPort, required String app, required String platform}) =>
    Uri(scheme: 'ws', host: host, port: port, path: '/app', queryParameters: {'name': app, 'platform': platform});

/// The host an app connects to: `--dart-define=KEYFRAMER_HOST=192.168.1.20` for a physical device,
/// else the Android emulator's alias for the Mac, else this machine.
String defaultRelayHost() {
  const defined = String.fromEnvironment('KEYFRAMER_HOST');
  if (defined.isNotEmpty) return defined;
  return Platform.isAndroid ? '10.0.2.2' : '127.0.0.1';
}

int defaultRelayPort() => const int.fromEnvironment('KEYFRAMER_PORT', defaultValue: kfRelayPort);

/// A dart:io WebSocket as a [KfSocket]. Keep-alive is the protocol's own ping (any server answers it),
/// so no non-JSON text frame ever goes over the wire.
class IoKfSocket implements KfSocket {
  IoKfSocket._(this._ws) {
    _ws.listen(
      (data) {
        if (data is String) _controller.add(data);
      },
      onDone: () => _controller.close(),
      onError: (Object e) {
        _controller.addError(e);
        _controller.close();
      },
      cancelOnError: true,
    );
  }

  final WebSocket _ws;
  final _controller = StreamController<String>();

  static Future<KfSocket> connect(Uri url, {Duration pingInterval = const Duration(seconds: 10)}) async {
    final ws = await WebSocket.connect(url.toString()).timeout(const Duration(seconds: 5));
    ws.pingInterval = pingInterval;
    return IoKfSocket._(ws);
  }

  @override
  Stream<String> get messages => _controller.stream;

  @override
  void send(String data) {
    if (_ws.readyState == WebSocket.open) _ws.add(data);
  }

  @override
  Future<void> close() async {
    await _ws.close(WebSocketStatus.normalClosure, 'disconnect');
  }
}

/// The OS this app runs on, as `hello.platform` names it: macos, ios, android, linux, windows.
String currentOs() => Platform.operatingSystem;

/// The OS version where dart:io can tell it (Apple platforms: "26.6.2"); null on Android, where
/// dart:io only knows the kernel's.
String? currentOsVersion() {
  if (Platform.isAndroid) return null;
  final m = RegExp(r'\d+(\.\d+)+').firstMatch(Platform.operatingSystemVersion);
  return m?.group(0);
}
