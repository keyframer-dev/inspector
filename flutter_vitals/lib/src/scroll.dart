import 'package:flutter/widgets.dart';

import 'vitals.dart';

/// Opens a scroll window while a scrollable below it scrolls (drag and fling), so slow frames there
/// read `scroll` instead of `unknown`. Touches already open a window until 1.5 s after the last finger
/// lifts; this one also covers long flings and scrolls the app drives itself. Wrap the app once, or a
/// screen. It never stops a notification.
class VitalsScrollListener extends StatelessWidget {
  const VitalsScrollListener({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) => NotificationListener<ScrollNotification>(onNotification: _on, child: child);

  static bool _on(ScrollNotification n) {
    final reporter = KeyframerVitals.reporter;
    final r = reporter?.recorder;
    if (r == null) return false;
    if (n is ScrollStartNotification) {
      r.scrollStart(reporter!.clock());
    } else if (n is ScrollEndNotification) {
      r.scrollEnd(reporter!.clock());
    }
    return false;
  }
}
