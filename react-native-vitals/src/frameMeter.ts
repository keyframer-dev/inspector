/**
 * The frame meter math, copied from the inspector (`react-native/src/frameMeter.ts` and
 * `motionStats.ts` `droppedFrames`) so the field and a local recording count frames the same way.
 * `frameMeter.parity.test.ts` runs both copies on the same frames: change them together.
 *
 * Plain state and a worklet tick, so the same code measures the JS thread (requestAnimationFrame) and
 * the UI thread (the UI runtime's requestAnimationFrame). The refresh interval is what most frames of
 * the last window took, snapped to 60/90/120 Hz: not the shortest, because a jittery loop sometimes
 * delivers two callbacks a few ms apart.
 */

export type MeterStat = { t: number; thread: 'ui' | 'js'; fps: number; dropped: number }
export type MeterDrop = { t: number; thread: 'ui' | 'js'; ms: number; dropped: number }

export type FrameMeter = {
  thread: 'ui' | 'js'
  windowMs: number
  interval: number
  last: number
  windowStart: number
  frames: number
  dropped: number
  fast: number
  mid: number
  stats: MeterStat[]
  drops: MeterDrop[]
}

export function createFrameMeter(thread: 'ui' | 'js', windowMs = 250): FrameMeter {
  'worklet'
  return { thread, windowMs, interval: 1000 / 60, last: -1, windowStart: -1, frames: 0, dropped: 0, fast: 0, mid: 0, stats: [], drops: [] }
}

/** A frame was drawn at `t` (ms). Finished windows land in `m.stats`, long frames in `m.drops`. */
export function tickFrameMeter(m: FrameMeter, t: number): void {
  'worklet'
  const last = m.last
  m.last = t
  if (last < 0) {
    m.windowStart = t
    return
  }
  const dt = t - last
  if (dt <= 0) return
  if (dt < 10.5) m.fast += 1
  else if (dt < 13) m.mid += 1
  const lost = Math.max(0, Math.round(dt / m.interval) - 1)
  if (lost > 0) {
    m.dropped += lost
    m.drops.push({ t, thread: m.thread, ms: Math.round(dt * 10) / 10, dropped: lost })
  }
  m.frames += 1
  const span = t - m.windowStart
  if (span >= m.windowMs) {
    m.stats.push({ t, thread: m.thread, fps: Math.round((m.frames * 1000) / span), dropped: m.dropped })
    const n = m.frames
    m.interval = m.fast * 2 > n ? 1000 / 120 : (m.fast + m.mid) * 2 > n ? 1000 / 90 : 1000 / 60
    m.frames = 0
    m.dropped = 0
    m.fast = 0
    m.mid = 0
    m.windowStart = t
  }
}

/** Frames a single frame of `dt` ms skipped at an `interval` ms refresh. */
export function droppedFrames(dt: number, interval: number): number {
  'worklet'
  return Math.max(0, Math.round(dt / interval) - 1)
}

// ─── Field additions ────────────────────────────────────────────────────────────────

/**
 * One measured thread in the field: the meter above, plus every frame since the last flush as flat
 * `[t, dt, budget, …]` (the frame's end, its length, the refresh interval it was counted against), so
 * the JS side can attribute each frame to its screen and to the animations running then. The meter's
 * own stats and drops are emptied as it goes: the field never keeps a recording.
 */
export type FieldMeter = { m: FrameMeter; buf: number[] }

export function createFieldMeter(thread: 'ui' | 'js'): FieldMeter {
  'worklet'
  return { m: createFrameMeter(thread), buf: [] }
}

/** A frame at `t`. Returns true when the buffer holds a flush's worth (about a quarter second). */
export function tickFieldMeter(f: FieldMeter, t: number): boolean {
  'worklet'
  const last = f.m.last
  const interval = f.m.interval
  tickFrameMeter(f.m, t)
  f.m.stats.length = 0
  f.m.drops.length = 0
  if (last >= 0 && t > last) f.buf.push(t, t - last, interval)
  return f.buf.length >= 90
}
