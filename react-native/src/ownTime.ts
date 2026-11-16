/**
 * The inspector's own work on a thread, timed so a frame drop it caused is told from the app's
 * (InspectorFrameDrop.inspectorMs): on the JS thread the reports the Babel plugin's calls make, taking
 * stacks, handling the editor's messages, batching, encoding and sending, sampling and the recorder; on
 * the UI thread the frame loops that meter, sample and report, and the hook that forwards animations.
 *
 * Each stretch of it is a section: enterInspector() before, leaveInspector() after (in a finally).
 * Sections nest and only the outermost is timed, so a report that takes a stack is counted once. The
 * time adds up in a running total per runtime, on its globalThis: the JS runtime and the UI runtime
 * each have their own, and Metro can load this module twice. A frame meter reads the total at every
 * frame, and what it grew by since the frame before is the inspector's part of that one (frameMeter.ts).
 * A total, not a counter each read resets, so two meters on one thread (a live recording and one on
 * the device) both see all of it.
 *
 * Timed only while a meter runs on the runtime (timeInspector); otherwise a section is a check of one
 * field. Plain worklets that allocate nothing per section, so the same code runs on both runtimes and
 * under vitest. The clock is performance.now(), which react-native-worklets also installs on the UI
 * runtime (steady time), and Date.now() where there is none.
 */

export type OwnTime = {
  /** Frame meters reading the total: sections are timed while there is one. */
  meters: number
  /** How many sections are open, and when the outermost began (-1: it is not timed). */
  depth: number
  start: number
  /** Everything timed so far, ms. */
  total: number
}

type OwnTimeGlobal = { __KF_OWN_TIME__?: OwnTime; performance?: { now(): number } }

/** This runtime's. */
export function ownTime(): OwnTime {
  'worklet'
  const g = globalThis as OwnTimeGlobal
  let s = g.__KF_OWN_TIME__
  if (s === undefined) {
    s = { meters: 0, depth: 0, start: -1, total: 0 }
    g.__KF_OWN_TIME__ = s
  }
  return s
}

function clockMs(): number {
  'worklet'
  const p = (globalThis as OwnTimeGlobal).performance
  return p && typeof p.now === 'function' ? p.now() : Date.now()
}

/** The thread starts working for the inspector. Pair it with leaveInspector() in a finally. */
export function enterInspector(): void {
  'worklet'
  const s = ownTime()
  if (s.depth++ === 0) s.start = s.meters > 0 ? clockMs() : -1
}

/** The thread is back to the app's code: the outermost section adds its time to the total. */
export function leaveInspector(): void {
  'worklet'
  const s = ownTime()
  if (s.depth === 0) return
  if (--s.depth === 0 && s.start >= 0) {
    s.total += clockMs() - s.start
    s.start = -1
  }
}

/** How long the inspector has worked on this runtime while a meter ran, ms: a running total. */
export function inspectorTotalMs(): number {
  'worklet'
  return ownTime().total
}

/** A frame meter starts (or stops) reading the total on this runtime. */
export function timeInspector(on: boolean): void {
  'worklet'
  const s = ownTime()
  s.meters = on ? s.meters + 1 : Math.max(0, s.meters - 1)
}

/** `fn` as one section, wrapped once: for timers and listeners on the JS thread, not per-frame paths. */
export function inspectorWork<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  return (...args) => {
    enterInspector()
    try {
      return fn(...args)
    } finally {
      leaveInspector()
    }
  }
}
