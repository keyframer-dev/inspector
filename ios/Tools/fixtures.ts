/**
 * Protocol fixtures for the Swift tests, type-checked against the real protocol types.
 *
 *   bun Tools/fixtures.ts > Tests/KeyframerInspectorCoreTests/Fixtures/messages.json
 *   ../../node_modules/.bin/tsc --noEmit --strict --skipLibCheck --target es2022 --moduleResolution bundler --module esnext Tools/fixtures.ts
 *
 * Every value is typed with the TS types from protocol/inspector.ts, so tsc rejects a
 * fixture that drifts from the contract; the Swift tests then decode each one and must encode it back
 * to the same JSON. Shapes are the ones the iOS SDK sends (an iOS anim event, layer signals) plus
 * every editor message it has to read.
 */
import type {
  InspectorAppMessage,
  InspectorCliMessage,
  InspectorEditorMessage,
  InspectorEvent,
  InspectorMarker,
  InspectorMessage,
  InspectorPresenceMessage,
  InspectorRelayMessage,
} from '../../protocol/inspector'

const anim: InspectorEvent = {
  kind: 'anim',
  eid: 7,
  site: {
    id: 'KeyframerExample/ViewController.swift:88:9/position',
    file: 'KeyframerExample/ViewController.swift',
    line: 88,
    column: 9,
    fn: 'UIView.animate',
    component: 'ViewController',
    target: 'card',
    prop: 'position',
    params: [
      { path: '1.duration', value: 600 },
      { path: '1.damping', value: 18.5 },
    ],
  },
  at: 1760000000123,
  args: [{ x: 195, y: 420 }, { animation: 'CASpringAnimation', duration: 600, damping: 18.5, from: { x: 195, y: 300 } }],
  thread: 'js',
  t: 1250,
  stack: 'Error\n    at closure #1 in ViewController.bounce() (KeyframerExample.debug.dylib+0x78:0:0)',
  frames: [
    {
      methodName: 'closure #1 in ViewController.bounce()',
      file: 'KeyframerExample.debug.dylib',
      lineNumber: 0,
      column: 0,
      image: 'KeyframerExample.debug.dylib',
      offset: 23120,
      symbol: '$s16KeyframerExample14ViewControllerC6bounceyyFyycfU_',
    },
    { methodName: 'UIView.animateWithDuration:animations:', file: 'UIKitCore', lineNumber: 0, column: 0, collapse: true, image: 'UIKitCore', offset: 4410924, symbol: '+[UIView(UIViewAnimationWithBlocks) animateWithDuration:animations:]' },
  ],
  durationMs: 700,
}

const stackless: InspectorEvent = {
  kind: 'anim',
  eid: 8,
  site: { id: 'ViewController.spin()/transform.rotation.z', file: 'ViewController.spin()', line: 0, column: 0, fn: 'CABasicAnimation', component: null, target: null, prop: null, params: [] },
  at: 1760000000200,
  args: [6.283, { animation: 'CABasicAnimation', duration: 1000, easing: 'linear', bezier: [0, 0, 1, 1], repeatCount: 'infinite' }],
}

const signal: InspectorEvent = {
  kind: 'signal',
  site: { id: 'ViewController.card/position.y', file: 'KeyframerExample/ViewController.swift', line: 88, component: 'ViewController', name: 'card.position.y' },
}
const unnamedSignal: InspectorEvent = { kind: 'signal', site: { id: 'CALayer/opacity', file: '<system>', line: 0, component: null, name: null } }
const scrollSignal: InspectorEvent = {
  kind: 'signal',
  site: { id: 'CardsViewController.chips/bounds.origin.x', file: '<scroll>', line: 0, column: 0, component: 'CardsViewController', name: 'chips.bounds.origin.x', kind: 'scroll', writable: true },
}
const readOnlySignal: InspectorEvent = { kind: 'signal', site: { id: 'Sensor/pitch', file: 'Sensor.swift', line: 12, component: null, name: 'pitch', kind: 'value', writable: false } }
const unsignal: InspectorEvent = { kind: 'unsignal', id: 'DetailViewController.header/opacity' }
const style: InspectorEvent = { kind: 'style', site: { id: 'App.tsx:10:2', file: 'App.tsx', line: 10, component: 'App', name: 'cardStyle', links: [{ signal: 'App.tsx:4:2', prop: 'transform.scale' }] } }
const shadowHint: InspectorEvent = {
  kind: 'renderHint',
  id: 'CardsViewController.card/shadowPath',
  hint: 'shadow-path',
  detail: 'shadowOpacity 0.25, shadowRadius 12 and no shadowPath on CardsViewController.card',
}
const blurHint: InspectorEvent = { kind: 'renderHint', id: 'CardsViewController.pill/blur', hint: 'blur' }
// A SwiftUI trace (KeyframerInspectorSwiftUI): a withKeyframerAnimation call site, a value signal.
const swiftUIAnim: InspectorEvent = {
  kind: 'anim',
  eid: 9,
  site: {
    id: 'KeyframerExample/SwiftUICardsView.swift:41:13/card',
    file: 'KeyframerExample/SwiftUICardsView.swift',
    line: 41,
    column: 13,
    fn: 'withAnimation',
    component: 'SwiftUICardsView',
    target: 'card',
    prop: null,
    params: [
      { path: '1.response', value: 500 },
      { path: '1.dampingFraction', value: 0.55 },
    ],
  },
  at: 1760000000300,
  args: [-120, { animation: 'spring', response: 500, dampingFraction: 0.55, settlingDuration: 1393.2, from: 0 }],
  thread: 'js',
  durationMs: 1393.2,
}
const swiftUISignal: InspectorEvent = {
  kind: 'signal',
  site: { id: 'SwiftUICardsView.dot/x', file: 'KeyframerExample/SwiftUICardsView.swift', line: 52, column: 18, component: 'SwiftUICardsView', name: 'dot.x', kind: 'value', writable: false },
}

const markers: InspectorMarker[] = [
  { kind: 'touch', t: 10, phase: 'start', id: 1, x: 120.5, y: 300 },
  { kind: 'touch', t: 30, phase: 'cancel', id: 1, x: 121, y: 310, lost: true },
  { kind: 'navigation', t: 0, route: 'ViewController', params: { title: 'Cards' } },
  { kind: 'navigation', t: 900, route: 'DetailViewController' },
  { kind: 'appState', t: 1000, state: 'inactive' },
  { kind: 'keyboard', t: 1100, visible: true, height: 336 },
  { kind: 'log', t: 1200, level: 'warn', message: 'slow' },
  { kind: 'note', t: 1300, text: 'tapped twice' },
  { kind: 'gesture', t: 1400, gesture: 'Pan', on: 'onUpdate', handler: 3, x: null, y: 20, site: 'App.tsx:20', component: null },
  { kind: 'accessibility', t: 1500, reduceMotion: true },
  { kind: 'display', t: 1600, hz: 60 },
  { kind: 'visibility', t: 1700, id: 'CardsViewController.pill/position.x', visible: false, reason: 'offscreen' },
  { kind: 'visibility', t: 2300, id: 'CardsViewController.pill/position.x', visible: true },
  { kind: 'visibility', t: 2400, id: 'DetailViewController.header/opacity', visible: false, reason: 'detached' },
  { kind: 'time', t: 1800, scale: 0.25 },
  { kind: 'time', t: 2000, scale: 0 },
  { kind: 'time', t: 2100, scale: 0, step: 6 },
]

const app: InspectorAppMessage[] = [
  {
    type: 'hello',
    role: 'app',
    app: 'Keyframer UIKit Example',
    platform: 'ios',
    capture: true,
    screen: { width: 402, height: 874, scale: 3 },
    scenarios: ['bounce', 'spin'],
    protocol: 1,
    sdk: { name: 'KeyframerInspector', version: '0.1.0' },
    framework: 'uikit',
    osVersion: '26.5',
    threads: { js: { label: 'Main', animates: true } },
    capabilities: ['capture', 'playback', 'scrub', 'overrides', 'replay', 'scenarios', 'time'],
    display: { hz: 120, adaptive: true },
    accessibility: { reduceMotion: false },
    device: { name: 'iPhone 17 Pro', model: 'iPhone18,1', id: 'D95F3325-AE85-4445-9CB9-2D3C90388D88', simulator: true },
  },
  { type: 'hello', role: 'app', app: 'Bare', platform: 'ios' },
  // A physical device: its model, never its name.
  { type: 'hello', role: 'app', app: 'SwiftUI', platform: 'ios', framework: 'swiftui', display: { hz: 60 }, accessibility: { reduceMotion: true }, device: { model: 'iPhone17,1', simulator: false } },
  { type: 'scenarios', names: ['bounce'] },
  { type: 'scenarioDone', name: 'bounce', ms: 612 },
  { type: 'scenarioDone', name: 'nope', ms: 0, error: 'No scenario named "nope". Registered: bounce.' },
  { type: 'events', events: [anim, stackless, signal, unnamedSignal, scrollSignal, readOnlySignal, unsignal, style, shadowHint, blurHint, swiftUIAnim, swiftUISignal] },
  {
    type: 'samples',
    samples: [
      { id: 'ViewController.card/position.y', t: 0, v: 300 },
      { id: 'ViewController.card/position.y', t: 16, v: 301.25 },
    ],
    frames: [{ t: 250, thread: 'js', fps: 120, dropped: 0 }],
    drops: [{ t: 420, thread: 'js', ms: 125.3, dropped: 14 }],
    markers,
  },
  { type: 'samples', samples: [] },
  { type: 'frame', id: 'f1', data: 'AAAA', format: 'jpg' },
  { type: 'frame', id: 'f2', error: 'No window to capture.' },
  { type: 'time', scale: 0.25 },
  { type: 'time', scale: 1 },
]

const editor: InspectorEditorMessage[] = [
  { type: 'hello', role: 'editor' },
  { type: 'overrides', overrides: { 'KeyframerExample/ViewController.swift:88:9/position': { '1.duration': 900, '1.damping': 12 } } },
  { type: 'replay' },
  { type: 'record', signalIds: ['*'], on: true },
  { type: 'record', signalIds: ['ViewController.card/position.y'], on: false },
  { type: 'record', signalIds: ['*'], on: true, recorder: 'ci-7f3a' },
  { type: 'record', signalIds: ['*'], on: false, recorder: 'ci-7f3a' },
  { type: 'scenario', name: 'bounce' },
  { type: 'playback', samples: [{ id: 'ViewController.card/position.y', t: 16, v: 301.25 }] },
  { type: 'playback', samples: [], routes: [{ t: 0, route: 'ViewController' }, { t: 900, route: 'DetailViewController', params: { id: 3 } }] },
  { type: 'capture', id: 'f1', samples: [{ id: 'ViewController.card/position.y', t: 16, v: 301.25 }], format: 'png', quality: 0.8, width: 320, route: { t: 0, route: 'ViewController' } },
  { type: 'capture', id: 'f2', samples: [] },
  { type: 'scrub', t: 1250 },
  { type: 'scrub', t: null },
  { type: 'time', scale: 0.1 },
  { type: 'time', scale: 0, step: 1 },
  { type: 'time', scale: 0, step: 4 },
  { type: 'apply', edits: [{ file: 'App.tsx', line: 3, column: 2, fn: 'withTiming', path: '1.duration', value: 300 }] },
  { type: 'source', files: ['App.tsx'] },
]

const cli: InspectorCliMessage[] = [
  { type: 'hello', role: 'cli', root: '/tmp/app' },
  { type: 'applied', results: [{ file: 'App.tsx', applied: 1, skipped: [] }] },
  { type: 'sources', file: 'App.tsx', text: null, reason: 'outside the root' },
]

const presence: InspectorPresenceMessage[] = [{ type: 'presence', app: true, editors: 2, cli: false }]

// The desktop relay's own messages: an app passes them through untouched.
const relay: InspectorRelayMessage[] = [
  { type: 'apps', apps: [{ id: 'a1', name: 'Keyframer UIKit Example', platform: 'ios', address: '127.0.0.1', connectedAt: 1760000000000, editors: 1 }], attached: 'a1', mode: 'auto' },
  { type: 'select', app: null },
]

const fixtures = [...app, ...editor, ...cli, ...presence, ...relay] satisfies InspectorMessage[]

console.log(JSON.stringify(fixtures, null, 2))
