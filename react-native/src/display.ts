/**
 * The display's refresh rate, read from frame timestamps: 60, 90 or 120 Hz, and when it changes
 * (ProMotion and Android's variable refresh lower it, so does low power mode, and on iOS Reanimated
 * itself asks for 60 Hz while its frames take more than 8 ms).
 *
 * A frame thread that keeps up delivers frames one refresh apart; one that drops frames delivers
 * multiples. So the rate is read from regular frames only: a window with enough frames one 120 Hz
 * refresh apart shows 120 Hz, and 60 Hz needs nearly every frame of a window one 60 Hz refresh apart.
 * A janky window proves nothing and changes nothing. A change counts once two windows in a row agree,
 * so a burst of jank does not read as the display slowing down.
 *
 * Pure worklets: the UI thread's frame loop runs it (native.ts), and so does a JS loop on the web.
 */

export type DisplayMeter = {
  windowMs: number
  last: number
  windowStart: number
  /** Frame intervals in the current window, and how many were one 120, 90 or 60 Hz refresh long. */
  n: number
  b120: number
  b90: number
  b60: number
  /** Over the whole run: a first guess before a window settles it. */
  all120: number
  all90: number
  all60: number
  /** The rate now, 0 until known. */
  hz: number
  /** The highest rate seen. */
  maxHz: number
  /** How many times the rate changed after it was first known: an adaptive display. */
  changes: number
  pending: number
  pendingWindows: number
}

export function createDisplayMeter(windowMs = 250): DisplayMeter {
  'worklet'
  return { windowMs, last: -1, windowStart: -1, n: 0, b120: 0, b90: 0, b60: 0, all120: 0, all90: 0, all60: 0, hz: 0, maxHz: 0, changes: 0, pending: 0, pendingWindows: 0 }
}

/** What one window of frames says about the rate: 120, 90, 60, or 0 for nothing (too few frames, or jank). */
export function windowRate(n: number, b120: number, b90: number, b60: number): number {
  'worklet'
  if (n < 4) return 0
  if (b120 * 4 >= n) return 120
  if (b90 * 4 >= n) return 90
  if (b60 * 5 >= n * 4) return 60
  return 0
}

// Declared before the worklet that calls it: the worklets plugin turns declarations into plain
// variables, so a worklet defined first captures `undefined`, and calling it aborts the app.
function setRate(m: DisplayMeter, hz: number): boolean {
  'worklet'
  m.hz = hz
  if (hz > m.maxHz) m.maxHz = hz
  m.pending = 0
  m.pendingWindows = 0
  return true
}

/** A frame at `t` (ms). True when the rate became known or changed (read `m.hz`). */
export function tickDisplayMeter(m: DisplayMeter, t: number): boolean {
  'worklet'
  const last = m.last
  m.last = t
  if (last < 0) {
    m.windowStart = t
    return false
  }
  const dt = t - last
  if (dt <= 0) return false
  m.n += 1
  if (dt >= 6 && dt < 10) {
    m.b120 += 1
    m.all120 += 1
  } else if (dt >= 10 && dt < 13) {
    m.b90 += 1
    m.all90 += 1
  } else if (dt >= 13 && dt < 20.5) {
    m.b60 += 1
    m.all60 += 1
  }
  if (t - m.windowStart < m.windowMs) return false
  const rate = windowRate(m.n, m.b120, m.b90, m.b60)
  m.n = 0
  m.b120 = 0
  m.b90 = 0
  m.b60 = 0
  m.windowStart = t
  if (!rate) return false
  if (rate === m.hz) {
    m.pending = 0
    m.pendingWindows = 0
    return false
  }
  if (m.hz === 0) return setRate(m, rate)
  if (rate === m.pending) m.pendingWindows += 1
  else {
    m.pending = rate
    m.pendingWindows = 1
  }
  if (m.pendingWindows < 2) return false
  m.changes += 1
  return setRate(m, rate)
}

/**
 * The best reading so far: the rate once a window settled it, else the fastest refresh that at least
 * three frames ran at (a busy start can hold the frame rate down, it cannot make frames come faster
 * than the display). 0 when there is nothing to go on.
 */
export function displayHz(m: DisplayMeter): number {
  'worklet'
  if (m.maxHz) return m.maxHz
  if (m.all120 >= 3) return 120
  if (m.all90 >= 3) return 90
  if (m.all60 >= 3) return 60
  return 0
}

/**
 * The interval a UI thread's frames are counted against: one refresh of the display, read from these
 * frames (`m`) or measured before (`knownHz`), so a busy 120 Hz screen counts its drops at 8.3 ms, not
 * at the 60 Hz a window of long frames looks like. `fallbackMs` until the rate is known.
 */
export function frameBudget(m: DisplayMeter, knownHz: number, fallbackMs: number): number {
  'worklet'
  const hz = m.hz || knownHz
  return hz > 0 ? 1000 / hz : fallbackMs
}
