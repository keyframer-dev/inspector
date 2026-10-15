// End to end over real WebSockets: the app client (dart:io transport) and an editor meet in the
// development relay, as they will in the desktop app's.

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:keyframer_inspector/keyframer_inspector.dart';

import '../tool/relay.dart';
import 'support/fakes.dart';

class Editor {
  Editor._(this.ws) {
    ws.listen((data) {
      if (data is String) {
        received.add((jsonDecode(data) as Map).cast<String, Object?>());
        _changed.add(null);
      }
    });
  }

  final WebSocket ws;
  final List<Map<String, Object?>> received = [];
  final _changed = StreamController<void>.broadcast();

  static Future<Editor> connect(int port) async => Editor._(await WebSocket.connect('ws://127.0.0.1:$port/editor'));

  void send(Map<String, Object?> msg) => ws.add(jsonEncode(msg));

  /// Waits until a received message matches.
  Future<Map<String, Object?>> next(bool Function(Map<String, Object?>) test) async {
    for (var seen = 0; ;) {
      for (; seen < received.length; seen++) {
        if (test(received[seen])) return received[seen];
      }
      await _changed.stream.first.timeout(const Duration(seconds: 5));
    }
  }
}

void main() {
  test('app and editor meet in the relay: hello, catalog, record, samples, playback, presence', () async {
    final relay = await KfRelay.start(port: 0);
    final rt = KfRuntime()..appPackage = 'demo';
    final card = TestValue('cardX');
    rt.register(card.signal);
    final host = FakeHost();
    final client = KfInspectorClient(
      url: relayAppUrl(port: relay.port, app: 'Demo', platform: 'macos'),
      platform: 'macos',
      connector: (u) => IoKfSocket.connect(u),
      app: 'Demo',
      host: host,
      runtime: rt,
    )..start();

    // The app joins first; the editor learns about it from the relay's copy of its hello.
    await Future<void>.delayed(const Duration(milliseconds: 200));
    expect(client.connected, isTrue);
    final editor = await Editor.connect(relay.port);
    editor.send({'type': 'hello', 'role': 'editor'});
    final hello = await editor.next((m) => m['type'] == 'hello');
    expect(hello['platform'], 'macos');
    expect(hello['framework'], 'flutter');
    expect(hello['app'], 'Demo');
    final catalog = await editor.next((m) => m['type'] == 'events');
    expect((catalog['events'] as List).single, containsPair('kind', 'signal'));

    editor.send({
      'type': 'record',
      'signalIds': ['*'],
      'on': true,
    });
    await Future<void>.delayed(const Duration(milliseconds: 100));
    for (var i = 0; i < 5; i++) {
      card.value = i.toDouble();
      host.onFrame!();
      await Future<void>.delayed(const Duration(milliseconds: 16));
    }
    final batch = await editor.next((m) => m['type'] == 'samples' && (m['samples'] as List).isNotEmpty);
    expect((batch['samples'] as List).first, containsPair('id', 'lib/main.dart:10:5'));

    editor.send({
      'type': 'playback',
      'samples': [
        {'id': 'lib/main.dart:10:5', 't': 0, 'v': 0.25},
        {'id': 'lib/main.dart:10:5', 't': 50, 'v': 0.75},
      ],
    });
    await Future<void>.delayed(const Duration(milliseconds: 200));
    expect(card.writes, [0.25, 0.75]);
    expect(card.ended, 1);

    await client.dispose();
    final gone = await editor.next((m) => m['type'] == 'presence' && m['app'] == false);
    expect(gone['editors'], 1);
    await editor.ws.close();
    await relay.close();
  });

  test('the app keeps trying until the relay is up', () async {
    // A free port with nothing on it yet.
    final probe = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    final port = probe.port;
    await probe.close();
    final client = KfInspectorClient(
      url: relayAppUrl(port: port, app: 'Late', platform: 'macos'),
      platform: 'macos',
      connector: (u) => IoKfSocket.connect(u),
      app: 'Late',
      runtime: KfRuntime(),
    )..start();
    await Future<void>.delayed(const Duration(milliseconds: 300));
    expect(client.connected, isFalse);
    final relay = await KfRelay.start(port: port);
    final editor = await Editor.connect(port);
    final hello = await editor.next((m) => m['type'] == 'hello');
    expect(hello['app'], 'Late');
    await client.dispose();
    await editor.ws.close();
    await relay.close();
  });
}
