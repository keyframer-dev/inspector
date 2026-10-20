// Where an app finds the relay and how it connects. The socket itself is the platform's: dart:io's
// WebSocket on iOS, Android and desktop (transport_io.dart), the browser's on the web
// (transport_web.dart), picked at compile time so a web build never imports dart:io.

import 'client.dart';
import 'transport_io.dart' if (dart.library.js_interop) 'transport_web.dart' as platform;

export 'transport_io.dart'
    if (dart.library.js_interop) 'transport_web.dart'
    show IoKfSocket, currentOs, currentOsVersion, currentDevice;

/// The relay's default port (the desktop app hosts it).
const int kfRelayPort = 8790;

/// `ws://<host>:<port>/app?name=<app>&platform=<os>`: where an app joins the local relay.
Uri relayAppUrl({String host = '127.0.0.1', int port = kfRelayPort, required String app, required String platform}) =>
    Uri(scheme: 'ws', host: host, port: port, path: '/app', queryParameters: {'name': app, 'platform': platform});

/// The host an app connects to: `--dart-define=KEYFRAMER_HOST=192.168.1.20` for a physical device,
/// else the Android emulator's alias for the Mac, else (on the web) the page's own host when it is
/// served from this machine or the LAN, else this machine.
String defaultRelayHost() {
  const defined = String.fromEnvironment('KEYFRAMER_HOST');
  if (defined.isNotEmpty) return defined;
  return platform.platformRelayHost();
}

int defaultRelayPort() => const int.fromEnvironment('KEYFRAMER_PORT', defaultValue: kfRelayPort);

/// Connects to the relay with this platform's WebSocket (dart:io's, or the browser's on the web).
Future<KfSocket> connectRelaySocket(Uri url, {Duration pingInterval = const Duration(seconds: 10)}) =>
    platform.IoKfSocket.connect(url, pingInterval: pingInterval);
