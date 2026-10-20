import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:keyframer_inspector/keyframer_inspector.dart';

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
