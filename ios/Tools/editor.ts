/**
 * A scripted editor for the iOS SDK: connects to the relay as `/editor`, drives the app through the
 * protocol and checks every message the app sends against the shapes in
 * protocol/inspector.ts.
 *
 *   bun Tools/editor.ts smoke    [--url ws://127.0.0.1:8790/editor] [--out /tmp/kf-editor]
 *   bun Tools/editor.ts touches  [--seconds 15]     record while someone (or a UI test) touches the app
 *   bun Tools/editor.ts watch                       print what the app sends
 *
 * `smoke` needs the example app (its scenarios: bounce, spin, fade, jank, push, back). It records, runs
 * scenarios, scrubs with `playback`, captures frames, scrubs Core Animation with `scrub`, applies an
 * override, and writes what it saw (session.json, frame-*.jpg) to --out. Exit code 1 on any failure.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import type {
  InspectorAppMessage,
  InspectorEditorMessage,
  InspectorEvent,
  InspectorFrameDrop,
  InspectorFrameStat,
  InspectorMarker,
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
  } else expect(e.kind === 'style', `event kind ${(e as { kind: string }).kind}`)
}
function checkMarker(m: InspectorMarker) {
  expect(isNum(m.t), `marker ${m.kind}: t`)
  if (m.kind === 'touch') expect(['start', 'move', 'end', 'cancel'].includes(m.phase) && isNum(m.id) && isNum(m.x) && isNum(m.y), `touch marker`)
  else if (m.kind === 'navigation') expect(isStr(m.route), 'navigation marker')
  else expect(['appState', 'keyboard', 'log', 'note', 'gesture'].includes(m.kind), `marker kind ${m.kind}`)
}
function checkApp(m: InspectorAppMessage) {
  switch (m.type) {
    case 'hello':
      expect(m.role === 'app' && isStr(m.app) && m.platform === 'ios', 'hello: role/app/platform')
      expect(!m.screen || (isNum(m.screen.width) && isNum(m.screen.height) && isNum(m.screen.scale)), 'hello: screen')
      expect(m.protocol === 1 && m.framework === 'uikit' && isStr(m.osVersion) && m.sdk?.name === 'KeyframerInspector', 'hello: protocol/framework/osVersion/sdk')
      expect(m.threads?.js?.label === 'Main' && m.threads.js.animates === true && !m.threads.ui, 'hello: threads')
      expect(!!m.capabilities?.includes('scrub') && !!m.capabilities.includes('playback'), 'hello: capabilities')
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
}
const waiters: Array<{ test: (m: InspectorAppMessage) => boolean; resolve: (m: InspectorAppMessage) => void }> = []

const ws = new WebSocket(url)
const send = (m: InspectorEditorMessage | { type: 'scrub'; t: number | null }) => ws.send(JSON.stringify(m))
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
  const m = JSON.parse(String(ev.data)) as InspectorAppMessage
  session.counts[m.type] = (session.counts[m.type] ?? 0) + 1
  checkApp(m)
  if (m.type === 'hello') session.hello = m
  if (m.type === 'events') {
    for (const e of m.events) {
      if (e.kind === 'signal') session.signals.set(e.site.id, e.site)
      if (e.kind === 'anim') session.anims.push(e)
      if (e.kind === 'unsignal') session.unsignals.push(e.id)
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
    !!bounce && bounce.site.fn === 'UIView.animate' && bounce.site.component === 'CardsViewController' && bounce.site.file === 'closure #1 in CardsViewController.bounce()',
    bounce && `${bounce.site.fn}, ${bounce.site.component}, ${bounce.site.file}`,
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

  // A full playback in time order.
  send({ type: 'playback', samples: session.samples.filter((s) => s.id === cardY) })
  await sleep(600)
  send({ type: 'replay' })
  await sleep(300)
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
