import 'transport_stub.dart' if (dart.library.io) 'transport_io.dart' as impl;

/// A response the reporter reads: the status and the body as text (empty on a network error, status 0).
class VitalsHttpResponse {
  const VitalsHttpResponse(this.status, this.body);

  final int status;
  final String body;
}

/// How reports and config travel. The default uses dart:io's HttpClient; tests pass a fake.
abstract class VitalsTransport {
  /// POSTs `json` to `url`, gzipped where the platform can.
  Future<VitalsHttpResponse> post(Uri url, String json, {required String key});

  Future<VitalsHttpResponse> get(Uri url);

  /// dart:io's HttpClient, or null on the web (no reporter there in version 1).
  static VitalsTransport? platform() => impl.platformTransport();
}

/// What the device says about itself without plugins. Null on platforms the reporter does not cover.
class PlatformFacts {
  const PlatformFacts({required this.os, required this.osVersion});

  /// `ios` or `android`.
  final String os;

  /// `Platform.operatingSystemVersion`.
  final String osVersion;

  static PlatformFacts? current() => impl.platformFacts();
}
