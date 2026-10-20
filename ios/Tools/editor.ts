/**
 * A scripted editor for the iOS SDK: connects to the relay as `/editor`, drives the app through the
 * protocol and checks every message the app sends against the shapes in
 * protocol/inspector.ts.
 *
 *   bun Tools/editor.ts smoke    [--url ws://127.0.0.1:8790/editor] [--out /tmp/kf-editor]
 *   bun Tools/editor.ts touches  [--seconds 15]     record while someone (or a UI test) touches the app
 *   bun Tools/editor.ts watch                       print what the app sends
 *
 * `smoke` needs the example app (its scenarios: bounce, spin, fade, jank, push, back, slide, swiftui). It
 * records, runs scenarios, scrubs with `playback`, captures frames, scrubs Core Animation with `scrub`,
 * applies an override, then slows, pauses and steps time (`time`), checks render hints, visibility
 * markers and the SwiftUI traces, and writes what it saw (session.json, frame-*.jpg) to --out. Exit
 * code 1 on any failure.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import type {
  InspectorAppMessage,
  InspectorEditorMessage,
  InspectorEvent,
  InspectorFrameDrop,
  InspectorFrameStat,
  InspectorMarker,
  InspectorRenderHint,
  InspectorSample,
  InspectorSignalSite,
} from '../../protocol/inspector'

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1]! : fallback
}
const mode = process.argv[2] ?? 'smoke'
const url = arg('--url', 'ws://127.0.0.1:8790/editor')
const out = arg('--out', '/tmp/kf-editor')
mkdirSync(out, { recursive: true })

// ─── Shape checks (runtime mirror of the TS types) ────────────────────────────

const problems: string[] = []
const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v)
const isStr = (v: unknown) => typeof v === 'string'
const isStrOrNull = (v: unknown) => v === null || typeof v === 'string'
function expect(ok: boolean, what: string) {
  if (!ok && problems.length < 50) problems.push(what)
}
function checkSite(s: Record<string, unknown>, where: string) {
  expect(isStr(s.id) && isStr(s.file) && isNum(s.line) && isNum(s.column) && isStr(s.fn), `${where}: id/file/line/column/fn`)
  for (const k of ['component', 'target', 'prop']) expect(k in s && isStrOrNull(s[k]), `${where}: ${k} must be string | null`)
  expect(Array.isArray(s.params) && (s.params as Array<Record<string, unknown>>).every((p) => isStr(p.path) && isNum(p.value)), `${where}: params`)
}
function checkEvent(e: InspectorEvent) {
  if (e.kind === 'anim') {
    expect(isNum(e.eid) && isNum(e.at) && Array.isArray(e.args), `anim ${e.eid}: eid/at/args`)
    expect(e.thread === undefined || e.thread === 'ui' || e.thread === 'js', `anim ${e.eid}: thread`)
    expect(e.t === undefined || isNum(e.t), `anim ${e.eid}: t`)
    expect(e.stack === undefined || isStr(e.stack), `anim ${e.eid}: stack`)
    checkSite(e.site as unknown as Record<string, unknown>, `anim ${e.eid} site`)
    expect(e.thread === 'js', `anim ${e.eid}: iOS reports the main thread as js`)
    expect(e.frames === undefined || e.frames.every((f) => isStr(f.methodName) && f.lineNumber === 0 && isStr(f.image)), `anim ${e.eid}: frames`)
    expect(e.durationMs === undefined || isNum(e.durationMs), `anim ${e.eid}: durationMs`)
  } else if (e.kind === 'unsignal') {
    expect(isStr(e.id), 'unsignal id')
  } else if (e.kind === 'signal') {
    const s = e.site
    expect(isStr(s.id) && isStr(s.file) && isNum(s.line) && 'component' in s && isStrOrNull(s.component) && 'name' in s && isStrOrNull(s.name), `signal ${s.id}`)
  } else if (e.kind === 'renderHint') {
    expect(isStr(e.id) && ['shadow-path', 'mask', 'blur', 'group-opacity', 'rasterize'].includes(e.hint) && (e.detail === undefined || isStr(e.detail)), `renderHint ${e.id} ${e.hint}`)
  } else expect(e.kind === 'style', `event kind ${(e as { kind: string }).kind}`)
}
function checkMarker(m: InspectorMarker) {
  expect(isNum(m.t), `marker ${m.kind}: t`)
  if (m.kind === 'touch') expect(['start', 'move', 'end', 'cancel'].includes(m.phase) && isNum(m.id) && isNum(m.x) && isNum(m.y), `touch marker`)
  else if (m.kind === 'navigation') expect(isStr(m.route), 'navigation marker')
  else if (m.kind === 'accessibility') expect(typeof m.reduceMotion === 'boolean', 'accessibility marker')
  else if (m.kind === 'display') expect(isNum(m.hz) && m.hz > 0, 'display marker')
  else if (m.kind === 'visibility')
    expect(isStr(m.id) && typeof m.visible === 'boolean' && (m.reason === undefined || ['offscreen', 'hidden', 'detached', 'covered'].includes(m.reason)), `visibility marker ${m.id}`)
  else if (m.kind === 'time') expect(isNum(m.scale) && m.scale >= 0 && (m.step === undefined || (m.scale === 0 && m.step >= 1)), 'time marker')
  else expect(['appState', 'keyboard', 'log', 'note', 'gesture'].includes(m.kind), `marker kind ${m.kind}`)
}
function checkApp(m: InspectorAppMessage) {
  switch (m.type) {
    case 'hello':
      expect(m.role === 'app' && isStr(m.app) && m.platform === 'ios', 'hello: role/app/platform')
      expect(!m.screen || (isNum(m.screen.width) && isNum(m.screen.height) && isNum(m.screen.scale)), 'hello: screen')
      expect(m.protocol === 1 && (m.framework === 'uikit' || m.framework === 'swiftui') && isStr(m.osVersion) && m.sdk?.name === 'KeyframerInspector', 'hello: protocol/framework/osVersion/sdk')
      expect(m.threads?.js?.label === 'Main' && m.threads.js.animates === true && !m.threads.ui, 'hello: threads')
      expect(!!m.capabilities?.includes('scrub') && !!m.capabilities.includes('playback') && !!m.capabilities.includes('time'), 'hello: capabilities')
      expect(!m.display || (isNum(m.display.hz) && (m.display.adaptive === undefined || m.display.adaptive === true)), 'hello: display')
      expect(typeof m.accessibility?.reduceMotion === 'boolean', 'hello: accessibility')
      // A physical device says its model only, never its name or an id.
      expect(!!m.device && (m.device.simulator === true || (m.device.name === undefined && m.device.id === undefined)), 'hello: device')
      break
    case 'time':
      expect(isNum(m.scale) && m.scale >= 0, 'time: scale')
      break
    case 'events':
      m.events.forEach(checkEvent)
      break
    case 'samples':
      expect(Array.isArray(m.samples), 'samples: samples[]')
      for (const s of m.samples) expect(isStr(s.id) && isNum(s.t) && isNum(s.v), `sample ${JSON.stringify(s)}`)
      for (const f of m.frames ?? []) expect(isNum(f.t) && f.thread === 'js' && isNum(f.fps) && isNum(f.dropped), 'frame stat on js')
      for (const d of m.drops ?? []) expect(isNum(d.t) && d.thread === 'js' && isNum(d.ms) && isNum(d.dropped), 'drop on js')
      ;(m.markers ?? []).forEach(checkMarker)
      break
    case 'scenarioDone':
      expect(isStr(m.name) && isNum(m.ms), 'scenarioDone')
      break
    case 'frame':
      expect(isStr(m.id) && (isStr(m.data) || isStr(m.error)), 'frame')
      break
    case 'scenarios':
      expect(Array.isArray(m.names), 'scenarios')
      break
    default:
      expect(false, `unexpected app message ${(m as { type: string }).type}`)
  }
}

// ─── Session ──────────────────────────────────────────────────────────────────

const session = {
  hello: null as Extract<InspectorAppMessage, { type: 'hello' }> | null,
  signals: new Map<string, InspectorSignalSite>(),
  anims: [] as Extract<InspectorEvent, { kind: 'anim' }>[],
  samples: [] as InspectorSample[],
  frames: [] as InspectorFrameStat[],
  drops: [] as InspectorFrameDrop[],
  markers: [] as InspectorMarker[],
  counts: {} as Record<string, number>,
  unsignals: [] as string[],
  hellos: [] as Extract<InspectorAppMessage, { type: 'hello' }>[],
  hints: [] as InspectorRenderHint[],
}
const waiters: Array<{ test: (m: InspectorAppMessage) => boolean; resolve: (m: InspectorAppMessage) => void }> = []

const ws = new WebSocket(url)
const send = (m: InspectorEditorMessage) => ws.send(JSON.stringify(m))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
function next<T extends InspectorAppMessage['type']>(type: T, test: (m: Extract<InspectorAppMessage, { type: T }>) => boolean = () => true, ms = 15_000) {
  return new Promise<Extract<InspectorAppMessage, { type: T }>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), ms)
    waiters.push({
      test: (m) => m.type === type && test(m as Extract<InspectorAppMessage, { type: T }>),
      resolve: (m) => {
        clearTimeout(timer)
        resolve(m as Extract<InspectorAppMessage, { type: T }>)
      },
    })
  })
}

ws.onmessage = (ev) => {
  if (String(ev.data) === 'pong') return
  const parsed = JSON.parse(String(ev.data)) as { type?: string }
  // The relay's own messages (who is connected, how many editors): not the app's.
  if (parsed.type === 'apps' || parsed.type === 'presence') return
  const m = parsed as InspectorAppMessage
  session.counts[m.type] = (session.counts[m.type] ?? 0) + 1
  checkApp(m)
  if (m.type === 'hello') {
    session.hello = m
    session.hellos.push(m)
  }
  if (m.type === 'events') {
    for (const e of m.events) {
      if (e.kind === 'signal') session.signals.set(e.site.id, e.site)
      if (e.kind === 'anim') session.anims.push(e)
      if (e.kind === 'unsignal') session.unsignals.push(e.id)
      if (e.kind === 'renderHint') session.hints.push(e)
    }
  }
  if (m.type === 'samples') {
    session.samples.push(...m.samples)
    session.frames.push(...(m.frames ?? []))
    session.drops.push(...(m.drops ?? []))
    session.markers.push(...(m.markers ?? []))
  }
  if (mode === 'watch') console.log(JSON.stringify(m).slice(0, 400))
  for (let i = waiters.length - 1; i >= 0; i--) {
    if (waiters[i]!.test(m)) waiters.splice(i, 1)[0]!.resolve(m)
  }
}

const checks: Array<[string, boolean, string?]> = []
const check = (name: string, ok: boolean, detail?: string) => {
  checks.push([name, ok, detail])
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`)
}

/** The value of every recorded track at `t`: what a scrub sends. */
function valuesAt(t: number): InspectorSample[] {
  const last = new Map<string, InspectorSample>()
  for (const s of [...session.samples].sort((a, b) => a.t - b.t)) if (s.t <= t) last.set(s.id, s)
  return [...last.values()]
}

async function capture(id: string, samples: InspectorSample[]) {
  send({ type: 'capture', id, samples, format: 'jpg', quality: 0.7, width: 300 })
  const f = await next('frame', (m) => m.id === id)
  if (f.data) writeFileSync(`${out}/${id}.jpg`, Buffer.from(f.data, 'base64'))
  return f
}

async function smoke() {
  const hello = await next('hello')
  check('hello', hello.platform === 'ios' && !!hello.screen && hello.capture === true, `${hello.app}, scenarios: ${hello.scenarios?.join(', ')}`)

  send({ type: 'record', signalIds: ['*'], on: true })
  await sleep(300)
  for (const name of ['bounce', 'spin', 'fade', 'jank']) {
    send({ type: 'scenario', name })
    const done = await next('scenarioDone', (m) => m.name === name)
    check(`scenario ${name}`, !done.error, `${done.ms} ms${done.error ? `: ${done.error}` : ''}`)
  }
  send({ type: 'scenario', name: 'missing' })
  const missing = await next('scenarioDone', (m) => m.name === 'missing')
  check('unknown scenario answers with an error', !!missing.error, missing.error)
  await sleep(400)
  send({ type: 'record', signalIds: ['*'], on: false })
  await sleep(400)

  const recorded = session.anims.filter((a) => a.t !== undefined)
  check('anim events while recording carry t and a stack', recorded.length > 0 && recorded.every((a) => !!a.stack), `${recorded.length} anims`)
  const withFrames = recorded.filter((a) => a.frames?.some((f) => f.offset !== undefined && f.symbol))
  check('anim events carry frames (image + offset) and durationMs', withFrames.length === recorded.length && recorded.every((a) => isNum(a.durationMs)), `durations ${recorded.map((a) => a.durationMs).join(', ')}`)
  const sites = [...new Set(recorded.map((a) => `${a.site.fn} ${a.site.target}.${a.site.prop} @ ${a.site.file}:${a.site.line}`))]
  console.log(`     ${sites.join('\n     ')}`)
  const bounce = recorded.find((a) => a.site.target === 'card' && a.site.prop === 'position')
  check(
    'UIView.animate spring is attributed to the card and its code',
    // The id is the function (stable across builds, N5); file and line are its declaration, read from
    // the sources the simulator can see (N33).
    !!bounce &&
      bounce.site.fn === 'UIView.animate' &&
      bounce.site.component === 'CardsViewController' &&
      bounce.site.id === 'closure #1 in CardsViewController.bounce()/position' &&
      /CardsViewController\.swift$/.test(bounce.site.file) &&
      bounce.site.line > 0,
    bounce && `${bounce.site.id}, ${bounce.site.fn}, ${bounce.site.component}, ${bounce.site.file}:${bounce.site.line}`,
  )
  check('UIKit bookkeeping animations are left out', !recorded.some((a) => a.site.prop === 'uiFractionalProgress'))
  const spin = recorded.find((a) => a.site.prop === 'transform.rotation.z')
  check('trace() gives the exact file and line', !!spin && /CardsViewController\.swift$/.test(spin.site.file) && spin.site.line > 0, spin && `${spin.site.file}:${spin.site.line}:${spin.site.column}`)
  check('signals were announced', session.signals.size > 0, `${session.signals.size}: ${[...session.signals.keys()].slice(0, 6).join(', ')}`)
  const cardY = 'CardsViewController.card/position.y'
  const ys = session.samples.filter((s) => s.id === cardY)
  check('the card was sampled while it moved', ys.length > 5 && new Set(ys.map((s) => s.v)).size > 3, `${ys.length} samples, ${Math.min(...ys.map((s) => s.v)).toFixed(1)} to ${Math.max(...ys.map((s) => s.v)).toFixed(1)}`)
  check('frame stats arrived', session.frames.length > 3, `${session.frames.length} windows, fps ${session.frames.map((f) => f.fps).slice(0, 8).join(' ')}`)
  const jank = session.drops.find((d) => d.ms > 100)
  check('the jank scenario shows up as a long frame', !!jank, jank && `${jank.ms} ms, ${jank.dropped} dropped at ${jank.t}`)
  check('navigation marker at the start', session.markers.some((m) => m.kind === 'navigation' && m.t <= 50), session.markers.map((m) => m.kind).join(','))

  // Scrub with playback: the card's value halfway through the bounce, then a frame of it.
  const peak = ys.reduce((a, b) => (b.v > a.v ? b : a), ys[0]!)
  const values = valuesAt(peak.t)
  send({ type: 'playback', samples: values })
  await sleep(150)
  const f1 = await capture('frame-playback', values)
  check('capture after a playback scrub', !!f1.data && f1.format === 'jpg', f1.error ?? `${Math.round((f1.data?.length ?? 0) / 1024)} KB base64`)

  // Scrub Core Animation itself to the same moment (proposed `scrub` message), capture, release.
  send({ type: 'scrub', t: peak.t })
  await sleep(150)
  const f2 = await capture('frame-scrub', [])
  check('capture after a Core Animation scrub', !!f2.data, f2.error)
  // Mid-spin: the rotation only exists in Core Animation's timeline (the model never rotates).
  if (spin?.t !== undefined) {
    send({ type: 'scrub', t: spin.t + 300 })
    await sleep(150)
    const f3 = await capture('frame-scrub-spin', [])
    check('capture mid-spin (Core Animation scrub)', !!f3.data, f3.error)
  }
  send({ type: 'scrub', t: null })

  // Overrides: the next bounce runs with the edited spring.
  if (bounce) {
    send({ type: 'overrides', overrides: { [bounce.site.id]: { '1.duration': 1500, '1.damping': 7 } } })
    await sleep(100)
    const before = session.anims.length
    send({ type: 'scenario', name: 'bounce' })
    await next('scenarioDone', (m) => m.name === 'bounce')
    await sleep(300)
    const again = session.anims.slice(before).find((a) => a.site.id === bounce.site.id)
    const cfg = (again?.args[1] ?? {}) as Record<string, unknown>
    check('an override edits the next animation', cfg.duration === 1500 && cfg.damping === 7, again && JSON.stringify(cfg))
    send({ type: 'overrides', overrides: {} })
  }

  await motionSettings(cardY)

  // A full playback in time order.
  send({ type: 'playback', samples: session.samples.filter((s) => s.id === cardY) })
  await sleep(600)
  send({ type: 'replay' })
  await sleep(300)
}

/** The values of one signal between two moments of the recording's clock. */
const between = (id: string, from: number, to: number) => session.samples.filter((s) => s.id === id && s.t >= from && s.t <= to)
/** How long a signal kept moving inside a window: first change to last change, in ms. */
function movingFor(id: string, from: number, to: number): number {
  const xs = between(id, from, to).sort((a, b) => a.t - b.t)
  const moves = xs.filter((s, i) => i > 0 && Math.abs(s.v - xs[i - 1]!.v) > 0.01)
  return moves.length ? moves[moves.length - 1]!.t - xs[xs.indexOf(moves[0]!) - 1]!.t : 0
}
const markerT = () => session.markers.reduce((t, m) => Math.max(t, m.t), 0)

/** Slow motion, pause and step (`time`), render hints, visibility markers and the SwiftUI traces. */
async function motionSettings(cardY: string) {
  // Two recorders (N21): one stopping leaves the other's recording running.
  send({ type: 'record', signalIds: ['*'], on: true, recorder: 'smoke-a' })
  send({ type: 'record', signalIds: ['*'], on: true, recorder: 'smoke-b' })
  await sleep(300)
  send({ type: 'record', signalIds: ['*'], on: false, recorder: 'smoke-a' })
  const stillFrom = session.frames.length
  await sleep(800)
  check('one recorder stopping leaves the other recording', session.frames.length > stillFrom, `${session.frames.length - stillFrom} frame windows after smoke-a stopped`)
  send({ type: 'record', signalIds: ['*'], on: false, recorder: 'smoke-b' })
  await sleep(500)
  const afterBoth = session.frames.length
  await sleep(600)
  check('the last recorder stopping stops the recording', session.frames.length === afterBoth)

  const hello = session.hellos[0]!
  const device = hello.device
  check(
    'hello says which simulator it runs on',
    device?.simulator === true ? /^[0-9A-F-]{36}$/.test(device.id ?? '') && !!device.name && /,/.test(device.model ?? '') : !!device?.model && !device?.name,
    JSON.stringify(device),
  )
  check('hello says the display, Reduce Motion and the time capability', isNum(hello.display?.hz) && typeof hello.accessibility?.reduceMotion === 'boolean' && !!hello.capabilities?.includes('time'), JSON.stringify({ display: hello.display, accessibility: hello.accessibility }))

  send({ type: 'record', signalIds: ['*'], on: true })
  await sleep(300)

  // A quarter of the speed: the same spring takes four times as long on the recording's clock.
  send({ type: 'time', scale: 0.25 })
  const slowed = await next('time')
  check('time 0.25 is answered with the speed', slowed.scale === 0.25)
  const slowFrom = markerT()
  send({ type: 'scenario', name: 'bounce' })
  await next('scenarioDone', (m) => m.name === 'bounce')
  await sleep(3000)
  const slowMs = movingFor(cardY, slowFrom, slowFrom + 10_000)
  check('a bounce at 0.25x runs about four times longer', slowMs > 1800, `${slowMs} ms of motion (about 600 at 1x)`)

  // Paused: an animation started now does not move; steps move it a frame at a time.
  send({ type: 'time', scale: 0 })
  check('time 0 is answered: paused', (await next('time')).scale === 0)
  await sleep(200)
  const pausedAt = markerT()
  send({ type: 'scenario', name: 'bounce' })
  await next('scenarioDone', (m) => m.name === 'bounce')
  await sleep(300)
  const still = between(cardY, pausedAt, pausedAt + 5000)
  const spread = still.length ? Math.max(...still.map((s) => s.v)) - Math.min(...still.map((s) => s.v)) : 0
  check('nothing moves while paused', spread < 0.5, `${still.length} samples, spread ${spread.toFixed(2)}`)
  const before = between(cardY, 0, 1e9).at(-1)?.v
  send({ type: 'time', scale: 0, step: 6 })
  check('a step is answered, still paused', (await next('time')).scale === 0)
  await sleep(300)
  const after = between(cardY, 0, 1e9).at(-1)?.v
  check('six steps move the paused spring a little', before !== undefined && after !== undefined && after !== before, `${before?.toFixed(1)} to ${after?.toFixed(1)}`)
  const pausedFrame = await capture('frame-paused', [])
  check('capture while paused', !!pausedFrame.data, pausedFrame.error)
  send({ type: 'time', scale: 1 })
  check('time 1 is answered', (await next('time')).scale === 1)
  await sleep(1500)

  // The pill slides out of the screen and pulses there, then comes back.
  send({ type: 'scenario', name: 'slide' })
  await next('scenarioDone', (m) => m.name === 'slide')
  await sleep(600)

  // SwiftUI: an explicit spring from its call site, an implicit easeInOut through the transaction.
  send({ type: 'scenario', name: 'swiftui' })
  const swiftUIDone = await next('scenarioDone', (m) => m.name === 'swiftui', 20_000)
  check('scenario swiftui', !swiftUIDone.error, swiftUIDone.error)

  // The editor's slow motion reaches the SwiftUI animations a trace sees (Animation.speed).
  send({ type: 'time', scale: 0.25 })
  await next('time')
  const swiftSlowFrom = markerT()
  send({ type: 'scenario', name: 'swiftui' })
  await next('scenarioDone', (m) => m.name === 'swiftui', 20_000)
  await sleep(3000)
  const swiftSlowMs = movingFor('SwiftUICardsView.card', swiftSlowFrom, swiftSlowFrom + 20_000)
  check('a SwiftUI spring at 0.25x runs about four times longer', swiftSlowMs > 2500, `${swiftSlowMs} ms of motion (about 1000 at 1x)`)
  send({ type: 'time', scale: 1 })
  await next('time')

  // An override from the panel rebuilds the next SwiftUI animation from that call site.
  const cardSite = session.anims.find((a) => a.site.fn === 'withAnimation' && a.site.target === 'card')?.site.id
  if (cardSite) {
    send({ type: 'overrides', overrides: { [cardSite]: { '1.response': 900, '1.dampingFraction': 0.8 } } })
    await sleep(100)
    const before = session.anims.length
    send({ type: 'scenario', name: 'swiftui' })
    await next('scenarioDone', (m) => m.name === 'swiftui', 20_000)
    const edited = session.anims.slice(before).find((a) => a.site.id === cardSite)
    const cfg = (edited?.args[1] ?? {}) as Record<string, unknown>
    check('an override edits the next SwiftUI animation', cfg.response === 900 && cfg.dampingFraction === 0.8, edited && JSON.stringify(cfg))
    send({ type: 'overrides', overrides: {} })
    await sleep(1500)
  }
  send({ type: 'scenario', name: 'back' })
  await next('scenarioDone', (m) => m.name === 'back')
  await sleep(400)
  send({ type: 'record', signalIds: ['*'], on: false })
  await sleep(400)

  const times = session.markers.flatMap((m) => (m.kind === 'time' && m.step === undefined ? [m.scale] : []))
  check('time markers on the recording', times.join(',') === '0.25,0,1,0.25,1', times.join(','))
  const steps = session.markers.flatMap((m) => (m.kind === 'time' && m.step !== undefined ? [`${m.scale}+${m.step}`] : []))
  check('a step while paused is a marker of its own', steps.join(',') === '0+6', steps.join(','))
  const hints = (id: string) => session.hints.filter((h) => h.id.startsWith(id)).map((h) => h.hint)
  check('render hint: the card\'s shadow has no path', hints('CardsViewController.card/').includes('shadow-path'), session.hints.map((h) => `${h.id} ${h.hint}`).join('; '))
  check('render hint: the card fades as a group', hints('CardsViewController.card/').includes('group-opacity'), session.hints.find((h) => h.hint === 'group-opacity')?.detail)
  const pill = session.markers.filter((m) => m.kind === 'visibility' && m.id.startsWith('CardsViewController.pill/'))
  const pillStates = pill.map((m) => (m.kind === 'visibility' ? `${m.visible ? 'visible' : m.reason}@${m.t}` : ''))
  // It pulses out of sight for 1.1 s before it slides back.
  const gone = pill.find((m) => m.kind === 'visibility' && !m.visible && m.reason === 'offscreen')
  const back = gone && pill.find((m) => m.kind === 'visibility' && m.visible && m.t > gone.t)
  check('visibility: the pill went offscreen while it pulsed, and came back', !!gone && !!back && back.t - gone.t > 800, pillStates.filter((_, i, a) => a.indexOf(_) === i).slice(0, 6).join(' '))

  const swiftHello = session.hellos.at(-1)
  check('the hello says swiftui once it is used', swiftHello?.framework === 'swiftui', session.hellos.map((h) => h.framework).join(' then '))
  const explicit = session.anims.find((a) => a.site.fn === 'withAnimation' && a.site.target === 'card')
  check(
    'withKeyframerAnimation is reported from its exact line',
    !!explicit && /SwiftUICardsView\.swift$/.test(explicit.site.file) && explicit.site.line > 0 && (explicit.args[1] as Record<string, unknown>)?.animation === 'spring',
    explicit && `${explicit.site.file}:${explicit.site.line}:${explicit.site.column} ${JSON.stringify(explicit.args)}`,
  )
  const implicit = session.anims.find((a) => a.site.fn === 'Transaction' && a.site.target === 'dot')
  check('an implicit .animation is reported through the transaction', !!implicit && (implicit.args[1] as Record<string, unknown>)?.easing === 'easeInOut', implicit && JSON.stringify(implicit.args))
  const swiftCard = session.samples.filter((s) => s.id === 'SwiftUICardsView.card')
  const lowest = Math.min(...swiftCard.map((s) => s.v))
  check('the SwiftUI card is sampled every frame, overshoot included', swiftCard.length > 10 && lowest < -122, `${swiftCard.length} samples, lowest ${lowest.toFixed(1)}`)
  const dotX = session.samples.filter((s) => s.id === 'SwiftUICardsView.dot/x')
  check('a traced point is two signals', new Set(dotX.map((s) => s.v)).size > 5 && session.signals.has('SwiftUICardsView.dot/y'), `${dotX.length} samples of dot/x`)
}

async function touches(seconds: number) {
  await next('hello', () => true, 60_000)
  send({ type: 'record', signalIds: ['*'], on: true })
  // The app relaunched (a UI test starts its own): a new process is not recording, ask again.
  const again = () =>
    void next('hello', () => true, seconds * 1000)
      .then(() => {
        send({ type: 'record', signalIds: ['*'], on: true })
        again()
      })
      .catch(() => {})
  again()
  console.log(`recording for ${seconds} s`)
  await sleep(seconds * 1000)
  send({ type: 'record', signalIds: ['*'], on: false })
  await sleep(500)
  const scroll = [...session.signals.values()].filter((s) => s.kind === 'scroll')
  check('scroll tracks are kind scroll', scroll.length > 0, scroll.map((s) => s.id).join(', '))
  check('freed layers are unsignalled', session.unsignals.length > 0, session.unsignals.join(', '))
  const t = session.markers.filter((m) => m.kind === 'touch')
  check('touch markers', t.length > 0, `${t.length}: ${t.slice(0, 6).map((m) => (m.kind === 'touch' ? `${m.phase}#${m.id}@${m.x},${m.y}` : '')).join(' ')}`)
  const navs = session.markers.filter((m) => m.kind === 'navigation').map((m) => (m.kind === 'navigation' ? m.route : ''))
  check('navigation markers', navs.length > 1, navs.join(' → '))
  check('no animation is attributed to the app entry point', !session.anims.some((a) => a.site.file.endsWith('.main()')), [...new Set(session.anims.map((a) => a.site.file))].join(' | '))
  const header = session.anims.find((a) => a.site.target === 'header')
  const delay = (header?.args[1] as Record<string, unknown> | undefined)?.delay
  check('a UIKit delay is read (beginTimeMode relative)', delay === 100, `delay ${delay}`)
  const dragged = session.samples.filter((s) => s.id === 'CardsViewController.card/position.x')
  check('a drag on a tracked view is sampled', new Set(dragged.map((s) => s.v)).size > 2, `${dragged.length} samples`)
}

ws.onopen = async () => {
  send({ type: 'hello', role: 'editor' })
  try {
    if (mode === 'smoke') await smoke()
    else if (mode === 'touches') await touches(Number(arg('--seconds', '15')))
    else if (mode === 'watch') return
  } catch (e) {
    check('script', false, String(e))
  }
  check('every message matches the protocol types', problems.length === 0, problems.slice(0, 5).join('; '))
  writeFileSync(
    `${out}/session.json`,
    JSON.stringify({ ...session, signals: [...session.signals.values()], counts: session.counts, checks }, null, 1),
  )
  console.log(`messages: ${JSON.stringify(session.counts)}  →  ${out}/session.json`)
  ws.close()
  process.exit(checks.every((c) => c[1]) ? 0 : 1)
}
ws.onerror = () => {
  console.error(`could not connect to ${url}: start the relay (bun Tools/relay.ts)`)
  process.exit(1)
}
