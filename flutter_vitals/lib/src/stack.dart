// Where an animation was created, from the stack taken once when its controller is constructed.
//
// Two shapes of Dart stack trace reach a release app:
// - symbolic (JIT, and AOT builds without --split-debug-info): `#1  _CardState.initState (package:app/card.dart:42:7)`,
//   the column missing in AOT. The first frame of the app's own code is a `source` site.
// - non-symbolic (AOT built with --split-debug-info or --obfuscate): a header with the snapshot's build id,
//   then `#01 abs 0000007b0c6e7f43 virt 00000000002f6f43 _kDartIsolateSnapshotInstructions+0x220503`.
//   The caller's `virt` offset is a `native` site, named on the server from the uploaded symbols.

/// One symbolic frame. `uri` is as Dart prints it: `package:app/main.dart`, `file:///…`, `dart:core`.
class VitalsStackFrame {
  const VitalsStackFrame(this.member, this.uri, this.line, this.column);

  final String member;
  final String uri;
  final int line;

  /// 0 when the trace has none (AOT).
  final int column;

  @override
  String toString() => '$member ($uri:$line:$column)';
}

// VM: "#1      _CardState.initState (package:app/main.dart:42:7)", column optional.
final _vmFrame = RegExp(r'^#\d+\s+(.+?) \((.+?):(\d+)(?::(\d+))?\)$');

/// The symbolic frames of a trace. A non-symbolic trace has none.
List<VitalsStackFrame> parseSymbolicStack(String trace) {
  final frames = <VitalsStackFrame>[];
  for (final raw in trace.split('\n')) {
    final m = _vmFrame.firstMatch(raw.trim());
    if (m == null) continue;
    frames.add(VitalsStackFrame(m[1]!, m[2]!, int.parse(m[3]!), int.tryParse(m[4] ?? '') ?? 0));
  }
  return frames;
}

const _libraryPrefixes = ['dart:', 'package:flutter/', 'package:keyframer_vitals/', 'org-dartlang-sdk:'];

/// A frame of the SDK, Flutter or this package: how the call got here, not who made it.
bool isLibraryFrame(VitalsStackFrame f) => _libraryPrefixes.any(f.uri.startsWith);

/// The first frame of the app's code that names a `package:` file, or null.
VitalsStackFrame? appFrame(List<VitalsStackFrame> frames) {
  for (final f in frames) {
    if (isLibraryFrame(f)) continue;
    return f.uri.startsWith('package:') ? f : null;
  }
  return null;
}

/// `package:<appPackage>/x.dart` is `lib/x.dart`, as the inspector names files; another package's file,
/// or any file when the app package is not known, stays as Dart printed it.
String sourceFile(String uri, {String? appPackage}) {
  if (appPackage != null && uri.startsWith('package:$appPackage/')) {
    return 'lib/${uri.substring('package:$appPackage/'.length)}';
  }
  return uri;
}

/// The widget or class a frame belongs to: `_CardState.initState.<anonymous closure>` is `Card`.
String? componentOf(String member) {
  var head = member.split('.').first.trim();
  if (head.startsWith('new ')) head = head.substring(4);
  if (head.isEmpty || head.startsWith('<') || head.contains(' ')) return null;
  if (head.startsWith('_')) head = head.substring(1);
  if (head.length > 5 && head.endsWith('State')) head = head.substring(0, head.length - 5);
  return head.isEmpty || RegExp(r'^[a-z]').hasMatch(head) ? null : head;
}

/// A non-symbolic trace: the snapshot it came from and each frame's addresses.
class NativeStack {
  const NativeStack({this.buildId, this.arch, this.os, this.isolateDsoBase, required this.frames});

  /// The snapshot's build id (lowercase hex), the `debugId` its symbols are uploaded under.
  final String? buildId;
  final String? arch;
  final String? os;
  final int? isolateDsoBase;
  final List<NativeFrame> frames;
}

class NativeFrame {
  const NativeFrame(this.index, this.abs, this.virt, this.symbol);

  final int index;
  final int abs;

  /// The address relative to the snapshot's load address: what `native` refs send.
  final int? virt;
  final String? symbol;
}

final _nativeFrame = RegExp(r'^#(\d+)\s+abs\s+([0-9a-fA-F]+)(?:\s+virt\s+([0-9a-fA-F]+))?(?:\s+(\S+))?');
final _buildId = RegExp(r"^build_id:\s*'?([0-9a-fA-F]+)'?");
final _osArch = RegExp(r'^os:\s*(\S+)\s+arch:\s*(\S+)');
final _dsoBase = RegExp(r'^isolate_dso_base:\s*([0-9a-fA-F]+)');

/// Reads a trace in the format Dart prints with `--dwarf-stack-traces` (what --split-debug-info and
/// --obfuscate turn on); null when `trace` is not one. A frame without `virt` gets it from the
/// isolate's DSO base when the header has one.
NativeStack? parseNativeStack(String trace) {
  String? buildId, arch, os;
  int? base;
  final frames = <NativeFrame>[];
  var header = false;
  for (final raw in trace.split('\n')) {
    final line = raw.trim();
    if (line.startsWith('*** *** ***')) {
      header = true;
      continue;
    }
    var m = _nativeFrame.firstMatch(line);
    if (m != null) {
      final abs = int.parse(m[2]!, radix: 16);
      var virt = m[3] == null ? null : int.parse(m[3]!, radix: 16);
      if (virt == null && base != null && base > 0 && abs >= base) virt = abs - base;
      frames.add(NativeFrame(int.parse(m[1]!), abs, virt, m[4]));
      continue;
    }
    m = _buildId.firstMatch(line);
    if (m != null) {
      buildId = m[1]!.toLowerCase();
      continue;
    }
    m = _osArch.firstMatch(line);
    if (m != null) {
      os = m[1];
      arch = m[2];
      continue;
    }
    m = _dsoBase.firstMatch(line);
    if (m != null) base = int.parse(m[1]!, radix: 16);
  }
  if (!header && frames.isEmpty) return null;
  return NativeStack(buildId: buildId, arch: arch, os: os, isolateDsoBase: base, frames: frames);
}

/// Where a site was created, as the report names it.
sealed class SiteOrigin {
  const SiteOrigin();
}

/// A symbolic frame of the app: `file` as [sourceFile] gives it.
class SourceOrigin extends SiteOrigin {
  const SourceOrigin(this.file, this.line, this.column, this.member);

  final String file;
  final int line;
  final int column;
  final String member;

  String? get component => componentOf(member);
}

/// An address in the app's AOT snapshot. A return address: the symbol resolver looks up `offset - 1`.
class NativeOrigin extends SiteOrigin {
  const NativeOrigin(this.buildId, this.offset, {this.arch});

  final String buildId;
  final int offset;
  final String? arch;
}

/// The origin of a site from the trace taken in its constructor. `callerIndex` is the caller's frame in
/// a non-symbolic trace: 1 when the trace was taken directly in a never-inlined constructor (frame 0 is
/// the constructor itself). Null when the trace names neither (no app frame, or no build id).
SiteOrigin? originOf(String trace, {int callerIndex = 1, String? appPackage}) {
  final symbolic = parseSymbolicStack(trace);
  if (symbolic.isNotEmpty) {
    final f = appFrame(symbolic);
    return f == null ? null : SourceOrigin(sourceFile(f.uri, appPackage: appPackage), f.line, f.column, f.member);
  }
  final native = parseNativeStack(trace);
  if (native == null || native.buildId == null || native.buildId!.length < 16) return null;
  for (final f in native.frames) {
    if (f.index == callerIndex && f.virt != null) return NativeOrigin(native.buildId!, f.virt!, arch: native.arch);
  }
  return null;
}

/// The architecture as the symbol files name it (`arm64`, `arm`, `x64`, `ia32`, `riscv64`), from what
/// the trace header says.
String? normalArch(String? arch) => switch (arch) {
  null => null,
  'arm64' || 'aarch64' => 'arm64',
  'arm' || 'armv7' => 'arm',
  'x64' || 'x86_64' => 'x64',
  'ia32' || 'x86' => 'ia32',
  final other => other.length <= 16 ? other : null,
};
