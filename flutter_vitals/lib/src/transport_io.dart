import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'transport.dart';

VitalsTransport? platformTransport() => _IoTransport();

PlatformFacts? platformFacts() {
  if (Platform.isIOS) return PlatformFacts(os: 'ios', osVersion: Platform.operatingSystemVersion);
  if (Platform.isAndroid) return PlatformFacts(os: 'android', osVersion: Platform.operatingSystemVersion);
  return null;
}

class _IoTransport implements VitalsTransport {
  static const _timeout = Duration(seconds: 15);

  HttpClient _client() =>
      HttpClient()
        ..connectionTimeout = _timeout
        ..idleTimeout = const Duration(seconds: 1)
        ..userAgent = 'keyframer_vitals';

  @override
  Future<VitalsHttpResponse> post(Uri url, String json, {required String key}) async {
    final client = _client();
    try {
      final req = await client.postUrl(url).timeout(_timeout);
      req.headers
        ..set(HttpHeaders.authorizationHeader, 'Bearer $key')
        ..set(HttpHeaders.contentTypeHeader, 'application/json')
        ..set(HttpHeaders.contentEncodingHeader, 'gzip');
      req.add(gzip.encode(utf8.encode(json)));
      return await _read(await req.close().timeout(_timeout));
    } catch (_) {
      return const VitalsHttpResponse(0, '');
    } finally {
      client.close();
    }
  }

  @override
  Future<VitalsHttpResponse> get(Uri url) async {
    final client = _client();
    try {
      final req = await client.getUrl(url).timeout(_timeout);
      return await _read(await req.close().timeout(_timeout));
    } catch (_) {
      return const VitalsHttpResponse(0, '');
    } finally {
      client.close();
    }
  }

  Future<VitalsHttpResponse> _read(HttpClientResponse res) async {
    // Config answers are small; anything bigger is not ours.
    final bytes = <int>[];
    await for (final chunk in res.timeout(_timeout)) {
      bytes.addAll(chunk);
      if (bytes.length > 64 * 1024) break;
    }
    return VitalsHttpResponse(res.statusCode, utf8.decode(bytes, allowMalformed: true));
  }
}
