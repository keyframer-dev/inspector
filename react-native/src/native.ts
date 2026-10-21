/**
 * React Native entry: connectInspector with the UI-thread hook installed as well.
 *
 * Animations started inside worklets (gesture callbacks, useAnimatedReaction, scroll handlers) run on
 * the UI runtime, where `globalThis` is a different object: the JS hook installed by createInspector
 * never sees them and they ran uninspected. This installs a second hook there that applies the same
 * override table and forwards each call to the JS thread with scheduleOnRN, where it is reported like
 * any other animation.
 *
 * Kept out of the main entry because it imports react-native-worklets, which does not load in node.
 *
 *   if (__DEV__) {
 *     const { connectInspector } = require('@keyframerdev/inspector/native')
 *     connectInspector({ apiUrl: 'http://192.168.1.10:8787', code: 'ABC234', app: 'MyApp' })
 *   }
 */

import type {
  InspectorAccessibility,
  InspectorDevice,
  InspectorCallSite,
  InspectorDisplay,
  InspectorFrameDrop,
  InspectorFrameStat,
  InspectorGestureSite,
  InspectorMarker,
  InspectorOverrides,
} from '../../protocol/inspector'
// Imported, not required at runtime: the build rewrites a runtime require into one Metro cannot resolve.
import { AccessibilityInfo, AppState, Dimensions, Keyboard, NativeModules, PixelRatio, Platform, TurboModuleRegistry } from 'react-native'
import { scheduleOnRN, scheduleOnUI } from 'react-native-worklets'
import {
  connectInspector as connectCore,
  type AppFacts,
  type ConnectInspectorOptions,
  type InspectorBridge,
  type InspectorBridgeContext,
} from './client'
import { autoCaptureScreen } from './capture'
import { clockFrame, clockTime, createClock, realFrameTime, setClockScale, stepClock, type AnimationClock } from './clock'
import { createDisplayMeter, displayHz, tickDisplayMeter } from './display'
import { describeDevice, type ExpoDeviceModule } from './device'
import { createFrameMeter, tickFrameMeter, type FrameMeter } from './frameMeter'
import type { UiFrameMeter } from './recorder'
import { watchLogs } from './logs'
import { applyOverrides, currentRoute, registeredSignals, signalRoutes, tapNavigation, tapTimeScale, tapTouches, timeScale } from './runtime'

export { registerReplay } from './client'
export { fire, press, registerScenario, waitForTestId } from './scenarios'
export { isInstrumented } from './runtime'

// The runtime reads the OS for what only one platform pays for (a shadow without a path on iOS), and
// the pixel scale for how many pixels an image is drawn at.
;(globalThis as { __KF_OS__?: string }).__KF_OS__ = Platform.OS
;(globalThis as { __KF_SCALE__?: number }).__KF_SCALE__ = PixelRatio.get()

type UiGlobal = {
  __KF_INSPECTOR__?: unknown
  __KF_UI_OVERRIDES__?: InspectorOverrides
  /** The UI thread's frame meter while a recording runs; cleared to stop its loop. */
  __KF_UI_FRAMES__?: FrameMeter | null
  requestAnimationFrame?: (cb: (t: number) => void) => number
}

// ─── Animation speed (the `time` message) ─────────────────────────────────────────
// Reanimated reads animation time from two globals of the UI runtime (react-native-worklets sets them
// up): the timestamp each frame is flushed with (`__nativeRequestAnimationFrame`'s callback; older
// versions flush through `__flushAnimationFrame`) and `_getAnimationTimestamp()`. The inspector puts
// its clock (clock.ts) in front of both the first time the speed changes, and takes it out when the
// connection ends. Everything Reanimated drives from the UI thread follows: withTiming, withSpring,
// withDecay and the ones they are nested in, animated styles, layout animations, useFrameCallback.
// Not covered: CSS animations and transitions (Reanimated runs them natively), React Native's
// Animated, and native transitions (a native stack's push).

type ClockGlobal = {
  __KF_CLOCK__?: AnimationClock
  /** The real clock and how to take the inspector's clock out again. */
  __KF_CLOCK_STATE__?: { now: () => number; restore: () => void }
  __nativeRequestAnimationFrame?: (cb: (t: number) => void) => unknown
  __flushAnimationFrame?: (t: number) => void
  _getAnimationTimestamp?: () => number
  __frameTimestamp?: number
}

/** Whether this UI runtime has the frame plumbing the clock wraps (react-native-worklets on a native app). */
function uiTimeSupported(): boolean {
  'worklet'
  const g = globalThis as ClockGlobal
  return typeof g._getAnimationTimestamp === 'function' && (typeof g.__nativeRequestAnimationFrame === 'function' || typeof g.__flushAnimationFrame === 'function')
}

/** On the UI runtime: animations run at `scale` from now on, then move on `step` frames of `frameMs`. */
function uiSetTime(scale: number, step: number, frameMs: number): void {
  'worklet'
  const g = globalThis as ClockGlobal
  if (g.__KF_CLOCK__ === undefined) {
    if ((scale === 1 && step === 0) || !uiTimeSupported()) return
    const now = g._getAnimationTimestamp!
    const nativeRaf = g.__nativeRequestAnimationFrame
    const flush = g.__flushAnimationFrame
    const clock = createClock(now())
    // Plain functions on the UI runtime, like the frame loops below.
    let inFrame = false
    const timestamp = () => clockTime(clock, now())
    const raf =
      typeof nativeRaf === 'function'
        ? (cb: (t: number) => void) =>
            nativeRaf((t: number) => {
              if (typeof t !== 'number') return cb(t)
              inFrame = true
              try {
                cb(clockFrame(clock, t))
              } finally {
                inFrame = false
              }
            })
        : undefined
    const flushed =
      typeof flush === 'function'
        ? (t: number) => {
            // Inside a frame the clock already mapped: pass it on as it is.
            if (inFrame || typeof t !== 'number') return flush(t)
            const v = clockFrame(clock, t)
            g.__frameTimestamp = v
            flush(v)
          }
        : undefined
    g._getAnimationTimestamp = timestamp
    if (raf) g.__nativeRequestAnimationFrame = raf
    if (flushed) g.__flushAnimationFrame = flushed
    g.__KF_CLOCK__ = clock
    g.__KF_CLOCK_STATE__ = {
      now,
      // Only what is still the inspector's: something that wrapped them since keeps its wrapper.
      restore: () => {
        if (g._getAnimationTimestamp === timestamp) g._getAnimationTimestamp = now
        if (raf && g.__nativeRequestAnimationFrame === raf) g.__nativeRequestAnimationFrame = nativeRaf
        if (flushed && g.__flushAnimationFrame === flushed) g.__flushAnimationFrame = flush
      },
    }
  }
  const c = g.__KF_CLOCK__!
  setClockScale(c, scale, g.__KF_CLOCK_STATE__!.now())
  if (step > 0) stepClock(c, step, frameMs)
}

/**
 * On the UI runtime: takes the clock out. Animations that were slowed or paused catch up with real
 * time at once (they jump ahead by the time they lost): what ending a connection while slowed costs.
 */
function uiResetTime(): void {
  'worklet'
  const g = globalThis as ClockGlobal
  g.__KF_CLOCK_STATE__?.restore()
  delete g.__KF_CLOCK__
  delete g.__KF_CLOCK_STATE__
}

/** Sets the animation speed on the UI thread: 1 is normal, 0 paused; `step` frames forward. */
export function setUiTime(scale: number, step = 0): void {
  // A step is one frame at the rate the display runs at now.
  scheduleOnUI(uiSetTime, scale, step, 1000 / (currentRefreshRate() || 60))
}

/** Back to real time, the clock taken out (a connection ending). */
export function resetUiTime(): void {
  scheduleOnUI(uiResetTime)
}

// ─── Display ─────────────────────────────────────────────────────────────────────
// The refresh rate, read from the UI thread's frames (display.ts): measured once when a connection
// opens (for the hello), and all along while recording (the frame meter's budget, and a `display`
// marker when it changes). Nothing runs in between.

/** `display`: what a hello says (the highest rate seen, adaptive once it changed); `hz`: the rate now. */
type DisplayShared = { __KF_DISPLAY__?: { display: InspectorDisplay | null; hz: number; listeners: Set<(hz: number) => void> } }
const display = ((globalThis as DisplayShared).__KF_DISPLAY__ ??= { display: null, hz: 0, listeners: new Set() })

/** The display as measured so far (`hz` the highest rate it ran at), or null before the first measurement. */
export function knownDisplay(): InspectorDisplay | null {
  return display.display
}

/** The refresh rate the display ran at last, or 0 before the first measurement. */
export function currentRefreshRate(): number {
  return display.hz
}

/** Calls `fn` with the new rate whenever a frame loop sees the display change. Returns the unsubscribe. */
export function watchDisplay(fn: (hz: number) => void): () => void {
  display.listeners.add(fn)
  return () => {
    display.listeners.delete(fn)
  }
}

/** ProMotion is adaptive by design, and Reanimated lowers its own rate there while frames are slow. */
const adaptiveByPlatform = (hz: number) => Platform.OS === 'ios' && hz > 60

/**
 * A reading from a frame loop: the first one says what the display is, later ones that it changed.
 * Listeners hear both: a recording whose header could not say the rate learns it as a marker.
 */
export function noteDisplay(hz: number, changes: number): void {
  if (!hz) return
  const was = display.display
  if (!was) {
    display.display = { hz, ...(changes > 0 || adaptiveByPlatform(hz) ? { adaptive: true } : {}) }
    display.hz = hz
    for (const fn of display.listeners) fn(hz)
    return
  }
  if (changes > 0 && !was.adaptive) display.display = { ...was, adaptive: true }
  if (display.hz === hz) return
  display.hz = hz
  // It changed while we watched: an adaptive display, whose `hz` stays the highest it runs at.
  display.display = { hz: Math.max(was.hz, hz), adaptive: true }
  for (const fn of display.listeners) fn(hz)
}

function measureDisplayOnUi(ms: number, done: (hz: number, changes: number, time: boolean) => void): void {
  scheduleOnUI(
    (span: number) => {
      'worklet'
      const g = globalThis as UiGlobal
      const time = uiTimeSupported()
      if (!g.requestAnimationFrame) {
        scheduleOnRN(done, 0, 0, time)
        return
      }
      const raf = g.requestAnimationFrame
      const d = createDisplayMeter()
      let start = -1
      // A plain function on the UI runtime, like the frame meter's loop.
      function frame(ts: number) {
        const t = realFrameTime(ts)
        if (start < 0) start = t
        tickDisplayMeter(d, t)
        if (t - start >= span) scheduleOnRN(done, displayHz(d), d.changes, time)
        else raf!(frame)
      }
      raf(frame)
    },
    ms,
  )
}

/** The same measurement on the JS thread: on the web, where the JS thread draws the frames. */
function measureDisplayOnJs(ms: number, done: (hz: number, changes: number) => void): void {
  const raf = (globalThis as { requestAnimationFrame?: (cb: (t: number) => void) => unknown }).requestAnimationFrame
  if (!raf) return done(0, 0)
  const d = createDisplayMeter()
  let start = -1
  const frame = (t: number) => {
    if (start < 0) start = t
    tickDisplayMeter(d, t)
    if (t - start >= ms) done(displayHz(d), d.changes)
    else raf(frame)
  }
  raf(frame)
}

/** How long a connection measures the display before it says hello, ms. */
const DISPLAY_MEASURE_MS = 500

// ─── Motion settings ─────────────────────────────────────────────────────────────
// Reduce Motion (iOS), Remove animations (Android), prefers-reduced-motion (web), through React
// Native's AccessibilityInfo. One listener however many recordings watch it.

type A11yShared = { __KF_A11Y__?: { reduceMotion: boolean | null; listeners: Set<(on: boolean) => void>; sub: { remove(): void } | null } }
const a11y = ((globalThis as A11yShared).__KF_A11Y__ ??= { reduceMotion: null, listeners: new Set(), sub: null })

/** Whether Reduce Motion is on, or null when the platform does not say. */
export async function reduceMotionNow(): Promise<boolean | null> {
  try {
    const on = await AccessibilityInfo.isReduceMotionEnabled()
    a11y.reduceMotion = !!on
    return a11y.reduceMotion
  } catch {
    return a11y.reduceMotion
  }
}

/** The last known Reduce Motion setting, or null before it was read. */
export function knownReduceMotion(): boolean | null {
  return a11y.reduceMotion
}

/** Calls `fn` whenever Reduce Motion is turned on or off, until the returned function is called. */
export function watchReduceMotion(fn: (on: boolean) => void): () => void {
  a11y.listeners.add(fn)
  if (!a11y.sub) {
    try {
      a11y.sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (on: boolean) => {
        a11y.reduceMotion = !!on
        for (const l of a11y.listeners) l(!!on)
      })
    } catch {
      a11y.sub = null
    }
  }
  return () => {
    if (!a11y.listeners.delete(fn) || a11y.listeners.size) return
    a11y.sub?.remove()
    a11y.sub = null
  }
}

/** What a connection's hello says about the device: the display, the motion settings, and whether time control works here. */
export async function deviceFacts(onUiThread: boolean): Promise<AppFacts> {
  const [rm, measured] = await Promise.all([
    reduceMotionNow(),
    new Promise<{ hz: number; changes: number; time: boolean }>((resolve) => {
      try {
        if (onUiThread) measureDisplayOnUi(DISPLAY_MEASURE_MS, (hz, changes, time) => resolve({ hz, changes, time }))
        else measureDisplayOnJs(DISPLAY_MEASURE_MS, (hz, changes) => resolve({ hz, changes, time: false }))
      } catch {
        resolve({ hz: 0, changes: 0, time: false })
      }
    }),
  ])
  noteDisplay(measured.hz, measured.changes)
  const d = knownDisplay()
  return {
    ...(d ? { display: d } : {}),
    ...(rm === null ? {} : { accessibility: { reduceMotion: rm } satisfies InspectorAccessibility }),
    ...(measured.time ? { capabilities: ['time'] } : {}),
  }
}

/** Plain, cross-thread-copyable version of animation args (animation objects carry worklets). */
function plainArgs(args: unknown[]): unknown[] {
  'worklet'
  const out: unknown[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === null || typeof a === 'number' || typeof a === 'string' || typeof a === 'boolean') out.push(a)
    else if (a && typeof a === 'object' && !Array.isArray(a)) {
      const o: Record<string, unknown> = {}
      for (const k in a as Record<string, unknown>) {
        const v = (a as Record<string, unknown>)[k]
        if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') o[k] = v
      }
      out.push(o)
    } else out.push(null)
  }
  return out
}

// ─── UI thread frames ────────────────────────────────────────────────────────────
// One frame loop on the UI runtime, however many listen (a live recording and one on the device can
// run at once): it reports to JS, which hands the stats to every listener.
const uiListeners = new Set<Parameters<UiFrameMeter>[0]>()
const fanOut = (stats: InspectorFrameStat[], drops: InspectorFrameDrop[], at: number) => {
  for (const l of uiListeners) l(stats, drops, at)
}

function runUiLoop(on: boolean) {
  scheduleOnUI(
    (start: boolean, knownHz: number) => {
      'worklet'
      const g = globalThis as UiGlobal
      if (!start) {
        g.__KF_UI_FRAMES__ = null
        return
      }
      if (g.__KF_UI_FRAMES__ || !g.requestAnimationFrame) return
      const m = createFrameMeter('ui')
      // Frames are counted against the display's refresh rate: the one last measured until the frames
      // themselves say (display.ts), not the meter's own guess from how many frames were short.
      const d = createDisplayMeter()
      if (knownHz) m.interval = 1000 / knownHz
      g.__KF_UI_FRAMES__ = m
      const raf = g.requestAnimationFrame
      // A plain function, not a nested worklet: it is created on the UI runtime already, and a worklet
      // that refers to itself captures itself before it exists, which aborts the app.
      function frame(ts: number) {
        // A newer loop (or none) took over: this one ends.
        if ((globalThis as UiGlobal).__KF_UI_FRAMES__ !== m) return
        // Real time, also while the inspector slows animations down.
        const t = realFrameTime(ts)
        if (tickDisplayMeter(d, t)) scheduleOnRN(noteDisplay, d.hz, d.changes)
        const hz = d.hz || knownHz
        if (hz) m.interval = 1000 / hz
        tickFrameMeter(m, t)
        if (m.stats.length) scheduleOnRN(fanOut, m.stats.splice(0), m.drops.splice(0), t)
        raf!(frame)
      }
      raf(frame)
    },
    on,
    currentRefreshRate(),
  )
}

/** Measures the UI thread's frame rate and long frames until the returned function is called. */
export const measureUiFrames: UiFrameMeter = (onFrames) => {
  uiListeners.add(onFrames)
  if (uiListeners.size === 1) runUiLoop(true)
  return () => {
    if (!uiListeners.delete(onFrames)) return
    if (uiListeners.size === 0) runUiLoop(false)
  }
}

// ─── UI thread values ────────────────────────────────────────────────────────────
// Shared values read on the UI thread once per frame, at the frame's own time: exactly what was on
// screen. Read from JS on a timer instead, a value lags and repeats (JS sees the UI thread's writes
// late), and played back the motion stutters.

type SamplerGlobal = { __KF_SAMPLERS__?: Record<number, boolean>; requestAnimationFrame?: (cb: (t: number) => void) => number }
let nextSampler = 1

/**
 * Reads these shared values every UI frame until the returned function is called. `onRows` gets
 * batches of `[uiTime, value0, value1, …]`, values in the order given (NaN when not a number).
 */
export function sampleUiValues(values: unknown[], onRows: (rows: number[][]) => void): () => void {
  const token = nextSampler++
  let live = true
  const deliver = (rows: number[][]) => {
    if (live) onRows(rows)
  }
  scheduleOnUI(
    (tok: number, list: Array<{ value: unknown }>) => {
      'worklet'
      const g = globalThis as SamplerGlobal
      if (!g.requestAnimationFrame) return
      if (!g.__KF_SAMPLERS__) g.__KF_SAMPLERS__ = {}
      g.__KF_SAMPLERS__[tok] = true
      const raf = g.requestAnimationFrame
      let rows: number[][] = []
      // A plain function on the UI runtime, like the frame meter's loop (see runUiLoop).
      function frame(ts: number) {
        if (!(globalThis as SamplerGlobal).__KF_SAMPLERS__?.[tok]) {
          if (rows.length) scheduleOnRN(deliver, rows)
          return
        }
        // Real time: a recording's clock keeps running while the inspector slows animations down.
        const row: number[] = [realFrameTime(ts)]
        for (let i = 0; i < list.length; i++) {
          const v = list[i]!.value
          row.push(typeof v === 'number' ? v : NaN)
        }
        rows.push(row)
        // Every few frames: one hop to JS per batch, not per frame.
        if (rows.length >= 6) {
          scheduleOnRN(deliver, rows)
          rows = []
        }
        raf(frame)
      }
      raf(frame)
    },
    token,
    values as Array<{ value: unknown }>,
  )
  return () => {
    scheduleOnUI((tok: number) => {
      'worklet'
      const g = globalThis as SamplerGlobal
      if (g.__KF_SAMPLERS__) delete g.__KF_SAMPLERS__[tok]
    }, token)
    // The last batch, flushed when the loop sees it stopped, still counts.
    setTimeout(() => (live = false), 100)
  }
}

// ─── Gestures ────────────────────────────────────────────────────────────────────
// The Babel plugin wraps gesture handler callbacks (runtime.ts __kfGesture); this listens to them on
// the UI thread, and on the JS thread for gestures that run there (runOnJS(true)).

export type GestureReport = {
  site: InspectorGestureSite
  handler: number
  x: number | null
  y: number | null
  /** Wall clock (Date.now) when the callback ran: the same on both threads. */
  at: number
  /** onEnd and onFinalize: whether it succeeded, and whether it had activated (null where the event does not say). */
  success: boolean | null
  activated: boolean | null
}

type GestureEvent = {
  handlerTag?: number
  /** react-native-gesture-handler's State: 1 failed, 2 began, 3 cancelled, 4 active, 5 end. */
  state?: number
  oldState?: number
  absoluteX?: number
  absoluteY?: number
  changedTouches?: Array<{ absoluteX?: number; absoluteY?: number }>
  allTouches?: Array<{ absoluteX?: number; absoluteY?: number }>
}

/** Where the finger is in a gesture handler event: absoluteX/Y, or the first touch of a touch event. */
function fingerOf(e: GestureEvent | undefined): [number | null, number | null] {
  'worklet'
  if (!e) return [null, null]
  if (typeof e.absoluteX === 'number' && typeof e.absoluteY === 'number') return [e.absoluteX, e.absoluteY]
  const touch = (e.changedTouches && e.changedTouches[0]) || (e.allTouches && e.allTouches[0])
  if (touch && typeof touch.absoluteX === 'number' && typeof touch.absoluteY === 'number') return [touch.absoluteX, touch.absoluteY]
  return [null, null]
}

const STATE_ACTIVE = 4
const STATE_END = 5

/**
 * How an ending callback says the gesture went: onEnd and onFinalize get `success` as their second
 * argument (else the event's state is END), and onFinalize's event says whether it had been active
 * (onEnd only runs after an activation). [null, null] for the other callbacks.
 */
function outcomeOf(on: string, e: GestureEvent | undefined, success: unknown): [boolean | null, boolean | null] {
  'worklet'
  if (on !== 'onEnd' && on !== 'onFinalize') return [null, null]
  const ok = typeof success === 'boolean' ? success : e && typeof e.state === 'number' ? e.state === STATE_END : null
  const activated = on === 'onEnd' ? true : e && typeof e.oldState === 'number' ? e.oldState === STATE_ACTIVE : null
  return [ok, activated]
}

const gestureListeners = new Set<(r: GestureReport) => void>()
const gestureFanOut = (site: InspectorGestureSite, handler: number, x: number | null, y: number | null, at: number, success: boolean | null, activated: boolean | null) => {
  for (const l of gestureListeners) l({ site, handler, x, y, at, success, activated })
}

function installGestureHook(on: boolean) {
  const g = globalThis as { __KF_GESTURE__?: unknown }
  if (on) {
    g.__KF_GESTURE__ = (site: InspectorGestureSite, e: GestureEvent | undefined, success: unknown) => {
      const [x, y] = fingerOf(e)
      const [ok, activated] = outcomeOf(site.on, e, success)
      gestureFanOut(site, e?.handlerTag ?? -1, x, y, Date.now(), ok, activated)
    }
  } else delete g.__KF_GESTURE__
  scheduleOnUI((start: boolean) => {
    'worklet'
    const ui = globalThis as { __KF_GESTURE__?: unknown }
    if (!start) {
      delete ui.__KF_GESTURE__
      return
    }
    ui.__KF_GESTURE__ = (site: InspectorGestureSite, e: GestureEvent | undefined, success: unknown) => {
      'worklet'
      const [x, y] = fingerOf(e)
      const [ok, activated] = outcomeOf(site.on, e, success)
      scheduleOnRN(gestureFanOut, site, e?.handlerTag ?? -1, x, y, Date.now(), ok, activated)
    }
  }, on)
}

/** Calls `onGesture` for every wrapped gesture callback that runs, until the returned function is called. */
export function watchGestures(onGesture: (r: GestureReport) => void): () => void {
  gestureListeners.add(onGesture)
  if (gestureListeners.size === 1) installGestureHook(true)
  return () => {
    if (!gestureListeners.delete(onGesture)) return
    if (gestureListeners.size === 0) installGestureHook(false)
  }
}

// ─── UI thread work ───────────────────────────────────────────────────────────────
// Worklets the Babel plugin timed (runtime.ts __kfWork) push into a buffer on the UI runtime while
// something listens; one frame loop sums it per worklet and frame, and hands batches to JS.

/** One worklet's time in one frame: [uiFrameTime, kind, site, name, ms, calls]. */
export type UiWorkRow = [number, string, string, string | null, number, number]

/** Where a scrolled list was at a frame: [uiFrameTime, scroll id, x, y]. */
export type UiScrollRow = [number, string, number, number]

const workListeners = new Set<(rows: UiWorkRow[]) => void>()
const scrollListeners = new Set<(rows: UiScrollRow[]) => void>()
const workFanOut = (rows: UiWorkRow[], scrolls: UiScrollRow[]) => {
  if (rows.length) for (const l of workListeners) l(rows)
  if (scrolls.length) for (const l of scrollListeners) l(scrolls)
}
type WorkGlobal = {
  __KF_UI_WORK__?: unknown[]
  __KF_UI_SCROLL__?: unknown[]
  __KF_UI_WORK_LOOP__?: number
  requestAnimationFrame?: (cb: (t: number) => void) => number
}
let workLoop = 0

function runWorkLoop(on: boolean) {
  const loop = on ? ++workLoop : 0
  scheduleOnUI((token: number) => {
    'worklet'
    const g = globalThis as WorkGlobal
    if (!token) {
      g.__KF_UI_WORK_LOOP__ = 0
      delete g.__KF_UI_WORK__
      delete g.__KF_UI_SCROLL__
      return
    }
    if (!g.requestAnimationFrame) return
    g.__KF_UI_WORK_LOOP__ = token
    g.__KF_UI_WORK__ = []
    g.__KF_UI_SCROLL__ = []
    const raf = g.requestAnimationFrame
    let rows: UiWorkRow[] = []
    let scrolls: UiScrollRow[] = []
    let frames = 0
    // A plain function on the UI runtime, like the frame meter's loop.
    function frame(ts: number) {
      const t = realFrameTime(ts)
      const ui = globalThis as WorkGlobal
      if (ui.__KF_UI_WORK_LOOP__ !== token) {
        if (rows.length || scrolls.length) scheduleOnRN(workFanOut, rows, scrolls)
        return
      }
      // Scroll offsets: the last one each list reported this frame.
      const sb = ui.__KF_UI_SCROLL__
      if (sb && sb.length) {
        const lastAt: Record<string, UiScrollRow> = {}
        for (let i = 0; i + 2 < sb.length; i += 3) lastAt[sb[i] as string] = [t, sb[i] as string, sb[i + 1] as number, sb[i + 2] as number]
        sb.length = 0
        for (const k in lastAt) scrolls.push(lastAt[k]!)
      }
      const buf = ui.__KF_UI_WORK__
      if (buf && buf.length) {
        const sums: Record<string, UiWorkRow> = {}
        for (let i = 0; i + 3 < buf.length; i += 4) {
          const key = `${buf[i]}|${buf[i + 1]}|${buf[i + 2]}`
          const row = sums[key]
          if (row) {
            row[4] += buf[i + 3] as number
            row[5] += 1
          } else sums[key] = [t, buf[i] as string, buf[i + 1] as string, buf[i + 2] as string | null, buf[i + 3] as number, 1]
        }
        buf.length = 0
        for (const k in sums) rows.push(sums[k]!)
      }
      if (++frames % 6 === 0 && (rows.length || scrolls.length)) {
        scheduleOnRN(workFanOut, rows, scrolls)
        rows = []
        scrolls = []
      }
      raf(frame)
    }
    raf(frame)
  }, loop)
}

/** Calls `onWork` with batches of timed worklet runs on the UI thread until the returned function is called. */
export function watchUiWork(onWork: (rows: UiWorkRow[]) => void): () => void {
  return watchLoop(workListeners, onWork)
}

/** The last offset each list reported on the UI thread, [x, y, Date.now()] by scroll id. */
export function snapshotScroll(onSnapshot: (last: Record<string, number[]>) => void): void {
  scheduleOnUI(() => {
    'worklet'
    scheduleOnRN(onSnapshot, (globalThis as { __KF_UI_SCROLL_LAST__?: Record<string, number[]> }).__KF_UI_SCROLL_LAST__ ?? {})
  })
}

/** Calls `onScroll` with batches of scroll offsets (one per list per frame) until the returned function is called. */
export function watchUiScroll(onScroll: (rows: UiScrollRow[]) => void): () => void {
  return watchLoop(scrollListeners, onScroll)
}

/** One UI loop for work and scroll listeners: running while either has one. */
function watchLoop<T>(set: Set<T>, l: T): () => void {
  const was = workListeners.size + scrollListeners.size
  set.add(l)
  if (was === 0) runWorkLoop(true)
  return () => {
    if (!set.delete(l)) return
    if (workListeners.size + scrollListeners.size === 0) runWorkLoop(false)
  }
}

const MOVE_CALLBACKS = new Set(['onUpdate', 'onChange', 'onTouchesMove'])

/** At most this many visibility markers for one screen change (a long list's rows each own a value). */
const MAX_VISIBILITY_MARKERS = 200

/**
 * Touches and gesture callbacks as markers on a recording's clock (`elapsed`), until the returned
 * function is called. Touches are timed by the screen's own stamp, gestures by the wall clock; both
 * keep at most one move per finger (or gesture) per 120 Hz frame.
 *
 * Also the speed, display and motion settings as they change, and values whose screen another one
 * covers. `said` is what the recording's header already says (a live connection's hello): a setting
 * that differs from it now is marked at the start.
 */
export function markersWhileRecording(elapsed: () => number, onMarker: (m: InspectorMarker) => void, said?: AppFacts): () => void {
  let touchOffset = Infinity
  const lastTouchMove = new Map<number, number>()
  const lastGestureMove = new Map<number, number>()
  // Touches still down. React Native drops a touch's end when the view it started on is removed
  // mid-touch (a row deleted under the finger): such a touch ends where the view went away, marked lost.
  const open = new Map<number, { target: unknown; x: number; y: number; t: number }>()
  const lose = (id: number, t: number) => {
    const o = open.get(id)
    if (!o) return
    open.delete(id)
    onMarker({ kind: 'touch', t, phase: 'cancel', id, x: o.x, y: o.y, lost: true })
  }
  const offTouches = tapTouches((touch) => {
    const now = elapsed()
    let t = now
    if (touch.stamp !== null) {
      touchOffset = Math.min(touchOffset, now - touch.stamp)
      t = Math.round(touch.stamp + touchOffset)
    }
    if (touch.phase === 'start') {
      // The same finger down again while its last touch never ended: that one is over.
      if (open.has(touch.id)) lose(touch.id, open.get(touch.id)!.t)
      open.set(touch.id, { target: touch.target, x: touch.x, y: touch.y, t })
    } else if (open.has(touch.id)) {
      if (touch.phase === 'move') Object.assign(open.get(touch.id)!, { x: touch.x, y: touch.y, t })
      else open.delete(touch.id)
    }
    if (touch.phase === 'move') {
      if (t - (lastTouchMove.get(touch.id) ?? -Infinity) < 8) return
      lastTouchMove.set(touch.id, t)
    }
    onMarker({ kind: 'touch', t, phase: touch.phase, id: touch.id, x: touch.x, y: touch.y })
  })
  const watchTargets = setInterval(() => {
    for (const [id, o] of open) {
      // React Native's DOM-like nodes say when they left the tree.
      if ((o.target as { isConnected?: boolean } | undefined)?.isConnected === false) lose(id, elapsed())
    }
  }, 50)
  const offGestures =
    platformName() === 'web'
      ? () => {}
      : watchGestures((g) => {
          const t = Math.max(0, Math.round(elapsed() - (Date.now() - g.at)))
          if (MOVE_CALLBACKS.has(g.site.on)) {
            if (t - (lastGestureMove.get(g.handler) ?? -Infinity) < 8) return
            lastGestureMove.set(g.handler, t)
          }
          onMarker({
            kind: 'gesture',
            t,
            gesture: g.site.gesture,
            on: g.site.on,
            handler: g.handler,
            x: g.x === null ? null : Math.round(g.x),
            y: g.y === null ? null : Math.round(g.y),
            site: `${g.site.file}:${g.site.line}`,
            component: g.site.component,
            ...(g.success === null ? {} : { success: g.success }),
            ...(g.activated === null ? {} : { activated: g.activated }),
          })
        })
  // Values on a screen that another one covers: a stack keeps the screens below mounted, and what
  // animates there spends frames nobody sees. Judged by the screen each value mounted on (runtime.ts
  // signalRoutes), so a transparent modal or a form sheet, which leave the screen below in sight, read
  // as covering it too.
  const covered = new Map<string, boolean>()
  const judgeCovered = (t: number) => {
    const here = currentRoute()?.route
    if (!here) return
    let n = 0
    for (const [id, route] of signalRoutes()) {
      const hidden = route !== here
      if ((covered.get(id) ?? false) === hidden || !registeredSignals().has(id)) continue
      covered.set(id, hidden)
      onMarker({ kind: 'visibility', t, id, visible: !hidden, ...(hidden ? { reason: 'covered' as const } : {}) })
      if (++n >= MAX_VISIBILITY_MARKERS) break
    }
  }
  // The screen it starts on, then every screen change.
  const start = currentRoute()
  if (start) onMarker({ kind: 'navigation', t: elapsed(), ...start })
  judgeCovered(0)
  const offNav = tapNavigation((n) => {
    const t = elapsed()
    onMarker({ kind: 'navigation', t, ...n })
    judgeCovered(t)
  })
  // The speed the inspector runs animations at, when it is not normal from the start, then each change.
  if (timeScale() !== 1) onMarker({ kind: 'time', t: 0, scale: timeScale() })
  const offTime = tapTimeScale((scale) => onMarker({ kind: 'time', t: elapsed(), scale }))
  // Reduce Motion, and the refresh rate, as they change; and where they differ from what the header says.
  let stopped = false
  const offMotion = watchReduceMotion((reduceMotion) => onMarker({ kind: 'accessibility', t: elapsed(), reduceMotion }))
  if (said?.accessibility) {
    void reduceMotionNow().then((rm) => {
      if (!stopped && rm !== null && rm !== said.accessibility!.reduceMotion) onMarker({ kind: 'accessibility', t: elapsed(), reduceMotion: rm })
    })
  }
  const hzNow = currentRefreshRate()
  if (said?.display && hzNow && hzNow !== said.display.hz) onMarker({ kind: 'display', t: 0, hz: hzNow })
  const offDisplay = watchDisplay((hz) => onMarker({ kind: 'display', t: elapsed(), hz }))
  // Warnings and errors, app state and the keyboard.
  const offLogs = watchLogs((l) => onMarker({ kind: 'log', t: elapsed(), ...l }))
  const appState = AppState.addEventListener('change', (state) => onMarker({ kind: 'appState', t: elapsed(), state }))
  const show = Keyboard.addListener('keyboardDidShow', (e) => onMarker({ kind: 'keyboard', t: elapsed(), visible: true, height: Math.round(e.endCoordinates.height) }))
  const hide = Keyboard.addListener('keyboardDidHide', () => onMarker({ kind: 'keyboard', t: elapsed(), visible: false, height: 0 }))
  return () => {
    stopped = true
    offTouches()
    clearInterval(watchTargets)
    offGestures()
    offLogs()
    offNav()
    offTime()
    offMotion()
    offDisplay()
    appState.remove()
    show.remove()
    hide.remove()
  }
}

/** The bridge connectInspector installs: a hook on the UI runtime that reports back to JS. */
export function uiThreadBridge(ctx: InspectorBridgeContext): InspectorBridge {
  const reportFromUI = (site: InspectorCallSite, args: unknown[]) => ctx.report(site, args)
  let stopFrames: (() => void) | null = null

  scheduleOnUI((initial: InspectorOverrides) => {
    'worklet'
    const g = globalThis as UiGlobal
    g.__KF_UI_OVERRIDES__ = initial
    g.__KF_INSPECTOR__ = {
      anim(fn: (...a: unknown[]) => unknown, site: InspectorCallSite, args: unknown[]) {
        'worklet'
        const table = (globalThis as UiGlobal).__KF_UI_OVERRIDES__ ?? {}
        const next = applyOverrides(args, table[site.id])
        scheduleOnRN(reportFromUI, site, plainArgs(next))
        return fn(...next)
      },
      // Shared values and styles are registered on the JS thread, where components render.
      signal() {
        'worklet'
      },
      style() {
        'worklet'
      },
    }
  }, ctx.overrides)

  return {
    setOverrides(overrides) {
      scheduleOnUI((next: InspectorOverrides) => {
        'worklet'
        ;(globalThis as UiGlobal).__KF_UI_OVERRIDES__ = next
      }, overrides)
    },
    sampleValues: sampleUiValues,
    watchMarkers: markersWhileRecording,
    watchWork: watchUiWork,
    watchScroll: watchUiScroll,
    scrollSnapshot: snapshotScroll,
    measureFrames(on) {
      if (on && !stopFrames) stopFrames = measureUiFrames((stats, drops, at) => ctx.reportFrames?.(stats, drops, at))
      else if (!on) {
        stopFrames?.()
        stopFrames = null
      }
    },
    dispose() {
      stopFrames?.()
      stopFrames = null
      scheduleOnUI(() => {
        'worklet'
        const g = globalThis as UiGlobal
        delete g.__KF_INSPECTOR__
        delete g.__KF_UI_OVERRIDES__
      })
    },
  }
}

/**
 * The bridge of a connection (not of Motion Scan's local inspector): what the hello says about the
 * device, and the speed of animations. `timeControl`: the UI runtime can run the clock (the facts say
 * so); without it, `time` is answered with the speed unchanged.
 */
function deviceBridge(onUiThread: boolean) {
  return (): InspectorBridge => {
    let timeControl = false
    let clockOn = false
    return {
      async facts() {
        const facts = await deviceFacts(onUiThread)
        timeControl = !!facts.capabilities?.includes('time')
        return facts
      },
      ...(onUiThread
        ? {
            setTime(scale: number, step: number) {
              if (!timeControl) return false
              if (scale !== 1 || step > 0) clockOn = true
              if (clockOn) setUiTime(scale, step)
              return true
            },
          }
        : // The web has no UI runtime for the clock, but recordings get their markers from here.
          { watchMarkers: markersWhileRecording }),
      dispose() {
        // A connection that ends leaves animations at normal speed, with the clock taken out.
        if (clockOn) resetUiTime()
      },
    }
  }
}

/**
 * connectInspector for a React Native app: the JS hook plus the UI-thread one. On web there is no
 * separate UI runtime (worklets run on the JS thread), so a UI hook would only replace the JS one,
 * and with it the matching of nested animations: web gets the JS hook alone.
 */
export function connectInspector(opts: ConnectInspectorOptions): () => void {
  const platform = opts.platform ?? platformName()
  const native = platform !== 'web' && Platform.OS !== 'web'
  // A clock an earlier connection left running (its JavaScript reloaded before it could take it out).
  if (native) resetUiTime()
  return connectCore({
    ...opts,
    platform,
    osVersion: opts.osVersion ?? String(Platform.Version),
    device: opts.device ?? readDevice() ?? undefined,
    root: opts.root ?? expoProjectRoot(),
    screen: opts.screen ?? screenSize(),
    // What is installed (view-shot, else Skia) when the app passes nothing; null turns capture off.
    captureScreen: opts.captureScreen === null ? undefined : (opts.captureScreen ?? autoCaptureScreen()),
    bridges: [...(native ? [uiThreadBridge] : []), deviceBridge(native), ...(opts.bridges ?? [])],
  })
}

/**
 * The device this app runs on (device.ts says what may be sent): React Native's platform constants,
 * and expo-device's native module where Expo installed it. Null when nothing can be told.
 */
export function readDevice(): InspectorDevice | null {
  try {
    type FileSystemModule = { documentDirectory?: string | null; cacheDirectory?: string | null; bundleDirectory?: string | null }
    const modules = (globalThis as { expo?: { modules?: Record<string, unknown> } }).expo?.modules ?? {}
    const expoDevice = (modules.ExpoDevice as ExpoDeviceModule | undefined) ?? null
    // Where the app's files are (a simulator's paths name it): Expo's file system module, and the
    // bundle's own URL when it is loaded from a file (an app without Metro).
    const paths: Array<string | null | undefined> = []
    for (const name of ['FileSystem', 'ExponentFileSystem']) {
      const fs = modules[name] as FileSystemModule | undefined
      if (fs) paths.push(fs.documentDirectory, fs.bundleDirectory, fs.cacheDirectory)
    }
    paths.push(scriptUrl())
    return describeDevice({ os: Platform.OS, constants: Platform.constants as unknown as Record<string, unknown>, expoDevice, paths })
  } catch {
    return null
  }
}

/** The URL React Native loaded the bundle from: Metro's, or a file inside the app. */
function scriptUrl(): string | undefined {
  try {
    const turbo = (globalThis as { __turboModuleProxy?: unknown }).__turboModuleProxy != null ? TurboModuleRegistry.get<never>('SourceCode') : null
    const m = (turbo ?? (NativeModules as Record<string, unknown>).SourceCode) as { getConstants?: () => { scriptURL?: string }; scriptURL?: string } | null | undefined
    return m?.getConstants?.().scriptURL ?? m?.scriptURL
  } catch {
    return undefined
  }
}

/** The project folder Expo's dev server reports to the app (development only): where call sites resolve. */
function expoProjectRoot(): string | undefined {
  try {
    const root = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.EXPO_PUBLIC_PROJECT_ROOT
    return root || undefined
  } catch {
    return undefined
  }
}

/** "ios" / "android" / "web", for the editor's app chip. */
function platformName(): string {
  return Platform.OS
}

/** The window in points and its pixel scale: the panel maps touches onto captured frames with it. */
function screenSize(): { width: number; height: number; scale: number } {
  const w = Dimensions.get('window')
  return { width: w.width, height: w.height, scale: w.scale }
}
