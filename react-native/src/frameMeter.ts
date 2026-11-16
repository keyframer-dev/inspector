/**
 * Counts one thread's frames while a recording runs: its frame rate per window and every long frame.
 *
 * Plain state and a worklet tick, so the same code measures the JS thread (requestAnimationFrame) and
 * the UI thread (the UI runtime's requestAnimationFrame). The refresh interval is what most frames of
 * the last window took, snapped to 60/90/120 Hz: not the shortest, because a jittery loop sometimes
 * delivers two callbacks a few ms apart.
 *
 * A long frame says how much of it was the inspector's own work on that thread (ownTime.ts): what the
 * running total grew by since the frame before, when it was 0.5 ms or more.
 */

import type { InspectorFrameDrop, InspectorFrameStat } from '../../protocol/inspector'

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
  /** The inspector's running total of work (ownTime.ts) at the last frame. */
  inspector: number
  stats: InspectorFrameStat[]
  drops: InspectorFrameDrop[]
}

export function createFrameMeter(thread: 'ui' | 'js', windowMs = 250): FrameMeter {
  'worklet'
  return { thread, windowMs, interval: 1000 / 60, last: -1, windowStart: -1, frames: 0, dropped: 0, fast: 0, mid: 0, inspector: 0, stats: [], drops: [] }
}

/** Less of the inspector's own work than this in a long frame is not said (ms). */
const MIN_INSPECTOR_MS = 0.5

/**
 * A frame was drawn at `t` (ms). Finished windows land in `m.stats`, long frames in `m.drops`.
 * `inspector`: how long the inspector has worked on this thread so far (ownTime.ts inspectorTotalMs);
 * what it grew by since the last frame was the inspector's part of this one.
 */
export function tickFrameMeter(m: FrameMeter, t: number, inspector = 0): void {
  'worklet'
  const last = m.last
  m.last = t
  if (last < 0) {
    m.windowStart = t
    m.inspector = inspector
    return
  }
  const dt = t - last
  if (dt <= 0) return
  // Never more than the frame took: the two are read from different clocks.
  const own = Math.min(inspector - m.inspector, dt)
  m.inspector = inspector
  if (dt < 10.5) m.fast += 1
  else if (dt < 13) m.mid += 1
  const lost = Math.max(0, Math.round(dt / m.interval) - 1)
  if (lost > 0) {
    m.dropped += lost
    const ms = Math.round(dt * 10) / 10
    m.drops.push(
      own >= MIN_INSPECTOR_MS
        ? { t, thread: m.thread, ms, dropped: lost, inspectorMs: Math.round(own * 10) / 10 }
        : { t, thread: m.thread, ms, dropped: lost },
    )
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

