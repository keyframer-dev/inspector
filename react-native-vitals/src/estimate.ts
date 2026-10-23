/**
 * How long an animation call runs, copied from the inspector's `motionStats.ts` (`springSettleMs`,
 * `estimateMs`) so a field window and a local Motion Scan window are the same length.
 * `parity.test.ts` runs both copies on the same calls: change them together (and the core's port,
 * `motion.rs` in the inspector).
 *
 * Every animation call opens an ACTIVE WINDOW from when it was called until its estimated end (a
 * timing's duration, how long a spring runs, delays and sequences added up).
 */

/** The part of an animation event the estimate reads. Nested calls are `{ $anim: id }` in `args`. */
export type EstimateEvent = { site: { fn: string }; args: unknown[]; durationMs?: number }

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

/**
 * Estimated run time of one animation call (ms). Nested animations are read through their ids
 * (`withDelay(200, withTiming(…))` reports the inner call as `{ $anim: id }`); one whose inner call is
 * not known falls back to a short default.
 */
export function estimateMs<E extends EstimateEvent>(ev: E, byEid: (eid: number) => E | undefined, depth = 0): number {
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
    // From props: one config with duration and delay in ms.
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

/** Config keys the estimate reads: all an argument keeps before it is handed to the JS thread. */
const KEEP = ['duration', 'delay', 'stiffness', 'damping', 'mass', 'dampingRatio', 'energyThreshold', 'overshootClamping', 'speed', 'repeatCount', 'iterationCount'] as const

/**
 * An argument reduced to what the estimate needs: a number, a nested call's id, or a config's
 * timing keys (numbers, `'infinite'`, a spring's `overshootClamping: true`). Values, colors, callbacks
 * and easing functions never leave the thread they were passed on (and could not be copied between
 * runtimes anyway).
 */
export function slimArg(a: unknown, idOf: (x: object) => number | undefined): unknown {
  'worklet'
  if (typeof a === 'number') return a
  if ((typeof a === 'object' && a !== null) || typeof a === 'function') {
    const id = idOf(a as object)
    if (id !== undefined) return { $anim: id }
    if (typeof a === 'function' || Array.isArray(a)) return null
    const o = a as Record<string, unknown>
    const out: Record<string, unknown> = {}
    let any = false
    for (let i = 0; i < KEEP.length; i++) {
      const k = KEEP[i]!
      const v = o[k]
      if (typeof v === 'number' || v === 'infinite' || v === true) {
        out[k] = v
        any = true
      }
    }
    return any ? out : null
  }
  return null
}
