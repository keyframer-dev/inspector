import 'dart:async';
import 'dart:developer' show Timeline;
import 'dart:math' as math;

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/physics.dart';
import 'package:keyframer_inspector/keyframer_inspector.dart';

void main() {
  runApp(
    const KeyframerInspector(app: 'Flutter example', appPackage: 'keyframer_inspector_example', child: ExampleApp()),
  );
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
      routes: {'/': (_) => const HomeScreen(), '/details': (_) => const DetailsScreen()},
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
  late final _entrance = KfAnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 700),
    name: 'entrance',
  );
  // The loop: a dot that breathes forever.
  late final _pulse = KfAnimationController(vsync: this, duration: const Duration(milliseconds: 1200), name: 'pulse');
  // The gesture: a card dragged sideways (-1 to 1) that springs back when let go.
  late final _drag = KfAnimationController(vsync: this, lowerBound: -1, upperBound: 1, value: 0, name: 'drag');
  final _cardKey = GlobalKey();
  final List<void Function()> _unregister = [];
  // An implicit animation: the inspector finds AnimatedContainer and friends while it records.
  bool _expanded = false;

  @override
  void initState() {
    super.initState();
    _entrance.forward();
    _pulse.repeat(reverse: true);
    _unregister
      ..add(registerReplay(_replay))
      ..add(registerScenario('drag card', _dragScenario))
      ..add(
        registerScenario('expand', () async {
          setState(() => _expanded = !_expanded);
          await Future<void>.delayed(const Duration(milliseconds: 600));
        }),
      )
      ..add(
        registerScenario('open details', () async {
          unawaited(navigatorKey.currentState!.pushNamed('/details', arguments: {'id': 7}));
          await Future<void>.delayed(const Duration(milliseconds: 1400));
          navigatorKey.currentState!.pop();
          await Future<void>.delayed(const Duration(milliseconds: 500));
        }),
      );
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
    // On the engine's clock from where the drag starts, counted by a stopwatch: on the web Timeline.now
    // does not move between events, so a drag stamped with it would read as one jump.
    final start = Timeline.now;
    final clock = Stopwatch()..start();
    Duration stamp() => Duration(microseconds: start + clock.elapsedMicroseconds);
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
          // An Opacity rebuilt every frame: the inspector reports it as a render hint ("opacity-widget");
          // FadeTransition(opacity: entrance) would not rebuild or repaint.
          AnimatedBuilder(
            animation: entrance,
            builder:
                (context, child) => Opacity(
                  opacity: entrance.value,
                  child: Transform.translate(offset: Offset(0, 40 * (1 - entrance.value)), child: child),
                ),
            child: Text('Recorded, traced, replayed.', style: Theme.of(context).textTheme.headlineSmall),
          ),
          const SizedBox(height: 32),
          Row(
            children: [
              AnimatedBuilder(
                animation: _pulse,
                builder:
                    (context, _) => Container(
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
            ],
          ),
          const SizedBox(height: 32),
          GestureDetector(
            onHorizontalDragUpdate: _onDragUpdate,
            onHorizontalDragEnd: _onDragEnd,
            child: AnimatedBuilder(
              animation: _drag,
              builder:
                  (context, child) => Transform.translate(
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
          GestureDetector(
            onTap: () => setState(() => _expanded = !_expanded),
            child: AnimatedContainer(
              duration: const Duration(milliseconds: 450),
              curve: Curves.easeOutBack,
              height: _expanded ? 140 : 72,
              decoration: BoxDecoration(
                color: _expanded ? const Color(0xFFE5484D) : const Color(0xFF6E56CF),
                borderRadius: BorderRadius.circular(_expanded ? 28 : 12),
              ),
              alignment: Alignment.center,
              child: AnimatedOpacity(
                duration: const Duration(milliseconds: 300),
                opacity: _expanded ? 1 : 0.6,
                child: const Text('Tap me: implicit animations', style: TextStyle(color: Colors.white)),
              ),
            ),
          ),
          const SizedBox(height: 32),
          Row(
            children: [
              // Flies to the details screen's header (a Hero flight).
              const Hero(tag: 'badge', child: CircleAvatar(radius: 18, child: Icon(Icons.bar_chart, size: 18))),
              const SizedBox(width: 16),
              FilledButton(
                onPressed: () => Navigator.of(context).pushNamed('/details', arguments: {'id': 7}),
                child: const Text('Open details'),
              ),
            ],
          ),
        ],
      ),
    );
  }

  /// A clean state for each run: back on this screen (a scenario cut short can leave details open), then
  /// the entrance again.
  void _replay() {
    navigatorKey.currentState?.popUntil((route) => route.isFirst);
    _entrance.forward(from: 0);
  }
}

class DetailsScreen extends StatefulWidget {
  const DetailsScreen({super.key});

  @override
  State<DetailsScreen> createState() => _DetailsScreenState();
}

class _DetailsScreenState extends State<DetailsScreen> with SingleTickerProviderStateMixin {
  // Room above 1: easeOutBack overshoots, and a controller clamps its value to its bounds.
  late final _bars = KfAnimationController(vsync: this, upperBound: 1.2, name: 'bars');

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
      appBar: AppBar(
        title: const Row(
          children: [
            Hero(tag: 'badge', child: CircleAvatar(radius: 14, child: Icon(Icons.bar_chart, size: 14))),
            SizedBox(width: 12),
            Text('Details'),
          ],
        ),
      ),
      body: Padding(
        padding: const EdgeInsets.all(24),
        child: AnimatedBuilder(
          animation: _bars,
          builder:
              (context, _) => Row(
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
