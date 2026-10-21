/**
 * Motion Scan's bookkeeping, kept pure so it runs (and is tested) outside React Native.
 *
 * Every animation call the inspector reports becomes an ACTIVE WINDOW: from when it was called until
 * its estimated end (a timing's duration, a spring's settle time, delays and sequences added up). A
 * dropped frame is charged to every animation active at that moment, per call site, so the scan can
 * say "Card.tsx:42 withSpring dropped 12 frames" instead of only "the app dropped frames".
 *
 * Which view an animation moves comes from the styles the Babel plugin tagged: a style whose links read
 * the shared value the animation writes (same component), or, for an animation written inline in a
 * style object, the styles of its component.
 */

import type { InspectorCallSite, InspectorEvent, InspectorStyleSite } from '../../protocol/inspector'

type AnimEvent = Extract<InspectorEvent, { kind: 'anim' }>

const isRef = (v: unknown): v is { $anim: number } =>
  !!v && typeof v === 'object' && typeof (v as { $anim?: unknown }).$anim === 'number'
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const cfg = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

/** How long a spring takes to settle (ms), from its physics: 4 time constants of its slowest decay. */
export function springSettleMs(c: Record<string, unknown>): number {
  if (typeof c.duration === 'number') return c.duration
  const k = num(c.stiffness, 100)
  const d = num(c.damping, 10)
  const m = num(c.mass, 1)
  const w0 = Math.sqrt(k / m)
  const zeta = d / (2 * Math.sqrt(k * m))
  const decay = zeta < 1 ? zeta * w0 : w0 * (zeta - Math.sqrt(zeta * zeta - 1))
  const s = decay > 0 ? 4 / decay : 2
  return Math.max(50, Math.min(5000, s * 1000))
}

/**
 * Whether an animation call never ends on its own: withRepeat(…, -1 or 0), or one wrapping it (withDelay,
 * withSequence, withClamp), or an infinite CSS animation. Its estimated run time is only a first guess.
 */
export function isEndless(ev: AnimEvent, byEid: (eid: number) => AnimEvent | undefined, depth = 0): boolean {
  if (depth > 12) return false
  const inner = (a: unknown) => {
    if (!isRef(a)) return false
    const e = byEid(a.$anim)
    return e ? isEndless(e, byEid, depth + 1) : false
  }
  const [a0, a1] = ev.args
  switch (ev.site.fn) {
    case 'withRepeat':
      return num(a1, 2) <= 0 || inner(a0)
    case 'withDelay':
    case 'withClamp':
      return inner(a1)
    case 'withSequence':
      return ev.args.some(inner)
    case 'CSS animation':
      return cfg(a0).iterationCount === 'infinite'
    default:
      return false
  }
}

/**
 * Estimated run time of one animation call (ms). Nested animations are read through their ids
 * (`withDelay(200, withTiming(…))` reports the inner call as `{ $anim: id }`); one forwarded from the UI
 * thread has lost its nesting, and falls back to a short default.
 */
export function estimateMs(ev: AnimEvent, byEid: (eid: number) => AnimEvent | undefined, depth = 0): number {
  if (depth > 12) return 300
  // Native SDKs say how long it runs: delay, duration and repeats in one number.
  if (typeof ev.durationMs === 'number' && Number.isFinite(ev.durationMs)) return ev.durationMs
  const inner = (a: unknown) => {
    if (!isRef(a)) return 300
    const e = byEid(a.$anim)
    return e ? estimateMs(e, byEid, depth + 1) : 300
  }
  const [a0, a1] = ev.args
  switch (ev.site.fn) {
    case 'withTiming':
      return num(cfg(a1).duration, 300)
    case 'withSpring':
      return springSettleMs(cfg(a1))
    case 'withDelay':
      return num(a0, 0) + inner(a1)
    case 'withSequence':
      return ev.args.reduce<number>((s, a) => s + inner(a), 0)
    case 'withRepeat': {
      const n = num(a1, 2)
      // Infinite repeats stay "active" for a while after each call; they keep reporting anyway.
      return inner(a0) * (n > 0 ? n : 10)
    }
    case 'withClamp':
      return inner(a1)
    case 'withDecay':
      return 1000
    // From props (runtime.ts reportMotion): one config with duration and delay in ms.
    case 'CSS animation': {
      const c = cfg(a0)
      const n = typeof c.iterationCount === 'number' ? c.iterationCount : c.iterationCount === 'infinite' ? 10 : 1
      return num(c.delay, 0) + num(c.duration, 0) * n
    }
    case 'CSS transition':
    case 'entering':
    case 'exiting':
    case 'layout':
      return num(cfg(a0).delay, 0) + num(cfg(a0).duration, 300)
    // SwiftUI (the iOS SDK sends durationMs when it can tell): `.default`, or one that repeats forever.
    case 'withAnimation':
    case 'Transaction': {
      const c = cfg(a1)
      const speed = num(c.speed, 1) > 0 ? num(c.speed, 1) : 1
      const reps = c.repeatCount === 'infinite' ? 10 : Math.max(1, num(c.repeatCount, 1))
      return (num(c.delay, 0) + num(c.duration, 300) * reps) / speed
    }
    default: {
      // An API the inspector does not know (UIView.animate, ObjectAnimator, animateTo): a config with
      // duration and delay in ms, as the second argument or the only one.
      const c = cfg(a1).duration !== undefined ? cfg(a1) : cfg(a0)
      return typeof c.duration === 'number' ? num(c.delay, 0) + c.duration : 300
    }
  }
}

export type SiteStats = {
  site: InspectorCallSite
  calls: number
  /** Frames dropped while one of this site's calls was running. */
  dropped: number
  /** The longest frame seen while it ran (ms). */
  worstFrameMs: number
}

type Window = { ev: AnimEvent; start: number; end: number; dropped: number; endless: boolean }

export type Outline = { styleId: string; siteId: string; dropped: number; live: boolean; age: number }

export class MotionTracker {
  private events = new Map<number, AnimEvent>()
  private windows: Window[] = []
  readonly sites = new Map<string, SiteStats>()
  readonly styles = new Map<string, InspectorStyleSite>()

  /** Feed every inspector event here. `now` is when it was seen (ms, same clock as onDrop). */
  onEvent(ev: InspectorEvent, now: number): void {
    if (ev.kind === 'style') {
      this.styles.set(ev.site.id, ev.site)
      return
    }
    if (ev.kind !== 'anim') return
    this.events.set(ev.eid, ev)
    // An inner animation (withTiming inside withDelay) runs as part of its parent: its window is the
    // parent's. Only calls nobody wraps open a window; the inner one is reported first, so drop it if
    // a later call refers to it.
    for (const a of ev.args) if (isRef(a)) this.windows = this.windows.filter((w) => w.ev.eid !== a.$anim)
    const ms = estimateMs(ev, (id) => this.events.get(id))
    this.windows.push({ ev, start: now, end: now + ms, dropped: 0, endless: isEndless(ev, (id) => this.events.get(id)) })
    if (this.windows.length > 400) this.windows.splice(0, this.windows.length - 400)
    if (this.events.size > 2000) {
      const keep = new Set(this.windows.map((w) => w.ev.eid))
      for (const id of this.events.keys()) if (!keep.has(id)) this.events.delete(id)
    }
    const s = this.sites.get(ev.site.id) ?? { site: ev.site, calls: 0, dropped: 0, worstFrameMs: 0 }
    s.calls++
    this.sites.set(ev.site.id, s)
  }

  /** `frames` frames were dropped by a frame that took `frameMs`, seen at `now`. */
  onDrop(now: number, frames: number, frameMs: number): void {
    for (const w of this.windows) {
      if (now < w.start || now > w.end + 32) continue
      w.dropped += frames
      const s = this.sites.get(w.ev.site.id)
      if (s) {
        s.dropped += frames
        s.worstFrameMs = Math.max(s.worstFrameMs, frameMs)
      }
    }
  }

  /** Call sites that cost frames, worst first. */
  worst(limit = 5): SiteStats[] {
    return [...this.sites.values()].filter((s) => s.dropped > 0).sort((a, b) => b.dropped - a.dropped).slice(0, limit)
  }

  /** The styles an animation call drives. */
  stylesOf(site: InspectorCallSite): InspectorStyleSite[] {
    const out: InspectorStyleSite[] = []
    for (const st of this.styles.values()) {
      if (st.file !== site.file) continue
      const sameComponent = st.component === site.component
      if (site.target && st.links.some((l) => l.signal === site.target) && sameComponent) out.push(st)
      // Written inline in the style object: `{ scale: withSpring(1) }` belongs to that style.
      else if (!site.target && sameComponent) out.push(st)
    }
    return out
  }

  /**
   * Endless loops have no end to estimate: each stays open while the value it writes keeps changing.
   * `moving(site)` says whether the value that call writes changed since it was last asked; a loop that
   * stopped (cancelAnimation, its screen gone) is let go, and its outline fades.
   */
  keepEndless(now: number, moving: (site: InspectorCallSite) => boolean): void {
    for (const w of this.windows) {
      if (w.endless && w.ev.site.target && now > w.end - 300 && moving(w.ev.site)) w.end = now + 600
    }
  }

  /**
   * What to outline now: every style an animation moved within the last `fadeMs`, with the frames that
   * animation cost. `live` while it still runs.
   */
  outlines(now: number, fadeMs = 700): Outline[] {
    const best = new Map<string, Outline>()
    for (const w of this.windows) {
      if (now < w.start || now > w.end + fadeMs) continue
      const live = now <= w.end
      const age = live ? 0 : now - w.end
      for (const st of this.stylesOf(w.ev.site)) {
        const prev = best.get(st.id)
        if (!prev || w.dropped > prev.dropped || (live && !prev.live)) best.set(st.id, { styleId: st.id, siteId: w.ev.site.id, dropped: w.dropped, live, age })
      }
    }
    return [...best.values()]
  }
}

/**
 * The refresh interval a stream of frame times shows: the TYPICAL one (median), snapped to 60/90/120 Hz.
 * Not the shortest: a jittery loop (the iOS simulator's JS thread) sometimes delivers two callbacks a few
 * ms apart, and reading that as 120 Hz turned every ordinary 60 Hz frame into a "dropped" one.
 * `displayHz`, when the app knows its display's rate: frames are never shorter than that display's,
 * and it is the first rate tried (a 144 Hz screen, a 30 Hz one).
 */
export function frameIntervalOf(recent: number[], displayHz?: number | null): number {
  const top = typeof displayHz === 'number' && Number.isFinite(displayHz) && displayHz >= 1 ? displayHz : Infinity
  const rates = top === Infinity ? [120, 90, 60] : [top, ...[120, 90, 60].filter((hz) => hz < top)]
  const fallback = 1000 / Math.min(60, top)
  const xs = recent.filter((x) => x > 4).sort((a, b) => a - b)
  if (!xs.length) return fallback
  const median = xs[Math.floor(xs.length / 2)]!
  for (const hz of rates) if (median <= 1000 / hz + 1.5) return 1000 / hz
  return fallback
}

/** Frames a single frame of `dt` ms skipped at an `interval` ms refresh. */
export function droppedFrames(dt: number, interval: number): number {
  return Math.max(0, Math.round(dt / interval) - 1)
}
