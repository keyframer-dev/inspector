/**
 * Counts one thread's frames while a recording runs: its frame rate per window and every long frame.
 *
 * Plain state and a worklet tick, so the same code measures the JS thread (requestAnimationFrame) and
 * the UI thread (the UI runtime's requestAnimationFrame). The refresh interval is what most frames of
 * the last window took, snapped to 60/90/120 Hz: not the shortest, because a jittery loop sometimes
 * delivers two callbacks a few ms apart.
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
  stats: InspectorFrameStat[]
  drops: InspectorFrameDrop[]
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

