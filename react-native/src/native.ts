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
  InspectorCallSite,
  InspectorFrameDrop,
  InspectorFrameStat,
  InspectorGestureSite,
  InspectorMarker,
  InspectorOverrides,
} from '../../protocol/inspector'
// Imported, not required at runtime: the build rewrites a runtime require into one Metro cannot resolve.
import { AppState, Dimensions, Keyboard, Platform } from 'react-native'
import { scheduleOnRN, scheduleOnUI } from 'react-native-worklets'
import {
  connectInspector as connectCore,
  type ConnectInspectorOptions,
  type InspectorBridge,
  type InspectorBridgeContext,
} from './client'
import { autoCaptureScreen } from './capture'
import { createFrameMeter, tickFrameMeter, type FrameMeter } from './frameMeter'
import type { UiFrameMeter } from './recorder'
import { watchLogs } from './logs'
import { applyOverrides, currentRoute, tapNavigation, tapTouches } from './runtime'

export { registerReplay } from './client'
export { fire, press, registerScenario, waitForTestId } from './scenarios'
export { isInstrumented } from './runtime'

type UiGlobal = {
  __KF_INSPECTOR__?: unknown
  __KF_UI_OVERRIDES__?: InspectorOverrides
  /** The UI thread's frame meter while a recording runs; cleared to stop its loop. */
  __KF_UI_FRAMES__?: FrameMeter | null
  requestAnimationFrame?: (cb: (t: number) => void) => number
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
  scheduleOnUI((start: boolean) => {
    'worklet'
    const g = globalThis as UiGlobal
    if (!start) {
      g.__KF_UI_FRAMES__ = null
      return
    }
    if (g.__KF_UI_FRAMES__ || !g.requestAnimationFrame) return
    const m = createFrameMeter('ui')
    g.__KF_UI_FRAMES__ = m
    const raf = g.requestAnimationFrame
    // A plain function, not a nested worklet: it is created on the UI runtime already, and a worklet
    // that refers to itself captures itself before it exists, which aborts the app.
    function frame(t: number) {
      // A newer loop (or none) took over: this one ends.
      if ((globalThis as UiGlobal).__KF_UI_FRAMES__ !== m) return
      tickFrameMeter(m, t)
      if (m.stats.length) scheduleOnRN(fanOut, m.stats.splice(0), m.drops.splice(0), t)
      raf!(frame)
    }
    raf(frame)
  }, on)
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
      function frame(t: number) {
        if (!(globalThis as SamplerGlobal).__KF_SAMPLERS__?.[tok]) {
          if (rows.length) scheduleOnRN(deliver, rows)
          return
        }
        const row: number[] = [t]
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
}

type GestureEvent = {
  handlerTag?: number
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

const gestureListeners = new Set<(r: GestureReport) => void>()
const gestureFanOut = (site: InspectorGestureSite, handler: number, x: number | null, y: number | null, at: number) => {
  for (const l of gestureListeners) l({ site, handler, x, y, at })
}

function installGestureHook(on: boolean) {
  const g = globalThis as { __KF_GESTURE__?: unknown }
  if (on) {
    g.__KF_GESTURE__ = (site: InspectorGestureSite, e: GestureEvent | undefined) => {
      const [x, y] = fingerOf(e)
      gestureFanOut(site, e?.handlerTag ?? -1, x, y, Date.now())
    }
  } else delete g.__KF_GESTURE__
  scheduleOnUI((start: boolean) => {
    'worklet'
    const ui = globalThis as { __KF_GESTURE__?: unknown }
    if (!start) {
      delete ui.__KF_GESTURE__
      return
    }
    ui.__KF_GESTURE__ = (site: InspectorGestureSite, e: GestureEvent | undefined) => {
      'worklet'
      const [x, y] = fingerOf(e)
      scheduleOnRN(gestureFanOut, site, e?.handlerTag ?? -1, x, y, Date.now())
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
    function frame(t: number) {
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

/**
 * Touches and gesture callbacks as markers on a recording's clock (`elapsed`), until the returned
 * function is called. Touches are timed by the screen's own stamp, gestures by the wall clock; both
 * keep at most one move per finger (or gesture) per 120 Hz frame.
 */
export function markersWhileRecording(elapsed: () => number, onMarker: (m: InspectorMarker) => void): () => void {
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
          })
        })
  // The screen it starts on, then every screen change.
  const start = currentRoute()
  if (start) onMarker({ kind: 'navigation', t: elapsed(), ...start })
  const offNav = tapNavigation((n) => onMarker({ kind: 'navigation', t: elapsed(), ...n }))
  // Warnings and errors, app state and the keyboard.
  const offLogs = watchLogs((l) => onMarker({ kind: 'log', t: elapsed(), ...l }))
  const appState = AppState.addEventListener('change', (state) => onMarker({ kind: 'appState', t: elapsed(), state }))
  const show = Keyboard.addListener('keyboardDidShow', (e) => onMarker({ kind: 'keyboard', t: elapsed(), visible: true, height: Math.round(e.endCoordinates.height) }))
  const hide = Keyboard.addListener('keyboardDidHide', () => onMarker({ kind: 'keyboard', t: elapsed(), visible: false, height: 0 }))
  return () => {
    offTouches()
    clearInterval(watchTargets)
    offGestures()
    offLogs()
    offNav()
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
 * connectInspector for a React Native app: the JS hook plus the UI-thread one. On web there is no
 * separate UI runtime (worklets run on the JS thread), so a UI hook would only replace the JS one,
 * and with it the matching of nested animations: web gets the JS hook alone.
 */
export function connectInspector(opts: ConnectInspectorOptions): () => void {
  const platform = opts.platform ?? platformName()
  return connectCore({
    ...opts,
    platform,
    osVersion: opts.osVersion ?? String(Platform.Version),
    root: opts.root ?? expoProjectRoot(),
    screen: opts.screen ?? screenSize(),
    // What is installed (view-shot, else Skia) when the app passes nothing; null turns capture off.
    captureScreen: opts.captureScreen === null ? undefined : (opts.captureScreen ?? autoCaptureScreen()),
    bridges: [...(platform === 'web' ? [] : [uiThreadBridge]), ...(opts.bridges ?? [])],
  })
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
