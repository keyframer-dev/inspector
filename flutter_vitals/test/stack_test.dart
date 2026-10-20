import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:keyframer_vitals/src/controller.dart';
import 'package:keyframer_vitals/src/stack.dart';

String sample(String name) => File('test/fixtures/$name').readAsStringSync();

void main() {
  group('symbolic traces', () {
    test('JIT frames with columns, AOT frames without', () {
      final frames = parseSymbolicStack('''
#0      new VitalsAnimationController (package:keyframer_vitals/src/controller.dart:31:52)
#1      _FeedCardState.initState (package:shop/feed/card.dart:57:12)
#2      StatefulElement._firstBuild (package:flutter/src/widgets/framework.dart:5602)
''');
      expect(frames, hasLength(3));
      expect(frames[1].toString(), '_FeedCardState.initState (package:shop/feed/card.dart:57:12)');
      expect(frames[2].column, 0);
    });

    test('the first app frame is a source origin', () {
      const trace = '''
#0      new VitalsAnimationController (package:keyframer_vitals/src/controller.dart:31:52)
#1      new AnimationController (package:flutter/src/animation/animation_controller.dart:250:7)
#2      _FeedCardState.initState (package:shop/feed/card.dart:57)
''';
      final o = originOf(trace, appPackage: 'shop') as SourceOrigin;
      expect(o.file, 'lib/feed/card.dart');
      expect(o.line, 57);
      expect(o.column, 0);
      expect(o.component, 'FeedCard');
      // Without the app's package name the file stays as Dart printed it.
      expect((originOf(trace) as SourceOrigin).file, 'package:shop/feed/card.dart');
    });

    test('a file:// frame (a test, a script) is not an app source', () {
      expect(originOf('#0      main (file:///Users/me/app/test/x_test.dart:3:4)'), isNull);
    });

    test('componentOf', () {
      expect(componentOf('_CardState.initState.<anonymous closure>'), 'Card');
      expect(componentOf('new HomeScreen'), 'HomeScreen');
      expect(componentOf('main'), isNull);
      expect(componentOf('<anonymous closure>'), isNull);
    });
  });

  group('non-symbolic traces (--split-debug-info, --obfuscate)', () {
    test('a real trace from dart compile exe on macOS', () {
      final s = parseNativeStack(sample('trace-macos-arm64.txt'))!;
      expect(s.buildId, '2943649c15509c2b37ca8150ce6170a2');
      expect(s.arch, 'arm64');
      expect(s.os, 'macos');
      expect(s.isolateDsoBase, 0x104f98000);
      expect(s.frames, hasLength(8));
      expect(s.frames[1].virt, 0x38bdb);
      expect(s.frames[1].symbol, '_kDartSnapshotText+0x34bdb');
      // Frame 0 is the never-inlined constructor that took the trace; frame 1 called it (`make` in
      // the sample, as native_stack_traces decodes it with the build's debug info).
      final o = originOf(sample('trace-macos-arm64.txt')) as NativeOrigin;
      expect(o.buildId, '2943649c15509c2b37ca8150ce6170a2');
      expect(o.offset, 0x38bdb);
      expect(o.arch, 'arm64');
      expect(parseSymbolicStack(sample('trace-macos-arm64.txt')), isEmpty);
    });

    test('an Android trace', () {
      final o = originOf(sample('trace-android-arm64.txt')) as NativeOrigin;
      expect(o.buildId, '8d2f61c0b7e94a3c5f1e08d9a6b4c27e');
      expect(o.offset, 0x2f6f43);
      expect(o.arch, 'arm64');
    });

    test('frames without virt get it from the isolate DSO base', () {
      final s = parseNativeStack(sample('trace-ios-arm64-abs-only.txt'))!;
      expect(s.frames[1].virt, 0x104b1b9f0 - 0x1048a0000);
      final o = originOf(sample('trace-ios-arm64-abs-only.txt')) as NativeOrigin;
      expect(o.offset, 0x27b9f0);
    });

    test('no build id, no native origin', () {
      final noId = sample('trace-android-arm64.txt').split('\n').where((l) => !l.startsWith('build_id')).join('\n');
      expect(parseNativeStack(noId)!.buildId, isNull);
      expect(originOf(noId), isNull);
    });

    test('plain text is neither', () {
      expect(parseNativeStack('hello'), isNull);
      expect(originOf('hello'), isNull);
    });
  });

  group('sites', () {
    test('a name wins, with the owner type', () {
      final s = siteFor(name: 'card-expand', fn: 'AnimationController', owner: '_CardState', created: null);
      expect(s.ref, {'kind': 'name', 'name': 'card-expand', 'type': '_CardState'});
      expect(s.key, 'card-expand');
      expect(s.component, 'Card');
    });

    test('unnamed: source, then native into the snapshot image, then the owner type', () {
      final src = siteFor(
        name: null,
        fn: 'AnimationController',
        owner: '_FeedCardState',
        created: StackTrace.fromString('#1      _FeedCardState.initState (package:shop/feed/card.dart:57:12)'),
        appPackage: 'shop',
      );
      expect(src.ref, {'kind': 'source', 'file': 'lib/feed/card.dart', 'line': 57, 'column': 12});
      expect(src.key, 'lib/feed/card.dart#_FeedCardState.initState#AnimationController');
      expect(src.component, 'FeedCard');

      final nat = siteFor(
        name: null,
        fn: 'AnimationController',
        owner: '_FeedCardState',
        created: StackTrace.fromString(sample('trace-android-arm64.txt')),
      );
      expect(nat.ref, {'kind': 'native', 'offset': 0x2f6f43, 'type': '_FeedCardState'});
      expect(nat.key, isNull);
      expect(nat.image!.toJson(), {
        'debugId': '8d2f61c0b7e94a3c5f1e08d9a6b4c27e',
        'kind': 'elf',
        'name': 'libapp.so',
        'arch': 'arm64',
      });

      final bare = siteFor(name: null, fn: 'AnimationController', owner: '_FeedCardState', created: null);
      expect(bare.ref, {'kind': 'name', 'name': 'FeedCard', 'type': '_FeedCardState'});
    });
  });

  test('on iOS the snapshot is a Mach-O image named App', () {
    final s = siteFor(
      name: null,
      fn: 'AnimationController',
      owner: null,
      created: StackTrace.fromString(sample('trace-ios-arm64-abs-only.txt')),
      imageName: 'App',
      imageKind: 'macho',
    );
    expect(s.image!.toJson(), {
      'debugId': 'c43d0e9a51f27b8866e0aa1f9b3d2e74',
      'kind': 'macho',
      'name': 'App',
      'arch': 'arm64',
    });
  });
}
