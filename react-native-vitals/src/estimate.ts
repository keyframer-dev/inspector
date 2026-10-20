/**
 * How long an animation call runs, copied from the inspector's `motionStats.ts` (`springSettleMs`,
 * `estimateMs`) so a field window and a local Motion Scan window are the same length.
 * `estimate.parity.test.ts` runs both copies on the same calls: change them together.
 *
 * Every animation call opens an ACTIVE WINDOW from when it was called until its estimated end (a
 * timing's duration, a spring's settle time, delays and sequences added up).
 */

/** The part of an animation event the estimate reads. Nested calls are `{ $anim: id }` in `args`. */
export type EstimateEvent = { site: { fn: string }; args: unknown[]; durationMs?: number }

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
const KEEP = ['duration', 'delay', 'stiffness', 'damping', 'mass', 'speed', 'repeatCount', 'iterationCount'] as const

/**
 * An argument reduced to what the estimate needs: a number, a nested call's id, or a config's
 * numeric timing keys. Values, colors, callbacks and easing functions never leave the thread they
 * were passed on (and could not be copied between runtimes anyway).
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
      if (typeof v === 'number' || v === 'infinite') {
        out[k] = v
        any = true
      }
    }
    return any ? out : null
  }
  return null
}
