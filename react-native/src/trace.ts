/**
 * A recording session and what can be read from it: every shared value it sampled, the frame rate of
 * both threads, each long frame, the animations that started (where, on which thread, from which JS
 * stack) and the React commits. Pure, so the dev tools panel and the MCP server read a session the
 * same way: the panel draws it, the agent gets it as text.
 *
 * All times are on the recording's clock (ms since the app started recording), the one samples use.
 */

import type {
  InspectorAppInfo,
  InspectorAppMessage,
  InspectorCommit,
  InspectorFrameDrop,
  InspectorFrameStat,
  InspectorMarker,
  InspectorRecordedAnim,
  InspectorRecording,
  InspectorRoute,
  InspectorSample,
  InspectorScreenshot,
  InspectorSignalSite,
  InspectorStyleSite,
  InspectorTask,
  InspectorThread,
  InspectorUiWork,
} from '../../protocol/inspector'
import { adviceFor, isReactNative } from './platforms'
import { isScrollSample } from './runtime'
import { sampleAt } from './signals'

/** An animation that started while recording. */
export type TraceAnim = InspectorRecordedAnim

/** Where a session came from when it was not recorded live: a recording file. */
export type SessionSource = Pick<InspectorRecording, 'app' | 'startedAt' | 'screen' | 'note' | 'signals'>

export type InspectorSession = {
  /** The shared values recorded, by call site id. */
  ids: string[]
  samples: Record<string, InspectorSample[]>
  stats: InspectorFrameStat[]
  drops: InspectorFrameDrop[]
  anims: TraceAnim[]
  commits: InspectorCommit[]
  /** Touches, navigation, app state, keyboard and logs: recordings made on the device have them. */
  markers?: InspectorMarker[]
  screenshots?: InspectorScreenshot[]
  /** JS tasks (handlers, effects, timers) and UI-thread worklet time per frame. */
  tasks?: InspectorTask[]
  work?: InspectorUiWork[]
  /** Animated styles: which shared value feeds which style property. */
  styles?: InspectorStyleSite[]
  /** Recording every shared value: ones that show up mid-recording join. */
  all?: boolean
  /** Set when the session was opened from a recording file. */
  source?: SessionSource
  /** What the app said about itself (framework, threads), for a session recorded live. */
  app?: InspectorAppInfo
}

/** What an app's hello says about it, kept with its sessions and recordings. */
export function appFromHello(msg: Extract<InspectorAppMessage, { type: 'hello' }>): InspectorAppInfo {
  return {
    name: msg.app,
    platform: msg.platform,
    ...(msg.framework ? { framework: msg.framework } : {}),
    ...(msg.osVersion ? { osVersion: msg.osVersion } : {}),
    ...(msg.threads ? { threads: msg.threads } : {}),
    ...(msg.build ? { build: msg.build } : {}),
  }
}

/** The app a session is from: the live app's hello, or the recording's. */
export function appOf(s: InspectorSession): InspectorAppInfo | undefined {
  return s.app ?? s.source?.app
}

const MAX_SAMPLES = 20_000
const MAX_ITEMS = 4000

/** A session for these shared values; `['*']` records all of them, including ones that show up later. */
export function emptySession(ids: string[]): InspectorSession {
  const all = ids.includes('*')
  const own = ids.filter((id) => id !== '*')
  return { ids: own, samples: Object.fromEntries(own.map((id) => [id, []])), stats: [], drops: [], anims: [], commits: [], tasks: [], work: [], ...(all ? { all } : {}) }
}

const capped = <T>(xs: T[], max = MAX_ITEMS) => (xs.length > max ? xs.slice(xs.length - max) : xs)

/** The session with what one app message adds to it. Returns the same object when nothing changed. */
export function addToSession(session: InspectorSession, msg: InspectorAppMessage): InspectorSession {
  if (msg.type === 'samples') {
    const mine = session.all ? msg.samples : msg.samples.filter((s) => s.id in session.samples)
    if (!mine.length && !msg.frames?.length && !msg.drops?.length && !msg.commits?.length && !msg.markers?.length && !msg.tasks?.length && !msg.work?.length) {
      return session
    }
    const samples = { ...session.samples }
    // Recording everything: a shared value seen for the first time joins the session.
    let ids = session.ids
    for (const s of mine) {
      if (s.id in samples) continue
      samples[s.id] = []
      if (ids === session.ids) ids = [...ids]
      ids.push(s.id)
    }
    for (const s of mine) samples[s.id] = [...samples[s.id]!, s]
    for (const id of new Set(mine.map((s) => s.id))) samples[id] = capped(samples[id]!.sort((a, b) => a.t - b.t), MAX_SAMPLES)
    return {
      ...session,
      ids,
      samples,
      tasks: msg.tasks?.length ? capped([...(session.tasks ?? []), ...msg.tasks]) : session.tasks,
      work: msg.work?.length ? capped([...(session.work ?? []), ...msg.work], 40_000) : session.work,
      stats: msg.frames?.length ? capped([...session.stats, ...msg.frames]) : session.stats,
      drops: msg.drops?.length ? capped([...session.drops, ...msg.drops]) : session.drops,
      commits: msg.commits?.length ? capped([...session.commits, ...msg.commits]) : session.commits,
      markers: msg.markers?.length ? capped([...(session.markers ?? []), ...msg.markers], 20_000) : session.markers,
    }
  }
  if (msg.type === 'events') {
    const anims: TraceAnim[] = []
    let styles = session.styles
    for (const e of msg.events) {
      if (e.kind === 'style') {
        if (!styles?.some((x) => x.id === e.site.id)) styles = [...(styles ?? []), e.site]
        continue
      }
      if (e.kind !== 'anim' || e.t === undefined) continue
      anims.push({
        t: e.t,
        thread: e.thread ?? 'js',
        site: e.site,
        args: e.args,
        ...(e.stack ? { stack: e.stack } : {}),
        ...(e.frames?.length ? { frames: e.frames } : {}),
        ...(e.durationMs !== undefined ? { durationMs: e.durationMs } : {}),
      })
    }
    if (!anims.length && styles === session.styles) return session
    return { ...session, styles, anims: anims.length ? capped([...session.anims, ...anims]) : session.anims }
  }
  return session
}

/** First and last moment the session saw anything. */
export function sessionSpan(s: InspectorSession): { t0: number; t1: number } {
  let t0 = Infinity
  let t1 = -Infinity
  const see = (t: number) => {
    if (t < t0) t0 = t
    if (t > t1) t1 = t
  }
  for (const id of s.ids) {
    const list = s.samples[id] ?? []
    if (list.length) {
      see(list[0]!.t)
      see(list[list.length - 1]!.t)
    }
  }
  for (const a of s.anims) see(a.t)
  for (const m of s.markers ?? []) see(m.t)
  for (const x of s.screenshots ?? []) see(x.t)
  if (t0 === Infinity) return { t0: 0, t1: 0 }
  return { t0, t1 }
}

export function hasSamples(s: InspectorSession): boolean {
  return s.ids.some((id) => (s.samples[id]?.length ?? 0) > 1)
}

/** Every recorded shared value's value at `t`: one sample each, ready to send as `playback` or `capture`. */
export function valuesAt(s: InspectorSession, t: number): InspectorSample[] {
  const out: InspectorSample[] = []
  for (const id of s.ids) {
    // A list reports only while it moves: between reports it rested, so its offset holds.
    const v = sampleAt(s.samples[id] ?? [], t, isScrollSample(id) ? 60 : Infinity)
    if (v !== undefined) out.push({ id, t, v })
  }
  return out
}

/** The screen the app was on at `t` (the first one recorded, before any change). */
export function routeAt(s: InspectorSession, t: number): InspectorRoute | undefined {
  const navs = (s.markers ?? []).filter((m): m is Extract<InspectorMarker, { kind: 'navigation' }> => m.kind === 'navigation')
  let pick: (typeof navs)[number] | undefined
  for (const n of navs) if (n.t <= t) pick = n
  // Before the first marker: it is the screen the recording started on only when it was marked as
  // recording began (a few ms after the first sample). A later one is a screen the app went to, and
  // playback from here must not go there early.
  if (!pick && navs[0] && navs[0].t <= sessionSpan(s).t0 + START_MARK_MS) pick = navs[0]
  return pick ? { t: pick.t, route: pick.route, ...(pick.params ? { params: pick.params } : {}) } : undefined
}

/** How long after a session starts its first screen marker still says where it started. */
const START_MARK_MS = 250

/** The screen at `t` and every change after it: what playback from `t` navigates through. */
export function routesFrom(s: InspectorSession, t: number): InspectorRoute[] {
  const start = routeAt(s, t)
  const later = (s.markers ?? []).flatMap((m) => (m.kind === 'navigation' && m.t > t ? [{ t: m.t, route: m.route, ...(m.params ? { params: m.params } : {}) }] : []))
  return start ? [{ ...start, t }, ...later] : later
}

/** The session from `t` on, all values merged in time order, each starting from its value at `t`: playback that resumes from a playhead. */
export function playbackFrom(s: InspectorSession, t: number): InspectorSample[] {
  const out = valuesAt(s, t)
  for (const id of s.ids) for (const x of s.samples[id] ?? []) if (x.t > t) out.push(x)
  return out.sort((a, b) => a.t - b.t)
}

// ─── Frames ───────────────────────────────────────────────────────────────────────

export type ThreadSummary = { avg: number; min: number; dropped: number; longest: number }

/** Frame rate per thread over the session: average and worst window, frames dropped, the longest frame. */
export function frameSummary(s: InspectorSession): Record<InspectorThread, ThreadSummary | null> {
  const of = (thread: InspectorThread): ThreadSummary | null => {
    const stats = s.stats.filter((x) => x.thread === thread)
    if (!stats.length) return null
    const drops = s.drops.filter((d) => d.thread === thread)
    return {
      avg: Math.round(stats.reduce((n, x) => n + x.fps, 0) / stats.length),
      min: Math.min(...stats.map((x) => x.fps)),
      dropped: drops.reduce((n, d) => n + d.dropped, 0),
      longest: Math.round(Math.max(0, ...drops.map((d) => d.ms))),
    }
  }
  return { ui: of('ui'), js: of('js') }
}

// ─── Causes ───────────────────────────────────────────────────────────────────────

export type DropSuspects = { anims: TraceAnim[]; commits: InspectorCommit[]; hints: string[] }

/** How far before a long frame began something counts as having started it. */
const LEAD_MS = 50

/**
 * What was going on when a frame dropped: the animations that started and the React commits that ran
 * during the long frame or just before it, and a hint at what to change.
 */
export function suspectsFor(s: InspectorSession, drop: InspectorFrameDrop): DropSuspects {
  const from = drop.t - drop.ms - LEAD_MS
  const to = drop.t + 4
  const anims = s.anims.filter((a) => a.t >= from && a.t <= to)
  // A commit is timed when it finished: one that ended inside the long frame ran in it.
  const commits = s.commits.filter((c) => c.t >= drop.t - drop.ms - 4 && c.t <= to + 16).sort((a, b) => b.ms - a.ms)
  // The recorder's own screenshots hold the UI thread up: say so rather than blame the app.
  const shot = s.screenshots?.find((x) => x.t <= drop.t + 4 && x.t + x.ms >= drop.t - drop.ms - 4)
  const hints = shot
    ? [`The recorder took a screenshot during this frame (${Math.round(shot.ms)} ms): this drop is likely its own, not the app's.`]
    : hintsFor(drop, anims, commits, appOf(s))
  return { anims, commits, hints }
}

/** Long frames the recorder's screenshots did not cause: the ones that count. */
export function appDrops(s: InspectorSession): InspectorFrameDrop[] {
  const shots = s.screenshots ?? []
  return s.drops.filter((d) => d.dropped > 0 && !shots.some((x) => x.t <= d.t + 4 && x.t + x.ms >= d.t - d.ms - 4))
}

function hintsFor(drop: InspectorFrameDrop, anims: TraceAnim[], commits: InspectorCommit[], app?: InspectorAppInfo): string[] {
  const hints: string[] = []
  // Worklets, React and the JS/UI split are React Native's: other frameworks get their own fixes from the problems engine.
  if (!isReactNative(app)) {
    const all = distinctAnims(anims).length
    if (all >= 6) hints.push(`${all} animations started at once. ${adviceFor(app).burst}`)
    return hints
  }
  const slow = commits.find((c) => c.ms >= 8)
  if (slow) {
    const who = slow.components[0]?.name
    hints.push(
      who
        ? `React rendered for ${Math.round(slow.ms)} ms (${who} the slowest). Memoize it, or keep this state out of render while it animates (a shared value instead of useState).`
        : `React rendered for ${Math.round(slow.ms)} ms. Keep this state out of render while it animates (a shared value instead of useState).`,
    )
  }
  const moving = (xs: TraceAnim[]) => distinctAnims(xs).length
  const fromJs = moving(anims.filter((a) => a.thread === 'js'))
  if (drop.thread === 'js' && fromJs) {
    hints.push(
      `${fromJs === 1 ? 'An animation was' : `${fromJs} animations were`} started from the JS thread while it was busy. Start it from a worklet (a gesture callback or useAnimatedReaction) so the UI thread drives it without waiting on JS.`,
    )
  }
  const all = moving(anims)
  if (all >= 6) hints.push(`${all} animations started at once. Stagger them with withDelay, or drive them from one shared progress value.`)
  if (drop.thread === 'ui' && !anims.length && !slow) {
    hints.push('Nothing started on the UI thread here: look for heavy animated styles (shadows, blur, large images) or layout changes on the moving views.')
  }
  return hints
}

/**
 * One animation per thing it moves and line it is written on: withDelay(withTiming(…)) is one
 * animation written as two calls. Keeps the last call of each, the outermost.
 */
export function distinctAnims(anims: TraceAnim[]): TraceAnim[] {
  const byKey = new Map<string, TraceAnim>()
  for (const a of anims) byKey.set(`${a.site.file}:${a.site.line}:${a.site.target ?? a.site.prop ?? a.site.column}`, a)
  return [...byKey.values()]
}

/** "withSpring → logoScale (WelcomeHero, App.tsx:34)" */
export function describeAnim(a: Pick<TraceAnim, 'site'>): string {
  const { site } = a
  const target = site.target ?? site.prop
  const where = `${site.component ? `${site.component}, ` : ''}${site.file.split('/').pop()}:${site.line}`
  return `${site.fn}${target ? ` → ${target}` : ''} (${where})`
}

// ─── Gestures ─────────────────────────────────────────────────────────────────────

export type Gesture = {
  id: number
  t0: number
  t1: number
  x0: number
  y0: number
  x1: number
  y1: number
  kind: 'tap' | 'drag' | 'long press'
  path: Array<{ t: number; x: number; y: number }>
  /** The gesture handler that took the touch, when one did: "Pan" in SwipeCard at welcome.tsx:46. */
  handler?: { gesture: string; component: string | null; site: string }
  /** Its end was never seen: the view under the finger went away (it ends where that happened). */
  lost?: boolean
}

const END_CALLBACKS = new Set(['onEnd', 'onFinalize', 'onTouchesUp', 'onTouchesCancelled'])

/**
 * Touches grouped into gestures, from the first contact of a finger to its lift. A gesture handler
 * that takes a touch over cancels it for JS (React Native's touch events stop there), so the
 * handler's own events (gesture markers) continue its path; a handler with no JS touch to continue
 * (rare) becomes a gesture of its own.
 */
export function gesturesOf(markers: InspectorMarker[] = []): Gesture[] {
  const touches = touchGestures(markers)
  for (const run of handlerRuns(markers)) {
    const points = run.points
    if (!points.length) continue
    // The touch this handler took over: down before (or as) the handler started, not lifted before.
    const owner = touches.find((g) => g.t0 <= run.t0 + 40 && g.t1 >= run.t0 - 60 && !g.handler)
    const label = { gesture: run.gesture, component: run.component, site: run.site }
    if (owner) {
      owner.handler = label
      for (const p of points) if (p.t > owner.path[owner.path.length - 1]!.t) owner.path.push(p)
      const last = owner.path[owner.path.length - 1]!
      owner.t1 = Math.max(owner.t1, last.t)
      owner.x1 = last.x
      owner.y1 = last.y
      owner.kind = classify(owner)
    } else {
      const g: Gesture = { id: 100_000 + run.handler, t0: points[0]!.t, t1: points[points.length - 1]!.t, x0: points[0]!.x, y0: points[0]!.y, x1: 0, y1: 0, kind: 'tap', path: points, handler: label }
      g.x1 = points[points.length - 1]!.x
      g.y1 = points[points.length - 1]!.y
      g.kind = classify(g)
      touches.push(g)
    }
  }
  return touches.sort((a, b) => a.t0 - b.t0)
}

function classify(g: Gesture): Gesture['kind'] {
  return Math.hypot(g.x1 - g.x0, g.y1 - g.y0) > 10 ? 'drag' : g.t1 - g.t0 > 500 ? 'long press' : 'tap'
}

type HandlerRun = { handler: number; gesture: string; component: string | null; site: string; t0: number; points: Array<{ t: number; x: number; y: number }> }

/** Gesture markers split into one run per handler activation, from its first callback to its end. */
function handlerRuns(markers: InspectorMarker[]): HandlerRun[] {
  const open = new Map<number, HandlerRun>()
  const runs: HandlerRun[] = []
  for (const m of markers) {
    if (m.kind !== 'gesture') continue
    let run = open.get(m.handler)
    if (!run) {
      run = { handler: m.handler, gesture: m.gesture, component: m.component, site: m.site, t0: m.t, points: [] }
      open.set(m.handler, run)
      runs.push(run)
    }
    if (m.x !== null && m.y !== null) run.points.push({ t: m.t, x: m.x, y: m.y })
    if (END_CALLBACKS.has(m.on)) open.delete(m.handler)
  }
  return runs
}

function touchGestures(markers: InspectorMarker[]): Gesture[] {
  const open = new Map<number, Gesture>()
  const done: Gesture[] = []
  for (const m of markers) {
    if (m.kind !== 'touch') continue
    if (m.phase === 'start') {
      // The same finger down again while its last touch never ended (older recordings, where the view
      // under the finger went away): that touch is over.
      const prev = open.get(m.id)
      if (prev) done.push({ ...prev, kind: classify(prev), lost: true })
      open.set(m.id, { id: m.id, t0: m.t, t1: m.t, x0: m.x, y0: m.y, x1: m.x, y1: m.y, kind: 'tap', path: [{ t: m.t, x: m.x, y: m.y }] })
      continue
    }
    const g = open.get(m.id)
    if (!g) continue
    g.t1 = m.t
    g.x1 = m.x
    g.y1 = m.y
    g.path.push({ t: m.t, x: m.x, y: m.y })
    if (m.phase === 'end' || m.phase === 'cancel') {
      open.delete(m.id)
      g.kind = classify(g)
      if (m.lost) g.lost = true
      done.push(g)
    }
  }
  // Still down when the recording stopped.
  for (const g of open.values()) done.push({ ...g, kind: Math.hypot(g.x1 - g.x0, g.y1 - g.y0) > 10 ? 'drag' : 'long press' })
  return done.sort((a, b) => a.t0 - b.t0)
}

/** Where each finger was at `t`, for drawing touches over a screenshot. */
export function touchesAt(gestures: Gesture[], t: number): Array<{ id: number; x: number; y: number }> {
  const out: Array<{ id: number; x: number; y: number }> = []
  for (const g of gestures) {
    if (t < g.t0 || t > g.t1 + 80) continue
    let p = g.path[0]!
    for (const q of g.path) {
      if (q.t > t) break
      p = q
    }
    out.push({ id: g.id, x: p.x, y: p.y })
  }
  return out
}

export type Finger = {
  id: number
  x: number
  y: number
  trail: Array<{ x: number; y: number; age: number }>
  /** How long it has stayed where it went down (0 once it moved): drawn as a filling ring, a long press. */
  held: number
  /** After a long press lifts, its ring and timer fade out: 1 while down, falling to 0. */
  fade: number
  /** The finger has lifted (only the fading ring and timer remain). */
  lifted: boolean
}

/** How long a long press's ring and timer take to fade out once the finger lifts, ms. */
export const HOLD_FADE_MS = 450

/** Where each finger was at `t`, the path it drew over the last `trailMs` and how long it has been held still. */
export function fingersAt(gestures: Gesture[], t: number, trailMs = 160): Finger[] {
  const out: Finger[] = []
  for (const g of gestures) {
    // A finger lingers a moment after it lifts, so a quick tap still shows; a long press's ring and
    // timer fade out instead of vanishing.
    const heldAtLift = g.path.some((q) => Math.hypot(q.x - g.x0, q.y - g.y0) > 10) ? 0 : g.t1 - g.t0
    const linger = longPressProgress(heldAtLift) > 0 ? HOLD_FADE_MS : 80
    if (t < g.t0 || t > g.t1 + linger) continue
    let p = g.path[0]!
    let moved = false
    const trail: Array<{ x: number; y: number; age: number }> = []
    for (const q of g.path) {
      if (q.t > t) break
      p = q
      if (Math.hypot(q.x - g.x0, q.y - g.y0) > 10) moved = true
      if (t - q.t <= trailMs) trail.push({ x: q.x, y: q.y, age: t - q.t })
    }
    const held = moved ? 0 : Math.max(0, Math.min(t, g.t1) - g.t0)
    const lifted = t > g.t1
    const fade = lifted && longPressProgress(held) > 0 ? Math.max(0, 1 - (t - g.t1) / HOLD_FADE_MS) : 1
    out.push({ id: g.id, x: p.x, y: p.y, trail: lifted ? [] : trail, held, fade, lifted })
  }
  return out
}

/** How far a held finger's long-press ring has filled (0..1): starts after 150 ms, full at 500 ms. */
export function longPressProgress(held: number): number {
  return held <= 150 ? 0 : Math.min(1, (held - 150) / 350)
}

/** The screenshot shown at `t`: the latest one taken at or before it (or the first). */
export function screenshotAt(s: InspectorSession, t: number): InspectorScreenshot | undefined {
  const shots = s.screenshots ?? []
  let pick = shots[0]
  for (const x of shots) {
    if (x.t > t) break
    pick = x
  }
  return pick
}

// ─── Files ────────────────────────────────────────────────────────────────────────

/** The session a recording file holds. */
export function sessionFromRecording(rec: InspectorRecording): InspectorSession {
  const ids = rec.signals.map((x) => x.id)
  const samples: Record<string, InspectorSample[]> = Object.fromEntries(ids.map((id) => [id, []]))
  for (const x of rec.samples) samples[x.id]?.push(x)
  for (const id of ids) samples[id]!.sort((a, b) => a.t - b.t)
  return {
    ids,
    samples,
    stats: rec.frames,
    drops: rec.drops,
    anims: rec.anims,
    commits: rec.commits,
    markers: rec.markers,
    screenshots: rec.screenshots,
    tasks: rec.tasks ?? [],
    work: rec.work ?? [],
    styles: rec.styles ?? [],
    source: { app: rec.app, startedAt: rec.startedAt, screen: rec.screen, note: rec.note, signals: rec.signals },
  }
}

/** A session as a recording file, for saving one recorded live. */
export function recordingFromSession(
  s: InspectorSession,
  info: { app: InspectorRecording['app']; signals: InspectorSignalSite[]; startedAt?: string; screen?: InspectorRecording['screen'] },
): InspectorRecording {
  const { t0, t1 } = sessionSpan(s)
  const sites = s.source?.signals ?? info.signals.filter((x) => s.ids.includes(x.id))
  return {
    format: 'keyframer-recording',
    version: 1,
    app: s.source?.app ?? s.app ?? info.app,
    startedAt: s.source?.startedAt ?? info.startedAt ?? new Date().toISOString(),
    duration: Math.round(t1 - t0),
    screen: s.source?.screen ?? info.screen ?? { width: 0, height: 0, scale: 1 },
    signals: sites,
    samples: s.ids.flatMap((id) => s.samples[id] ?? []),
    frames: s.stats,
    drops: s.drops,
    anims: s.anims,
    commits: s.commits,
    markers: s.markers ?? [],
    screenshots: s.screenshots ?? [],
    tasks: s.tasks ?? [],
    work: s.work ?? [],
    styles: s.styles ?? [],
    ...(s.source?.note ? { note: s.source.note } : {}),
  }
}

/** A recording file's text, checked: what it holds, or why it is not a recording. */
export function parseRecording(text: string): InspectorRecording | string {
  let rec: Partial<InspectorRecording>
  try {
    rec = JSON.parse(text)
  } catch {
    return 'This is not a JSON file.'
  }
  if (rec?.format !== 'keyframer-recording') return 'This is not a Keyframer recording.'
  if (rec.version !== 1) return `This recording is version ${rec.version}; update @keyframerdev/inspector to open it.`
  const lists = ['signals', 'samples', 'frames', 'drops', 'anims', 'commits', 'markers', 'screenshots'] as const
  for (const k of lists) if (!Array.isArray(rec[k])) return `The recording is missing its ${k}.`
  return rec as InspectorRecording
}

/** `myapp-2026-10-09-1842.kfrec.json` */
export function recordingFilename(rec: Pick<InspectorRecording, 'app' | 'startedAt'>): string {
  const name = rec.app.name.replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'recording'
  // Local time: the name is for the person sharing the file.
  const d = new Date(rec.startedAt)
  const p2 = (n: number) => String(n).padStart(2, '0')
  const when = Number.isNaN(d.getTime())
    ? 'recording'
    : `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`
  return `${name}-${when}.kfrec.json`
}
