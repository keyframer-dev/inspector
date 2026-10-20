// Where a widget was written, for what the SDK finds in the widget tree instead of in the app's calls
// (implicit animations, Hero flights, render hints). Flutter's `--track-widget-creation` (on in debug
// builds: `flutter run`, `flutter test`) records the file, line and column of every widget constructor
// call; the widget inspector's serialization delegate is its public way out. Profile and release builds
// have none: callers fall back to names there.

import 'package:flutter/widgets.dart';

import 'call_site.dart';
import 'runtime.dart';

/// Whether widgets carry their creation location in this build.
bool get kfWidgetCreationTracked {
  try {
    return WidgetInspectorService.instance.isWidgetCreationTracked();
  } catch (_) {
    return false;
  }
}

/// A widget's creation location: `{file, line, column}` with `file` a `file://` URI, or null.
Map<String, Object?>? _creation(Widget widget) {
  try {
    // A delegate per call: one kept around would also keep every node it saw.
    final props = InspectorSerializationDelegate(
      service: WidgetInspectorService.instance,
    ).additionalNodeProperties(widget.toDiagnosticsNode());
    final location = props['creationLocation'];
    return location is Map ? location.cast<String, Object?>() : null;
  } catch (_) {
    return null;
  }
}

/// Files that are not the app's own: Flutter itself and packages from the pub cache.
bool _foreign(String path) =>
    path.contains('/packages/flutter/') ||
    path.contains('/.pub-cache/') ||
    path.contains('/pub-cache/') ||
    path.contains('/flutter/bin/cache/') ||
    path.startsWith('package:flutter/');

/// A creation location's file as the URI a stack frame would print, so the runtime maps it like any
/// call site: `package:<app>/x.dart` for the app's `lib/x.dart`, a `file://` URI inside `root` as it is
/// (made relative later), anything else unchanged.
String creationUri(String file, {String? appPackage, String? root}) {
  var path = file;
  if (file.startsWith('file://')) {
    try {
      path = Uri.parse(file).toFilePath();
    } catch (_) {}
  } else if (file.startsWith('org-dartlang-app:///')) {
    // Flutter web's debug builds name the app's files from its root.
    path = file.substring('org-dartlang-app://'.length);
  }
  if (root != null && root.isNotEmpty) {
    final base = root.endsWith('/') ? root : '$root/';
    if (path.startsWith(base)) {
      final rel = path.substring(base.length);
      if (appPackage != null && rel.startsWith('lib/')) return 'package:$appPackage/${rel.substring(4)}';
      return 'file://$path';
    }
  }
  final lib = path.lastIndexOf('/lib/');
  if (appPackage != null && lib >= 0 && !_foreign(path)) return 'package:$appPackage/${path.substring(lib + 5)}';
  return file;
}

/// Where `element`'s widget was created, as a stack frame whose member names the component that
/// built it (`HomeScreen.build`), when it is the app's own code. Null without creation tracking, or for
/// a widget Flutter or another package created.
KfStackFrame? appWidgetFrame(Element element, KfRuntime runtime) {
  final loc = _creation(element.widget);
  if (loc == null) return null;
  final file = loc['file'], line = loc['line'], column = loc['column'];
  if (file is! String || line is! int || _foreign(file)) return null;
  final uri = creationUri(file, appPackage: runtime.appPackage, root: runtime.root);
  final component = _creator(element, file, line);
  return KfStackFrame(component == null ? '<build>' : '$component.build', uri, line, column is int ? column : 0);
}

/// The nearest widget the app created at or above `element` (a Card for the Material inside it), for
/// what Flutter builds on the app's behalf. Null without creation tracking.
(Element, KfStackFrame)? nearestAppWidget(Element element, KfRuntime runtime, {int maxDepth = 40}) {
  final own = appWidgetFrame(element, runtime);
  if (own != null) return (element, own);
  (Element, KfStackFrame)? found;
  var depth = 0;
  element.visitAncestorElements((a) {
    final f = appWidgetFrame(a, runtime);
    if (f != null) {
      found = (a, f);
      return false;
    }
    return ++depth < maxDepth;
  });
  return found;
}

/// The component whose build created the widget at `file:line`: the nearest ancestor stateless or
/// stateful widget the app created whose own built widget (its only child) was written in the same
/// file, at or before that line. Its build method is where both were written. Flutter's wrappers
/// around a child the app passed in (a list's KeyedSubtree, an AppBar's parts) were not created by the
/// app, and a builder's child is written inside the component that made the builder: both are skipped.
String? _creator(Element element, String file, int line) {
  String? name;
  var depth = 0;
  element.visitAncestorElements((a) {
    if ((a is StatelessElement || a is StatefulElement) && !_builders.contains(_typeName(a.widget))) {
      final own = _creation(a.widget);
      final ownFile = own?['file'];
      if (ownFile is String && !_foreign(ownFile)) {
        Element? child;
        a.visitChildElements((c) => child = c);
        final built = child == null ? null : _creation(child!.widget);
        if (built != null && built['file'] == file && built['line'] is int && (built['line'] as int) <= line) {
          name = _typeName(a.widget);
          return false;
        }
      }
    }
    return ++depth < 200;
  });
  return name;
}

const _builders = {
  'Builder',
  'StatefulBuilder',
  'AnimatedBuilder',
  'ListenableBuilder',
  'ValueListenableBuilder',
  'TweenAnimationBuilder',
  'StreamBuilder',
  'FutureBuilder',
  'OrientationBuilder',
};

/// `TweenAnimationBuilder<double>` is `TweenAnimationBuilder`.
String _typeName(Object o) {
  final s = o.runtimeType.toString();
  final i = s.indexOf('<');
  return i < 0 ? s : s.substring(0, i);
}

/// A widget's type without type arguments, as the panel names it.
String widgetTypeName(Widget w) => _typeName(w);
