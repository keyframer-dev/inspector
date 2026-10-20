// The widget tree while recording, on real widgets: implicit animations as values with their sites,
// visibility of moving values, render hints, and Hero flights.

import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:keyframer_inspector/keyframer_inspector.dart';
import 'package:keyframer_inspector/src/scene.dart';

/// Collects what the runtime reports.
class Collect implements KfSink {
  final anims = <(KfCallSite, List<Object?>, num?)>[];
  final signals = <KfSignalSite>[];
  final gone = <String>[];

  @override
  void anim(KfCallSite site, List<Object?> args, {List<KfStackFrame>? frames, num? durationMs}) =>
      anims.add((site, args, durationMs));

  @override
  void signal(KfSignal s) => signals.add(s.site(KfRuntime.instance));

  @override
  void unsignal(String id) => gone.add(id);
}

/// The line of the first line holding `snippet` in this file.
int lineOf(String snippet) => File('test/scene_test.dart').readAsLinesSync().indexWhere((l) => l.contains(snippet)) + 1;

class Implicit extends StatefulWidget {
  const Implicit({super.key});

  @override
  State<Implicit> createState() => ImplicitState();
}

class ImplicitState extends State<Implicit> {
  bool big = false;

  void toggle() => setState(() => big = !big);

  @override
  Widget build(BuildContext context) => Column(
    children: [
      AnimatedContainer(duration: const Duration(milliseconds: 300), curve: Curves.easeOut, width: big ? 200 : 100),
      AnimatedOpacity(duration: const Duration(milliseconds: 200), opacity: big ? 1 : 0.2, child: const Text('a')),
      TweenAnimationBuilder<double>(
        tween: Tween(begin: 0, end: big ? 1 : 0.5),
        duration: const Duration(milliseconds: 400),
        builder: (_, v, _) => SizedBox(width: 10 * v),
      ),
    ],
  );
}

/// A loop on its own screen's ticker (muted when the screen is covered).
class Looping extends StatefulWidget {
  const Looping({super.key});

  @override
  State<Looping> createState() => _LoopingState();
}

class _LoopingState extends State<Looping> with SingleTickerProviderStateMixin {
  late final c = KfAnimationController(vsync: this, duration: const Duration(seconds: 1), name: 'loop')..repeat();

  @override
  void dispose() {
    c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Moving(controller: c);
}

/// A page whose loop is drawn by the first row of a lazy list (its own ticker, not muted when the row
/// scrolls away).
class _ListPage extends StatefulWidget {
  const _ListPage({super.key});

  @override
  State<_ListPage> createState() => _ListPageState();
}

class _ListPageState extends State<_ListPage> with SingleTickerProviderStateMixin {
  late final c = KfAnimationController(vsync: this, duration: const Duration(seconds: 1), name: 'row loop')..repeat();
  final scroll = ScrollController();

  @override
  void dispose() {
    c.dispose();
    scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ListView.builder(
    controller: scroll,
    itemCount: 200,
    itemExtent: 100,
    itemBuilder:
        (_, i) =>
            i == 0
                ? KeyedSubtree(key: const ValueKey('row 0'), child: Moving(controller: c))
                : const SizedBox(height: 100),
  );
}

class _Look {
  const _Look({this.color = Colors.blue, this.height = 40, this.radius = 0});

  final Color color;
  final double height;
  final double radius;
}

class _Container extends StatefulWidget {
  const _Container({super.key});

  @override
  State<_Container> createState() => _ContainerState();
}

class _ContainerState extends State<_Container> {
  _Look look = const _Look();

  void set(_Look next) => setState(() => look = next);

  @override
  Widget build(BuildContext context) => AnimatedContainer(
    duration: const Duration(milliseconds: 100),
    height: look.height,
    decoration: BoxDecoration(color: look.color, borderRadius: BorderRadius.circular(look.radius)),
  );
}

/// An implicit animation straight in a list: Flutter wraps each child in its own widgets.
class InList extends StatelessWidget {
  const InList({super.key});

  @override
  Widget build(BuildContext context) =>
      ListView(children: [AnimatedContainer(duration: const Duration(milliseconds: 250), height: 40)]);
}

/// A value that keeps moving whatever the tree does (its ticker is not the widget's), drawn by an
/// AnimatedBuilder wrapped by `wrap`.
class Moving extends StatefulWidget {
  const Moving({super.key, required this.controller, this.wrap, this.paint});

  final AnimationController controller;
  final Widget Function(Widget animated)? wrap;
  final Widget Function(Animation<double> a, Widget child)? paint;

  @override
  State<Moving> createState() => _MovingState();
}

class _MovingState extends State<Moving> {
  @override
  Widget build(BuildContext context) {
    final c = widget.controller;
    final animated = AnimatedBuilder(
      animation: CurvedAnimation(parent: c, curve: Curves.easeInOut),
      builder:
          (context, child) =>
              widget.paint?.call(c, child!) ?? Transform.translate(offset: Offset(40 * c.value, 0), child: child),
      child: const SizedBox(width: 40, height: 40, child: ColoredBox(color: Colors.blue)),
    );
    return widget.wrap?.call(animated) ?? animated;
  }
}

void main() {
  final rt = KfRuntime.instance;
  late Collect sink;
  late List<(String, bool, String?)> visibility;
  late List<KfRenderHint> hints;
  late KfScene scene;

  setUp(() {
    rt.reset();
    rt.root = Directory.current.path;
    sink = Collect();
    rt.install(sink);
    visibility = [];
    hints = [];
    scene = KfScene(rt, onVisibility: (id, v, r) => visibility.add((id, v, r)), onHint: hints.add);
  });
  tearDown(() {
    scene.stop();
    rt.reset();
  });

  Element root(WidgetTester tester) => tester.binding.rootElement!;

  /// Looks as the recording does: before, and after the value moved for two frames (what is hidden is
  /// confirmed on a second look).
  Future<void> look(WidgetTester tester) async {
    scene.scan(root(tester));
    scene.check();
    await tester.pump(const Duration(milliseconds: 16));
    scene.check();
    await tester.pump(const Duration(milliseconds: 16));
    scene.check();
  }

  test('widget creation is tracked under flutter test (implicit animations need it)', () {
    expect(WidgetInspectorService.instance.isWidgetCreationTracked(), isTrue);
  });

  testWidgets('the app\'s implicit animations become values, reported where they were written', (tester) async {
    final key = GlobalKey<ImplicitState>();
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: Implicit(key: key))));
    scene.scan(root(tester));
    // Only the three the app wrote: Material's own implicit animations (AnimatedTheme,
    // AnimatedDefaultTextStyle, the Material shapes) are Flutter's.
    expect(sink.signals.map((s) => s.name), ['AnimatedContainer', 'AnimatedOpacity', 'TweenAnimationBuilder']);
    final container = sink.signals.first;
    expect(container.toJson(), {
      'id': 'test/scene_test.dart:${lineOf('AnimatedContainer(duration')}:7',
      'file': 'test/scene_test.dart',
      'line': lineOf('AnimatedContainer(duration'),
      'column': 7,
      'component': 'Implicit',
      'name': 'AnimatedContainer',
      'writable': false,
    });
    // TweenAnimationBuilder runs from its first build: reported when found.
    expect(sink.anims.map((a) => a.$1.fn), ['TweenAnimationBuilder']);
    await tester.pumpAndSettle();
    sink.anims.clear();

    key.currentState!.toggle();
    await tester.pump();
    expect(sink.anims.map((a) => a.$1.fn), ['AnimatedContainer', 'AnimatedOpacity', 'TweenAnimationBuilder']);
    final (site, args, ms) = sink.anims.first;
    expect(site.id, container.id);
    expect(site.component, 'Implicit');
    expect(site.target, 'AnimatedContainer');
    expect(args, [
      1,
      {'duration': 300.0, 'curve': 'easeOut'},
    ]);
    expect(ms, 300);
    expect(sink.anims.last.$2.first, 1.0);
    // What each animates: the Reduce Motion rule reads 'opacity' as a fade, the rest as motion.
    expect(sink.anims.map((a) => a.$1.prop), ['size', 'opacity', null]);
    expect(sink.signals.map((s) => s.prop), [null, 'opacity', null]);
    // The value is the progress through the change, eased by the widget's curve.
    await tester.pump(const Duration(milliseconds: 150));
    final value = rt.signals[container.id]!.read();
    expect(value, closeTo(Curves.easeOut.transform(0.5), 0.02));
    await tester.pumpAndSettle();

    // The screen goes: so do its values.
    await tester.pumpWidget(const SizedBox());
    scene.scan(root(tester));
    expect(sink.gone, hasLength(3));
    expect(rt.signals, isEmpty);
  });

  testWidgets('the component is the app\'s widget that wrote it, not the list wrapped around it', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: InList())));
    scene.scan(root(tester));
    expect(sink.signals.single.component, 'InList');
    expect(sink.signals.single.line, lineOf('AnimatedContainer(duration: const Duration(milliseconds: 250)'));
  });

  testWidgets('an AnimatedContainer says what changed', (tester) async {
    final key = GlobalKey<_ContainerState>();
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: _Container(key: key))));
    scene.scan(root(tester));
    Future<String?> change(_Look look) async {
      sink.anims.clear();
      key.currentState!.set(look);
      await tester.pump();
      await tester.pumpAndSettle();
      return sink.anims.single.$1.prop;
    }

    expect(await change(const _Look(color: Colors.red)), 'color');
    expect(await change(const _Look(color: Colors.red, height: 80)), 'size');
    expect(await change(const _Look(color: Colors.green, height: 40, radius: 12)), 'size,color,borderRadius');
  });

  testWidgets('implicit animations leave the runtime when the recording stops', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: Implicit())));
    scene.scan(root(tester));
    expect(rt.signals, hasLength(3));
    scene.stop();
    expect(rt.signals, isEmpty);
    await tester.pumpAndSettle();
  });

  testWidgets('a value that stops as its screen is covered is not reported', (tester) async {
    // The screen's own ticker: muted once another screen covers it, as Flutter does.
    final nav = GlobalKey<NavigatorState>();
    await tester.pumpWidget(
      MaterialApp(
        navigatorKey: nav,
        navigatorObservers: [KfNavigatorObserver()],
        home: const Scaffold(body: Center(child: Looping())),
      ),
    );
    await tester.pump();
    scene.scan(root(tester));
    scene.check();
    nav.currentState!.push(MaterialPageRoute<void>(builder: (_) => const Scaffold(body: Text('next'))));
    for (var i = 0; i < 80; i++) {
      await tester.pump(const Duration(milliseconds: 16));
      if (i % 12 == 0) scene.check();
    }
    expect(visibility, isEmpty);
    await tester.pumpWidget(const SizedBox());
  });

  group('visibility of a moving value', () {
    late AnimationController c;
    setUp(() {
      c = KfAnimationController(vsync: const TestVSync(), duration: const Duration(seconds: 1), name: 'move');
    });
    tearDown(() => c.dispose());

    Future<List<(String, bool, String?)>> whenWrapped(WidgetTester tester, Widget Function(Widget) wrap) async {
      await tester.pumpWidget(MaterialApp(home: Scaffold(body: Center(child: Moving(controller: c, wrap: wrap)))));
      c.repeat();
      await tester.pump();
      await look(tester);
      return visibility;
    }

    testWidgets('on screen: nothing to say', (tester) async {
      expect(await whenWrapped(tester, (w) => w), isEmpty);
      c.stop();
    });

    testWidgets('under an opacity of 0', (tester) async {
      final seen = await whenWrapped(tester, (w) => Opacity(opacity: 0, child: w));
      expect(seen.single.$2, isFalse);
      expect(seen.single.$3, 'hidden');
      c.stop();
    });

    testWidgets('under Offstage or Visibility', (tester) async {
      expect((await whenWrapped(tester, (w) => Offstage(child: w))).single.$3, 'hidden');
      visibility.clear();
      await tester.pumpWidget(const SizedBox());
      scene = KfScene(rt, onVisibility: (id, v, r) => visibility.add((id, v, r)), onHint: hints.add);
      expect(
        (await whenWrapped(tester, (w) => Visibility(visible: false, maintainState: true, child: w))).single.$3,
        'hidden',
      );
      c.stop();
    });

    testWidgets('moved off the screen', (tester) async {
      final seen = await whenWrapped(tester, (w) => Transform.translate(offset: const Offset(5000, 0), child: w));
      expect(seen.single.$3, 'offscreen');
      c.stop();
    });

    testWidgets('scrolled out of its list', (tester) async {
      final seen = await whenWrapped(
        tester,
        // Built, but 2000 points down a 300 point viewport.
        (w) => SizedBox(
          height: 300,
          child: SingleChildScrollView(child: Column(children: [const SizedBox(height: 2000), w])),
        ),
      );
      expect(seen.single.$3, 'offscreen');
      c.stop();
    });

    testWidgets('detached: its widget went away while it keeps moving', (tester) async {
      await whenWrapped(tester, (w) => w);
      await tester.pumpWidget(const SizedBox());
      // Gone since the last walk: the next look walks again first, as the scene's own timer does.
      await tester.pump(const Duration(milliseconds: 16));
      scene.check();
      expect(visibility, isEmpty);
      for (var i = 0; i < 2; i++) {
        await tester.pump(const Duration(milliseconds: 16));
        scene.scan(root(tester));
        scene.check();
      }
      final id = rt.signals.values.single.id!;
      expect(visibility, [(id, false, 'detached')]);
      c.stop();
    });

    testWidgets('scrolled out of a lazy list: off screen, not its (visible) State', (tester) async {
      final page = GlobalKey<_ListPageState>();
      await tester.pumpWidget(MaterialApp(home: Scaffold(body: _ListPage(key: page))));
      await tester.pump();
      await look(tester);
      expect(visibility, isEmpty);
      page.currentState!.scroll.jumpTo(8000);
      await tester.pump();
      // The row's AnimatedBuilder is unmounted; the page that owns the loop is still on screen.
      expect(find.byKey(const ValueKey('row 0')), findsNothing);
      for (var i = 0; i < 3; i++) {
        await tester.pump(const Duration(milliseconds: 16));
        scene.scan(root(tester));
        scene.check();
      }
      final id = rt.signals.values.singleWhere((v) => v.name == 'row loop').id!;
      expect(visibility, [(id, false, 'offscreen')]);
      // Scrolled back: visible again.
      page.currentState!.scroll.jumpTo(0);
      await tester.pump();
      await look(tester);
      expect(visibility.last, (id, true, null));
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('on a screen covered by another, then shown again', (tester) async {
      final nav = GlobalKey<NavigatorState>();
      await tester.pumpWidget(
        MaterialApp(
          navigatorKey: nav,
          navigatorObservers: [KfNavigatorObserver()],
          home: Scaffold(body: Center(child: Moving(controller: c))),
        ),
      );
      c.repeat();
      nav.currentState!.push(MaterialPageRoute<void>(builder: (_) => const Scaffold(body: Text('next'))));
      await tester.pump();
      // While the next screen slides in, this one still shows.
      await tester.pump(const Duration(milliseconds: 50));
      await look(tester);
      expect(visibility, isEmpty);
      await tester.pump(const Duration(seconds: 1));
      await look(tester);
      final id = rt.signals.values.single.id!;
      expect(visibility, [(id, false, 'covered')]);
      nav.currentState!.pop();
      await tester.pump();
      await tester.pump(const Duration(seconds: 1));
      await look(tester);
      expect(visibility.last, (id, true, null));
      c.stop();
    });
  });

  group('render hints', () {
    late AnimationController c;
    setUp(() {
      c = KfAnimationController(vsync: const TestVSync(), duration: const Duration(seconds: 1), name: 'move');
    });
    tearDown(() => c.dispose());

    Future<List<KfRenderHint>> hintsFor(
      WidgetTester tester, {
      Widget Function(Widget)? wrap,
      Widget Function(Animation<double>, Widget)? paint,
    }) async {
      await tester.pumpWidget(
        MaterialApp(home: Scaffold(body: Center(child: Moving(controller: c, wrap: wrap, paint: paint)))),
      );
      c.repeat();
      await tester.pump();
      await look(tester);
      await tester.pump(const Duration(milliseconds: 16));
      scene.check();
      c.stop();
      return hints;
    }

    testWidgets('an Opacity whose opacity animates', (tester) async {
      final found = await hintsFor(tester, paint: (a, child) => Opacity(opacity: 0.2 + 0.6 * a.value, child: child));
      expect(found.single.hint, 'opacity-widget');
      expect(found.single.id, rt.signals.values.single.id);
      expect(
        found.single.detail,
        startsWith('Opacity at test/scene_test.dart:${lineOf('paint: (a, child) => Opacity')}'),
      );
    });

    testWidgets('a FadeTransition is not one', (tester) async {
      expect(await hintsFor(tester, paint: (a, child) => FadeTransition(opacity: a, child: child)), isEmpty);
    });

    testWidgets('ClipPath and ShaderMask over moving content: mask', (tester) async {
      expect((await hintsFor(tester, wrap: (w) => ClipPath(clipper: _Diamond(), child: w))).single.hint, 'mask');
      hints.clear();
      await tester.pumpWidget(const SizedBox());
      scene = KfScene(rt, onVisibility: (id, v, r) => visibility.add((id, v, r)), onHint: hints.add);
      final masked = await hintsFor(
        tester,
        wrap:
            (w) => ShaderMask(
              shaderCallback: (r) => const LinearGradient(colors: [Colors.black, Colors.white]).createShader(r),
              child: w,
            ),
      );
      expect(masked.single.hint, 'mask');
      expect(masked.single.detail, contains('ShaderMask at test/scene_test.dart:'));
    });

    testWidgets('a blur over moving content, and an ImageFiltered around it', (tester) async {
      final found = await hintsFor(
        tester,
        wrap:
            (w) => Stack(
              children: [
                w,
                Positioned.fill(
                  child: BackdropFilter(filter: ui.ImageFilter.blur(sigmaX: 4, sigmaY: 4), child: const SizedBox()),
                ),
              ],
            ),
      );
      expect(found.single.hint, 'blur');
      expect(found.single.detail, contains('BackdropFilter at test/scene_test.dart:'));
      hints.clear();
      await tester.pumpWidget(const SizedBox());
      scene = KfScene(rt, onVisibility: (id, v, r) => visibility.add((id, v, r)), onHint: hints.add);
      final filtered = await hintsFor(
        tester,
        wrap: (w) => ImageFiltered(imageFilter: ui.ImageFilter.blur(sigmaX: 2, sigmaY: 2), child: w),
      );
      expect(filtered.single.hint, 'blur');
    });

    testWidgets('a blur drawn under the moving content is not one', (tester) async {
      final found = await hintsFor(
        tester,
        wrap:
            (w) => Stack(
              children: [
                Positioned.fill(
                  child: BackdropFilter(filter: ui.ImageFilter.blur(sigmaX: 4, sigmaY: 4), child: const SizedBox()),
                ),
                w,
              ],
            ),
      );
      expect(found, isEmpty);
    });

    testWidgets('a clip that saves a layer', (tester) async {
      final found = await hintsFor(
        tester,
        wrap:
            (w) =>
                ClipRRect(borderRadius: BorderRadius.circular(8), clipBehavior: Clip.antiAliasWithSaveLayer, child: w),
      );
      expect(found.single.hint, 'save-layer');
    });
  });

  testWidgets('Hero flights: an animation each, and a value while they fly', (tester) async {
    final nav = GlobalKey<NavigatorState>();
    await tester.pumpWidget(
      MaterialApp(
        navigatorKey: nav,
        navigatorObservers: [KfNavigatorObserver()],
        routes: {
          '/': (_) => const Scaffold(body: Hero(tag: 'card', child: SizedBox(width: 40, height: 40))),
          '/details':
              (_) => const Scaffold(body: Center(child: Hero(tag: 'card', child: SizedBox(width: 200, height: 200)))),
        },
      ),
    );
    nav.currentState!.pushNamed('/details');
    await tester.pump();
    await tester.pump();
    final hero = sink.anims.singleWhere((a) => a.$1.fn == 'Hero');
    final line = lineOf("Center(child: Hero(tag: 'card'");
    expect(hero.$1.file, 'test/scene_test.dart');
    expect(hero.$1.line, line);
    expect(hero.$1.target, 'Hero(card)');
    expect(hero.$2.first, 1);
    expect(hero.$2.last, containsPair('from', '/'));
    expect(hero.$2.last, containsPair('to', '/details'));
    expect(hero.$3, greaterThan(0));
    final flying = rt.signals.values.where((s) => s.name == 'Hero(card)').single;
    await tester.pump(const Duration(milliseconds: 100));
    expect(flying.read(), inExclusiveRange(0, 1));
    expect(flying.site(rt).writable, isFalse);
    await tester.pumpAndSettle();
    expect(rt.signals.values.where((s) => s.name == 'Hero(card)'), isEmpty);
    // And back: the flight lands on the first screen's Hero.
    sink.anims.clear();
    nav.currentState!.pop();
    await tester.pump();
    await tester.pump();
    final back = sink.anims.singleWhere((a) => a.$1.fn == 'Hero');
    expect(back.$1.line, lineOf("body: Hero(tag: 'card'"));
    expect(back.$2.first, 0);
    await tester.pumpAndSettle();
  });
}

class _Diamond extends CustomClipper<Path> {
  @override
  Path getClip(Size size) =>
      Path()
        ..moveTo(size.width / 2, 0)
        ..lineTo(size.width, size.height / 2)
        ..lineTo(size.width / 2, size.height)
        ..lineTo(0, size.height / 2)
        ..close();

  @override
  bool shouldReclip(_Diamond oldClipper) => false;
}
