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
  InspectorMount,
  InspectorRecordedAnim,
  InspectorRecording,
  InspectorRenderHint,
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
import { isScrollSample } from './scrollIds'
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
  /** What the SDK saw about how animated views are drawn (renderHint events, a recording's hints). */
  hints?: InspectorRenderHint[]
  /** When values mounted and went away while recording (`signal` and `unsignal` events with `t`; see InspectorMount). */
  mounts?: InspectorMount[]
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
    ...(msg.display ? { display: msg.display } : {}),
    ...(msg.accessibility ? { accessibility: msg.accessibility } : {}),
    ...(msg.device ? { device: msg.device } : {}),
  }
}

/** How soon after the recording's clock starts a `display` or `accessibility` marker still says how things were as it began, ms. */
const START_STATE_MS = 50

/**
 * The app a session is from: the live app's hello, or the recording's, with the display rate and the
 * motion setting as the recording began (`display` and `accessibility` markers in its first
 * START_STATE_MS: an SDK marks them as it starts recording, and they overrule an older hello).
 */
export function appOf(s: Pick<InspectorSession, 'app' | 'source' | 'markers'>): InspectorAppInfo | undefined {
  const app = s.app ?? s.source?.app
  if (!app) return app
  let out = app
  for (const m of s.markers ?? []) {
    if (m.t > START_STATE_MS) continue
    if (m.kind === 'display' && validHz(m.hz) !== null && validHz(m.hz) !== out.display?.hz) out = { ...out, display: { ...out.display, hz: validHz(m.hz)! } }
    if (m.kind === 'accessibility' && typeof m.reduceMotion === 'boolean' && m.reduceMotion !== (out.accessibility?.reduceMotion ?? false)) out = { ...out, accessibility: { ...out.accessibility, reduceMotion: m.reduceMotion } }
  }
  return out
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
    let hints = session.hints
    let mounts = session.mounts
    for (const e of msg.events) {
      // Timed while recording: a value mounting (again, after its screen remounted) or going away.
      if ((e.kind === 'signal' || e.kind === 'unsignal') && typeof e.t === 'number') {
        const id = e.kind === 'signal' ? e.site.id : e.id
        const mounted = e.kind === 'signal'
        const t = e.t
        if (!mounts?.some((m) => m.id === id && m.t === t && m.mounted === mounted)) mounts = capped([...(mounts ?? []), { id, t, mounted }])
        continue
      }
      if (e.kind === 'style') {
        if (!styles?.some((x) => x.id === e.site.id)) styles = [...(styles ?? []), e.site]
        continue
      }
      // Sent once per view and hint; a reconnect may send it again.
      if (e.kind === 'renderHint') {
        if (!hints?.some((x) => x.id === e.id && x.hint === e.hint)) hints = [...(hints ?? []), { id: e.id, hint: e.hint, ...(e.detail !== undefined ? { detail: e.detail } : {}) }]
        continue
      }
      if (e.kind !== 'anim' || e.t === undefined) continue
      anims.push({
        ...(typeof e.eid === 'number' ? { eid: e.eid } : {}),
        t: e.t,
        thread: e.thread ?? 'js',
        site: e.site,
        args: e.args,
        ...(e.stack ? { stack: e.stack } : {}),
        ...(e.frames?.length ? { frames: e.frames } : {}),
        ...(e.durationMs !== undefined ? { durationMs: e.durationMs } : {}),
      })
    }
    if (!anims.length && styles === session.styles && hints === session.hints && mounts === session.mounts) return session
    return { ...session, styles, hints, mounts, anims: anims.length ? capped([...session.anims, ...anims]) : session.anims }
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

// ─── Display and time ─────────────────────────────────────────────────────────────
// What the screen and the person's settings were at a moment of the recording, and the app's own
// animation clock: the editor can slow it down or pause it (the `time` message), and a `time` marker
// says so, so durations on the recording's clock can be read as the app's.

const validHz = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) && x >= 1 ? Math.round(x) : null)
const validScale = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : 1)

/** A setting that changes at markers: at `t`, the last change at or before it (the later of two at the same time), else `initial`. */
function stepper<T>(initial: T, changes: Array<{ t: number; v: T }>): (t: number) => T {
  const xs = changes.sort((a, b) => a.t - b.t)
  return (t) => {
    let lo = 0
    let hi = xs.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (xs[mid]!.t <= t) lo = mid + 1
      else hi = mid
    }
    return lo ? xs[lo - 1]!.v : initial
  }
}

/**
 * The display's refresh rate over a recording (whole Hz), for reading many times: at `t`, the last
 * `display` marker at or before it, else the app's hello, else 60. A frame's budget is 1000 / this.
 */
export function displayHzOf(app: Pick<InspectorAppInfo, 'display'> | null | undefined, markers: InspectorMarker[] | undefined): (t: number) => number {
  const changes: Array<{ t: number; v: number }> = []
  for (const m of markers ?? []) {
    if (m.kind !== 'display') continue
    const hz = validHz(m.hz)
    if (hz !== null) changes.push({ t: m.t, v: hz })
  }
  return stepper(validHz(app?.display?.hz) ?? 60, changes)
}

/** The display's refresh rate at `t` (see displayHzOf). */
export function displayHzAt(app: Pick<InspectorAppInfo, 'display'> | null | undefined, markers: InspectorMarker[] | undefined, t: number): number {
  return displayHzOf(app, markers)(t)
}

/** Whether the person asked for less motion (Reduce Motion, Remove animations), over a recording: the last `accessibility` marker, else the hello. */
export function reduceMotionOf(app: Pick<InspectorAppInfo, 'accessibility'> | null | undefined, markers: InspectorMarker[] | undefined): (t: number) => boolean {
  const changes: Array<{ t: number; v: boolean }> = []
  for (const m of markers ?? []) if (m.kind === 'accessibility' && typeof m.reduceMotion === 'boolean') changes.push({ t: m.t, v: m.reduceMotion })
  return stepper(app?.accessibility?.reduceMotion === true, changes)
}

/** Whether the person asked for less motion at `t` (see reduceMotionOf). */
export function reduceMotionAt(app: Pick<InspectorAppInfo, 'accessibility'> | null | undefined, markers: InspectorMarker[] | undefined, t: number): boolean {
  return reduceMotionOf(app, markers)(t)
}

/**
 * The app's animation clock over a recording, from its `time` markers (a scale that is not a number
 * of 0 or more reads as 1): built once, read many times. A marker's `step` while paused moves the
 * clock on by that many frames at once, at the display's rate then (`app`'s hello and the `display`
 * markers, 60 Hz without them).
 */
export type AppClock = {
  /** The app's animation speed at `t`: 1 unless a marker said otherwise (0: paused). */
  scaleAt(t: number): number
  /** Whether its animations were paused at any moment between `a` and `b` (a frame's start and end). */
  paused(a: number, b: number): boolean
  /** `t` on the app's clock: the recording's, with the time it was slowed or paused taken out. */
  appTime(t: number): number
  /** When `ms` of the app's time have passed after `t`, on the recording's clock; Infinity when it stayed paused. */
  after(t: number, ms: number): number
}

export function appClockOf(markers: InspectorMarker[] | undefined, app?: Pick<InspectorAppInfo, 'display'> | null): AppClock {
  const list: Array<{ t: number; scale: number; gain: number }> = []
  // A frame's length for a step: the display's rate then (its markers, else the app's hello, else 60 Hz).
  const hzAt = displayHzOf(app, markers)
  for (const m of markers ?? []) {
    if (m.kind !== 'time') continue
    const scale = validScale(m.scale)
    // A step while paused: the app's animations advanced that many frames at once.
    const step = scale === 0 && typeof m.step === 'number' && Number.isFinite(m.step) && m.step > 0 ? m.step : 0
    list.push({ t: m.t, scale, gain: step ? (step * 1000) / hzAt(m.t) : 0 })
  }
  list.sort((a, b) => a.t - b.t)
  // The paused stretches, [from, to).
  const pauses: Array<[number, number]> = []
  {
    let scale = 1
    let since = -Infinity
    for (const m of list) {
      if (scale === 0 && m.scale !== 0) pauses.push([since, m.t])
      if (scale !== 0 && m.scale === 0) since = m.t
      scale = m.scale
    }
    if (scale === 0) pauses.push([since, Infinity])
  }
  return {
    scaleAt(t) {
      let scale = 1
      for (const m of list) {
        if (m.t > t) break
        scale = m.scale
      }
      return scale
    },
    paused: (a, b) => pauses.some(([from, to]) => from < b && to > a),
    appTime(t) {
      if (!list.length) return t
      let lost = 0
      let scale = 1
      let since = 0
      // Steps count from their own moment: the frame they render is sampled at or after it.
      let gained = 0
      for (const m of list) {
        if (m.t <= t) gained += m.gain
        if (m.t >= t) break
        lost += (m.t - since) * (1 - scale)
        scale = m.scale
        since = m.t
      }
      return t - (lost + (t - since) * (1 - scale)) + gained
    },
    after(t, ms) {
      if (!list.length) return t + ms
      let i = 0
      let scale = 1
      for (; i < list.length && list[i]!.t <= t; i++) scale = list[i]!.scale
      let now = t
      let left = ms
      for (; i < list.length; i++) {
        const span = list[i]!.t - now
        if (scale > 0 && span * scale >= left) return now + left / scale
        left -= span * scale
        now = list[i]!.t
        scale = list[i]!.scale
        const gain = list[i]!.gain
        if (gain > 0) {
          if (left <= gain) return now
          left -= gain
        }
      }
      return scale > 0 ? now + left / scale : Infinity
    },
  }
}

/** The app's animation speed at `t` (see appClockOf). */
export function timeScaleAt(markers: InspectorMarker[] | undefined, t: number): number {
  return appClockOf(markers).scaleAt(t)
}

/** Whether the app's animations were paused at any moment between `a` and `b` (see appClockOf). */
export function pausedDuring(markers: InspectorMarker[] | undefined, a: number, b: number): boolean {
  return appClockOf(markers).paused(a, b)
}

/** `t` on the app's animation clock (see appClockOf). The same as `t` when the editor never slowed or paused it. */
export function appTimeAt(markers: InspectorMarker[] | undefined, t: number, app?: Pick<InspectorAppInfo, 'display'> | null): number {
  return appClockOf(markers, app).appTime(t)
}

/**
 * When `ms` of the app's animation time have passed after `t`, on the recording's clock: an animation
 * that runs 300 ms takes 1200 ms of the recording at a quarter of the speed. Infinity when the app
 * stayed paused.
 */
export function afterAppMs(markers: InspectorMarker[] | undefined, t: number, ms: number, app?: Pick<InspectorAppInfo, 'display'> | null): number {
  return appClockOf(markers, app).after(t, ms)
}

/** App states in which nothing the app draws is seen (React Native and iOS, Flutter's lifecycle). */
const BACKGROUND_STATES = new Set(['background', 'paused', 'hidden'])

/** When the app was in the background (`appState` markers), [from, to): nobody sees its frames, and the system may stop them. */
export function backgroundSpans(markers: InspectorMarker[] | undefined): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = []
  let since: number | null = null
  for (const m of markers ?? []) {
    if (m.kind !== 'appState') continue
    if (BACKGROUND_STATES.has(m.state)) {
      if (since === null) since = m.t
    } else if (since !== null) {
      out.push({ from: since, to: m.t })
      since = null
    }
  }
  if (since !== null) out.push({ from: since, to: Infinity })
  return out
}

/** Whether `[a, b]` (a frame's start and end, or one moment) overlaps a time the app was in the background. */
const inBackground = (away: Array<{ from: number; to: number }>, a: number, b: number) => away.some((x) => (a === b ? x.from <= a && a < x.to : x.from < b && x.to > a))

// ─── Frames ───────────────────────────────────────────────────────────────────────

export type ThreadSummary = { avg: number; min: number; dropped: number; longest: number }

/**
 * Frame rate per thread over the session: average and worst window, frames dropped, the longest frame.
 * Frames measured while the editor had the app's animations paused (a `time` marker) or the app was in
 * the background are left out: a paused clock is not a slow frame, and nobody sees a background one.
 */
export function frameSummary(s: InspectorSession): Record<InspectorThread, ThreadSummary | null> {
  const clock = appClockOf(s.markers)
  const away = backgroundSpans(s.markers)
  const of = (thread: InspectorThread): ThreadSummary | null => {
    const stats = s.stats.filter((x) => x.thread === thread && !clock.paused(x.t, x.t) && !inBackground(away, x.t, x.t))
    if (!stats.length) return null
    const drops = s.drops.filter((d) => d.thread === thread && !clock.paused(d.t - d.ms, d.t) && !inBackground(away, d.t - d.ms, d.t))
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
  // The margins are in frames of a 60 Hz display; a faster display has shorter frames.
  const k = 60 / displayHzAt(appOf(s), s.markers, drop.t)
  const from = drop.t - drop.ms - LEAD_MS * k
  const to = drop.t + 4 * k
  const anims = s.anims.filter((a) => a.t >= from && a.t <= to)
  // A commit is timed when it finished: one that ended inside the long frame ran in it.
  const commits = s.commits.filter((c) => c.t >= drop.t - drop.ms - 4 * k && c.t <= to + 16 * k).sort((a, b) => b.ms - a.ms)
  // The recorder's own screenshots hold the UI thread up: say so rather than blame the app.
  const shot = s.screenshots?.find((x) => x.t <= drop.t + 4 && x.t + x.ms >= drop.t - drop.ms - 4)
  const hints = shot
    ? [`The recorder took a screenshot during this frame (${Math.round(shot.ms)} ms): this drop is likely its own, not the app's.`]
    : hintsFor(drop, anims, commits, appOf(s))
  return { anims, commits, hints }
}

/**
 * Long frames the recorder's screenshots did not cause, outside the times the editor paused the app's
 * animations (a paused clock can read as one long frame) and the app was in the background (the
 * system stops its frames there): the ones that count.
 */
export function appDrops(s: InspectorSession): InspectorFrameDrop[] {
  const shots = s.screenshots ?? []
  const clock = appClockOf(s.markers)
  const away = backgroundSpans(s.markers)
  return s.drops.filter((d) => d.dropped > 0 && !shots.some((x) => x.t <= d.t + 4 && x.t + x.ms >= d.t - d.ms - 4) && !clock.paused(d.t - d.ms, d.t) && !inBackground(away, d.t - d.ms, d.t))
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

// ─── Mounts ───────────────────────────────────────────────────────────────────────
// A screen that remounts while recording gives its values new instances under the same ids (React
// Native's call-site ids, an SDK's names): each mount is a series of its own. Without mounts (older
// recordings), a value is one series from start to end, as before.

/** When each new instance of a value took over its id while recording, in time order: its series starts again there. */
export function mountTimes(s: Pick<InspectorSession, 'mounts'>, id: string): number[] {
  return (s.mounts ?? []).filter((m) => m.id === id && m.mounted).map((m) => m.t).sort((a, b) => a - b)
}

/**
 * When a value existed: from each mount (or the start) to its unmount, or the next mount (or the
 * end). One span from -Infinity to Infinity when nothing says otherwise.
 */
export function lifetimesOf(s: Pick<InspectorSession, 'mounts'>, id: string): Array<{ from: number; to: number }> {
  const events = (s.mounts ?? []).filter((m) => m.id === id).sort((a, b) => a.t - b.t)
  const out: Array<{ from: number; to: number }> = []
  // A value whose first event is a mount did not exist before it.
  let open: number | null = events[0]?.mounted ? null : -Infinity
  for (const m of events) {
    if (m.mounted) {
      if (open !== null) out.push({ from: open, to: m.t })
      open = m.t
    } else if (open !== null) {
      out.push({ from: open, to: m.t })
      open = null
    }
  }
  if (open !== null) out.push({ from: open, to: Infinity })
  return out
}

/** Samples in time order split where a new instance took over (`mounts`, from mountTimes): one series per mount. */
export function splitAtMounts<T extends { t: number }>(xs: T[], mounts: number[] | undefined): T[][] {
  if (!mounts?.length) return [xs]
  const at = mounts.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  const out: T[][] = [[]]
  let k = 0
  for (const x of xs) {
    let passed = false
    while (k < at.length && x.t >= at[k]!) {
      k++
      passed = true
    }
    if (passed && out[out.length - 1]!.length) out.push([])
    out[out.length - 1]!.push(x)
  }
  return out
}

/** Whether a new instance took over between two samples (in `(a, b]`): a step across it is not motion. */
export function remountBetween(mounts: number[], a: number, b: number): boolean {
  return mounts.some((m) => m > a && m <= b)
}

/**
 * The value an animation writes, as a sampled value's id: its target when that is an id, else the
 * value of that name in its component (in its file first). Null when it names none.
 *
 * A call site mounted more than once (each row of a list owns one: `<id>#2`, `<id>#3`…) is several
 * values under one name: the animation writes the one that starts moving when it should (its start,
 * after its withDelay), the first of them when none moves then.
 */
export function signalOfAnim(
  s: Pick<InspectorSession, 'samples'> & Partial<Pick<InspectorSession, 'markers' | 'mounts'>>,
  sites: InspectorSignalSite[],
  a: Pick<TraceAnim, 'site'> & Partial<Pick<TraceAnim, 't' | 'args'>>,
): string | null {
  const target = a.site.target
  if (!target) return null
  if (s.samples[target] || sites.some((x) => x.id === target)) return target
  const named = sites.filter((x) => x.name === target && (!a.site.component || !x.component || x.component === a.site.component))
  const id = (named.find((x) => x.file === a.site.file) ?? named[0])?.id ?? null
  return id === null ? null : instanceOf(s, sites, id, a)
}

/** `<id>#2`: the second mounted instance of call site `<id>`; its number, else null. */
function instanceNumber(x: string, id: string): number | null {
  if (!x.startsWith(`${id}#`)) return null
  const n = x.slice(id.length + 1)
  return /^\d+$/.test(n) ? Number(n) : null
}

/** Which instance of a call site's value the animation wrote (see signalOfAnim). */
function instanceOf(
  s: Pick<InspectorSession, 'samples'> & Partial<Pick<InspectorSession, 'markers' | 'mounts'>>,
  sites: InspectorSignalSite[],
  id: string,
  a: Partial<Pick<TraceAnim, 't' | 'args'>> & Pick<TraceAnim, 'site'>,
): string {
  if (typeof a.t !== 'number') return id
  const others = [...new Set([...Object.keys(s.samples), ...sites.map((x) => x.id)])].filter((x) => instanceNumber(x, id) !== null)
  if (!others.length) return id
  const delay = a.site.fn === 'withDelay' && typeof a.args?.[0] === 'number' && Number.isFinite(a.args[0]) ? Math.max(0, a.args[0] as number) : 0
  const expected = appClockOf(s.markers).after(a.t, delay)
  let best = id
  let score = Infinity
  for (const c of [id, ...others.sort((x, y) => instanceNumber(x, id)! - instanceNumber(y, id)!)]) {
    const at = movesAfter(s.samples[c] ?? [], a.t, mountTimes(s, c))
    if (at === null || at > expected + INSTANCE_WINDOW_MS) continue
    const d = Math.abs(at - expected)
    if (d < score) {
      score = d
      best = c
    }
  }
  return best
}

/** How long after it should have started an instance may start moving and still be the one an animation wrote, ms. */
const INSTANCE_WINDOW_MS = 1000

/** When a value first changed at or after `t` (a sample that moved from the one before it), or null. */
function movesAfter(xs: InspectorSample[], t: number, mounts: number[]): number | null {
  let lo = Infinity
  let hi = -Infinity
  for (const x of xs) {
    if (x.v < lo) lo = x.v
    if (x.v > hi) hi = x.v
  }
  const eps = Math.max((hi - lo) * 1e-3, 1e-9)
  for (let k = 1; k < xs.length; k++) {
    if (xs[k]!.t < t) continue
    if (Math.abs(xs[k]!.v - xs[k - 1]!.v) > eps && !remountBetween(mounts, xs[k - 1]!.t, xs[k]!.t)) return xs[k]!.t
  }
  return null
}

const isAnimRef = (x: unknown): x is { $anim: number } => !!x && typeof x === 'object' && typeof (x as { $anim?: unknown }).$anim === 'number'

/** How far apart a nested call and the call it is written in can be reported (a loaded JS thread), ms. */
const NESTED_MS = 50

/**
 * The animations not written inside another one, one per write: withDelay(…, withTiming(…)) reports
 * the inner call first, then the outer one, whose arguments point at it (`{ $anim: eid }`). Matched by
 * that reference when the animations kept their eid (within NESTED_MS: under load the two are
 * reported milliseconds apart); older recordings by the outer one following within 1 ms, in the same
 * file, on the same value.
 */
export function outermostAnims(anims: TraceAnim[]): TraceAnim[] {
  return anims.filter((a, i) => {
    const eid = a.eid
    for (let j = i + 1; j < Math.min(anims.length, i + 64); j++) {
      const b = anims[j]!
      if (b.t < a.t) continue
      if (typeof eid === 'number' && typeof b.eid === 'number') {
        if (b.t - a.t <= NESTED_MS && b.args.some((x) => isAnimRef(x) && x.$anim === eid)) return false
      } else if (j < i + 16 && b.t - a.t <= 1 && b.site.file === a.site.file && (b.site.target ?? null) === (a.site.target ?? null) && b.args.some(isAnimRef)) return false
    }
    return true
  })
}

/**
 * When animations of a value started, in time order (the outermost call of each write): a motion of
 * it begins there (curves.ts `starts`), not with what came before (a value set to its start, a drag).
 */
export function animStarts(s: Pick<InspectorSession, 'samples' | 'anims'> & Partial<Pick<InspectorSession, 'markers' | 'mounts'>>, sites: InspectorSignalSite[], id: string): number[] {
  return outermostAnims(s.anims)
    .filter((a) => signalOfAnim(s, sites, a) === id)
    .map((a) => a.t)
    .sort((x, y) => x - y)
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
    ...(rec.hints ? { hints: rec.hints } : {}),
    ...(rec.mounts ? { mounts: rec.mounts } : {}),
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
    ...(s.hints?.length ? { hints: s.hints } : {}),
    ...(s.mounts?.length ? { mounts: s.mounts } : {}),
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
  // What every reader takes on trust (the Rust core reads the file into its types and refuses it too).
  const app = rec.app as { name?: unknown; platform?: unknown } | undefined
  if (!app || typeof app !== 'object' || typeof app.name !== 'string') return 'The recording does not read: it does not say which app it was made on.'
  for (const k of lists) {
    const bad = (rec[k] as unknown[]).findIndex((x) => x === null || typeof x !== 'object')
    if (bad >= 0) return `The recording does not read: entry ${bad} of its ${k} is not an object.`
  }
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
