import 'dart:async';
import 'dart:developer' show Timeline;
import 'dart:math' as math;

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/physics.dart';
import 'package:keyframer_inspector/keyframer_inspector.dart';

void main() {
  runApp(const KeyframerInspector(
    app: 'Flutter example',
    appPackage: 'keyframer_inspector_example',
    child: ExampleApp(),
  ));
}

final navigatorKey = GlobalKey<NavigatorState>();

class ExampleApp extends StatelessWidget {
  const ExampleApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Keyframer example',
      navigatorKey: navigatorKey,
      navigatorObservers: [kfNavigatorObserver],
      theme: ThemeData(colorSchemeSeed: const Color(0xFF6E56CF), useMaterial3: true),
      routes: {
        '/': (_) => const HomeScreen(),
        '/details': (_) => const DetailsScreen(),
      },
    );
  }
}

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> with TickerProviderStateMixin {
  // The entrance: the header slides up and fades in once.
  late final _entrance = KfAnimationController(vsync: this, duration: const Duration(milliseconds: 700), name: 'entrance');
  // The loop: a dot that breathes forever.
  late final _pulse = KfAnimationController(vsync: this, duration: const Duration(milliseconds: 1200), name: 'pulse');
  // The gesture: a card dragged sideways (-1 to 1) that springs back when let go.
  late final _drag = KfAnimationController(vsync: this, lowerBound: -1, upperBound: 1, value: 0, name: 'drag');
  final _cardKey = GlobalKey();
  final List<void Function()> _unregister = [];

  @override
  void initState() {
    super.initState();
    _entrance.forward();
    _pulse.repeat(reverse: true);
    _unregister
      ..add(registerReplay(() => _entrance.forward(from: 0)))
      ..add(registerScenario('drag card', _dragScenario))
      ..add(registerScenario('open details', () async {
        unawaited(navigatorKey.currentState!.pushNamed('/details', arguments: {'id': 7}));
        await Future<void>.delayed(const Duration(milliseconds: 1400));
        navigatorKey.currentState!.pop();
        await Future<void>.delayed(const Duration(milliseconds: 500));
      }));
  }

  @override
  void dispose() {
    for (final u in _unregister) {
      u();
    }
    _entrance.dispose();
    _pulse.dispose();
    _drag.dispose();
    super.dispose();
  }

  double get _halfWidth => MediaQuery.sizeOf(context).width / 2;

  void _onDragUpdate(DragUpdateDetails d) {
    _drag.value = (_drag.value + d.delta.dx / _halfWidth).clamp(-1.0, 1.0);
  }

  void _onDragEnd(DragEndDetails d) {
    const spring = SpringDescription(mass: 1, stiffness: 180, damping: 14);
    _drag.animateWith(SpringSimulation(spring, _drag.value, 0, d.primaryVelocity! / _halfWidth));
  }

  /// A real drag through the gesture system: pointer events in, the same path a finger takes.
  Future<void> _dragScenario() async {
    final box = _cardKey.currentContext!.findRenderObject() as RenderBox;
    final center = box.localToGlobal(box.size.center(Offset.zero));
    const pointer = 4242;
    Duration stamp() => Duration(microseconds: Timeline.now);
    void send(PointerEvent e) => GestureBinding.instance.handlePointerEvent(e);
    send(PointerDownEvent(pointer: pointer, position: center, timeStamp: stamp()));
    var at = center;
    for (var i = 0; i < 18; i++) {
      await Future<void>.delayed(const Duration(milliseconds: 16));
      final next = center + Offset(140 * math.sin((i + 1) / 18 * math.pi / 2), 0);
      send(PointerMoveEvent(pointer: pointer, position: next, delta: next - at, timeStamp: stamp()));
      at = next;
    }
    send(PointerUpEvent(pointer: pointer, position: at, timeStamp: stamp()));
    await Future<void>.delayed(const Duration(milliseconds: 900));
  }

  @override
  Widget build(BuildContext context) {
    final entrance = CurvedAnimation(parent: _entrance, curve: Curves.easeOutCubic);
    return Scaffold(
      appBar: AppBar(title: const Text('Keyframer inspector')),
      body: ListView(
        padding: const EdgeInsets.all(24),
        children: [
          AnimatedBuilder(
            animation: entrance,
            builder: (context, child) => Opacity(
              opacity: entrance.value,
              child: Transform.translate(offset: Offset(0, 40 * (1 - entrance.value)), child: child),
            ),
            child: Text('Recorded, traced, replayed.', style: Theme.of(context).textTheme.headlineSmall),
          ),
          const SizedBox(height: 32),
          Row(children: [
            AnimatedBuilder(
              animation: _pulse,
              builder: (context, _) => Container(
                width: 28 + 20 * _pulse.value,
                height: 28 + 20 * _pulse.value,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: Color.lerp(const Color(0xFF6E56CF), const Color(0xFFE5484D), _pulse.value),
                ),
              ),
            ),
            const SizedBox(width: 16),
            const Text('A loop'),
          ]),
          const SizedBox(height: 32),
          GestureDetector(
            onHorizontalDragUpdate: _onDragUpdate,
            onHorizontalDragEnd: _onDragEnd,
            child: AnimatedBuilder(
              animation: _drag,
              builder: (context, child) => Transform.translate(
                offset: Offset(_drag.value * _halfWidth * 0.8, 0),
                child: Transform.rotate(angle: _drag.value * 0.25, child: child),
              ),
              child: Card(
                key: _cardKey,
                child: const SizedBox(height: 120, child: Center(child: Text('Drag me sideways'))),
              ),
            ),
          ),
          const SizedBox(height: 32),
          FilledButton(
            onPressed: () => Navigator.of(context).pushNamed('/details', arguments: {'id': 7}),
            child: const Text('Open details'),
          ),
        ],
      ),
    );
  }
}

class DetailsScreen extends StatefulWidget {
  const DetailsScreen({super.key});

  @override
  State<DetailsScreen> createState() => _DetailsScreenState();
}

class _DetailsScreenState extends State<DetailsScreen> with SingleTickerProviderStateMixin {
  late final _bars = KfAnimationController(vsync: this, name: 'bars');

  @override
  void initState() {
    super.initState();
    _bars.animateTo(1, duration: const Duration(milliseconds: 900), curve: Curves.easeOutBack);
  }

  @override
  void dispose() {
    _bars.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    const heights = [0.4, 0.75, 0.55, 1.0, 0.65];
    return Scaffold(
      appBar: AppBar(title: const Text('Details')),
      body: Padding(
        padding: const EdgeInsets.all(24),
        child: AnimatedBuilder(
          animation: _bars,
          builder: (context, _) => Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              for (final h in heights)
                Expanded(
                  child: Container(
                    margin: const EdgeInsets.symmetric(horizontal: 6),
                    height: 220 * h * _bars.value.clamp(0.0, 1.2),
                    decoration: BoxDecoration(
                      color: Theme.of(context).colorScheme.primary,
                      borderRadius: BorderRadius.circular(8),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
