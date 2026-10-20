/**
 * The clock behind the `time` message on React Native: slow motion, pause and step.
 *
 * Reanimated animates from frame timestamps. Every animation it runs on the UI thread (withTiming,
 * withSpring, withDecay, the ones nested in withDelay / withSequence / withRepeat, animated styles,
 * layout animations, useFrameCallback) reads time from two places only: the timestamp each frame hands
 * to requestAnimationFrame, and `_getAnimationTimestamp()` when one starts outside a frame (a gesture,
 * a scheduleOnUI). native.ts puts this clock in front of both, so animation time runs at `scale` of
 * real time: half speed, frozen, or moved on by whole frames while frozen. Nothing in the app or in
 * Reanimated changes, and an animation started before the speed changed slows down too.
 *
 * The mapping is continuous: a speed change takes effect from the moment it is made, so nothing jumps.
 * Pure worklets, so the same math runs on the UI runtime and under vitest.
 */

/** Animation time as a function of real time while the inspector controls the speed. Times in ms. */
export type AnimationClock = {
  /** 1 is normal, 0.25 a quarter of the speed, 0 paused. */
  scale: number
  /** Animation time at `anchor`. */
  base: number
  /** Real time the current speed took effect. */
  anchor: number
  /** The last real frame time mapped, and what it mapped to: the inspector's own frame loops read real time back from them. */
  real: number
  out: number
}

/** Slowest and fastest speeds the clock takes; 0 pauses. The same in every SDK (see clampScale). */
export const MIN_SCALE = 0.01
export const MAX_SCALE = 1
/** Frames one `time` message steps at most (MCP set_time's maximum). */
export const MAX_STEP = 120

export function createClock(now: number): AnimationClock {
  'worklet'
  return { scale: 1, base: now, anchor: now, real: now, out: now }
}

/** The animation time at real time `t`. */
export function clockTime(c: AnimationClock, t: number): number {
  'worklet'
  return c.base + (t - c.anchor) * c.scale
}

/** Maps a frame's real timestamp, remembering both: what a frame callback receives instead of `t`. */
export function clockFrame(c: AnimationClock, t: number): number {
  'worklet'
  const out = clockTime(c, t)
  c.real = t
  c.out = out
  return out
}

/**
 * Changes the speed at real time `now`. Frame timestamps run ahead of the clock (a frame is stamped
 * with when it will be shown), so the change is anchored at the later of `now` and the last frame:
 * animation time never goes back.
 */
export function setClockScale(c: AnimationClock, scale: number, now: number): void {
  'worklet'
  const at = now > c.real ? now : c.real
  c.base = clockTime(c, at)
  c.anchor = at
  c.scale = scale
}

/** Moves animation time on by `frames` frames of `frameMs`: a step while paused. */
export function stepClock(c: AnimationClock, frames: number, frameMs: number): void {
  'worklet'
  c.base += frames * frameMs
}

/**
 * The speed a `time` message asks for, by the rules every SDK shares: 0 pauses, below 0.01 is 0.01,
 * above 1 is 1. Null when the message changes nothing (missing, not a number, infinite or negative),
 * though it is still answered.
 */
export function clampScale(scale: unknown): number | null {
  'worklet'
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale < 0) return null
  if (scale === 0) return 0
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
}

/** Frames a `time` message steps: only with scale 0 (paused), whole frames (floored), 1 to MAX_STEP; else 0. */
export function clampStep(step: unknown, scale: number | null): number {
  'worklet'
  if (scale !== 0 || typeof step !== 'number' || !Number.isFinite(step)) return 0
  const frames = Math.floor(step)
  return frames < 1 ? 0 : Math.min(MAX_STEP, frames)
}

/**
 * The real time of the frame a callback was handed `t` for. Inside a frame while the clock runs, `t`
 * is animation time; the inspector's own loops (frame meter, samplers, Motion Scan) measure real
 * frames, so they read it back. Anything else passes through.
 */
export function realFrameTime(t: number): number {
  'worklet'
  const c = (globalThis as { __KF_CLOCK__?: AnimationClock }).__KF_CLOCK__
  return c !== undefined && c.out === t ? c.real : t
}
