import 'dart:convert';
import 'dart:io';

import 'package:keyframer_vitals/src/storage.dart';
import 'package:keyframer_vitals/src/transport.dart';

/// inspector/packages/protocol, from this package's folder.
const protocolDir = '../protocol';

String fixture(String name) => File('$protocolDir/fixtures/vitals/$name').readAsStringSync();

/// A protocol source file: `src/<name>` in this monorepo, `<name>` in the public repository's protocol/.
String protocolSource(String name) {
  final mono = File('$protocolDir/src/$name');
  return mono.existsSync() ? mono.path : '$protocolDir/$name';
}

class FakeTransport implements VitalsTransport {
  final List<String> posts = [];
  final List<Uri> gets = [];

  /// The status of the next posts, in order; then [status].
  final List<int> script = [];
  int status = 200;
  String body =
      '{"ok":true,"config":{"enabled":true,"sampleRate":1,"collect":{"reduceMotion":true,"deviceModel":true,"development":false},"ttlSec":86400}}';
  String configBody =
      '{"enabled":true,"sampleRate":1,"collect":{"reduceMotion":false,"deviceModel":true,"development":false},"ttlSec":86400}';

  @override
  Future<VitalsHttpResponse> post(Uri url, String json, {required String key}) async {
    posts.add(json);
    final st = script.isNotEmpty ? script.removeAt(0) : status;
    return VitalsHttpResponse(st, st == 200 ? body : '');
  }

  @override
  Future<VitalsHttpResponse> get(Uri url) async {
    gets.add(url);
    return VitalsHttpResponse(200, configBody);
  }

  List<Map<String, Object?>> get reports => [for (final p in posts) jsonDecode(p) as Map<String, Object?>];
}

/// In memory, but says it persists: checkpoints are written, and a second reporter on the same store
/// is the next launch.
class PersistentMemoryStorage extends MemoryVitalsStorage {
  @override
  bool get persistent => true;
}
