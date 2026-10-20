import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:keyframer_vitals/src/mask.dart';
import 'package:keyframer_vitals/src/protocol.dart';

import 'support.dart';

void main() {
  test('the sdk version matches pubspec.yaml', () {
    final pubspec = File('pubspec.yaml').readAsStringSync();
    expect(RegExp(r'^version: (\S+)$', multiLine: true).firstMatch(pubspec)![1], vitalsSdkVersion);
  });

  test('constants mirror protocol/src/vitals.ts', () {
    final ts = File(protocolSource('vitals.ts')).readAsStringSync();
    expect(ts, contains("VITALS_FORMAT = '$vitalsFormat'"));
    expect(ts, contains('VITALS_BUCKETS = [${vitalsBuckets.join(', ')}]'));
    expect(ts, contains('VITALS_FROZEN_MS = ${vitalsFrozenMs.round()}'));
    expect(ts, contains('VITALS_MAX_SESSIONS_PER_DAY = $vitalsMaxSessionsPerDay'));
    expect(ts, contains('VITALS_DEFAULT_SAMPLE_RATE = $vitalsDefaultSampleRate'));
    expect(
      ts,
      contains(
        'VITALS_LIMITS = { screens: $vitalsMaxScreens, sites: $vitalsMaxSites, worst: 10, images: $vitalsMaxImages, bytes: 32 * 1024, screenName: $vitalsScreenNameMax }',
      ),
    );
    expect(ts, contains("VITALS_ENDPOINT = '$vitalsEndpoint'"));
  });

  test('buckets by frames missed', () {
    expect([0, 1, 2, 3, 4, 5, 8, 9, 16, 17, 32, 33, 500].map(bucketOf), [0, 1, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7]);
  });

  test('reads the fixture config and the stop response', () {
    final c = VitalsConfig.fromJson(jsonDecode(fixture('config.json')))!;
    expect(c.sampleRate, 0.3);
    expect(c.minSdk, '0.0.1');
    expect(c.collectDeviceModel, isTrue);
    expect(c.collectReduceMotion, isFalse);
    expect(c.ttlSec, 86400);
    expect(c.stop, isFalse);
    final stop = VitalsConfig.fromJson((jsonDecode(fixture('ingest-response-stop.json')) as Map)['config'])!;
    expect(stop.stop, isTrue);
    expect(stop.enabled, isFalse);
    // Round trip through the cache.
    expect(VitalsConfig.fromJson(c.toJson())!.toJson(), c.toJson());
    expect(VitalsConfig.fromJson('nope'), isNull);
  });

  test('compares versions numerically', () {
    expect(compareVersions('0.1.0', '1.0.0'), -1);
    expect(compareVersions('0.10.0', '0.9.2'), 1);
    expect(compareVersions('1.0.0-beta.1', '1.0.0'), 0);
    expect(compareVersions('1.2', '1.2.0'), 0);
  });

  group('masking', () {
    test('as redact.ts maskText does', () {
      expect(maskText('mail ada.l@example.co.uk now'), 'mail [email] now');
      expect(maskText('card 4111 1111 1111 1111 ok'), 'card [number] ok');
      expect(maskText('call +1 (555) 123-4567'), 'call [number]');
      expect(maskText('order 1234567 failed'), 'order [number] failed');
      expect(maskText('id 3f2b8c1e-9d4a-4b2e-8f00-123456789abc'), 'id [id]');
      expect(maskText('Authorization: Bearer abcDEF123456789xyz'), 'Authorization: Bearer [token]');
      // Built at run time so the public assembly's secret scan never sees a key-shaped literal.
      expect(maskText('key kf_${'0123456789abcdef' * 2}'), 'key [token]');
      expect(maskText('sk-live_abcdefgh12345678'), '[token]');
      expect(maskText('GET /api?token=s3cr3t&page=2'), 'GET /api?token=[redacted]&page=2');
      expect(maskText('session a1b2c3d4e5f6a1b2c3d4e5f6a1b2'), 'session [token]');
      expect(maskText('withSpring took 120ms'), 'withSpring took 120ms');
    });

    test('screen names are masked and cut to 64', () {
      expect(screenName('/users/12345'), '/users/[number]');
      expect(screenName('Profile ada@example.com'), 'Profile [email]');
      expect(screenName('/a' * 50), hasLength(64));
      expect(screenName('  '), '(unnamed)');
      // Never half a surrogate pair.
      final emoji = '${'x' * 63}😀';
      expect(screenName(emoji), 'x' * 63);
    });

    test('hero tags fold their numbers', () {
      expect(heroName('avatar-42'), 'Hero(avatar-#)');
      expect(heroName('photo ada@example.com'), 'Hero(photo [email])');
    });
  });
}
