// A small app with Motion Vitals: two screens, a list and a named animation.
//
// Release builds report as production. To see this app's reports while you build it, run it in debug
// with the development environment below and turn on development builds for the project in the
// dashboard (Settings, Development builds).
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:keyframer_vitals/keyframer_vitals.dart';

void main() {
  KeyframerVitals.start(
    key: 'kfp_live_…', // the project's field key, from the dashboard (public by design)
    appVersion: '1.0.0', // package_info_plus: info.version
    build: '1', // package_info_plus: info.buildNumber
    appPackage: 'keyframer_vitals_example', // your pubspec name: call sites read lib/x.dart
    environment: kReleaseMode ? null : VitalsEnvironment.development,
  );
  runApp(const ExampleApp());
}

class ExampleApp extends StatelessWidget {
  const ExampleApp({super.key});

  @override
  Widget build(BuildContext context) {
    return VitalsScrollListener(
      child: MaterialApp(
        title: 'Motion Vitals',
        // Screens come from the navigator, and so do route transitions and Hero flights.
        navigatorObservers: [KeyframerVitals.navigatorObserver],
        routes: {'/': (_) => const FeedScreen(), '/detail': (_) => const DetailScreen()},
      ),
    );
  }
}

class FeedScreen extends StatelessWidget {
  const FeedScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Feed')),
      body: ListView.builder(
        itemCount: 200,
        itemBuilder: (context, i) => ListTile(
          leading: Hero(
            tag: 'avatar-$i',
            child: CircleAvatar(child: Text('$i')),
          ),
          title: Text('Item $i'),
          onTap: () => Navigator.pushNamed(context, '/detail', arguments: i),
        ),
      ),
    );
  }
}

class DetailScreen extends StatefulWidget {
  const DetailScreen({super.key});

  @override
  State<DetailScreen> createState() => _DetailScreenState();
}

class _DetailScreenState extends State<DetailScreen> with SingleTickerProviderStateMixin {
  // `AnimationController(` becomes `VitalsAnimationController(name: …, `: every run is counted against
  // 'card-expand' in the dashboard.
  late final VitalsAnimationController _expand = VitalsAnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 400),
    name: 'card-expand',
  );

  @override
  void dispose() {
    _expand.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final i = ModalRoute.of(context)!.settings.arguments as int? ?? 0;
    return Scaffold(
      appBar: AppBar(title: Text('Item $i')),
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Hero(
              tag: 'avatar-$i',
              child: CircleAvatar(radius: 40, child: Text('$i')),
            ),
            const SizedBox(height: 24),
            SizeTransition(
              sizeFactor: CurvedAnimation(parent: _expand, curve: Curves.easeOutCubic),
              child: const Padding(padding: EdgeInsets.all(16), child: Text('More about this item.')),
            ),
            TextButton(
              onPressed: () => _expand.isCompleted ? _expand.reverse() : _expand.forward(),
              child: const Text('Toggle details'),
            ),
          ],
        ),
      ),
    );
  }
}
