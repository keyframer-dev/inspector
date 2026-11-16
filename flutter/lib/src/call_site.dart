// Call sites from Dart stack traces: where an animated value was created and where an animation was
// started, without a build step. Debug builds (JIT) print file:line:column; AOT builds (profile,
// release) print file:line with no column. Built with --split-debug-info or --obfuscate, AOT prints
// raw addresses instead: no frames are found and sites fall back to the value's name.

import 'dart:collection';

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
    final f = _parseLine(raw);
    if (f != null) frames.add(f);
  }
  return frames;
}

/// The frame one line of a trace names, or null (a header, an address, a blank line).
KfStackFrame? _parseLine(String raw) {
  final line = raw.trimRight();
  if (line.isEmpty) return null;
  if (line.codeUnitAt(0) == _hash) {
    final f = _vmLine(line);
    if (f != null) return f;
  }
  var m = _vmFrame.firstMatch(line);
  if (m != null) return KfStackFrame(m[1]!, m[2]!, int.parse(m[3]!), int.tryParse(m[4] ?? '') ?? 0);
  m = _v8Frame.firstMatch(line);
  if (m != null) return KfStackFrame(m[1] ?? '<anonymous>', m[2]!, int.parse(m[3]!), int.parse(m[4]!));
  m = _terseFrame.firstMatch(line);
  if (m != null && (m[1]!.contains(':') || m[1]!.endsWith('.dart'))) {
    return KfStackFrame(m[4]!.trim(), m[1]!, int.parse(m[2]!), int.tryParse(m[3] ?? '') ?? 0);
  }
  return null;
}

const _hash = 0x23, _space = 0x20, _tab = 0x09, _colon = 0x3a, _close = 0x29, _zero = 0x30, _nine = 0x39;

/// A VM frame line (`#1      _CardState.initState (package:app/main.dart:42:7)`) read by hand: what
/// [_vmFrame] makes of it, without the expression, which costs about 5 µs a line (a recording reads
/// every line of a start's stack). Null for anything less plain (other whitespace, line separators, no
/// line number): the expressions decide those, as before.
KfStackFrame? _vmLine(String line) {
  final n = line.length;
  var i = 1;
  while (i < n && _digit(line.codeUnitAt(i))) {
    i++;
  }
  final digits = i;
  while (i < n && (line.codeUnitAt(i) == _space || line.codeUnitAt(i) == _tab)) {
    i++;
  }
  if (digits == 1 || i == digits || i >= n) return null;
  // The member starts at the first character the expression's `\s+` leaves (anything printable).
  final first = line.codeUnitAt(i);
  if (first <= _space || first > 0x7e) return null;
  final member = i;
  // The member is the shortest that a " (" follows, and the line ends with the location's ")".
  final open = line.indexOf(' (', member + 1);
  if (open < 0 || line.codeUnitAt(n - 1) != _close) return null;
  // `.` matches no line terminator: a line holding one is left to the expression.
  if (line.contains('\r') || line.contains('\u2028') || line.contains('\u2029')) return null;
  // uri:line:column or uri:line. The shortest uri the expression allows leaves the longest such tail:
  // the last run of digits after a colon, and the run before it when a colon precedes that too.
  final uri = open + 2, end = n - 1;
  var col = end;
  while (col > uri && _digit(line.codeUnitAt(col - 1))) {
    col--;
  }
  if (col == end || line.codeUnitAt(col - 1) != _colon) return null;
  var row = col - 1;
  while (row > uri && _digit(line.codeUnitAt(row - 1))) {
    row--;
  }
  if (row < col - 1 && line.codeUnitAt(row - 1) == _colon && row - 1 > uri) {
    return KfStackFrame(
      line.substring(member, open),
      line.substring(uri, row - 1),
      int.parse(line.substring(row, col - 1)),
      int.tryParse(line.substring(col, end)) ?? 0,
    );
  }
  if (col - 1 <= uri) return null;
  return KfStackFrame(
    line.substring(member, open),
    line.substring(uri, col - 1),
    int.parse(line.substring(col, end)),
    0,
  );
}

bool _digit(int c) => c >= _zero && c <= _nine;

/// A stack trace read line by line, only as far as it is asked: an animation's start needs its first
/// app frame (the call site) every time, the frames past it only while recording, so reading stops
/// there. A list of frames like [parseStackTrace]'s to whoever iterates it (an iteration reads as it
/// goes; `length` reads the rest). Dart prints a trace (`StackTrace.toString`) whole or not at all, and
/// printing costs ten times what taking it does: [KfLazyStack.of] holds a trace taken but not printed
/// until a frame is first read.
class KfLazyStack extends ListBase<KfStackFrame> {
  /// A trace printed already.
  KfLazyStack(String trace) : _text = trace;

  /// A trace taken (a few µs), printed when a frame is first read (50 to 100 µs at the depth of a
  /// gesture handler or a build).
  KfLazyStack.of(StackTrace trace) : _taken = trace;

  StackTrace? _taken;
  String? _text;
  int _at = 0;
  final List<KfStackFrame> _frames = [];
  KfStackFrame? _app;
  bool _appRead = false;

  String get _trace {
    final text = _text;
    if (text != null) return text;
    final printed = _taken.toString();
    _taken = null;
    return _text = printed;
  }

  /// Whether the trace has been printed yet (what tests check: not while the app starts it).
  bool get printed => _text != null;

  /// How many frames have been read so far (what tests check: no further than asked).
  int get framesRead => _frames.length;

  /// Reads lines until one more frame is found. False at the end of the trace.
  bool _more() {
    final trace = _trace;
    while (_at < trace.length) {
      var end = trace.indexOf('\n', _at);
      if (end < 0) end = trace.length;
      final f = _parseLine(trace.substring(_at, end));
      _at = end + 1;
      if (f != null) {
        _frames.add(f);
        return true;
      }
    }
    return false;
  }

  /// The first frame of the app's own code ([appFrame]), read no further than it. Null when there is
  /// none (a non-symbolic trace, or only library frames).
  KfStackFrame? get appFrame {
    if (_appRead) return _app;
    for (var i = 0; i < _frames.length || _more(); i++) {
      if (!isLibraryFrame(_frames[i])) {
        _app = _frames[i];
        break;
      }
    }
    _appRead = true;
    return _app;
  }

  @override
  int get length {
    while (_more()) {}
    return _frames.length;
  }

  @override
  set length(int n) => throw UnsupportedError('A stack trace cannot be changed.');

  @override
  KfStackFrame operator [](int i) {
    while (i >= _frames.length && _more()) {}
    return _frames[i];
  }

  @override
  void operator []=(int i, KfStackFrame f) => throw UnsupportedError('A stack trace cannot be changed.');

  @override
  bool get isEmpty => _frames.isEmpty && !_more();

  @override
  Iterator<KfStackFrame> get iterator => _read().iterator;

  Iterable<KfStackFrame> _read() sync* {
    for (var i = 0; i < _frames.length || _more(); i++) {
      yield _frames[i];
    }
  }
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
  final uri = f.uri;
  for (final p in _libraryPrefixes) {
    if (uri.startsWith(p)) return true;
  }
  // The expressions search the whole uri, a few µs each for every app frame: asked only of a uri that
  // could match (a query string, a packages/ folder).
  if (uri.contains('?')
      ? _compiled.hasMatch(uri)
      : uri.endsWith('.js') || uri.endsWith('.mjs') || uri.endsWith('.wasm')) {
    return true;
  }
  // A debug web build names the SDK's files dart-sdk/..., and serves packages under packages/<name>/.
  return uri.startsWith('dart-sdk/') ||
      uri.contains('/dart-sdk/') ||
      (uri.contains('packages/') && _webLibrary.hasMatch(uri));
}

final _compiled = RegExp(r'\.(m?js|wasm)(\?.*)?$');
final _webLibrary = RegExp(r'(^|/)packages/(flutter|keyframer_inspector|stack_trace)/');
final _webOwn = RegExp(r'(^|/)packages/keyframer_inspector/');

/// The inspector's own frame, on the VM or in a debug web build.
bool _ownFrame(KfStackFrame f) =>
    f.uri.startsWith('package:keyframer_inspector/') ||
    (f.uri.contains('packages/keyframer_inspector/') && _webOwn.hasMatch(f.uri));

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
  if (bare && (member.contains(' ') || member.contains('[') || _lowerFirst.hasMatch(member))) return null;
  var head = member.split('.').first.trim();
  if (head.startsWith('new ')) head = head.substring(4);
  if (head.isEmpty || head.startsWith('<')) return null;
  if (head.startsWith('_')) head = head.substring(1);
  // A State subclass is named after its widget.
  if (head.length > 5 && head.endsWith('State')) head = head.substring(0, head.length - 5);
  return head.isEmpty ? null : head;
}

final _lowerFirst = RegExp(r'^[a-z]');

/// A stack trace as V8 prints it (`    at member (file:line:col)`), app frames only, so the panel's
/// stack reader (symbolicate.ts parseStack) can read it. Library frames are dropped.
String formatStack(List<KfStackFrame> frames, {String? appPackage, String? root, int max = 12}) =>
    formatFrames(frames, appPackage: appPackage, root: root, maxStack: max, maxFrames: 0).stack;

/// A stack as `InspectorStackFrame`s, mapped to source already: the inspector's own frames dropped,
/// the SDK's and Flutter's marked `collapse` (library frames, as Metro marks node_modules).
List<Map<String, Object?>> inspectorFrames(
  List<KfStackFrame> frames, {
  String? appPackage,
  String? root,
  int max = 16,
}) => formatFrames(frames, appPackage: appPackage, root: root, maxStack: 0, maxFrames: max).frames;

/// [formatStack] and [inspectorFrames] in one pass, what an animation started while recording
/// carries: each frame is judged and its file worked out once (once per file, in fact), and frames
/// past what both need are not read.
({String stack, List<Map<String, Object?>> frames}) formatFrames(
  List<KfStackFrame> frames, {
  String? appPackage,
  String? root,
  int maxStack = 12,
  int maxFrames = 16,
}) {
  final stack = StringBuffer();
  final mapped = <Map<String, Object?>>[];
  final files = <String, String>{};
  var lines = 0;
  for (final f in frames) {
    final toStack = lines < maxStack, toFrames = mapped.length < maxFrames;
    if (!toStack && !toFrames) break;
    final library = isLibraryFrame(f);
    // The inspector's own frames are library frames too: dropped from both.
    final own = library && _ownFrame(f);
    final inStack = toStack && !library, inFrames = toFrames && !own;
    if (!inStack && !inFrames) continue;
    final file = files[f.uri] ??= sourceFile(f.uri, appPackage: appPackage, root: root);
    if (inStack) {
      stack.writeln('    at ${f.member} ($file:${f.line}:${f.column})');
      lines++;
    }
    if (inFrames) {
      mapped.add({
        'methodName': f.member,
        'file': file,
        'lineNumber': f.line,
        'column': f.column,
        if (library) 'collapse': true,
      });
    }
  }
  return (stack: stack.toString().trimRight(), frames: mapped);
}
