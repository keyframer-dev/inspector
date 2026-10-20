// Call sites from Dart stack traces: where an animated value was created and where an animation was
// started, without a build step. Debug builds (JIT) print file:line:column; AOT builds (profile,
// release) print file:line with no column. Built with --split-debug-info or --obfuscate, AOT prints
// raw addresses instead: no frames are found and sites fall back to the value's name.

/// One parsed stack frame. `uri` is as Dart prints it: `package:app/main.dart`, `file:///…`, `dart:core`.
class KfStackFrame {
  const KfStackFrame(this.member, this.uri, this.line, this.column);

  final String member;
  final String uri;
  final int line;
  final int column;

  @override
  String toString() => '$member ($uri:$line:$column)';
}

// VM: "#1      _CardState.initState (package:app/main.dart:42:7)", column optional.
final _vmFrame = RegExp(r'^#\d+\s+(.+?) \((.+?):(\d+)(?::(\d+))?\)$');
// package:stack_trace's terse format, used on web: "package:app/main.dart 42:7  _CardState.initState".
final _terseFrame = RegExp(r'^(\S+?) (\d+)(?::(\d+))?\s+(.+)$');
// V8 / dart2js: "    at _CardState.initState (http://…/main.dart:42:7)".
final _v8Frame = RegExp(r'^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$');

/// The frames of a stack trace that point at source. Non-symbolic (split debug info) traces have none.
List<KfStackFrame> parseStackTrace(String trace) {
  final frames = <KfStackFrame>[];
  for (final raw in trace.split('\n')) {
    final line = raw.trimRight();
    if (line.isEmpty) continue;
    var m = _vmFrame.firstMatch(line);
    if (m != null) {
      frames.add(KfStackFrame(m[1]!, m[2]!, int.parse(m[3]!), int.tryParse(m[4] ?? '') ?? 0));
      continue;
    }
    m = _v8Frame.firstMatch(line);
    if (m != null) {
      frames.add(KfStackFrame(m[1] ?? '<anonymous>', m[2]!, int.parse(m[3]!), int.parse(m[4]!)));
      continue;
    }
    m = _terseFrame.firstMatch(line);
    if (m != null && (m[1]!.contains(':') || m[1]!.endsWith('.dart'))) {
      frames.add(KfStackFrame(m[4]!.trim(), m[1]!, int.parse(m[2]!), int.tryParse(m[3] ?? '') ?? 0));
    }
  }
  return frames;
}

const _libraryPrefixes = [
  'dart:',
  'package:flutter/',
  'package:keyframer_inspector/',
  'package:stack_trace/',
  'org-dartlang-sdk:',
];

/// A frame of the SDK, Flutter or the inspector itself: how the call got here, not who made it. A
/// frame in compiled JavaScript or WebAssembly (a web build's `main.dart.js`) counts too: it names no
/// source line, so it cannot be the app's call site, and sites fall back to the value's name.
bool isLibraryFrame(KfStackFrame f) {
  for (final p in _libraryPrefixes) {
    if (f.uri.startsWith(p)) return true;
  }
  if (_compiled.hasMatch(f.uri)) return true;
  // A debug web build names the SDK's files dart-sdk/..., and serves packages under packages/<name>/.
  return f.uri.startsWith('dart-sdk/') || f.uri.contains('/dart-sdk/') || _webLibrary.hasMatch(f.uri);
}

final _compiled = RegExp(r'\.(m?js|wasm)(\?.*)?$');
final _webLibrary = RegExp(r'(^|/)packages/(flutter|keyframer_inspector|stack_trace)/');
final _webOwn = RegExp(r'(^|/)packages/keyframer_inspector/');

/// The first frame of the app's own code, or null (non-symbolic trace, or only library frames).
KfStackFrame? appFrame(List<KfStackFrame> frames) {
  for (final f in frames) {
    if (!isLibraryFrame(f)) return f;
  }
  return null;
}

/// Where a call site's file is, as the panel and the CLI read it: relative to the project.
///
/// `package:<appPackage>/x.dart` is `lib/x.dart`; a `file://` path inside `root` is made relative to
/// it. Anything else (another package's code) stays as Dart printed it.
String sourceFile(String uri, {String? appPackage, String? root}) {
  if (appPackage != null && uri.startsWith('package:$appPackage/')) {
    return 'lib/${uri.substring('package:$appPackage/'.length)}';
  }
  // A debug web build serves the app's lib/ as packages/<appPackage>/.
  if (appPackage != null && !uri.contains('://')) {
    final i = uri.startsWith('packages/$appPackage/') ? 0 : uri.indexOf('/packages/$appPackage/');
    if (i >= 0) return 'lib/${uri.substring(uri.indexOf('packages/$appPackage/', i) + 'packages/$appPackage/'.length)}';
  }
  if (uri.startsWith('file://')) {
    final path = Uri.parse(uri).toFilePath();
    if (root != null && root.isNotEmpty) {
      final base = root.endsWith('/') ? root : '$root/';
      if (path.startsWith(base)) return path.substring(base.length);
    }
    return path;
  }
  return uri;
}

/// The widget or class a frame belongs to: `_CardState.initState.<anonymous closure>` is `Card`. A bare
/// method name, as a debug web build prints its frames (`initState`, `get [_entrance]`), names none.
String? componentOf(String member) {
  final bare = !member.contains('.') && !member.startsWith('new ');
  if (bare && (member.contains(' ') || member.contains('[') || RegExp(r'^[a-z]').hasMatch(member))) return null;
  var head = member.split('.').first.trim();
  if (head.startsWith('new ')) head = head.substring(4);
  if (head.isEmpty || head.startsWith('<')) return null;
  if (head.startsWith('_')) head = head.substring(1);
  // A State subclass is named after its widget.
  if (head.length > 5 && head.endsWith('State')) head = head.substring(0, head.length - 5);
  return head.isEmpty ? null : head;
}

/// A stack trace as V8 prints it (`    at member (file:line:col)`), app frames only, so the panel's
/// stack reader (symbolicate.ts parseStack) can read it. Library frames are dropped.
String formatStack(List<KfStackFrame> frames, {String? appPackage, String? root, int max = 12}) {
  final out = StringBuffer();
  var n = 0;
  for (final f in frames) {
    if (isLibraryFrame(f)) continue;
    out.writeln('    at ${f.member} (${sourceFile(f.uri, appPackage: appPackage, root: root)}:${f.line}:${f.column})');
    if (++n >= max) break;
  }
  return out.toString().trimRight();
}

/// A stack as `InspectorStackFrame`s, mapped to source already: the inspector's own frames dropped,
/// the SDK's and Flutter's marked `collapse` (library frames, as Metro marks node_modules).
List<Map<String, Object?>> inspectorFrames(
  List<KfStackFrame> frames, {
  String? appPackage,
  String? root,
  int max = 16,
}) {
  final out = <Map<String, Object?>>[];
  for (final f in frames) {
    if (f.uri.startsWith('package:keyframer_inspector/') || _webOwn.hasMatch(f.uri)) continue;
    out.add({
      'methodName': f.member,
      'file': sourceFile(f.uri, appPackage: appPackage, root: root),
      'lineNumber': f.line,
      'column': f.column,
      if (isLibraryFrame(f)) 'collapse': true,
    });
    if (out.length >= max) break;
  }
  return out;
}
