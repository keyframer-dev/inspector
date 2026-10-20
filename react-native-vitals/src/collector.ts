/**
 * The on-device aggregation of one session window (production.md 1 and 2.1), pure so it runs and is
 * tested outside React Native. Fed with animation starts, touches, scrolls, navigations and frames on
 * one clock (ms, the JS thread's `performance.now()`); `snapshot()` returns the counters a report holds.
 *
 * Attribution is Motion Scan's rule (`MotionTracker` in the inspector): every animation call is ACTIVE
 * from its start to its estimated end, and a frame counts against every animation active then, plus
 * 32 ms of slack. Frames while no tracked animation ran are the screen's idle baseline. The 5 longest
 * frames carry a cause, from the light-mode rules of production.md 1 ("Attribution").
 */

import { VITALS_BUCKETS, VITALS_FROZEN_MS, VITALS_LIMITS, type VitalsCause, type VitalsSiteRef, type VitalsThread, type VitalsThreadStats } from '../../protocol/vitals'

/** What the Babel plugin bakes into each call site (or a runtime names). */
export type SiteInfo = { ref: VitalsSiteRef; key?: string; fn: string; component?: string | null; prop?: string | null }

/** A window's frame stays charged to an animation this long after its estimated end (MotionTracker). */
export const SLACK_MS = 32
/** How far before a long frame began an animation start counts as having started it (trace.ts). */
export const LEAD_MS = 50
/** A frame that ends this soon after a navigation is a screen mount. */
export const MOUNT_MS = 500
/** Distinct animations starting together that make a burst (trace.ts hintsFor). */
export const BURST = 6
/** A touch keeps its window open this long after the finger lifts (scroll deceleration). */
export const TOUCH_TAIL_MS = 1500
/** A scroll handler keeps its window open this long after its last event. */
export const SCROLL_TAIL_MS = 250
/** Field caps (production.md 2.2: MotionTracker's 400 windows and 2000 events drop to 100 and 500). */
export const MAX_WINDOWS = 100
export const MAX_EVENTS = 500
const MAX_STARTS = 64
const MAX_SPANS = 16
const MAX_NAVS = 16

export type SiteStats = {
  info: SiteInfo
  runs: number
  runsReduceMotion: number
  activeMs: number
  frames: number
  missed: number
  hitchMs: number
  worstMs: number
  /** Runs per screen name: the site's screen is where it ran most. */
  screens: Map<string, number>
  /** End of the latest run counted into activeMs, so overlapping runs count once. */
  activeUntil: number
}

export type WorstFrame = {
  thread: VitalsThread
  ms: number
  missed: number
  screen: string
  sites: SiteStats[]
  cause: VitalsCause
  afterNavMs?: number
}

export type ScreenStats = { name: string; ms: number; threads: Partial<Record<VitalsThread, VitalsThreadStats>> }

export type Snapshot = {
  screens: ScreenStats[]
  sites: SiteStats[]
  worst: WorstFrame[]
  foregroundMs: number
  measuredMs: number
  /** The refresh rate most frames were counted against, and the fastest seen. */
  targetHz: number
  maxHz: number
  reduceMotion: boolean
}

type Window = { key: string; info: SiteInfo; start: number; end: number; eid: number }
type Start = { t: number; key: string; thread: VitalsThread }
type Span = { start: number; end: number }

export function bucketOf(missed: number): number {
  let b = 0
  for (let i = 1; i < VITALS_BUCKETS.length; i++) if (missed >= VITALS_BUCKETS[i]!) b = i
  return b
}

const emptyThread = (): VitalsThreadStats => ({ frames: 0, hist: VITALS_BUCKETS.map(() => 0), frozen: 0, hitchMs: 0, idleFrames: 0, idleMissed: 0 })
const siteId = (s: SiteInfo) => s.key ?? refId(s.ref)
function refId(r: VitalsSiteRef): string {
  switch (r.kind) {
    case 'source':
      return `${r.file}:${r.line}:${r.column ?? 0}`
    case 'hashed':
      return `#${r.hash}`
    case 'name':
      return `name:${r.name}`
    case 'native':
      return `native:${r.image}:${r.offset}`
    case 'jvm':
      return `jvm:${r.className}.${r.method}:${r.line ?? 0}`
  }
}
const hzOf = (budget: number) => Math.round(1000 / budget)

export class Collector {
  private screens = new Map<string, ScreenStats>()
  private sites = new Map<string, SiteStats>()
  private windows: Window[] = []
  private starts: Start[] = []
  private touches: Span[] = []
  private scrolls: Span[] = []
  /** Navigations, for screen mounts. */
  private navs: Array<{ t: number; name: string }> = []
  /** Every screen change (navigations and renames), for the screen a late frame was drawn on. */
  private shown: Array<{ t: number; name: string }> = []
  private before = 'app'
  private worst: WorstFrame[] = []
  private touching = 0
  private screen = 'app'
  private fgSince: number | null = null
  private fgMs = 0
  private measuring: number | null = null
  private measuredMs = 0
  private latest = -Infinity
  private hzFrames = new Map<number, number>()
  /** Sum of frame lengths per thread: measured time as the meters saw it. */
  private frameMs: Record<VitalsThread, number> = { ui: 0, js: 0 }
  private reduceMotion = false
  private reduceMotionSeen = false

  constructor(private readonly keepWorst = 5) {}

  // ── Inputs ──────────────────────────────────────────────────────────────────────────

  /** The app came to the foreground (true) or left it. Screen time and foreground time accrue while in it. */
  foreground(on: boolean, now: number): void {
    if (on && this.fgSince === null) this.fgSince = now
    else if (!on && this.fgSince !== null) {
      this.accrue(now)
      this.fgSince = null
      this.measure(false, now)
    }
  }

  /** A navigation (or the first screen). `nav` false: a rename that is not a mount (setScreen at start). */
  setScreen(name: string, now: number, nav = true): void {
    if (name === this.screen && this.shown.length) return
    this.accrue(now)
    if (!this.shown.length) this.before = this.screen
    this.screen = this.screenKey(name)
    this.shown.push({ t: now, name: this.screen })
    if (this.shown.length > MAX_NAVS) this.before = this.shown.shift()!.name
    if (nav) {
      this.navs.push({ t: now, name: this.screen })
      if (this.navs.length > MAX_NAVS) this.navs.shift()
    }
  }

  setReduceMotion(on: boolean): void {
    this.reduceMotion = on
    if (on) this.reduceMotionSeen = true
  }

  /** An animation started at `now` and runs about `ms`. */
  animStart(info: SiteInfo, now: number, ms: number, thread: VitalsThread, eid = -1): void {
    const key = siteId(info)
    const s = this.site(key, info)
    s.runs++
    if (this.reduceMotion) s.runsReduceMotion++
    s.screens.set(this.screen, (s.screens.get(this.screen) ?? 0) + 1)
    const end = now + Math.max(0, ms)
    s.activeMs += Math.max(0, end - Math.max(now, s.activeUntil))
    s.activeUntil = Math.max(s.activeUntil, end)
    this.windows.push({ key, info, start: now, end, eid })
    if (this.windows.length > MAX_WINDOWS) this.windows.splice(0, this.windows.length - MAX_WINDOWS)
    this.starts.push({ t: now, key, thread })
    if (this.starts.length > MAX_STARTS) this.starts.shift()
  }

  /**
   * An outer call took an inner one in (`withDelay(200, withTiming(…))`): the inner one runs as part
   * of it, so its window and its run go (MotionTracker drops the inner window the same way).
   */
  consume(eid: number): void {
    const i = this.windows.findIndex((w) => w.eid === eid)
    if (i < 0) return
    const [w] = this.windows.splice(i, 1)
    const s = this.sites.get(w!.key)
    if (s && s.runs > 0) {
      s.runs--
      const n = (s.screens.get(this.screen) ?? 0) - 1
      if (n > 0) s.screens.set(this.screen, n)
      else s.screens.delete(this.screen)
      s.activeMs = Math.max(0, s.activeMs - (w!.end - w!.start))
      if (s.runs === 0 && s.frames === 0) this.sites.delete(w!.key)
    }
    for (let j = this.starts.length - 1; j >= 0; j--) {
      if (this.starts[j]!.key === w!.key && this.starts[j]!.t === w!.start) {
        this.starts.splice(j, 1)
        break
      }
    }
  }

  touch(down: boolean, now: number): void {
    if (down) {
      if (this.touching++ === 0) this.pushSpan(this.touches, now, Infinity)
    } else if (this.touching > 0 && --this.touching === 0) {
      const last = this.touches[this.touches.length - 1]
      if (last && last.end === Infinity) last.end = now + TOUCH_TAIL_MS
    }
  }

  scroll(now: number): void {
    const last = this.scrolls[this.scrolls.length - 1]
    if (last && now <= last.end + SCROLL_TAIL_MS) last.end = Math.max(last.end, now)
    else this.pushSpan(this.scrolls, now, now)
  }

  /** The frame meters started (true) or stopped: measured time. */
  measure(on: boolean, now: number): void {
    if (on && this.measuring === null) this.measuring = now
    else if (!on && this.measuring !== null) {
      this.measuredMs += Math.max(0, now - this.measuring)
      this.measuring = null
    }
  }

  /** One frame of `thread` that ended at `t`, took `dt` ms, against a refresh interval of `budget` ms. */
  frame(thread: VitalsThread, t: number, dt: number, budget: number): void {
    if (!(dt > 0) || !(budget > 0)) return
    const missed = Math.max(0, Math.round(dt / budget) - 1)
    const hitch = Math.max(0, dt - budget)
    const screenName = this.screenAt(t)
    const screen = this.screenStats(screenName)
    const st = (screen.threads[thread] ??= emptyThread())
    st.frames++
    st.hist[bucketOf(missed)]!++
    if (dt >= VITALS_FROZEN_MS) st.frozen++
    st.hitchMs += hitch
    const hz = hzOf(budget)
    this.hzFrames.set(hz, (this.hzFrames.get(hz) ?? 0) + 1)
    this.frameMs[thread] += dt
    if (t > this.latest) this.latest = t

    const active = new Map<string, SiteInfo>()
    for (const w of this.windows) if (t >= w.start && t <= w.end + SLACK_MS) active.set(w.key, w.info)
    if (!active.size) {
      st.idleFrames++
      st.idleMissed += missed
    }
    const charged: SiteStats[] = []
    for (const [key, info] of active) {
      const s = this.site(key, info)
      s.frames++
      s.missed += missed
      s.hitchMs += hitch
      if (dt > s.worstMs) s.worstMs = dt
      charged.push(s)
    }
    if (missed > 0) this.considerWorst(thread, t, dt, missed, screenName, charged)
    this.prune()
  }

  // ── Output ──────────────────────────────────────────────────────────────────────────

  snapshot(now: number): Snapshot {
    this.accrue(now)
    const gate = this.measuredMs + (this.measuring !== null ? Math.max(0, now - this.measuring) : 0)
    // A meter can run a little past the gate (the UI loop keeps its own time): never less than it saw.
    const measuredMs = Math.min(this.fgMs, Math.max(gate, this.frameMs.ui, this.frameMs.js))
    let targetHz = 60
    let best = -1
    let maxHz = 0
    for (const [hz, n] of this.hzFrames) {
      if (n > best) {
        best = n
        targetHz = hz
      }
      if (hz > maxHz) maxHz = hz
    }
    return {
      screens: [...this.screens.values()],
      sites: [...this.sites.values()],
      worst: [...this.worst],
      foregroundMs: this.fgMs,
      measuredMs,
      targetHz,
      maxHz: maxHz || targetHz,
      reduceMotion: this.reduceMotionSeen,
    }
  }

  /**
   * A new session window starts at `now`: the counters empty, what is running and where the app is
   * carry over (an animation that spans the cut keeps its window, counted in the new one from here).
   */
  reset(now: number): void {
    this.accrue(now)
    this.screens.clear()
    this.sites.clear()
    this.worst = []
    this.fgMs = 0
    this.measuredMs = 0
    if (this.measuring !== null) this.measuring = now
    this.hzFrames.clear()
    this.frameMs = { ui: 0, js: 0 }
    this.reduceMotionSeen = this.reduceMotion
  }

  /** Nothing is kept (setVitalsEnabled(false), a session that ends). */
  clear(): void {
    this.screens.clear()
    this.sites.clear()
    this.windows = []
    this.starts = []
    this.touches = []
    this.scrolls = []
    this.navs = []
    this.shown = []
    this.before = this.screen
    this.worst = []
    this.touching = 0
    this.fgMs = 0
    this.fgSince = null
    this.measuring = null
    this.measuredMs = 0
    this.hzFrames.clear()
    this.frameMs = { ui: 0, js: 0 }
    this.reduceMotionSeen = this.reduceMotion
  }

  get currentScreen(): string {
    return this.screen
  }

  get foregroundMs(): number {
    return this.fgMs
  }

  /** Foreground time of this window so far, at `now`. */
  foregroundAt(now: number): number {
    return this.fgMs + (this.fgSince !== null ? Math.max(0, now - this.fgSince) : 0)
  }

  // ── Internals ───────────────────────────────────────────────────────────────────────

  private accrue(now: number): void {
    if (this.fgSince === null) return
    const dt = Math.max(0, now - this.fgSince)
    this.fgMs += dt
    this.fgSince = now
    if (dt > 0) this.screenStats(this.screen).ms += dt
  }

  /** A screen name, or `other` once VITALS_LIMITS.screens names are taken. */
  private screenKey(name: string): string {
    if (this.screens.has(name) || this.screens.size < VITALS_LIMITS.screens - 1) return name
    return 'other'
  }

  private screenStats(name: string): ScreenStats {
    let s = this.screens.get(name)
    if (!s) this.screens.set(name, (s = { name, ms: 0, threads: {} }))
    return s
  }

  /** The screen shown when a frame that ended at `t` was drawn: frames reach here late. */
  private screenAt(t: number): string {
    for (let i = this.shown.length - 1; i >= 0; i--) if (this.shown[i]!.t <= t) return this.shown[i]!.name
    return this.shown.length ? this.before : this.screen
  }

  private site(key: string, info: SiteInfo): SiteStats {
    let s = this.sites.get(key)
    if (!s) {
      s = { info, runs: 0, runsReduceMotion: 0, activeMs: 0, frames: 0, missed: 0, hitchMs: 0, worstMs: 0, screens: new Map(), activeUntil: -Infinity }
      this.sites.set(key, s)
    }
    return s
  }

  private pushSpan(list: Span[], start: number, end: number): void {
    list.push({ start, end })
    if (list.length > MAX_SPANS) list.shift()
  }

  private open(list: Span[], t: number, tail: number): boolean {
    return list.some((s) => t >= s.start - 16 && t <= s.end + tail)
  }

  private considerWorst(thread: VitalsThread, t: number, dt: number, missed: number, screen: string, charged: SiteStats[]): void {
    if (this.worst.length >= this.keepWorst && dt <= this.worst[this.worst.length - 1]!.ms) return
    const { cause, afterNavMs } = this.causeOf(thread, t, dt)
    const w: WorstFrame = { thread, ms: dt, missed, screen, sites: charged, cause, ...(afterNavMs !== undefined ? { afterNavMs } : {}) }
    this.worst.push(w)
    this.worst.sort((a, b) => b.ms - a.ms)
    if (this.worst.length > this.keepWorst) this.worst.length = this.keepWorst
  }

  /** The light-mode cause of a long frame (production.md 1, "Attribution"), in the table's order. */
  causeOf(thread: VitalsThread, t: number, dt: number): { cause: VitalsCause; afterNavMs?: number } {
    let nav: number | undefined
    for (const n of this.navs) if (n.t <= t) nav = n.t
    if (nav !== undefined && t - nav <= MOUNT_MS) return { cause: 'screen-mount', afterNavMs: Math.round(t - nav) }
    const from = t - dt - LEAD_MS
    const started = this.starts.filter((s) => s.t >= from && s.t <= t + 4)
    if (new Set(started.map((s) => s.key)).size >= BURST) return { cause: 'burst' }
    if (thread === 'js' && started.some((s) => s.thread === 'js')) return { cause: 'busy-start' }
    if (!started.length && this.open(this.scrolls, t, SCROLL_TAIL_MS)) return { cause: 'scroll' }
    if (!started.length && this.open(this.touches, t, 0)) return { cause: 'gesture' }
    return { cause: 'unknown' }
  }

  /** Windows long over (frames of the other thread arrive up to a few hundred ms late). */
  private prune(): void {
    const before = this.latest - 2000
    if (this.windows.length && this.windows[0]!.end + SLACK_MS < before) this.windows = this.windows.filter((w) => w.end + SLACK_MS >= before)
    while (this.touches.length > 1 && this.touches[0]!.end < before) this.touches.shift()
    while (this.scrolls.length > 1 && this.scrolls[0]!.end + SCROLL_TAIL_MS < before) this.scrolls.shift()
  }
}

/**
 * When the frame meters run: inside motion windows only, plus 250 ms after the last one closes
 * (production.md 2.1). Nothing here keeps a timer: the meters ask `open(now)` on each frame and stop
 * themselves.
 */
export const GATE_TAIL_MS = 250

export class MotionGate {
  until = -Infinity
  private touching = 0

  /** Something moves until `end`. True when the gate was closed at `now` (the meters must start). */
  note(end: number, now: number): boolean {
    const wasOpen = this.open(now)
    if (end + GATE_TAIL_MS > this.until) this.until = end + GATE_TAIL_MS
    return !wasOpen && this.open(now)
  }

  /** A touch went down (true) or up. True when the gate opened. */
  touch(down: boolean, now: number): boolean {
    const wasOpen = this.open(now)
    if (down) this.touching++
    else if (this.touching > 0 && --this.touching === 0) this.note(now + TOUCH_TAIL_MS, now)
    return !wasOpen && this.open(now)
  }

  open(now: number): boolean {
    return this.touching > 0 || now <= this.until
  }

  /** When the gate closes if nothing else happens (Infinity while a finger is down). */
  closesAt(): number {
    return this.touching > 0 ? Infinity : this.until
  }

  reset(): void {
    this.until = -Infinity
    this.touching = 0
  }
}
