## 0.3.0

- `KeyframerScreen(name: 'Settings', child: ...)` names the screen it is in while it is shown, for what
  the navigator cannot name (a page pushed without a name, a tab, a pager's page, a custom router's
  screen). The latest one still shown wins; when it goes, the one under it does again, else the
  navigator's page. `KeyframerInspector.setScreen('Feed')` does the same from code, for a pager that
  keeps its pages alive (from `onPageChanged`).
- Every page is a screen of its own: two pages under one name in a row, or one route pushed again with
  other arguments, are two `navigation` markers. A page without a name is called by its route's type
  without type arguments (`MaterialPageRoute`). A nested navigator needs a `KfNavigatorObserver()` of
  its own.
- `--dart-define=KEYFRAMER_INSPECTOR=false` turns the inspector off in any build: no connection, and
  controllers capture no call sites. `=true` turns it on in any build; `enabled:` decides over both.
- Animation starts cost far less. A controller's creation stack is read only once an inspector is
  installed. A start's stack is read only as far as its first app frame (the rest only while recording)
  and printed between frames, when its batch is sent, unless one of the panel's edits could apply to
  that call. In a profile build, a start while connected went from 28 to 36 µs to 2.7 µs, and a deep
  start while recording from 0.84 to 0.91 ms to 12 to 14 µs inside the frame.
- `anim` events are built when their batch is sent (every 100 ms): their `eid`, `at`, `t` and order are
  the start's, a batch builds at most 4 ms of them (the rest go with the next), nothing is built while
  disconnected, and a start whose stack cannot be read is left out.
- Long frames on the UI isolate carry `inspectorMs`, the inspector's own time on it since the frame
  before (from 0.5 ms), so the analysis can leave out the drops the inspector caused. New:
  `KfFrameDrop.inspectorMs` and `FrameMeter.tick(t, inspectorMs:)`. Raster drops carry none.
- Stacks are read by hand instead of through regular expressions, and formatted in one pass.
- `visibility` markers are sent for recorded values only, and a value created again at the same id
  (its screen opened again) starts afresh.

## 0.2.0

- Slow motion, pause and step (the `time` message and capability): speeds through `timeDilation`, a
  pause by holding the scheduler's frame time stamps, steps by one frame at the display's rate. Every
  animation in the app follows it, tracked or not. Answered with `time`; `time` markers while recording;
  back to normal speed when the last editor leaves. `KfClock` runs it.
- The hello says the display (`display`: refresh rate, adaptive) and the person's motion settings
  (`accessibility`: `reduceMotion`), and changes while recording are `display`, `accessibility` and
  `appState` markers. Frames are counted against the display's rate instead of 60 Hz.
- Implicit animations (`AnimatedContainer`, `AnimatedOpacity`, `TweenAnimationBuilder` and the other
  ImplicitlyAnimatedWidgets the app writes) are values while recording, with an animation each time one
  starts, located where the widget was written (debug builds). `Hero` flights are animations too,
  reported by `KfNavigatorObserver`.
- `visibility` markers: a value that keeps moving while its widgets are detached, hidden, off screen or
  covered by another screen.
- Render hints (`renderHint` events): an `Opacity` whose opacity animates, blurs over moving content,
  `ClipPath` and `ShaderMask` around it, clips that save a layer.
- Flutter web: a transport on the browser's WebSocket (package:web), picked by a conditional import, so
  `flutter build web` (and `--wasm`) works. Compiled web stacks no longer pass for call sites, and a
  debug web build's mapped stacks name the app's lines.
- The hello names the device (`device`), so a relay or a CI run tells apps apart: a simulator's or
  emulator's id and name (iOS simulators also when `simctl` launched them), a physical device's model
  only, never its owner's name for it. Read in plain Dart (the environment, getprop, sysctl through
  dart:ffi); `currentDevice` is exported.
- `time` follows the rule every SDK shares: a bad scale changes nothing (still answered), 0 pauses, 0.01
  to 1, `step` only while paused in whole frames from 1 to 120. Going back to 1x when the last editor
  leaves is announced (`time` 1) every time, and after the next hello when the connection dropped.
- `record` takes a `recorder`: several editors record at once, and one stopping leaves the others
  recording. All of them go when the last editor leaves or the connection drops.
- `widget-sites` in the hello's capabilities when widget creation is tracked (not in `flutter build ios
  --debug`), and a console line in a debug build without it: implicit animations and Hero flights need it.
- Implicit animations say what they animate (`prop`: `opacity` for AnimatedOpacity, and so on), so a fade
  is told from motion.
- A loop whose widget a lazy list scrolled away is `offscreen`, no longer judged by its (visible) State.
- Instances of one call site with names of their own keep them (no more "row1 #2").
- `KfHost` is unchanged: the new parts are optional interfaces (`KfDeviceHost`, `KfTimeHost`,
  `KfSceneHost`) that `FlutterKfHost` implements. `connectRelaySocket` connects on any platform.

## 0.1.1

- Builds on current Flutter: `KfAnimationController.repeat` takes `count` (added to
  `AnimationController.repeat` in Flutter 3.27) and reports it to the panel. 0.1.0 failed to compile
  on Flutter 3.27 and later.
- Requires Flutter 3.29 (Dart 3.7) or later.
- Formatted with `dart format` (page width 120).

## 0.1.0

- First release on pub.dev: connection and hello, signals with call sites, anim events, frame stats for
  the UI and raster threads, touch and navigation markers, playback, capture, scenarios, and protocol 1
  (threads by role, durations, scrub, reload).

## 0.0.1

- First vertical slice: connection and hello, signals with call sites, anim events, frame stats for the UI and raster threads, touch and navigation markers, playback, capture, scenarios.
