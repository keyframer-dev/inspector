import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:keyframer_vitals/src/transport.dart';

void main() {
  test('posts gzipped JSON with the field key, and reads the answer', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final seen = <String, Object?>{};
    server.listen((req) async {
      final bytes = await req.fold<List<int>>([], (a, b) => a..addAll(b));
      seen['method'] = req.method;
      seen['path'] = req.uri.path;
      seen['auth'] = req.headers.value(HttpHeaders.authorizationHeader);
      seen['encoding'] = req.headers.value(HttpHeaders.contentEncodingHeader);
      seen['type'] = req.headers.contentType?.mimeType;
      seen['body'] = req.method == 'POST' ? utf8.decode(gzip.decode(bytes)) : '';
      req.response
        ..statusCode = req.method == 'POST' ? 200 : 304
        ..write('{"ok":true}');
      await req.response.close();
    });
    try {
      final t = VitalsTransport.platform()!;
      final base = 'http://127.0.0.1:${server.port}';
      final res = await t.post(Uri.parse('$base/v1/reports'), '{"format":"keyframer-vitals"}', key: 'kfp_live_x');
      expect(res.status, 200);
      expect(res.body, '{"ok":true}');
      expect(seen, {
        'method': 'POST',
        'path': '/v1/reports',
        'auth': 'Bearer kfp_live_x',
        'encoding': 'gzip',
        'type': 'application/json',
        'body': '{"format":"keyframer-vitals"}',
      });
      final get = await t.get(Uri.parse('$base/v1/config/kfp_live_x'));
      expect(get.status, 304);
      expect(seen['path'], '/v1/config/kfp_live_x');
    } finally {
      await server.close(force: true);
    }
  });

  test('a network error is status 0, never an exception', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final port = server.port;
    await server.close(force: true);
    final res = await VitalsTransport.platform()!.post(Uri.parse('http://127.0.0.1:$port/v1/reports'), '{}', key: 'k');
    expect(res.status, 0);
  });

  test('the host is not iOS or Android: no platform facts (the reporter stays off)', () {
    expect(PlatformFacts.current(), isNull);
  });
}
