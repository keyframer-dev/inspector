import 'dart:io';
import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:keyframer_inspector/keyframer_inspector.dart';
import 'package:keyframer_inspector/src/call_site.dart' show KfLazyStack, formatFrames, isLibraryFrame;

void main() {
  group('parseStackTrace', () {
    test('reads VM frames, with and without a column', () {
      final frames = parseStackTrace('''
#0      KfAnimationController.forward (package:keyframer_inspector/src/controller.dart:38:7)
#1      _HomeScreenState.initState (package:demo/main.dart:42:15)
#2      StatefulElement._firstBuild (package:flutter/src/widgets/framework.dart:5602)
#3      main.<anonymous closure> (file:///Users/me/app/lib/main.dart:9:3)
''');
      expect(frames.map((f) => f.toString()), [
        'KfAnimationController.forward (package:keyframer_inspector/src/controller.dart:38:7)',
        '_HomeScreenState.initState (package:demo/main.dart:42:15)',
        'StatefulElement._firstBuild (package:flutter/src/widgets/framework.dart:5602:0)',
        'main.<anonymous closure> (file:///Users/me/app/lib/main.dart:9:3)',
      ]);
    });

    test('reads the terse format Flutter web prints, and V8 frames', () {
      final frames = parseStackTrace('''
package:keyframer_inspector/src/controller.dart 38:7   forward
package:demo/main.dart 42:15                         [_HomeScreenState.initState]
    at Object.main (http://localhost:5000/main.dart.js:120:9)
''');
      expect(frames, hasLength(3));
      expect(frames[1].uri, 'package:demo/main.dart');
      expect(frames[1].line, 42);
      expect(frames[1].column, 15);
      expect(frames[2].member, 'Object.main');
      expect(frames[2].line, 120);
      // Compiled JavaScript names no source line: never the app's call site.
      expect(appFrame(frames.sublist(2)), isNull);
      expect(appFrame(parseStackTrace('    at f (http://localhost:5000/main.dart.mjs:1:2)')), isNull);
    });

    test('reads an AOT trace (file:line, no column)', () {
      final frames = parseStackTrace('''
#0      _CardState.initState (package:demo/main.dart:42)
#1      main (package:demo/main.dart:9)
''');
      expect(frames.first.toString(), '_CardState.initState (package:demo/main.dart:42:0)');
    });

    test('finds nothing in a trace built with --split-debug-info', () {
      const aot = '''
*** *** *** *** *** *** *** *** *** *** *** *** *** *** *** ***
pid: 4242, tid: 6151647232, name 1.ui
os: macos arch: arm64 comp: no sim: no
isolate_dso_base: 104c00000, vm_dso_base: 104c00000
isolate_instructions: 104c0c000, vm_instructions: 104c04000
    #00 abs 0000000104e8b3b3 virt 00000000002cf3b3 _kDartIsolateSnapshotInstructions+0x2873b3
    #01 abs 0000000104e8a1c7 virt 00000000002ce1c7 _kDartIsolateSnapshotInstructions+0x2861c7
''';
      expect(parseStackTrace(aot), isEmpty);
    });

    test('reads a real trace from this VM', () {
      final here = appFrame(parseStackTrace(StackTrace.current.toString()));
      expect(here, isNotNull);
      expect(here!.uri, endsWith('test/call_site_test.dart'));
      // The line above, wherever it is in this file.
      final line =
          File('test/call_site_test.dart').readAsLinesSync().indexWhere((l) => l.contains('final here = ')) + 1;
      expect(here.line, line);
    });
  });

  test('VM frames read by hand are what the expressions made of every line', () {
    // How parseStackTrace read a line before VM frames were read by hand: three expressions in turn.
    final vm = RegExp(r'^#\d+\s+(.+?) \((.+?):(\d+)(?::(\d+))?\)$');
    final v8 = RegExp(r'^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$');
    final terse = RegExp(r'^(\S+?) (\d+)(?::(\d+))?\s+(.+)$');
    String? before(String raw) {
      final line = raw.trimRight();
      if (line.isEmpty) return null;
      var m = vm.firstMatch(line);
      if (m != null) return KfStackFrame(m[1]!, m[2]!, int.parse(m[3]!), int.tryParse(m[4] ?? '') ?? 0).toString();
      m = v8.firstMatch(line);
      if (m != null) return KfStackFrame(m[1] ?? '<anonymous>', m[2]!, int.parse(m[3]!), int.parse(m[4]!)).toString();
      m = terse.firstMatch(line);
      if (m != null && (m[1]!.contains(':') || m[1]!.endsWith('.dart'))) {
        return KfStackFrame(m[4]!.trim(), m[1]!, int.parse(m[2]!), int.tryParse(m[3] ?? '') ?? 0).toString();
      }
      return null;
    }

    String? now(String line) {
      final f = parseStackTrace(line);
      return f.isEmpty ? null : f.single.toString();
    }

    final lines = [
      ...StackTrace.current.toString().split('\n').where((l) => l.startsWith('#')),
      '#0 f (12:5)',
      '#0 f (:12:5)',
      '#0 f (x:1:2:3)',
      '#0 f (main.dart42:5)',
      '#0 f (x (:5)',
      '#0 f ( (:5)',
      '#1\tf (x:1)',
      '#1      main.<anonymous closure> (file:///a b/c.dart:9:3)',
      '#1      new KfAnimationController (package:k/c.dart:3:1)',
      '#1 f (http://localhost:8080/x.dart:12:5)',
      '#1 f (http://localhost:8080)',
      '#1 f (x:1:99999999999999999999999)',
      '#2      _RawReceivePort._handleMessage (dart:isolate-patch/isolate_patch.dart:192)',
    ];
    // And lines shaped like frames, with what trips an expression up: colons, digits, parentheses,
    // spaces, other whitespace, line separators.
    final random = Random(7);
    const parts = ['1', '2', ' ', '(', ')', ':', 'a', '.', '\t', ' (', ':1', ':12', '\u00a0', '\r', '\u2028'];
    String some(int max) => [for (var i = random.nextInt(max); i > 0; i--) parts[random.nextInt(parts.length)]].join();
    for (var i = 0; i < 20000; i++) {
      lines.add(
        '#${random.nextInt(30)}${[' ', '  ', '\t', '\u00a0', ''][random.nextInt(5)]}${some(5)}'
        '${random.nextInt(5) == 0 ? '(' : ' ('}${some(6)}'
        '${random.nextInt(5) > 0 ? ':${random.nextInt(300)}' : ''}${random.nextBool() ? ':${random.nextInt(300)}' : ''}'
        '${random.nextInt(6) > 0 ? ')' : ''}',
      );
    }
    var read = 0;
    for (final line in lines) {
      final expected = before(line);
      if (expected != null) read++;
      expect(now(line), expected, reason: line);
    }
    expect(read, greaterThan(1000));
  });

  test('appFrame skips the SDK, Flutter and the inspector', () {
    final frames = parseStackTrace('''
#0      KfAnimationController.forward (package:keyframer_inspector/src/controller.dart:38:7)
#1      AnimationController._tick (package:flutter/src/animation/animation_controller.dart:800:5)
#2      _rootRun (dart:async/zone.dart:1399:13)
#3      _CardState._onTap (package:demo/card.dart:17:9)
''');
    expect(appFrame(frames)!.uri, 'package:demo/card.dart');
  });

  test('sourceFile makes call sites project-relative', () {
    expect(sourceFile('package:demo/screens/card.dart', appPackage: 'demo'), 'lib/screens/card.dart');
    expect(sourceFile('package:other/x.dart', appPackage: 'demo'), 'package:other/x.dart');
    expect(sourceFile('file:///Users/me/app/test/a_test.dart', root: '/Users/me/app'), 'test/a_test.dart');
    expect(sourceFile('file:///elsewhere/a.dart', root: '/Users/me/app'), '/elsewhere/a.dart');
  });

  test('componentOf names the widget a frame belongs to', () {
    expect(componentOf('_HomeScreenState.initState'), 'HomeScreen');
    expect(componentOf('_HomeScreenState.initState.<anonymous closure>'), 'HomeScreen');
    expect(componentOf('CardView.build'), 'CardView');
    expect(componentOf('main.<anonymous closure>'), 'main');
    expect(componentOf('new KfAnimationController'), 'KfAnimationController');
    expect(componentOf('<anonymous closure>'), isNull);
    expect(componentOf('State.initState'), 'State');
    // A debug web build prints methods without their class.
    expect(componentOf('initState'), isNull);
    expect(componentOf('get [_entrance]'), isNull);
    expect(componentOf('[_onDragEnd]'), isNull);
  });

  group('KfLazyStack', () {
    const trace = '''
#0      KfAnimationController.forward (package:keyframer_inspector/src/controller.dart:38:7)
#1      AnimationController._tick (package:flutter/src/animation/animation_controller.dart:800:5)
#2      _CardState._onTap (package:demo/card.dart:17:9)
#3      GestureRecognizer.invokeCallback (package:flutter/src/gestures/recognizer.dart:275:24)
#4      main (package:demo/main.dart:9:3)
''';

    test('reads no further than the first app frame for the call site', () {
      final stack = KfLazyStack(trace);
      expect(stack.appFrame.toString(), '_CardState._onTap (package:demo/card.dart:17:9)');
      expect(stack.framesRead, 3);
      // Asked again: from what was read.
      expect(stack.appFrame!.line, 17);
      expect(stack.framesRead, 3);
    });

    test('is the same list parseStackTrace makes, read as it is iterated', () {
      final stack = KfLazyStack(trace);
      expect(stack.isNotEmpty, isTrue);
      expect(stack.framesRead, 1);
      final lines = <int>[];
      for (final f in stack) {
        lines.add(f.line);
        if (lines.length == 2) break;
      }
      expect(lines, [38, 800]);
      expect(stack.framesRead, 2);
      expect(stack[3].line, 275);
      expect(stack.framesRead, 4);
      expect(stack.map((f) => f.toString()), parseStackTrace(trace).map((f) => f.toString()));
      expect(stack, hasLength(5));
    });

    test('a trace taken but not printed is printed when a frame is first read', () {
      final stack = KfLazyStack.of(StackTrace.current);
      expect(stack.printed, isFalse);
      expect(stack.framesRead, 0);
      expect(stack.appFrame!.uri, endsWith('test/call_site_test.dart'));
      expect(stack.printed, isTrue);
      expect(stack.framesRead, 1);
    });

    test('a trace with no source frames has no app frame and is empty', () {
      final stack = KfLazyStack(
        '*** *** ***\n    #00 abs 0000000104e8b3b3 virt 00000000002cf3b3 _kDartIsolateSnapshotInstructions+0x2873b3\n',
      );
      expect(stack.appFrame, isNull);
      expect(stack.isEmpty, isTrue);
      expect(KfLazyStack('').isEmpty, isTrue);
    });
  });

  test('formatFrames writes what formatStack and inspectorFrames wrote, in one pass', () {
    // App frames past formatStack's 12, frames past inspectorFrames' 16, the inspector's own frames
    // (dropped from both), Flutter's (collapsed), web and file:// frames, and app frames between them.
    final lines = <String>[
      '#0      KfAnimationController.forward (package:keyframer_inspector/src/controller.dart:38:7)',
      '#1      _KfTracker.start (package:keyframer_inspector/src/controller.dart:290:5)',
      for (var i = 0; i < 30; i++)
        i % 3 == 0
            ? '#${i + 2}      Element.rebuild (package:flutter/src/widgets/framework.dart:${5000 + i}:7)'
            : i % 5 == 0
            ? '#${i + 2}      main.<anonymous closure> (file:///Users/me/app/test/a_test.dart:${10 + i}:3)'
            : '#${i + 2}      _CardState._step$i (package:demo/card.dart:${100 + i}:9)',
    ];
    final web = '''
packages/keyframer_inspector/src/controller.dart 38:7   forward
packages/demo/card.dart 17:9                          _onTap
dart-sdk/lib/_internal/js_dev_runtime/patch/core_patch.dart 12:3  get current
packages/flutter/src/gestures/recognizer.dart 275:24  invokeCallback
''';
    for (final trace in [lines.join('\n'), web]) {
      final frames = parseStackTrace(trace);
      for (final (appPackage, root) in [('demo', '/Users/me/app'), (null, null)]) {
        final one = formatFrames(frames, appPackage: appPackage, root: root);
        expect(one.stack, _twoPassStack(frames, appPackage: appPackage, root: root));
        expect(one.frames, _twoPassFrames(frames, appPackage: appPackage, root: root));
        expect(formatStack(frames, appPackage: appPackage, root: root), one.stack);
        expect(inspectorFrames(frames, appPackage: appPackage, root: root), one.frames);
      }
    }
    final frames = parseStackTrace(lines.join('\n'));
    expect(formatFrames(frames).stack.split('\n'), hasLength(12));
    expect(formatFrames(frames).frames, hasLength(16));
    // As a lazy stack, read no further than both needed.
    final lazy = KfLazyStack(lines.join('\n'));
    formatFrames(lazy);
    expect(lazy.framesRead, lessThan(lines.length));
  });

  test('formatStack writes app frames the way the panel reads stacks', () {
    final frames = parseStackTrace('''
#0      KfAnimationController.forward (package:keyframer_inspector/src/controller.dart:38:7)
#1      _CardState._onTap (package:demo/card.dart:17:9)
#2      GestureRecognizer.invokeCallback (package:flutter/src/gestures/recognizer.dart:275:24)
#3      _CardState.build.<anonymous closure> (package:demo/card.dart:40:20)
''');
    expect(
      formatStack(frames, appPackage: 'demo'),
      '    at _CardState._onTap (lib/card.dart:17:9)\n'
      '    at _CardState.build.<anonymous closure> (lib/card.dart:40:20)',
    );
  });
}

// formatStack and inspectorFrames as they were before formatFrames did both in one pass: what it must
// still write.
String _twoPassStack(List<KfStackFrame> frames, {String? appPackage, String? root, int max = 12}) {
  final out = StringBuffer();
  var n = 0;
  for (final f in frames) {
    if (isLibraryFrame(f)) continue;
    out.writeln('    at ${f.member} (${sourceFile(f.uri, appPackage: appPackage, root: root)}:${f.line}:${f.column})');
    if (++n >= max) break;
  }
  return out.toString().trimRight();
}

List<Map<String, Object?>> _twoPassFrames(List<KfStackFrame> frames, {String? appPackage, String? root, int max = 16}) {
  final out = <Map<String, Object?>>[];
  for (final f in frames) {
    if (f.uri.startsWith('package:keyframer_inspector/') ||
        RegExp(r'(^|/)packages/keyframer_inspector/').hasMatch(f.uri)) {
      continue;
    }
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
