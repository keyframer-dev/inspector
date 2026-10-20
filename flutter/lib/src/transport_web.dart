// The relay connection on the web: the browser's WebSocket, through package:web, so a web build never
// imports dart:io.

import 'dart:async';
import 'dart:js_interop';

import 'package:web/web.dart' as web;

import 'client.dart';
import 'protocol.dart';

/// The page's own host when it is served from this machine or the local network (`flutter run -d
/// chrome`, or a phone's browser on the Mac's address): the relay runs beside the dev server. A page
/// served from anywhere else connects to this machine.
String platformRelayHost() {
  try {
    final host = web.window.location.hostname;
    if (_isLocal(host)) return host;
  } catch (_) {
    // Not in a window (a worker): this machine.
  }
  return '127.0.0.1';
}

bool _isLocal(String host) {
  if (host == 'localhost' || host.endsWith('.local')) return true;
  final parts = host.split('.').map(int.tryParse).toList();
  if (parts.length != 4 || parts.contains(null)) return false;
  final a = parts[0]!, b = parts[1]!;
  return a == 127 || a == 10 || (a == 192 && b == 168) || (a == 172 && b >= 16 && b <= 31);
}

/// On the web, the browser's WebSocket as a [KfSocket] (the class keeps its dart:io name, so code that
/// names it builds for every platform). A browser cannot send WebSocket pings, so keep-alive is the
/// relay's text `ping`, answered with `pong`; the socket closes when nothing arrives for three intervals.
class IoKfSocket implements KfSocket {
  IoKfSocket._(this._ws, Duration pingInterval) {
    _ws.onmessage =
        ((web.MessageEvent e) {
          _lastSeen = DateTime.now();
          final data = e.data;
          if (data != null && data.typeofEquals('string')) {
            final text = (data as JSString).toDart;
            // The keep-alive's answer is not a protocol message.
            if (text != 'pong') _controller.add(text);
          }
        }).toJS;
    _ws.onclose = ((web.Event _) => _done()).toJS;
    _ws.onerror =
        ((web.Event _) {
          if (!_controller.isClosed) _controller.addError(StateError('The relay connection failed.'));
          _done();
        }).toJS;
    _ping = Timer.periodic(pingInterval, (_) {
      if (DateTime.now().difference(_lastSeen) > pingInterval * 3) {
        _ws.close();
        _done();
        return;
      }
      send('ping');
    });
  }

  final web.WebSocket _ws;
  final _controller = StreamController<String>();
  DateTime _lastSeen = DateTime.now();
  Timer? _ping;

  static Future<KfSocket> connect(Uri url, {Duration pingInterval = const Duration(seconds: 10)}) async {
    final ws = web.WebSocket(url.toString());
    final opened = Completer<void>();
    ws.onopen =
        ((web.Event _) {
          if (!opened.isCompleted) opened.complete();
        }).toJS;
    void failed(web.Event _) {
      if (!opened.isCompleted) opened.completeError(StateError('Could not reach the relay at $url.'));
    }

    ws.onerror = failed.toJS;
    ws.onclose = failed.toJS;
    try {
      await opened.future.timeout(const Duration(seconds: 5));
    } catch (_) {
      ws.close();
      rethrow;
    }
    return IoKfSocket._(ws, pingInterval);
  }

  void _done() {
    _ping?.cancel();
    _ping = null;
    if (!_controller.isClosed) _controller.close();
  }

  @override
  Stream<String> get messages => _controller.stream;

  @override
  void send(String data) {
    if (_ws.readyState == web.WebSocket.OPEN) _ws.send(data.toJS);
  }

  @override
  Future<void> close() async {
    _ws.close(1000, 'disconnect');
    _done();
  }
}

/// The OS, as `hello.platform` names it: always `web` here.
String currentOs() => 'web';

/// A browser does not say which OS version it runs on.
String? currentOsVersion() => null;

/// A browser says nothing worth telling apps apart by: no device.
Future<KfDevice?> currentDevice() async => null;
