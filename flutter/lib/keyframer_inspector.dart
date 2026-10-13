/// The Keyframer runtime inspector for Flutter: reports animations with their call sites, samples
/// animated values, measures frames and replays recordings over the same protocol as the React Native
/// inspector, through the local relay (`ws://127.0.0.1:8790`).
library keyframer_inspector;

export 'src/call_site.dart' show KfStackFrame, parseStackTrace, appFrame, sourceFile, componentOf, formatStack, inspectorFrames;
export 'src/client.dart' show KfInspectorClient, KfSocket, KfConnector, KfHost, KfTiming, KfTouch, sanitizeArgs;
export 'src/controller.dart' show KfAnimationController, KfTrackController, KfTrackNotifier, curveName, kfCaptureSites;
export 'src/flutter_host.dart' show FlutterKfHost;
export 'src/frame_meter.dart' show FrameMeter;
export 'src/inspector.dart'
    show KeyframerInspector, KfInspectorConnection, connectKeyframerInspector, registerReplay, registerScenario, kfInspectorDefaultEnabled;
export 'src/navigation.dart' show KfNavigatorObserver, kfNavigatorObserver;
export 'src/protocol.dart';
export 'src/runtime.dart' show KfRuntime, KfSignal, KfSink;
export 'src/transport.dart' show relayAppUrl, defaultRelayHost, kfRelayPort, IoKfSocket, currentOs, currentOsVersion;
