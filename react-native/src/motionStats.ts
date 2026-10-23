/**
 * Motion Scan's bookkeeping, kept pure so it runs (and is tested) outside React Native.
 *
 * Every animation call the inspector reports becomes an ACTIVE WINDOW: from when it was called until
 * its estimated end (a timing's duration, how long a spring runs, delays and sequences added up). A
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

/**
 * withSpring's defaults in Reanimated 4: a config is merged over GentleSpringConfig and
 * GentleSpringConfigWithDuration (react-native-reanimated 4.5.1, animation/spring/spring.ts and
 * springConfigs.ts). Reanimated 3's were stiffness 100, damping 10, mass 1.
 */
export const SPRING_DEFAULTS = { damping: 120, mass: 4, stiffness: 900, duration: 550, dampingRatio: 1, energyThreshold: 6e-9 } as const
/** The frames a spring is stepped on (60 fps), and the longest a physics config is said to run. */
const SPRING_FRAME_MS = 1000 / 60
const SPRING_MAX_MS = 5000

/**
 * The stiffness Reanimated gives a duration config (calculateNewStiffnessToMatchDuration): the one whose
 * energy, from rest, falls to the threshold at 1.5 × duration. Its bisection, step for step.
 */
function stiffnessForDuration(duration: number, zeta: number, mass: number, threshold: number): number {
  const t = (duration * 1.5) / 1000
  const diff = (k: number) => {
    const w = Math.sqrt(k / mass) * zeta
    const env = Math.exp(-w * t)
    const x = (1 + w * t) * env
    const v = x * -w + w * env
    return (k * x * x + mass * v * v) / k - threshold
  }
  let lo = Number.EPSILON
  let hi = 8000
  const direction = diff(hi) >= diff(lo) ? 1 : -1
  let k = (lo + hi) / 2
  let f = diff(k)
  for (let i = 100; Math.abs(f) > threshold * 1e-3 && i > 0; i--) {
    if (f * direction < 0) lo = k
    else hi = k
    k = (lo + hi) / 2
    f = diff(k)
  }
  return k
}

/**
 * How long a spring runs (ms), the way Reanimated 4 runs it: the config merged over withSpring's
 * defaults, stepped from rest at 60 fps until its energy falls to the threshold (where Reanimated ends
 * it and calls back), or until it passes its target with overshootClamping. A duration config
 * (`duration` or `dampingRatio`, 550 ms when only the ratio is given) gets the stiffness Reanimated
 * solves for, so it ends near 1.5 × duration. A damping ratio of 1 or more runs critically damped, as
 * in Reanimated. A config it rejects, or a duration of 0, jumps to the end: 0. A velocity or clamp in
 * the config is not read (both need the distance travelled, which the call does not say).
 */
export function springSettleMs(c: Record<string, unknown>): number {
  const mass = num(c.mass, SPRING_DEFAULTS.mass)
  const damping = num(c.damping, SPRING_DEFAULTS.damping)
  const duration = num(c.duration, SPRING_DEFAULTS.duration)
  const ratio = num(c.dampingRatio, SPRING_DEFAULTS.dampingRatio)
  const threshold = num(c.energyThreshold, SPRING_DEFAULTS.energyThreshold)
  let k = num(c.stiffness, SPRING_DEFAULTS.stiffness)
  if (!(k > 0 && damping > 0 && mass > 0 && ratio > 0 && threshold > 0 && duration > 0)) return 0
  const useDuration = num(c.duration, 0) !== 0 || num(c.dampingRatio, 0) !== 0
  if (useDuration) k = stiffnessForDuration(duration, ratio, mass, threshold)
  const w0 = Math.sqrt(k / mass)
  const zeta = useDuration ? ratio : damping / (2 * Math.sqrt(k * mass))
  // One frame of Reanimated's under- or critically damped solution.
  const h = SPRING_FRAME_MS / 1000
  const w1 = zeta < 1 ? w0 * Math.sqrt(1 - zeta * zeta) : 0
  const env = Math.exp(-(zeta < 1 ? zeta * w0 : w0) * h)
  const sin1 = Math.sin(w1 * h)
  const cos1 = Math.cos(w1 * h)
  const clamping = !!c.overshootClamping
  const cap = useDuration ? Math.max(SPRING_MAX_MS, 3 * duration) : SPRING_MAX_MS
  // Distance from the target (a share of the travel) and velocity.
  let x = 1
  let v = 0
  for (let n = 1; n * SPRING_FRAME_MS <= cap; n++) {
    if (zeta < 1) {
      const frag = env * (sin1 * ((v + zeta * w0 * x) / w1) + x * cos1)
      v = -zeta * w0 * frag + env * (cos1 * (v + zeta * w0 * x) - w1 * x * sin1)
      x = frag
    } else {
      const frag = x + (v + w0 * x) * h
      v = env * -w0 * frag + env * (v + w0 * x)
      x = env * frag
    }
    if ((clamping && (x < 0 || x > 1)) || (k * x * x + mass * v * v) / k <= threshold) return Math.max(50, n * SPRING_FRAME_MS)
  }
  return cap
}

/** How far from its target a spring may be, as a share of the distance it started from, and look settled. */
export const SPRING_VISUAL_SHARE = 0.02
/**
 * (1 + u)·e^(−u) = SPRING_VISUAL_SHARE: a critically damped spring from rest is that close to its
 * target from ω0·t = u on (it never overshoots). Solved once, to the last digit a double holds.
 */
const CRITICAL_VISUAL_U = 5.833921701917391

/**
 * How long a spring visibly moves (ms): until it stays within 2% of the distance it started from
 * (SPRING_VISUAL_SHARE), the way Reanimated 4 runs it (the config merged over withSpring's defaults,
 * mass 4; a duration config with the stiffness Reanimated solves for; a damping ratio of 1 or more
 * run critically damped). Its tail after that, until the energy threshold, moves less than the eye
 * sees: springSettleMs says how long it runs, this how long it looks like it does.
 *
 * Solved from Reanimated's closed form, from rest: critically damped, ω0·t = CRITICAL_VISUAL_U.
 * Underdamped, x(t) = e^(−ζω0·t)·(cos ω1t + ζω0/ω1·sin ω1t), whose peaks are at ω1t = nπ with
 * height e^(−ζω0·nπ/ω1): the last peak higher than 2% is found from that, and the time it comes back
 * within 2% after it (before the next zero) by bisection, where |x| only falls. With
 * overshootClamping it ends at its first pass, so the first descent decides. Rounded up to the next
 * 60 fps frame, and never past springSettleMs (a loose energy threshold ends it sooner). A config
 * Reanimated rejects jumps to the end: 0.
 */
export function springVisualMs(c: Record<string, unknown>): number {
  const settle = springSettleMs(c)
  if (settle <= 0) return 0
  const mass = num(c.mass, SPRING_DEFAULTS.mass)
  const damping = num(c.damping, SPRING_DEFAULTS.damping)
  const duration = num(c.duration, SPRING_DEFAULTS.duration)
  const ratio = num(c.dampingRatio, SPRING_DEFAULTS.dampingRatio)
  const threshold = num(c.energyThreshold, SPRING_DEFAULTS.energyThreshold)
  let k = num(c.stiffness, SPRING_DEFAULTS.stiffness)
  const useDuration = num(c.duration, 0) !== 0 || num(c.dampingRatio, 0) !== 0
  if (useDuration) k = stiffnessForDuration(duration, ratio, mass, threshold)
  const w0 = Math.sqrt(k / mass)
  const zeta = useDuration ? ratio : damping / (2 * Math.sqrt(k * mass))
  let t: number
  if (zeta >= 1) t = CRITICAL_VISUAL_U / w0
  else {
    const a = zeta * w0
    const b = w0 * Math.sqrt(1 - zeta * zeta)
    const x = (s: number) => Math.exp(-a * s) * (Math.cos(b * s) + (a / b) * Math.sin(b * s))
    // The last peak (n half-periods in) still more than 2% away; with overshootClamping, the start.
    const peaks = (Math.log(1 / SPRING_VISUAL_SHARE) * b) / (a * Math.PI)
    const n = c.overshootClamping ? 0 : Math.max(0, Math.ceil(peaks) - 1)
    let lo = (n * Math.PI) / b
    let hi = (n * Math.PI + Math.PI - Math.atan2(b, a)) / b
    for (let i = 0; i < 100; i++) {
      const mid = (lo + hi) / 2
      if (Math.abs(x(mid)) > SPRING_VISUAL_SHARE) lo = mid
      else hi = mid
    }
    t = hi
  }
  const frames = Math.ceil((t * 1000) / SPRING_FRAME_MS - 1e-9)
  return Math.min(settle, frames * SPRING_FRAME_MS)
}

/**
 * How long an animation call visibly runs (ms): a withSpring until it stays within 2% of its target
 * (springVisualMs), anything else as estimateMs. What "still running" means when another animation
 * takes the value over: a spring interrupted in its last 2% does not visibly jump.
 */
export function visibleMs(ev: AnimEvent, byEid: (eid: number) => AnimEvent | undefined): number {
  if (ev.site.fn === 'withSpring' && !(typeof ev.durationMs === 'number' && Number.isFinite(ev.durationMs))) return springVisualMs(cfg(ev.args[1]))
  return estimateMs(ev, byEid)
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
