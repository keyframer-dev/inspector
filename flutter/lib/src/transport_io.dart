// The relay connection on iOS, Android and desktop: dart:io's WebSocket.

import 'dart:async';
import 'dart:io';

import 'client.dart';
import 'device.dart';
import 'protocol.dart';
import 'sysctl_io.dart';

/// The Android emulator reaches the Mac at 10.0.2.2; everything else uses this machine.
String platformRelayHost() => Platform.isAndroid ? '10.0.2.2' : '127.0.0.1';

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

/// The device this app runs on (see device.dart for what may be sent): the simulator's environment on
/// iOS, `getprop` on Android, sysctl on Apple hardware, DMI on Linux. Null when nothing can be told.
Future<KfDevice?> currentDevice() async {
  try {
    return await readDevice(
      KfDeviceSources(
        os: Platform.operatingSystem,
        environment: Platform.environment,
        properties: Platform.isAndroid ? _androidProperties : null,
        sysctl: Platform.isIOS || Platform.isMacOS ? darwinSysctl : null,
        executable: Platform.resolvedExecutable,
        readFile: (path) async {
          try {
            return await File(path).readAsString();
          } catch (_) {
            return null;
          }
        },
      ),
    ).timeout(const Duration(seconds: 2));
  } catch (_) {
    return null;
  }
}

/// What an app may read of Android's system properties (getprop lists only those).
Future<Map<String, String>> _androidProperties() async {
  final r = await Process.run('/system/bin/getprop', const []).timeout(const Duration(seconds: 2));
  return r.exitCode == 0 && r.stdout is String ? parseProperties(r.stdout as String) : const {};
}
