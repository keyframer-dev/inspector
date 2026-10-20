/**
 * React Native wiring of the controller: the hooks the Babel plugin's calls run into (on the JS runtime
 * and on the UI runtime), the two frame loops, AppState, navigation and Reduce Motion.
 *
 * Frame loops run only while the motion gate is open (production.md 2.6: nothing scheduled while
 * nothing moves). The UI loop uses the UI runtime's requestAnimationFrame, like the inspector's, keeps
 * its own "until" and stops itself; it hands frames to JS in batches of about a quarter second. The JS
 * loop is requestAnimationFrame on the JS thread and asks the controller on every frame whether to go on.
 */

import { AccessibilityInfo, AppState, Platform, type AppStateStatus } from 'react-native'
import { scheduleOnRN, scheduleOnUI } from 'react-native-worklets'
import type { SiteInfo } from './collector'
import { UI_EVENT_BASE, VitalsController, type ControllerEnv, type ControllerOptions, type Meters } from './controller'
import { slimArg } from './estimate'
import { createJsHook } from './hook'
import { createFieldMeter, tickFieldMeter, tickFrameMeter, type FieldMeter } from './frameMeter'
import { screenName } from './mask'
import type { VitalsHook } from './runtime'
import { createJsLoop } from './jsLoop'

type AnimFn = (...args: unknown[]) => unknown

/** What startVitals reads from a React Navigation or expo-router container ref. */
export type NavigationRefLike = {
  isReady?(): boolean
  getCurrentRoute(): { name: string; path?: string } | undefined | null
  addListener(event: 'state', cb: () => void): (() => void) | { remove(): void } | void
}

export type VitalsOptions = ControllerOptions & {
  /** A React Navigation `createNavigationContainerRef()` or expo-router `useNavigationContainerRef()`: screens are named from its routes. */
  navigationRef?: NavigationRefLike | null
  /** Names a route yourself (still masked and cut to 64 characters). Default: the route's name. */
  screenName?: (route: { name: string; path?: string }) => string
}

// ─── Environment ──────────────────────────────────────────────────────────────────

const perf = (globalThis as { performance?: { now(): number } }).performance
const now = () => (perf && typeof perf.now === 'function' ? perf.now() : Date.now())

function osMajor(): number {
  const v = Platform.Version as string | number
  if (Platform.OS === 'android') {
    // API level to Android version: 35 → 15, 34 → 14, … 29 → 10, 28 → 9.
    const api = typeof v === 'number' ? v : Number.parseInt(String(v), 10)
    if (!Number.isFinite(api)) return 0
    if (api >= 29) return api - 20
    return ({ 28: 9, 27: 8, 26: 8, 25: 7, 24: 7, 23: 6 } as Record<number, number>)[api] ?? 0
  }
  const major = Number.parseInt(String(v), 10)
  return Number.isFinite(major) ? major : 0
}

const env: ControllerEnv = {
  now,
  wall: () => Date.now(),
  random: Math.random,
  fetch: (url, init) => fetch(url, init),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  platform: { os: Platform.OS === 'ios' ? 'ios' : 'android', osMajor: osMajor() },
  // console.debug and console.info, so Metro labels the lines DEBUG and INFO (RevenueCat's way); warnings stay warnings.
  log: (m, level) => (level === 'debug' ? console.debug(m) : level === 'info' ? console.info(m) : console.warn(m)),
}

export const controller = new VitalsController(env)

// ─── JS runtime hook ──────────────────────────────────────────────────────────────

const jsHook = createJsHook(controller, () => checkScreen())

// ─── UI runtime ───────────────────────────────────────────────────────────────────

type UiLoop = { f: FieldMeter; until: number; pending: number; lastTs: number }
type UiGlobal = {
  __KF_VITALS__?: VitalsHook | null
  __kfvLoop?: UiLoop | null
  __kfvInterval?: number
  requestAnimationFrame?: (cb: (t: number) => void) => number
}

/** Offset from the UI runtime's frame clock to the JS clock: the smallest delivery delay seen. */
let uiOffset = Infinity

function onUiFrames(buf: number[], lastTs: number): void {
  const off = now() - lastTs
  if (off < uiOffset) uiOffset = off
  for (let i = 0; i < buf.length; i += 3) buf[i] = buf[i]! + uiOffset
  controller.uiFrames(buf)
}

function uiTime(ts: number): number {
  return ts >= 0 && Number.isFinite(uiOffset) ? ts + uiOffset : now()
}

function onUiAnim(site: SiteInfo, slim: unknown[], eid: number, ts: number): void {
  controller.anim(site, slim, eid, 'ui', uiTime(ts))
  checkScreen()
}

function onUiScroll(ts: number): void {
  controller.scroll(uiTime(ts))
}

/** Keeps the UI loop running at least `ms` more, starting it if it is not running. On the UI runtime. */
function uiKeepAlive(ms: number): void {
  'worklet'
  const g = globalThis as UiGlobal
  const running = g.__kfvLoop
  if (running) {
    if (running.lastTs >= 0) running.until = Math.max(running.until, running.lastTs + ms)
    else running.pending = Math.max(running.pending, ms)
    return
  }
  const raf = g.requestAnimationFrame
  if (!raf) return
  const loop: UiLoop = { f: createFieldMeter('ui'), until: -1, pending: ms, lastTs: -1 }
  if (g.__kfvInterval) loop.f.m.interval = g.__kfvInterval
  g.__kfvLoop = loop
  // A plain function, not a nested worklet: it is created on the UI runtime already, and a worklet
  // that refers to itself captures itself before it exists (the inspector's runUiLoop learned this).
  function frame(ts: number) {
    const gg = globalThis as UiGlobal
    if (gg.__kfvLoop !== loop) return
    if (loop.pending > 0) {
      loop.until = Math.max(loop.until, ts + loop.pending)
      loop.pending = 0
    }
    loop.lastTs = ts
    const full = tickFieldMeter(loop.f, ts)
    gg.__kfvInterval = loop.f.m.interval
    if (ts > loop.until) {
      gg.__kfvLoop = null
      scheduleOnRN(onUiFrames, loop.f.buf.splice(0), ts)
      return
    }
    if (full) scheduleOnRN(onUiFrames, loop.f.buf.splice(0), ts)
    raf!(frame)
  }
  raf(frame)
}

function installUi(on: boolean, base: number): void {
  scheduleOnUI(
    (enable: boolean, first: number) => {
      'worklet'
      const g = globalThis as UiGlobal
      if (!enable) {
        g.__KF_VITALS__ = null
        g.__kfvLoop = null
        return
      }
      const ids = new WeakMap<object, number>()
      let next = first
      let lastScroll = -1e9
      g.__KF_VITALS__ = {
        anim(fn: AnimFn, site: SiteInfo, args: unknown[], via: AnimFn | null, viaSite: unknown) {
          const r = via ? via(fn, viaSite, ...args) : fn(...args)
          try {
            const eid = next++
            const slim: unknown[] = []
            for (let i = 0; i < args.length; i++) slim.push(slimArg(args[i], (x: object) => ids.get(x)))
            if ((typeof r === 'object' && r !== null) || typeof r === 'function') ids.set(r as object, eid)
            uiKeepAlive(500)
            const loop = (globalThis as UiGlobal).__kfvLoop
            scheduleOnRN(onUiAnim, site, slim, eid, loop && loop.lastTs >= 0 ? loop.lastTs : -1)
          } catch {
            // Never let measuring break the app.
          }
          return r
        },
        scroll() {
          uiKeepAlive(500)
          const loop = (globalThis as UiGlobal).__kfvLoop
          const t = loop && loop.lastTs >= 0 ? loop.lastTs : -1
          if (t < 0 || t - lastScroll > 100) {
            lastScroll = t
            scheduleOnRN(onUiScroll, t)
          }
        },
      }
    },
    on,
    base,
  )
}

function stopUi(): void {
  scheduleOnUI(() => {
    'worklet'
    ;(globalThis as UiGlobal).__kfvLoop = null
  })
}

function extendUi(ms: number): void {
  scheduleOnUI((m: number) => {
    'worklet'
    uiKeepAlive(m)
  }, ms)
}

// ─── JS loop ──────────────────────────────────────────────────────────────────────

const jsMeter = createFieldMeter('js')
const jsLoop = createJsLoop({
  raf: (cb) => requestAnimationFrame(cb),
  later: (cb) => setTimeout(cb, 16),
  now,
  frame: (t) => {
    const last = jsMeter.m.last
    const interval = jsMeter.m.interval
    tickFrameMeter(jsMeter.m, t)
    jsMeter.m.stats.length = 0
    jsMeter.m.drops.length = 0
    return controller.jsFrame(t, last >= 0 ? t - last : 0, interval)
  },
})

let uiInstalled = false
const meters: Meters = {
  install() {
    ;(globalThis as UiGlobal).__KF_VITALS__ = jsHook
    try {
      installUi(true, UI_EVENT_BASE)
      uiInstalled = true
    } catch {
      // No worklets runtime (web, tests): the JS thread is measured alone.
      uiInstalled = false
    }
  },
  uninstall() {
    ;(globalThis as UiGlobal).__KF_VITALS__ = null
    if (uiInstalled) installUi(false, 0)
    uiInstalled = false
  },
  start() {
    if (!jsLoop.running) {
      jsMeter.m.last = -1
      jsLoop.start()
    }
  },
  extendUi(ms) {
    if (uiInstalled) extendUi(ms)
  },
  stop() {
    jsLoop.stop()
    if (uiInstalled) stopUi()
  },
}

// ─── App state, navigation, accessibility ─────────────────────────────────────────

let options: VitalsOptions | null = null
let subscriptions: Array<() => void> = []
let manualScreen = false

function routeName(): string | null {
  const ref = options?.navigationRef
  if (!ref) return null
  try {
    if (ref.isReady && !ref.isReady()) return null
    const route = ref.getCurrentRoute()
    if (!route?.name) return null
    return options?.screenName ? options.screenName(route) : route.name
  } catch {
    return null
  }
}

let lastRoute: string | null = null
/** Reads the current route (cheap): on navigation, and when motion starts before the container was ready. */
function checkScreen(): void {
  if (manualScreen) return
  const name = routeName()
  if (name === null || name === lastRoute) return
  lastRoute = name
  controller.setScreen(screenName(name))
}

function unsubscribeAll(): void {
  for (const off of subscriptions) {
    try {
      off()
    } catch {
      // already gone
    }
  }
  subscriptions = []
}

declare const __DEV__: boolean | undefined

/**
 * Starts Motion Vitals. Nothing runs before this call (call it after your own consent flow if your app
 * needs one); from here this session may be sampled and report. Safe to call again with new options.
 */
export async function startVitals(opts: VitalsOptions): Promise<void> {
  unsubscribeAll()
  options = opts
  lastRoute = null
  manualScreen = false
  const environment = opts.environment ?? (typeof __DEV__ !== 'undefined' && __DEV__ ? 'development' : 'production')
  // 'inactive' (iOS: app switcher, Control Center, a call) is still the foreground, but React Native's
  // JS timers lose the display there (jsLoop.ts): the meters pause until the app is active again.
  const appState = AppState.addEventListener('change', (s: AppStateStatus) => {
    if (s !== 'active') touchDown = false
    controller.appState(s !== 'background', s === 'active')
  })
  subscriptions.push(() => appState.remove())
  if (opts.navigationRef) {
    const off = opts.navigationRef.addListener('state', checkScreen)
    subscriptions.push(() => (typeof off === 'function' ? off() : off && typeof off === 'object' ? off.remove() : undefined))
  }
  try {
    const rm = AccessibilityInfo.addEventListener('reduceMotionChanged', (on: boolean) => controller.setReduceMotion(on))
    subscriptions.push(() => rm.remove())
    AccessibilityInfo.isReduceMotionEnabled().then(
      (on) => controller.setReduceMotion(on),
      () => undefined,
    )
  } catch {
    // Not available on this platform.
  }
  checkScreen()
  await controller.start({ ...opts, environment }, meters)
  checkScreen()
}

/** Stops (false: now, and drops what is pending) or starts again (true) with the options of startVitals. */
export async function setVitalsEnabled(enabled: boolean): Promise<void> {
  if (!enabled) {
    unsubscribeAll()
    touchDown = false
    await controller.setEnabled(false)
  } else if (options && !controller.isEnabled) await startVitals(options)
}

/** Names the current screen where navigation is not automatic (no navigationRef, or a screen inside one). */
export function setVitalsScreen(name: string): void {
  manualScreen = true
  controller.setScreen(screenName(name))
}

/** Touches seen by `<VitalsRoot>`: a touch keeps the meters running until 1.5 s after the finger lifts. */
let touchDown = false
export function vitalsTouch(down: boolean, activeTouches: number): void {
  if (down && !touchDown) {
    touchDown = true
    controller.touch(true)
  } else if (!down && touchDown && activeTouches === 0) {
    touchDown = false
    controller.touch(false)
  }
}
