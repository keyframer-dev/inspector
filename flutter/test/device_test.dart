// Which device the hello names: simulators and emulators by id and name, physical devices by model only.

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:keyframer_inspector/keyframer_inspector.dart';
import 'package:keyframer_inspector/src/device.dart';
import 'package:keyframer_inspector/src/sysctl_io.dart';

/// What an emulator's app reads from getprop (trimmed), and a phone's.
const _emulator = '''
[ro.boot.qemu]: [1]
[ro.boot.qemu.avd_name]: [Pixel_4_API_VanillaIceCream]
[ro.hardware]: [ranchu]
[ro.product.model]: [sdk_gphone64_arm64]
''';
const _phone = '''
[ro.hardware]: [tensor]
[ro.product.model]: [Pixel 8]
[ro.product.name]: [shiba]
[persist.sys.device_name]: [Catalin's Pixel]
''';

void main() {
  test('an iOS simulator: its UDID, name and model from the environment it gives its apps', () async {
    final d = await readDevice(
      KfDeviceSources(
        os: 'ios',
        environment: const {
          'SIMULATOR_UDID': '9DD2965C-1BCE-4E5C-AE3F-3388ECC39672',
          'SIMULATOR_DEVICE_NAME': 'iPhone 17 Pro',
          'SIMULATOR_MODEL_IDENTIFIER': 'iPhone18,1',
        },
        sysctl: (_) => 'arm64',
      ),
    );
    expect(d!.toJson(), {
      'name': 'iPhone 17 Pro',
      'model': 'iPhone18,1',
      'id': '9DD2965C-1BCE-4E5C-AE3F-3388ECC39672',
      'simulator': true,
    });
  });

  test('an iOS simulator launched by simctl (no SIMULATOR_* variables): its folder and device.plist', () async {
    const folder = '/Users/someone/Library/Developer/CoreSimulator/Devices/5D57941A-D70D-47AB-B0B6-0F68320EB22D';
    final read = <String>[];
    final d = await readDevice(
      KfDeviceSources(
        os: 'ios',
        executable: '$folder/data/Containers/Bundle/Application/92A8BD12-2712-4D36-9F33-E559829E152A/Runner.app/Runner',
        sysctl: (_) => 'arm64',
        readFile: (path) async {
          read.add(path);
          return '<plist><dict><key>UDID</key><string>5D57941A-D70D-47AB-B0B6-0F68320EB22D</string>'
              '<key>name</key>\n\t<string>CI &amp; iPhone 17</string></dict></plist>';
        },
      ),
    );
    expect(read, ['$folder/device.plist']);
    expect(d!.toJson(), {'name': 'CI & iPhone 17', 'id': '5D57941A-D70D-47AB-B0B6-0F68320EB22D', 'simulator': true});
    // The path (with the Mac's user name) never leaves.
    expect(d.toString(), isNot(contains('someone')));
  });

  test("an iPad app on a Mac: the Mac's model, not its architecture", () async {
    final d = await readDevice(
      KfDeviceSources(
        os: 'ios',
        executable: '/Applications/Demo.app/Wrapper/Runner.app/Runner',
        sysctl: (n) => n == 'hw.machine' ? 'arm64' : 'Mac15,3',
      ),
    );
    expect(d!.toJson(), {'model': 'Mac15,3', 'simulator': false});
  });

  test('a physical iPhone: its model only', () async {
    final d = await readDevice(
      KfDeviceSources(os: 'ios', sysctl: (name) => name == 'hw.machine' ? 'iPhone17,1' : null),
    );
    expect(d!.toJson(), {'model': 'iPhone17,1', 'simulator': false});
  });

  test('an Android emulator: its AVD as id and name, and its model', () async {
    final d = await readDevice(KfDeviceSources(os: 'android', properties: () async => parseProperties(_emulator)));
    expect(d!.toJson(), {
      'name': 'Pixel_4_API_VanillaIceCream',
      'model': 'sdk_gphone64_arm64',
      'id': 'Pixel_4_API_VanillaIceCream',
      'simulator': true,
    });
  });

  test('a physical Android phone: its model only, never the name its owner gave it', () async {
    final d = await readDevice(KfDeviceSources(os: 'android', properties: () async => parseProperties(_phone)));
    expect(d!.toJson(), {'model': 'Pixel 8', 'simulator': false});
    expect(d.toString(), isNot(contains('Catalin')));
  });

  test('desktops: the model at most; nothing to tell is no device', () async {
    expect(
      (await readDevice(KfDeviceSources(os: 'macos', sysctl: (n) => n == 'hw.model' ? 'Mac15,3' : null)))!.toJson(),
      {'model': 'Mac15,3'},
    );
    expect((await readDevice(KfDeviceSources(os: 'linux', readFile: (_) async => 'XPS 13 9310\n')))!.toJson(), {
      'model': 'XPS 13 9310',
    });
    expect(await readDevice(const KfDeviceSources(os: 'windows')), isNull);
    expect(await readDevice(KfDeviceSources(os: 'linux', readFile: (_) async => null)), isNull);
    expect(await readDevice(const KfDeviceSources(os: 'android')), isNull);
  });

  test('getprop listings parse, odd lines skipped', () {
    expect(parseProperties('[a]: [1]\nnoise\n[b.c]: []\n[d]: [x y]\n'), {'a': '1', 'b.c': '', 'd': 'x y'});
  });

  test('on this machine: what the app would send', () async {
    final d = await currentDevice();
    if (Platform.isMacOS) {
      // sysctl through dart:ffi: the Mac's model, and nothing that names it.
      expect(d!.model, matches(RegExp(r'^[A-Za-z]+\d+,\d+$')));
      expect(d.toJson().keys, ['model']);
      expect(darwinSysctl('hw.machine'), anyOf('arm64', 'x86_64'));
      expect(darwinSysctl('kf.no.such.name'), isNull);
    } else {
      expect(d?.name, isNull);
    }
  });
}
