/**
 * Recorded signals, kept pure so the Keyframer editor and the Expo dev tools panel share them: sample
 * buffers, the sparkline, reading a recording at a playhead, and the frame rates it saw.
 */

import type { InspectorFrameDrop, InspectorFrameStat, InspectorRecordedFrames, InspectorSample } from '../../protocol/inspector'

export const MAX_SAMPLES = 600

/** Incoming samples appended per signal, oldest dropped past `max`, each list kept in time order. */
export function appendSamples(
  buffers: Record<string, InspectorSample[]>,
  samples: InspectorSample[],
  max = MAX_SAMPLES,
): Record<string, InspectorSample[]> {
  if (!samples.length) return buffers
  const next = { ...buffers }
  const touched = new Set<string>()
  for (const s of samples) {
    if (!touched.has(s.id)) {
      next[s.id] = [...(next[s.id] ?? [])]
      touched.add(s.id)
    }
    next[s.id]!.push(s)
  }
  for (const id of touched) {
    const list = next[id]!.sort((a, b) => a.t - b.t)
    if (list.length > max) next[id] = list.slice(list.length - max)
  }
  return next
}

/** SVG path for a sparkline of samples scaled into w × h (y up). Empty for fewer than two samples. */
export function sparklinePath(samples: InspectorSample[], w: number, h: number): string {
  if (samples.length < 2) return ''
  const t0 = samples[0]!.t
  const t1 = samples[samples.length - 1]!.t
  let lo = Infinity
  let hi = -Infinity
  for (const s of samples) {
    if (s.v < lo) lo = s.v
    if (s.v > hi) hi = s.v
  }
  const spanT = t1 - t0 || 1
  const spanV = hi - lo || 1
  const r = (n: number) => Math.round(n * 10) / 10
  return samples
    .map((s, i) => `${i ? 'L' : 'M'}${r(((s.t - t0) / spanT) * w)} ${r(h - ((s.v - lo) / spanV) * h)}`)
    .join(' ')
}

/** A recording's value at time `t` (same clock as its samples): linear between the samples around it, held past either end. */
export function sampleAt(samples: InspectorSample[], t: number, holdGapMs = Infinity): number | undefined {
  if (!samples.length) return undefined
  if (t <= samples[0]!.t) return samples[0]!.v
  const last = samples[samples.length - 1]!
  if (t >= last.t) return last.v
  let lo = 0
  let hi = samples.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (samples[mid]!.t <= t) lo = mid
    else hi = mid
  }
  const a = samples[lo]!
  const b = samples[hi]!
  // Across a gap longer than `holdGapMs` nothing was moving: hold the value from before it.
  if (b.t - a.t > holdGapMs) return a.v
  return b.t === a.t ? b.v : a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t)
}

/**
 * The part of a recording that plays from time `t` on, starting with its value at `t`, so playback
 * resumes from a scrubbed or paused playhead instead of the first sample.
 */
export function samplesFrom(samples: InspectorSample[], t: number): InspectorSample[] {
  const v = sampleAt(samples, t)
  if (v === undefined) return []
  return [{ id: samples[0]!.id, t, v }, ...samples.filter((s) => s.t > t)]
}

/** Adds the frames a `samples` message carried to every signal recording now. Keeps the newest `max` of each. */
export function appendFrames(
  prev: Record<string, InspectorRecordedFrames>,
  ids: string[],
  stats: InspectorFrameStat[],
  drops: InspectorFrameDrop[],
  max = 4000,
): Record<string, InspectorRecordedFrames> {
  const next = { ...prev }
  const cap = <T,>(xs: T[]) => (xs.length > max ? xs.slice(xs.length - max) : xs)
  for (const id of ids) {
    const cur = next[id] ?? { stats: [], drops: [] }
    next[id] = { stats: cap(cur.stats.concat(stats)), drops: cap(cur.drops.concat(drops)) }
  }
  return next
}

/** The frame-rate window a recording was in at time `t`, per thread: the first one ending at or after it. */
export function frameStatAt(stats: InspectorFrameStat[], thread: 'ui' | 'js', t: number): InspectorFrameStat | undefined {
  let last: InspectorFrameStat | undefined
  for (const s of stats) {
    if (s.thread !== thread) continue
    if (s.t >= t) return s
    last = s
  }
  return last
}
