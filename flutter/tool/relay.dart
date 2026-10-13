// A stand-in for the desktop app's local relay, for development and tests:
//
//   dart run tool/relay.dart [--lan] [--port 8790] [--verbose]
//
// Apps connect to /app?name=<app>&platform=<platform>, panels and CLIs to /editor. Every text frame
// is one JSON InspectorMessage, forwarded app → editors and editor → app. Like the API's pairing room
// it sends `presence` to everyone on each join and leave, keeps one app (a new one replaces it), and
// answers a text `ping` with `pong`. It also keeps the app's last hello and hands it to each editor
// that joins later, which the room does not need to (its editors join first).

import 'dart:async';
import 'dart:convert';
import 'dart:io';

class KfRelay {
  KfRelay._(this._server, {this.verbose = false});

  final HttpServer _server;
  final bool verbose;
  WebSocket? _app;
  String? _appHello;
  final Set<WebSocket> _editors = {};

  int get port => _server.port;

  static Future<KfRelay> start({int port = 8790, bool lan = false, bool verbose = false}) async {
    final server = await HttpServer.bind(lan ? InternetAddress.anyIPv4 : InternetAddress.loopbackIPv4, port);
    final relay = KfRelay._(server, verbose: verbose);
    server.listen(relay._onRequest);
    return relay;
  }

  Future<void> _onRequest(HttpRequest req) async {
    final path = req.uri.path;
    if ((path != '/app' && path != '/editor') || !WebSocketTransformer.isUpgradeRequest(req)) {
      req.response
        ..statusCode = HttpStatus.notFound
        ..write('Keyframer relay: connect a WebSocket to /app or /editor.');
      await req.response.close();
      return;
    }
    final ws = await WebSocketTransformer.upgrade(req);
    if (path == '/app') {
      final old = _app;
      _app = ws;
      _appHello = null;
      if (old != null) unawaited(old.close(4000, 'replaced'));
      _log('app joined: ${req.uri.queryParameters['name']} (${req.uri.queryParameters['platform']})');
      ws.listen((data) => _fromApp(ws, data), onDone: () => _left(ws));
    } else {
      _editors.add(ws);
      _log('editor joined (${_editors.length})');
      if (_appHello != null) _put(ws, _appHello!);
      ws.listen((data) => _fromEditor(ws, data), onDone: () => _left(ws));
    }
    _presence();
  }

  void _fromApp(WebSocket ws, Object? data) {
    if (data is! String || !identical(ws, _app)) return;
    if (data == 'ping') return _put(ws, 'pong');
    final type = _type(data);
    if (type == null) return;
    if (type == 'hello') _appHello = data;
    if (verbose) _log('app → editors: $type (${data.length} B)');
    for (final e in _editors.toList()) {
      _put(e, data);
    }
  }

  void _fromEditor(WebSocket ws, Object? data) {
    if (data is! String) return;
    if (data == 'ping') return _put(ws, 'pong');
    final type = _type(data);
    // An editor's hello is for the relay: presence already told the app.
    if (type == null || type == 'hello') return;
    if (verbose) _log('editor → app: $type (${data.length} B)');
    final app = _app;
    if (app != null) _put(app, data);
  }

  void _left(WebSocket ws) {
    if (identical(ws, _app)) {
      _app = null;
      _appHello = null;
      _log('app left');
    } else if (_editors.remove(ws)) {
      _log('editor left (${_editors.length})');
    }
    _presence();
  }

  void _presence() {
    final msg = jsonEncode({'type': 'presence', 'app': _app != null, 'editors': _editors.length, 'cli': false});
    final app = _app;
    if (app != null) _put(app, msg);
    for (final e in _editors.toList()) {
      _put(e, msg);
    }
  }

  /// Sends unless that socket is closing: one going away must not take the relay down.
  static void _put(WebSocket ws, String data) {
    if (ws.closeCode != null || ws.readyState != WebSocket.open) return;
    try {
      ws.add(data);
    } catch (_) {}
  }

  static String? _type(String data) {
    try {
      final m = jsonDecode(data);
      return m is Map && m['type'] is String ? m['type'] as String : null;
    } catch (_) {
      return null;
    }
  }

  void _log(String s) => stdout.writeln('[relay] $s');

  Future<void> close() async {
    final sockets = [if (_app != null) _app!, ..._editors];
    _app = null;
    _editors.clear();
    for (final s in sockets) {
      await s.close();
    }
    await _server.close(force: true);
  }
}

Future<void> main(List<String> args) async {
  final i = args.indexOf('--port');
  final port = i >= 0 && i + 1 < args.length ? int.parse(args[i + 1]) : 8790;
  final relay = await KfRelay.start(port: port, lan: args.contains('--lan'), verbose: args.contains('--verbose'));
  stdout.writeln('[relay] listening on ws://${args.contains('--lan') ? '0.0.0.0' : '127.0.0.1'}:${relay.port} (/app, /editor)');
}
