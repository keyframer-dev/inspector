// Which device an app runs on (`hello.device`), from what Dart can read without a plugin or a method
// channel: on an iOS simulator the environment Xcode gives the apps it launches, else the simulator's
// own device.plist beside the app (an app `simctl` launches gets no SIMULATOR_* variables); Android's
// system properties (getprop); sysctl on Apple hardware; DMI on Linux. The rules for what may be sent live here, platform-neutral;
// transport_io.dart supplies the readers.
//
// Privacy: a simulator's or emulator's id and name identify a test machine. A physical device sends
// its model only, never the name its owner gave it, since recordings get shared.

import 'protocol.dart';

/// Where the facts come from: dart:io's readers in an app, fakes in tests. Each may be missing.
class KfDeviceSources {
  const KfDeviceSources({
    required this.os,
    this.environment = const {},
    this.properties,
    this.sysctl,
    this.readFile,
    this.executable,
  });

  /// `Platform.operatingSystem`: ios, android, macos, linux, windows.
  final String os;
  final Map<String, String> environment;

  /// Android's system properties, as `getprop` lists them to an app.
  final Future<Map<String, String>> Function()? properties;

  /// A sysctl string by name (`hw.machine`, `hw.model`) on Apple platforms.
  final String? Function(String name)? sysctl;
  final Future<String?> Function(String path)? readFile;

  /// `Platform.resolvedExecutable`: inside a simulator, a path under its CoreSimulator device folder.
  final String? executable;
}

/// The device, or null when nothing can be told.
Future<KfDevice?> readDevice(KfDeviceSources s) async {
  final device = switch (s.os) {
    'ios' => await _ios(s),
    'android' => await _android(s),
    // Desktops: the model at most.
    'macos' => KfDevice(model: _clean(s.sysctl?.call('hw.model'))),
    'linux' => KfDevice(model: _clean(await s.readFile?.call('/sys/devices/virtual/dmi/id/product_name'))),
    _ => null,
  };
  return device == null || device.isEmpty ? null : device;
}

Future<KfDevice> _ios(KfDeviceSources s) async {
  final env = s.environment;
  final udid = _clean(env['SIMULATOR_UDID']);
  if (udid != null) {
    return KfDevice(
      id: udid,
      name: _clean(env['SIMULATOR_DEVICE_NAME']),
      model: _clean(env['SIMULATOR_MODEL_IDENTIFIER']),
      simulator: true,
    );
  }
  // Launched by simctl (CI): the app lives in its simulator's device folder, whose device.plist has
  // the simulator's name. Only the UDID and that name leave it, never the path (it holds the Mac's
  // user name). The model identifier is not there.
  final folder = RegExp(r'^(.*/CoreSimulator/Devices/([0-9A-Fa-f-]{36}))/').firstMatch(s.executable ?? '');
  if (folder != null) {
    final plist = await s.readFile?.call('${folder[1]}/device.plist');
    return KfDevice(id: folder[2], name: plist == null ? null : _plistString(plist, 'name'), simulator: true);
  }
  // A physical iPhone or iPad: its hardware model (iPhone17,1), nothing its owner named. An iPad app
  // on a Mac reads the Mac's architecture there, so the Mac's model instead.
  final machine = _clean(s.sysctl?.call('hw.machine'));
  final onMac = machine == 'arm64' || machine == 'x86_64' || machine == 'i386';
  return KfDevice(model: onMac ? _clean(s.sysctl?.call('hw.model')) : machine, simulator: false);
}

/// A string value of an XML property list: `<key>name</key><string>iPhone 17</string>`.
String? _plistString(String plist, String key) {
  final m = RegExp('<key>${RegExp.escape(key)}</key>\\s*<string>([^<]*)</string>').firstMatch(plist);
  final v = m?[1]
      ?.replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&quot;', '"')
      .replaceAll('&apos;', "'")
      .replaceAll('&amp;', '&');
  return _clean(v);
}

Future<KfDevice?> _android(KfDeviceSources s) async {
  final read = s.properties;
  if (read == null) return null;
  final props = await read();
  final model = _clean(props['ro.product.model']);
  final emulator =
      props['ro.boot.qemu'] == '1' ||
      props['ro.kernel.qemu'] == '1' ||
      props['ro.hardware'] == 'ranchu' ||
      props['ro.hardware'] == 'goldfish';
  if (!emulator) return KfDevice(model: model, simulator: false);
  // The AVD's name is the emulator's id and its name (what Android Studio and `emulator -avd` call it).
  final avd = _clean(props['ro.boot.qemu.avd_name']) ?? _clean(props['ro.kernel.qemu.avd_name']);
  return KfDevice(id: avd, name: avd, model: model, simulator: true);
}

/// Parses `getprop`'s listing: `[ro.product.model]: [Pixel 8]` per line.
Map<String, String> parseProperties(String listing) {
  final out = <String, String>{};
  for (final m in RegExp(r'^\[([^\]]+)\]: \[(.*)\]\s*$', multiLine: true).allMatches(listing)) {
    out[m[1]!] = m[2]!;
  }
  return out;
}

String? _clean(String? v) {
  final t = v?.replaceAll('\u0000', '').trim();
  return t == null || t.isEmpty ? null : t;
}
