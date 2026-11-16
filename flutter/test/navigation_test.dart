// The screens navigation markers name: pages from the navigator observer, KeyframerScreens the app
// declares, setScreen, and playback taking the app back to them.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:keyframer_inspector/keyframer_inspector.dart';

/// A screen that holds a named part (a tab's own KeyframerScreen) inside its own KeyframerScreen.
class _Shell extends StatefulWidget {
  const _Shell({super.key});

  @override
  State<_Shell> createState() => _ShellState();
}

class _ShellState extends State<_Shell> {
  bool shell = true;
  String outer = 'Shell';
  String? inner = 'Feed';
  int tab = 0;

  void update(void Function() change) => setState(change);

  @override
  Widget build(BuildContext context) {
    final content =
        inner == null ? const SizedBox() : KeyframerScreen(key: ValueKey(tab), name: inner!, child: const SizedBox());
    return shell ? KeyframerScreen(name: outer, child: content) : content;
  }
}

/// Tabs in an IndexedStack: every tab stays mounted, only the selected one is shown.
class _Tabs extends StatefulWidget {
  const _Tabs({super.key});

  @override
  State<_Tabs> createState() => _TabsState();
}

class _TabsState extends State<_Tabs> {
  int index = 0;

  void select(int i) => setState(() => index = i);

  @override
  Widget build(BuildContext context) => IndexedStack(
    index: index,
    children: const [
      KeyframerScreen(name: 'Feed', child: SizedBox()),
      KeyframerScreen(name: 'Profile', child: SizedBox()),
    ],
  );
}

void main() {
  final rt = KfRuntime.instance;
  late List<KfRoute> seen;
  late GlobalKey<NavigatorState> nav;

  setUp(() {
    rt.reset();
    seen = [];
    rt.tapNavigation(seen.add);
    nav = GlobalKey<NavigatorState>();
  });
  tearDown(rt.reset);

  List<String> names() => [for (final r in seen) r.route];

  Route<void> page(Widget child) => MaterialPageRoute<void>(builder: (_) => child);

  test('a page without a name is named after its type, without type arguments', () {
    expect(
      KfNavigatorObserver.routeName(MaterialPageRoute<void>(builder: (_) => const SizedBox())),
      'MaterialPageRoute',
    );
    expect(
      KfNavigatorObserver.routeName(MaterialPageRoute<Map<String, int>>(builder: (_) => const SizedBox())),
      'MaterialPageRoute',
    );
    expect(
      KfNavigatorObserver.routeName(
        MaterialPageRoute<void>(builder: (_) => const SizedBox(), settings: const RouteSettings(name: '/x')),
      ),
      '/x',
    );
  });

  testWidgets('every page is a screen: two pages without a name in a row, one route again with other arguments', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        navigatorKey: nav,
        navigatorObservers: [KfNavigatorObserver()],
        routes: {'/': (_) => const Text('home'), '/item': (_) => const Text('item')},
      ),
    );
    nav.currentState!.push(page(const Text('a')));
    await tester.pumpAndSettle();
    nav.currentState!.push(page(const Text('b')));
    await tester.pumpAndSettle();
    nav.currentState!.pushNamed('/item', arguments: {'id': 1});
    await tester.pumpAndSettle();
    nav.currentState!.pushNamed('/item', arguments: {'id': 2});
    await tester.pumpAndSettle();
    // Back to the first item: another page than the one it leaves.
    nav.currentState!.pop();
    await tester.pumpAndSettle();
    expect(names(), ['/', 'MaterialPageRoute', 'MaterialPageRoute', '/item', '/item', '/item']);
    expect(seen.map((r) => r.params), [
      null,
      null,
      null,
      {'id': 1},
      {'id': 2},
      {'id': 1},
    ]);
  });

  testWidgets('a KeyframerScreen names its page: one marker when it is pushed, and the page on top wins', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        navigatorKey: nav,
        navigatorObservers: [KfNavigatorObserver()],
        home: const KeyframerScreen(name: 'Home', child: Text('home')),
      ),
    );
    // Not '/' first: the page and its KeyframerScreen arrive in the same frame.
    expect(names(), ['Home']);
    nav.currentState!.push(page(const KeyframerScreen(name: 'Details', child: Text('details'))));
    await tester.pump();
    expect(names(), ['Home', 'Details']);
    await tester.pumpAndSettle();
    // A dialog over it is not a screen.
    showDialog<void>(context: nav.currentContext!, builder: (_) => const Text('dialog'));
    await tester.pumpAndSettle();
    nav.currentState!.pop();
    await tester.pumpAndSettle();
    expect(names(), ['Home', 'Details']);
    // A page without one over it: that page, not the covered Details.
    nav.currentState!.push(page(const Text('plain')));
    await tester.pumpAndSettle();
    expect(names().last, 'MaterialPageRoute');
    // Popped: Details again at once, while the plain page is still sliding away.
    nav.currentState!.pop();
    await tester.pump();
    expect(names().last, 'Details');
    await tester.pumpAndSettle();
    nav.currentState!.pop();
    await tester.pumpAndSettle();
    expect(names(), ['Home', 'Details', 'MaterialPageRoute', 'Details', 'Home']);
  });

  testWidgets('without a navigator observer, KeyframerScreens alone name the screens', (tester) async {
    await tester.pumpWidget(
      MaterialApp(navigatorKey: nav, home: const KeyframerScreen(name: 'Home', child: Text('home'))),
    );
    nav.currentState!.push(page(const KeyframerScreen(name: 'Details', child: Text('details'))));
    await tester.pumpAndSettle();
    // Under a page that names nothing, or a dialog: no screen is known, so none is reported.
    nav.currentState!.push(page(const Text('plain')));
    await tester.pumpAndSettle();
    showDialog<void>(context: nav.currentContext!, builder: (_) => const Text('dialog'));
    await tester.pumpAndSettle();
    nav.currentState!.pop();
    await tester.pumpAndSettle();
    nav.currentState!.pop();
    await tester.pumpAndSettle();
    nav.currentState!.pop();
    await tester.pumpAndSettle();
    expect(names(), ['Home', 'Details', 'Home']);
  });

  testWidgets('the latest one mounted is the screen: renamed in place, swapped, and the one under it after', (
    tester,
  ) async {
    final shell = GlobalKey<_ShellState>();
    await tester.pumpWidget(
      MaterialApp(navigatorKey: nav, navigatorObservers: [KfNavigatorObserver()], home: _Shell(key: shell)),
    );
    expect(names(), ['Feed']);
    shell.currentState!.update(() => shell.currentState!.inner = 'Search');
    await tester.pump();
    // The outer one renamed: still under the inner one, so nothing changes.
    shell.currentState!.update(() => shell.currentState!.outer = 'Shell 2');
    await tester.pump();
    expect(names(), ['Feed', 'Search']);
    // One swapped for another in a frame: one marker.
    shell.currentState!.update(() {
      shell.currentState!.tab = 1;
      shell.currentState!.inner = 'Profile';
    });
    await tester.pump();
    expect(names(), ['Feed', 'Search', 'Profile']);
    shell.currentState!.update(() => shell.currentState!.inner = null);
    await tester.pump();
    expect(names().last, 'Shell 2');
    // None left: the observer's page.
    shell.currentState!.update(() => shell.currentState!.shell = false);
    await tester.pump();
    expect(names(), ['Feed', 'Search', 'Profile', 'Shell 2', '/']);
  });

  testWidgets('tabs in an IndexedStack: the selected tab\'s KeyframerScreen is the screen', (tester) async {
    final tabs = GlobalKey<_TabsState>();
    await tester.pumpWidget(MaterialApp(navigatorObservers: [KfNavigatorObserver()], home: _Tabs(key: tabs)));
    tabs.currentState!.select(1);
    await tester.pump();
    tabs.currentState!.select(0);
    await tester.pump();
    expect(names(), ['Feed', 'Profile', 'Feed']);
  });

  testWidgets('setScreen names the screen until the observer or a KeyframerScreen changes it', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        navigatorKey: nav,
        navigatorObservers: [KfNavigatorObserver()],
        routes: {'/': (_) => const Text('home'), '/details': (_) => const Text('details')},
      ),
    );
    KeyframerInspector.setScreen('Feed');
    await tester.pump();
    KeyframerInspector.setScreen('Feed');
    await tester.pump();
    KeyframerInspector.setScreen('Search');
    await tester.pump();
    nav.currentState!.pushNamed('/details');
    await tester.pumpAndSettle();
    nav.currentState!.pop();
    await tester.pumpAndSettle();
    expect(names(), ['/', 'Feed', 'Search', '/details', '/']);
  });

  testWidgets('playback goes back to a page by its KeyframerScreen\'s name, and never pushes such a name', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        navigatorKey: nav,
        navigatorObservers: [KfNavigatorObserver()],
        home: const KeyframerScreen(name: 'Home', child: Text('home')),
        routes: {'/details': (_) => const KeyframerScreen(name: 'Details', child: Text('details'))},
      ),
    );
    // Twice in one frame: the second compares with where the first went, not with the last marker.
    expect(rt.navigateTo('/details'), isTrue);
    expect(rt.navigateTo('Home'), isTrue);
    await tester.pumpAndSettle();
    expect(find.text('home'), findsOneWidget);
    expect(find.text('details'), findsNothing);
    expect(rt.navigateTo('/details'), isTrue);
    await tester.pumpAndSettle();
    expect(rt.currentRoute!.route, 'Details');
    expect(rt.navigateTo('Home'), isTrue);
    await tester.pumpAndSettle();
    expect(find.text('home'), findsOneWidget);
    // Details is gone, and its name is no route.
    expect(rt.navigateTo('Details'), isFalse);
    expect(rt.navigateTo('Home'), isFalse);
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });
}
