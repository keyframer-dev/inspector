/**
 * What the Babel plugin's rewritten calls run into. With no inspector attached (the normal case, and
 * always on the UI runtime until one is installed there) they are a straight pass-through, so an
 * instrumented app behaves exactly like the original.
 *
 * `__kfAnim` is a worklet because animation calls are often made inside gesture callbacks, which run
 * on the UI thread.
 */

import type {
  InspectorCallSite,
  InspectorEvent,
  InspectorGestureSite,
  InspectorRenderHint,
  InspectorTask,
  InspectorOverrides,
  InspectorSignalSite,
  InspectorStyleSite,
  InspectorWorkletIssue,
} from '../../protocol/inspector'
import { useEffect } from 'react'
import { isScrollSample } from './scrollIds'
import { watchWorkletCrashes, type KnownSuspect } from './workletCrash'

type AnimFn = (...args: unknown[]) => unknown

export type InspectorHook = {
  anim(fn: AnimFn, site: InspectorCallSite, args: unknown[]): unknown
  signal(sv: unknown, site: InspectorSignalSite): void
  /** A shared value that unmounted, by its (instance) id. */
  unsignal?(id: string): void
  style(site: InspectorStyleSite): void
  /** Something about how an animated view is drawn that costs frames (see renderHints). */
  hint?(hint: InspectorRenderHint): void
  /** A worklet mistake that crashes the app, found in the code or seen crashing (see __kfWorkletIssues). */
  worklet?(issue: InspectorWorkletIssue): void
}

type HookGlobal = { __KF_INSPECTOR__?: InspectorHook; __KF_SEEN__?: Seen }

/**
 * Every shared value and style the app has rendered, by call site, whether or not an inspector was
 * installed then. An inspector installed later (connectInspector in an effect, after <MotionScan> or
 * the first render) gets them all on install: components report themselves while rendering, and one
 * that never re-renders would otherwise never show up. One entry per call site, so it stays small.
 * On globalThis because Metro can load this module twice (the CommonJS and ESM builds).
 * `hints` are the render hints found so far, by `id:hint`; `routes` the screen each shared value
 * instance mounted on, when navigation is tracked.
 */
type Seen = {
  signals: Map<string, { sv: unknown; site: InspectorSignalSite }>
  styles: Map<string, InspectorStyleSite>
  hints: Map<string, InspectorRenderHint>
  routes: Map<string, string>
  /** Worklet mistakes the Babel plugin found, by id, and what each file's worklets call that it could not see into, by file. */
  worklets: Map<string, InspectorWorkletIssue>
  suspects: Map<string, KnownSuspect[]>
}
function seen(): Seen {
  const g = globalThis as HookGlobal
  const s = (g.__KF_SEEN__ ??= { signals: new Map(), styles: new Map(), hints: new Map(), routes: new Map(), worklets: new Map(), suspects: new Map() })
  // A copy of an older runtime may have made it without these.
  s.hints ??= new Map()
  s.routes ??= new Map()
  s.worklets ??= new Map()
  s.suspects ??= new Map()
  return s
}

/** Every shared value rendered so far, by call site id: what a recording on the device samples. */
export function registeredSignals(): ReadonlyMap<string, { sv: unknown; site: InspectorSignalSite }> {
  return seen().signals
}

/** Every animated style rendered so far, by call site id: which shared value feeds which style property. */
export function registeredStyles(): ReadonlyMap<string, InspectorStyleSite> {
  return seen().styles
}

export function __kfAnim(fn: AnimFn, site: InspectorCallSite, ...args: unknown[]): unknown {
  'worklet'
  const hook = (globalThis as HookGlobal).__KF_INSPECTOR__
  if (hook === undefined) return fn(...args)
  return hook.anim(fn, site, args)
}

/** What a gesture callback reports, when something listens (a recording on the device): see native.ts watchGestures. */
type GestureHook = (site: InspectorGestureSite, event: unknown, success: unknown) => void
type GestureGlobal = { __KF_GESTURE__?: GestureHook }

/**
 * A react-native-gesture-handler callback, wrapped by the Babel plugin: it tells a listener which
 * gesture ran and where the finger was (and, for onEnd and onFinalize, their second argument: whether
 * it succeeded), then runs the original. A worklet, so it runs wherever the gesture runs its
 * callbacks (the UI thread, or JS with runOnJS(true)), and is a pass-through when nothing listens.
 */
export function __kfGesture<F extends (...args: never[]) => unknown>(fn: F, site: InspectorGestureSite): F {
  const wrapped = (...args: unknown[]) => {
    'worklet'
    const hook = (globalThis as GestureGlobal).__KF_GESTURE__
    if (hook === undefined) return (fn as unknown as (...a: unknown[]) => unknown)(...args)
    hook(site, args[0], args[1])
    const t0 = __kfNow()
    try {
      return (fn as unknown as (...a: unknown[]) => unknown)(...args)
    } finally {
      __kfWork('gesture', `${site.file}:${site.line}`, `${site.gesture}.${site.on}`, __kfNow() - t0)
    }
  }
  return wrapped as unknown as F
}

// ─── Timing ───────────────────────────────────────────────────────────────────────
// The Babel plugin times the app's own code while something records: worklets on the UI thread
// (animated styles, derived values, reactions, scroll handlers, scheduleOnUI) and JS tasks (event
// handlers, effects). Both are a clock read and a check of one global when nothing listens.

type TimingGlobal = {
  performance?: { now(): number }
  /** On the UI runtime while recording: flat [kind, site, name, ms, …], drained every frame (native.ts). */
  __KF_UI_WORK__?: unknown[]
  /** On the JS runtime while recording: receives each task (tasks.ts). */
  __KF_TASKS__?: (kind: InspectorTask['kind'], name: string, site: string | null, component: string | null, ms: number) => void
}

/** A fine clock where the runtime has one (ms). */
export function __kfNow(): number {
  'worklet'
  const p = (globalThis as TimingGlobal).performance
  return p && typeof p.now === 'function' ? p.now() : Date.now()
}

/** One worklet run on the UI thread: buffered for the frame when a recording listens. */
export function __kfWork(kind: string, site: string, name: string | null, ms: number): void {
  'worklet'
  const buf = (globalThis as TimingGlobal).__KF_UI_WORK__
  if (buf !== undefined) buf.push(kind, site, name, ms)
}

/** Where a scrolled list is, from its onScroll worklet: buffered for the frame when a recording listens. */
export function __kfScroll(id: string, event: { contentOffset?: { x: number; y: number } } | undefined): void {
  'worklet'
  if (!event || !event.contentOffset) return
  const g = globalThis as { __KF_UI_SCROLL__?: unknown[]; __KF_UI_SCROLL_LAST__?: Record<string, number[]> }
  const { x, y } = event.contentOffset
  // Where each list last was, always (one write per scroll event): a list only reports while it
  // moves, so a recording that starts with it at rest learns its offset from here.
  if (g.__KF_UI_SCROLL_LAST__ === undefined) g.__KF_UI_SCROLL_LAST__ = {}
  g.__KF_UI_SCROLL_LAST__[id] = [x, y, Date.now()]
  const buf = g.__KF_UI_SCROLL__
  if (buf !== undefined) buf.push(id, x, y)
}

// ─── Scrollables ──────────────────────────────────────────────────────────────────
// The views scrolled by a useAnimatedScrollHandler, by the handler's call site (the Babel plugin
// adds a ref), so playback and capture can scroll the real list, not only the values it drives.

type Scrollable = { scrollTo?: (o: { x?: number; y?: number; animated?: boolean }) => void; scrollToOffset?: (o: { offset: number; animated?: boolean }) => void }
type ScrollShared = {
  __KF_SCROLLABLES__?: Map<string, Scrollable>
  __KF_SCROLL_REFS__?: Map<string, { prev: unknown; ref: (i: unknown) => void }>
  __KF_SCROLL_MOUNTED__?: Map<string, number>
  __KF_SCROLL_MOUNT_TAPS__?: Set<(id: string) => void>
}
const scrollables = ((globalThis as ScrollShared).__KF_SCROLLABLES__ ??= new Map())
const scrollRefs = ((globalThis as ScrollShared).__KF_SCROLL_REFS__ ??= new Map())
/** When each list last mounted (Date.now): an offset it reported before that belongs to an older one. */
const scrollMounted = ((globalThis as ScrollShared).__KF_SCROLL_MOUNTED__ ??= new Map())
const scrollMountTaps = ((globalThis as ScrollShared).__KF_SCROLL_MOUNT_TAPS__ ??= new Set())

/** Calls `fn` with a list's id whenever one mounts (it starts at rest, at 0). Returns the unsubscribe. */
export function tapScrollMounts(fn: (id: string) => void): () => void {
  scrollMountTaps.add(fn)
  return () => {
    scrollMountTaps.delete(fn)
  }
}

/**
 * The ref the Babel plugin gives a scroll view: remembers it under its scroll handler's id and passes
 * it on to the app's own ref (a function or an object). The same ref for the same app ref, so React
 * does not detach and re-attach it on every render.
 */
export function __kfScrollRef(id: string, prev?: unknown): (instance: unknown) => void {
  const cached = scrollRefs.get(id)
  if (cached && cached.prev === prev) return cached.ref
  const ref = (instance: unknown) => {
    if (instance) {
      const fresh = scrollables.get(id) !== instance
      scrollables.set(id, instance as Scrollable)
      if (fresh) {
        scrollMounted.set(id, Date.now())
        for (const tap of scrollMountTaps) tap(id)
      }
    } else if (scrollables.get(id)) scrollables.delete(id)
    if (typeof prev === 'function') (prev as (i: unknown) => void)(instance)
    else if (prev && typeof prev === 'object' && 'current' in prev) (prev as { current: unknown }).current = instance
  }
  scrollRefs.set(id, { prev, ref })
  return ref
}

/**
 * Where every list on screen rests, from the last offsets the UI thread saw ([x, y, Date.now()] by
 * id): a list that has not scrolled since it mounted is at 0. What a recording starts from.
 */
export function restingOffsets(last: Record<string, number[]>): Array<{ id: string; x: number; y: number }> {
  return [...scrollables.keys()].map((id) => {
    const l = last[id]
    return l && l[2]! >= (scrollMounted.get(id) ?? 0) ? { id, x: l[0]!, y: l[1]! } : { id, x: 0, y: 0 }
  })
}

// A list scrolled by a plain JS onScroll (not a worklet): the Babel plugin wraps the handler, so its
// offsets join the same scroll tracks and its ref the same scrollables, by the onScroll's line.

type JsScrollShared = {
  __KF_JS_SCROLL_LAST__?: Record<string, number[]>
  __KF_JS_SCROLL_TAPS__?: Set<(id: string, x: number, y: number) => void>
  __KF_JS_SCROLL_FNS__?: Map<string, WeakMap<object, unknown>>
}
const jsScrollLast = ((globalThis as JsScrollShared).__KF_JS_SCROLL_LAST__ ??= {})
const jsScrollTaps = ((globalThis as JsScrollShared).__KF_JS_SCROLL_TAPS__ ??= new Set())
const jsScrollFns = ((globalThis as JsScrollShared).__KF_JS_SCROLL_FNS__ ??= new Map())

/** The last offset each JS-scrolled list reported, [x, y, Date.now()] by scroll id. */
export function jsScrollOffsets(): Record<string, number[]> {
  return jsScrollLast
}

/** Calls `fn` with every offset a JS-scrolled list reports. Returns the unsubscribe. */
export function tapJsScroll(fn: (id: string, x: number, y: number) => void): () => void {
  jsScrollTaps.add(fn)
  return () => {
    jsScrollTaps.delete(fn)
  }
}

/**
 * An onScroll that runs on the JS thread, wrapped by the Babel plugin: it notes where the list is,
 * then calls the app's handler. Anything that is not a function (Animated.event on the native
 * driver, a Reanimated handler) passes through. The same wrapper for the same handler.
 */
export function __kfScrollJs<F>(id: string, fn: F): F {
  if (typeof fn !== 'function') return fn
  let byFn = jsScrollFns.get(id)
  if (!byFn) jsScrollFns.set(id, (byFn = new WeakMap()))
  const cached = byFn.get(fn)
  if (cached) return cached as F
  const wrapped = function (this: unknown, e: { nativeEvent?: { contentOffset?: { x: number; y: number } } }) {
    const o = e?.nativeEvent?.contentOffset
    if (o) {
      jsScrollLast[id] = [o.x, o.y, Date.now()]
      for (const tap of jsScrollTaps) tap(id, o.x, o.y)
    }
    return (fn as unknown as (...a: unknown[]) => unknown).apply(this, arguments as unknown as unknown[])
  }
  byFn.set(fn, wrapped)
  return wrapped as unknown as F
}

export { isScrollSample }

/**
 * Scrolls the lists these samples name to their offsets (other samples are ignored): playback,
 * scrubbing and capture move the real list, and its scroll handler drives the rest.
 */
export function applyScrollSamples(samples: Array<{ id: string; v: number }>, last: Map<string, { x: number; y: number }> = new Map()): void {
  const touched = new Set<string>()
  for (const s of samples) {
    if (!isScrollSample(s.id)) continue
    const id = s.id.slice(0, -2)
    const at = last.get(id) ?? { x: 0, y: 0 }
    if (s.id.endsWith(':x')) at.x = s.v
    else at.y = s.v
    last.set(id, at)
    touched.add(id)
  }
  for (const id of touched) {
    const view = scrollables.get(id)
    const at = last.get(id)!
    if (view?.scrollTo) view.scrollTo({ x: at.x, y: at.y, animated: false })
    else if (view?.scrollToOffset) view.scrollToOffset({ offset: at.x || at.y, animated: false })
  }
}

const handlerWrappers = new WeakMap<object, unknown>()
const isHandlerWrapper = new WeakSet<object>()

/**
 * An event handler in the app (onPress={…}), wrapped by the Babel plugin: times each call while a
 * recording listens. The same function always gets the same wrapper, so a memoized child sees a
 * stable prop. `passed` marks one the file did not write (a prop, a hook's result, an import): it is
 * named after the function, and left alone when an outer component already wrapped it, or when it
 * is a worklet or not a function at all.
 */
export function __kfHandler<F>(fn: F, name: string, site: string, component: string | null, passed?: boolean): F {
  if (typeof fn !== 'function' || isHandlerWrapper.has(fn)) return fn
  if (passed && (fn as { __workletHash?: unknown }).__workletHash !== undefined) return fn
  const cached = handlerWrappers.get(fn)
  if (cached) return cached as F
  const fnName = (fn as { name?: unknown }).name
  const label = passed && typeof fnName === 'string' && fnName && fnName !== name && !fnName.startsWith('bound ') ? `${name} (${fnName})` : name
  const wrapped = function (this: unknown, ...args: unknown[]) {
    const hook = (globalThis as TimingGlobal).__KF_TASKS__
    if (!hook) return (fn as (...a: unknown[]) => unknown).apply(this, args)
    const t0 = __kfNow()
    try {
      return (fn as (...a: unknown[]) => unknown).apply(this, args)
    } finally {
      hook('handler', label, site, component, __kfNow() - t0)
    }
  }
  handlerWrappers.set(fn, wrapped)
  isHandlerWrapper.add(wrapped)
  return wrapped as F
}

/** A useEffect / useLayoutEffect body, wrapped by the Babel plugin: timed while a recording listens. */
export function __kfEffect<F extends () => unknown>(fn: F, name: string, site: string, component: string | null): F {
  return (() => {
    const hook = (globalThis as TimingGlobal).__KF_TASKS__
    if (!hook) return fn()
    const t0 = __kfNow()
    try {
      return fn()
    } finally {
      hook('effect', name, site, component, __kfNow() - t0)
    }
  }) as F
}

// ─── Components ───────────────────────────────────────────────────────────────────
// The app's own components by name (the Babel plugin lists each file's): React commits charge time in
// library components to the nearest one of these, and say which file it is in.
type ComponentsGlobal = { __KF_COMPONENTS__?: Map<string, string> }
const components = ((globalThis as ComponentsGlobal).__KF_COMPONENTS__ ??= new Map())

export function __kfComponents(file: string, names: string[]): void {
  for (const n of names) components.set(n, file)
}

/**
 * True when the Babel plugin is in this build (it registers the app's components as their files
 * load). The one switch for preview builds: `<MotionScan enabled={isInstrumented()}>` follows the
 * Babel config, so a build without the plugin carries no recorder.
 */
export function isInstrumented(): boolean {
  return components.size > 0
}

/**
 * The current values of the shared values an animation call writes: its `target` is the variable's name,
 * found in the same file and component (every mounted instance: a list's rows each own one). Read on the
 * JS thread; empty when none is registered.
 */
export function targetValues(site: { target: string | null; file: string; component: string | null }): unknown[] {
  if (!site.target) return []
  const out: unknown[] = []
  for (const { sv, site: s } of seen().signals.values()) {
    if (s.name !== site.target || s.file !== site.file || (site.component && s.component && s.component !== site.component)) continue
    try {
      out.push((sv as { value?: unknown }).value)
    } catch {
      // A value that cannot be read (released): not moving.
    }
  }
  return out
}

/** The file an app component is written in, or undefined for a library's. Strips wrappers: "Glitches(./glitches.tsx)" → Glitches. */
export function appComponentFile(name: string): string | undefined {
  return components.get(name) ?? components.get(name.replace(/\(.*\)$/, ''))
}

/**
 * A useSharedValue, registered at once under its call site. Older builds call this from render; it
 * stays for them and for tests. Builds from this plugin call useKfSignal, which tells instances apart.
 */
export function __kfSignal<T>(sv: T, site: InspectorSignalSite): T {
  seen().signals.set(site.id, { sv, site })
  ;(globalThis as HookGlobal).__KF_INSPECTOR__?.signal(sv, site)
  return sv
}

// Every mounted instance of a useSharedValue call site has a slot: the first is the call site itself,
// the next ones `<site>#2`, `<site>#3`… (each row of a list that owns a shared value). A slot frees
// when its component unmounts, so a screen that re-mounts gets its old ids back.
type SlotShared = { __KF_SLOTS__?: Map<string, Set<number>> }
const slots = ((globalThis as SlotShared).__KF_SLOTS__ ??= new Map())

function claimSlot(siteId: string): number {
  const taken = slots.get(siteId) ?? new Set<number>()
  let n = 0
  while (taken.has(n)) n++
  taken.add(n)
  slots.set(siteId, taken)
  return n
}

/**
 * A useSharedValue in a component, wrapped by the Babel plugin: registers this instance while it is
 * mounted, under its own id, and unregisters it when it unmounts. A hook (it is called where
 * useSharedValue is, so always at the top of a component or hook).
 */
export function useKfSignal<T>(sv: T, site: InspectorSignalSite): T {
  try {
    registerWhileMounted(sv, site)
  } catch {
    // Called outside React (a component run as a plain function, in a test): no effects to tie the
    // instance to, so it registers at once under its call site.
    __kfSignal(sv, site)
  }
  return sv
}

function registerWhileMounted(sv: unknown, site: InspectorSignalSite) {
  useEffect(() => {
    const n = claimSlot(site.id)
    const instance = n === 0 ? site : { ...site, id: `${site.id}#${n + 1}`, name: site.name ? `${site.name} #${n + 1}` : null }
    seen().signals.set(instance.id, { sv, site: instance })
    noteRoute(instance.id, sv)
    ;(globalThis as HookGlobal).__KF_INSPECTOR__?.signal(sv, instance)
    return () => {
      if (seen().signals.get(instance.id)?.sv === sv) {
        seen().signals.delete(instance.id)
        seen().routes.delete(instance.id)
      }
      slots.get(site.id)?.delete(n)
      ;(globalThis as HookGlobal).__KF_INSPECTOR__?.unsignal?.(instance.id)
    }
    // Once per shared value: a new one (a re-mount) is a new instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sv])
}

export function __kfStyle<T>(style: T, site: InspectorStyleSite): T {
  const s = seen()
  // Called on every render: the hints a style's links give are worked out once per call site.
  if (!s.styles.has(site.id)) hintStyle(site)
  s.styles.set(site.id, site)
  ;(globalThis as HookGlobal).__KF_INSPECTOR__?.style(site)
  return style
}

// ─── Screens ──────────────────────────────────────────────────────────────────────
// The screen a shared value mounted on, so a recording can say when its screen is covered by another
// one (a stack keeps the screens below mounted, and a loop there keeps running). A screen's components
// mount in the commit that navigates to it, before the navigation container's own effect reports the
// change, so the route is read once that commit's effects have run.

function noteRoute(id: string, sv: unknown): void {
  void Promise.resolve().then(() => {
    const route = nav.current?.route
    if (route && seen().signals.get(id)?.sv === sv) seen().routes.set(id, route)
  })
}

/**
 * The screen each mounted shared value appeared on, by instance id. Values that mounted before
 * navigation was tracked (the first screen, the root layout's chrome) are not in it: there is no
 * telling a screen from what is drawn over every screen.
 */
export function signalRoutes(): ReadonlyMap<string, string> {
  return seen().routes
}

// ─── Render hints ─────────────────────────────────────────────────────────────────
// What the Babel plugin's static view of animated styles says about drawing cost, worked out once per
// call site: shadows and layout animated every frame, a filter blur animated, and (iOS) a shadow on a
// moving view that React Native cannot give a shadow path. Reported to the inspector as `renderHint`
// events, and kept for recordings started later.

const SHADOW_PROPS = new Set(['shadowOpacity', 'shadowRadius', 'shadowOffset', 'shadowColor', 'elevation', 'boxShadow'])
/** Style properties that lay the view out again when they change (the problems engine's list). */
const LAYOUT_PROPS = new Set([
  'width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight', 'top', 'left', 'right', 'bottom', 'margin', 'marginTop', 'marginBottom',
  'marginLeft', 'marginRight', 'marginHorizontal', 'marginVertical', 'padding', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight',
  'paddingHorizontal', 'paddingVertical', 'flex', 'flexGrow', 'flexShrink', 'flexBasis', 'borderWidth', 'gap',
])

/** The hints a set of animated style properties gives. `id`: the style or animation call site they belong to. */
export function hintsForProps(id: string, props: Array<{ prop: string; by?: string | null }>): InspectorRenderHint[] {
  const groups: Array<[string, (p: string) => boolean, string]> = [
    ['animated-shadow', (p) => SHADOW_PROPS.has(p), 'the shadow is drawn again every frame'],
    ['animated-layout', (p) => LAYOUT_PROPS.has(p), 'the view is laid out again every frame'],
    ['animated-blur', (p) => p === 'blur', 'the blur is applied again every frame'],
  ]
  const out: InspectorRenderHint[] = []
  for (const [hint, matches, what] of groups) {
    const hit = props.filter((p) => matches(p.prop))
    if (!hit.length) continue
    const named = [...new Set(hit.map((p) => (p.by ? `${p.prop} (${p.by})` : p.prop)))]
    out.push({ id, hint, detail: `${named.join(', ')} animated: ${what}` })
  }
  return out
}

function hintStyle(site: InspectorStyleSite): void {
  for (const h of hintsForProps(site.id, site.links.map((l) => ({ prop: l.prop, by: l.signal })))) addHint(h)
}

const animSitesChecked = new Set<string>()

/** An animation written straight into a style key (`{ width: withTiming(w) }`) says which key it animates. */
export function hintAnimationSite(site: InspectorCallSite): void {
  if (!site.prop || animSitesChecked.has(site.id)) return
  animSitesChecked.add(site.id)
  for (const h of hintsForProps(site.id, [{ prop: site.prop, by: site.target }])) addHint(h)
}

function addHint(h: InspectorRenderHint): void {
  const key = `${h.id}:${h.hint}`
  const s = seen()
  if (s.hints.has(key)) return
  s.hints.set(key, h)
  ;(globalThis as HookGlobal).__KF_INSPECTOR__?.hint?.(h)
}

/** Every render hint found so far. */
export function renderHints(): InspectorRenderHint[] {
  return [...seen().hints.values()]
}

// ─── Worklet mistakes ─────────────────────────────────────────────────────────────
// What the Babel plugin found in each file (workletLint.ts): a call at the top of the file reports it
// when the file loads, before any worklet runs, so the inspector lists the crash before it happens.

/** Called once per file by the Babel plugin with its findings, and the calls its worklets make that the plugin could not see into. */
export function __kfWorkletIssues(file: string, issues: InspectorWorkletIssue[], suspects: Array<Omit<KnownSuspect, 'file'>>): void {
  const s = seen()
  s.suspects.set(file, suspects.map((x) => ({ ...x, file })))
  for (const issue of issues) {
    s.worklets.set(issue.id, issue)
    ;(globalThis as HookGlobal).__KF_INSPECTOR__?.worklet?.(issue)
  }
}

/** Every worklet mistake found in the code so far. */
export function workletIssues(): InspectorWorkletIssue[] {
  return [...seen().worklets.values()]
}

const knownWorklets = () => {
  const s = seen()
  return { issues: s.worklets.values(), suspects: [...s.suspects.values()].flat() }
}

type OsGlobal = { __KF_OS__?: string }
const viewsChecked = new Set<string>()

/**
 * The style of an element that takes an animated style, wrapped by the Babel plugin: returned as it
 * is. While an inspector listens, its static part is read once per element: on iOS, React Native
 * gives a shadow a path (drawn cheaply) only on a view with an opaque background; any other shadow is
 * drawn from the view's pixels, offscreen, every frame the view moves.
 */
export function __kfViewStyle<S>(style: S, styleId: string): S {
  if ((globalThis as HookGlobal).__KF_INSPECTOR__ === undefined || viewsChecked.has(styleId)) return style
  viewsChecked.add(styleId)
  try {
    if ((globalThis as OsGlobal).__KF_OS__ === 'ios') checkShadowPath(flatten(style), styleId)
  } catch {
    // A style the inspector cannot read is still the app's to render.
  }
  return style
}

function checkShadowPath(s: Record<string, unknown>, styleId: string): void {
  const links = seen().styles.get(styleId)?.links ?? []
  const animated = (p: string) => links.some((l) => l.prop === p)
  // The animated part decides the background: no telling whether it is opaque.
  if (animated('backgroundColor')) return
  const opacity = typeof s.shadowOpacity === 'number' ? s.shadowOpacity : 0
  if (opacity <= 0 && !animated('shadowOpacity')) return
  if (s.shadowColor !== undefined && colorAlpha(s.shadowColor) === 0) return
  const alpha = s.backgroundColor === undefined || s.backgroundColor === null ? 0 : colorAlpha(s.backgroundColor)
  if (alpha === null || alpha >= 0.999) return
  const bg = s.backgroundColor == null ? 'no backgroundColor' : `backgroundColor ${String(s.backgroundColor)}`
  addHint({ id: styleId, hint: 'shadow-path', detail: `shadowOpacity ${animated('shadowOpacity') ? 'animated' : opacity} on a view with ${bg}: no shadow path, so the shadow is rendered from the view's pixels` })
}

/** A color's alpha from 0 to 1, or null when it cannot be read here (a platform color, a dynamic one). */
export function colorAlpha(c: unknown): number | null {
  if (typeof c === 'number') return ((c >>> 24) & 255) / 255
  if (typeof c !== 'string') return null
  const v = c.trim().toLowerCase()
  if (v === 'transparent') return 0
  const hex = /^#([0-9a-f]{3,8})$/.exec(v)?.[1]
  if (hex) {
    if (hex.length === 4) return parseInt(hex[3]! + hex[3]!, 16) / 255
    if (hex.length === 8) return parseInt(hex.slice(6), 16) / 255
    return 1
  }
  const fn = /^(rgba?|hsla?)\((.*)\)$/.exec(v)
  if (fn) {
    const parts = fn[2]!.split(/[\s,/]+/).filter(Boolean)
    if (parts.length < 4) return 1
    const a = parts[3]!
    return a.endsWith('%') ? Number(a.slice(0, -1)) / 100 : Number(a)
  }
  // A named color.
  return 1
}

// ─── Heavy visuals ────────────────────────────────────────────────────────────────
// Two more drawing costs the Babel plugin can place: a react-native-svg element given animated props
// (react-native-svg keeps no drawing cache, so the whole SVG is drawn again every frame one changes), and
// an image inside an animated view whose source is far larger than the view (decoded, uploaded and, on
// Android, scaled at full size while it moves). Both are render hints, found as the app renders and loads.

/**
 * The animatedProps of a react-native-svg element (`<AnimatedPath animatedProps={…}>`), wrapped by the
 * Babel plugin: returned as they are. The first time it renders, what its useAnimatedProps animates
 * becomes an `animated-svg` hint on that call site. `element` is the react-native-svg component (Path, Circle, Svg).
 */
export function __kfSvgProps<P>(props: P, styleId: string, element: string): P {
  const s = seen()
  if (s.hints.has(`${styleId}:animated-svg`)) return props
  const links = s.styles.get(styleId)?.links ?? []
  const named = [...new Set(links.map((l) => `${l.prop} (${l.signal})`))]
  addHint({ id: styleId, hint: 'animated-svg', detail: `${named.length ? `${named.join(', ')} animated` : 'Animated props'} on react-native-svg's ${element}: the whole SVG is drawn again every frame` })
  return props
}

/** A source this many times the pixels it is drawn at, on its shorter side, is far larger than its view. */
export const IMAGE_OVERSIZE = 4
/** And this many pixels at least (4 MB decoded): a small image a few times too large costs little. */
export const IMAGE_MIN_PIXELS = 1_000_000
/** The pixel scale when the app has not said (native.ts sets it): the largest phones', so a source is never called too large for a screen it fits. */
const DEFAULT_SCALE = 3

type Size = { w: number; h: number }
type ImageShared = {
  /** By image element: the largest source it loaded and the largest it was laid out at. */
  __KF_IMAGES__?: Map<string, { source: Size | null; view: Size | null }>
  __KF_IMAGE_FNS__?: Map<string, { prev: unknown; fn: unknown }>
  __KF_SCALE__?: number
}
const images = ((globalThis as ImageShared).__KF_IMAGES__ ??= new Map())
const imageFns = ((globalThis as ImageShared).__KF_IMAGE_FNS__ ??= new Map())

/**
 * The onLoad of an image inside an animated view, wrapped by the Babel plugin: notes the source's size
 * (React Native's Image says it in nativeEvent.source, expo-image in source, FastImage in nativeEvent),
 * then calls the app's handler. `id` is where the image is written, `inside` the animated view it is in
 * ("a view animated by cardStyle"). The same function for the same handler.
 */
export function __kfImageLoad<F = (e: unknown) => unknown>(id: string, inside: string, prev?: F): F {
  return imageHandler(id, inside, 'load', prev)
}

/** The onLayout of the same image: notes the size it is drawn at, then calls the app's handler. */
export function __kfImageLayout<F = (e: unknown) => unknown>(id: string, inside: string, prev?: F): F {
  return imageHandler(id, inside, 'layout', prev)
}

function imageHandler<F>(id: string, inside: string, on: 'load' | 'layout', prev: F | undefined): F {
  // Something that is not a function (a Reanimated event handler object) is the app's to keep.
  if (prev != null && typeof prev !== 'function') return prev
  const key = `${id}|${on}`
  const cached = imageFns.get(key)
  if (cached && cached.prev === prev) return cached.fn as F
  const fn = function (this: unknown, e: unknown) {
    try {
      noteImage(id, inside, on, e)
    } catch {
      // An event the inspector cannot read is still the app's to handle.
    }
    if (typeof prev === 'function') return (prev as (...a: unknown[]) => unknown).apply(this, arguments as unknown as unknown[])
  }
  imageFns.set(key, { prev, fn })
  return fn as F
}

type ImageEvent = { nativeEvent?: { source?: { width?: unknown; height?: unknown }; width?: unknown; height?: unknown; layout?: { width?: unknown; height?: unknown } }; source?: { width?: unknown; height?: unknown } }
const positive = (x: unknown): x is number => typeof x === 'number' && x > 0 && Number.isFinite(x)

function noteImage(id: string, inside: string, on: 'load' | 'layout', e: unknown): void {
  const ev = e as ImageEvent | undefined
  const size = on === 'load' ? (ev?.nativeEvent?.source ?? ev?.source ?? ev?.nativeEvent) : ev?.nativeEvent?.layout
  if (!positive(size?.width) || !positive(size?.height)) return
  const { width: w, height: h } = size as { width: number; height: number }
  let img = images.get(id)
  if (!img) images.set(id, (img = { source: null, view: null }))
  // Rows of a list share the element: the largest source against the largest view, so a mix never calls one too large.
  if (on === 'load') {
    if (!img.source || w * h > img.source.w * img.source.h) img.source = { w, h }
  } else img.view = { w: Math.max(w, img.view?.w ?? 0), h: Math.max(h, img.view?.h ?? 0) }
  if (img.source && img.view) checkImage(id, inside, img.source, img.view)
}

function checkImage(id: string, inside: string, source: Size, view: Size): void {
  if (seen().hints.has(`${id}:oversized-image`)) return
  const scale = (globalThis as ImageShared).__KF_SCALE__
  const k = positive(scale) ? scale : DEFAULT_SCALE
  const px = { w: Math.round(view.w * k), h: Math.round(view.h * k) }
  // Scaled to cover its view, an image shrinks by its shorter side's ratio: the least it can be too large by.
  const ratio = Math.min(source.w / px.w, source.h / px.h)
  if (ratio < IMAGE_OVERSIZE || source.w * source.h < IMAGE_MIN_PIXELS) return
  const mb = Math.round((source.w * source.h * 4) / 1e5) / 10
  addHint({
    id,
    hint: 'oversized-image',
    detail: `A ${source.w}x${source.h} image (${mb} MB decoded) drawn at ${Math.round(view.w)}x${Math.round(view.h)} pt (${px.w}x${px.h} px), ${Math.floor(ratio)} times larger on each side, in ${inside}`,
  })
}

/**
 * Returns a copy of `args` with each overridden param set: "0" replaces the first argument, "1.duration"
 * a field of the second. Paths that do not exist in this call are ignored rather than created, so a stale
 * override after an edit to the source cannot invent arguments.
 */
export function applyOverrides(args: unknown[], patch: Record<string, number> | undefined): unknown[] {
  'worklet'
  if (!patch) return args
  const out = args.slice()
  for (const path in patch) {
    const [head, key] = path.split('.')
    const i = Number(head)
    if (!Number.isInteger(i) || i < 0 || i >= out.length) continue
    if (key === undefined) {
      if (typeof out[i] === 'number') out[i] = patch[path]
    } else {
      const obj = out[i]
      if (obj && typeof obj === 'object' && key in (obj as object)) {
        out[i] = { ...(obj as Record<string, unknown>), [key]: patch[path] }
      }
    }
  }
  return out
}

// ─── Taps ─────────────────────────────────────────────────────────────────────────
// Local listeners on every inspector's events, whoever installed it (a Keyframer connection or Motion
// Scan's own local one): the hook is a single global, its event stream is not.
// Shared through globalThis, not module state: Metro can load this file twice (the plugin's import
// resolves to runtime.cjs, a tool's to the ESM build), and both copies must see the same taps and layouts.
type SharedState = {
  __KF_TAPS__?: Set<(event: InspectorEvent) => void>
  __KF_CAPTURE__?: { on: boolean; listeners: Set<(on: boolean) => void> }
  __KF_LAYOUTS__?: Map<string, ScreenRect>
  __KF_LAYOUT_TARGETS__?: Map<string, LayoutTarget>
  __KF_LAYOUT_NODES__?: Map<string, unknown>
  __KF_LAYOUT_WATCH__?: boolean
}
const shared = globalThis as SharedState
const taps = (shared.__KF_TAPS__ ??= new Set<(event: InspectorEvent) => void>())

/** Listen to every event an inspector in this app reports. Returns the unsubscribe. */
export function tapInspector(fn: (event: InspectorEvent) => void): () => void {
  taps.add(fn)
  return () => {
    taps.delete(fn)
  }
}

// ─── Touches ──────────────────────────────────────────────────────────────────────
// Motion Scan's root view sees every touch (record.ts recordTouches); a recording on the device and a
// live one both listen. `stamp` is the time the screen saw the touch, on its own clock.

export type TouchReport = {
  phase: 'start' | 'move' | 'end' | 'cancel'
  id: number
  x: number
  y: number
  stamp: number | null
  /** The view the touch started on (its host instance), to notice it going away mid-touch. */
  target?: unknown
}
type TouchShared = { __KF_TOUCH_TAPS__?: Set<(t: TouchReport) => void> }
const touchTaps = ((globalThis as TouchShared).__KF_TOUCH_TAPS__ ??= new Set())

export function tapTouches(fn: (t: TouchReport) => void): () => void {
  touchTaps.add(fn)
  return () => {
    touchTaps.delete(fn)
  }
}

export function emitTouch(t: TouchReport): void {
  for (const fn of touchTaps) fn(t)
}

// ─── Navigation ───────────────────────────────────────────────────────────────────
// The screen the app is on (record.ts trackNavigation / markNavigation): recordings mark each change,
// and one that starts later learns where it started.

export type NavigationReport = { route: string; params?: Record<string, unknown> }
type NavShared = { __KF_NAV__?: { current: NavigationReport | null; listeners: Set<(n: NavigationReport) => void> } }
const nav = ((globalThis as NavShared).__KF_NAV__ ??= { current: null, listeners: new Set() })

export function emitNavigation(n: NavigationReport): void {
  if (nav.current?.route === n.route) return
  nav.current = n
  for (const fn of nav.listeners) fn(n)
}

export function tapNavigation(fn: (n: NavigationReport) => void): () => void {
  nav.listeners.add(fn)
  return () => {
    nav.listeners.delete(fn)
  }
}

export function currentRoute(): NavigationReport | null {
  return nav.current
}

// ─── Animation speed ──────────────────────────────────────────────────────────────
// The speed the inspector runs the app's animations at (the `time` message; native.ts applies it):
// recordings mark each change, and Motion Scan shows it.

type TimeShared = { __KF_TIME__?: { scale: number; listeners: Set<(scale: number) => void> } }
const speed = ((globalThis as TimeShared).__KF_TIME__ ??= { scale: 1, listeners: new Set() })

export function emitTimeScale(scale: number): void {
  if (speed.scale === scale) return
  speed.scale = scale
  for (const fn of speed.listeners) fn(scale)
}

/** Calls `fn` with every new speed (1 normal, 0 paused). Returns the unsubscribe. */
export function tapTimeScale(fn: (scale: number) => void): () => void {
  speed.listeners.add(fn)
  return () => {
    speed.listeners.delete(fn)
  }
}

/** The speed animations run at now: 1 unless an inspector slowed or paused them. */
export function timeScale(): number {
  return speed.scale
}

// What navigates the app back to a recorded screen (record.ts trackNavigation registers its container).
type Navigator = (route: string, params?: Record<string, unknown>) => void
type NavigatorShared = { __KF_NAVIGATORS__?: Set<Navigator> }
const navigators = ((globalThis as NavigatorShared).__KF_NAVIGATORS__ ??= new Set())

export function registerNavigator(fn: Navigator): () => void {
  navigators.add(fn)
  return () => {
    navigators.delete(fn)
  }
}

/** Takes the app to `route` when it is on another screen. True when it navigated (the screen changes). */
export function navigateTo(route: string, params?: Record<string, unknown>): boolean {
  if (!navigators.size || nav.current?.route === route) return false
  for (const go of navigators) {
    try {
      go(route, params)
    } catch {
      // A container that does not know the route: the next one may.
    }
  }
  return true
}

// ─── Capture ──────────────────────────────────────────────────────────────────────
// While the inspector snapshots the screen for an export, the app's own debug overlays (Motion Scan's
// outlines and frame-rate pill) step aside so they do not end up in the video.
const capturing = (shared.__KF_CAPTURE__ ??= { on: false, listeners: new Set() })

export function setCapturing(on: boolean): void {
  if (capturing.on === on) return
  capturing.on = on
  for (const fn of capturing.listeners) fn(on)
}

/** Calls `fn` whenever capturing starts or stops. Returns the unsubscribe. */
export function watchCapturing(fn: (on: boolean) => void): () => void {
  capturing.listeners.add(fn)
  return () => {
    capturing.listeners.delete(fn)
  }
}

export function isCapturing(): boolean {
  return capturing.on
}

/** True while an inspector hook is installed on this (JS) runtime. */
export function isInspectorInstalled(): boolean {
  return (globalThis as HookGlobal).__KF_INSPECTOR__ !== undefined
}

// ─── CSS and layout animations ────────────────────────────────────────────────────
// Reanimated 4 also animates from props, with no withTiming call to wrap: CSS animations and
// transitions in a style, and entering / exiting / layout. The Babel plugin hands each one to these
// helpers with where it is written, and they report it as an animation when it starts.

/** Where an element is written. */
export type MotionSite = { id: string; file: string; line: number; column: number; component: string | null }

const noop = () => undefined

function reportMotion(site: MotionSite, fn: string, target: string | null, detail: Record<string, unknown>): void {
  const hook = (globalThis as HookGlobal).__KF_INSPECTOR__
  if (hook === undefined) return
  hook.anim(noop, { ...site, id: `${site.id}#${fn}`, fn, target, prop: null, params: [] }, [detail])
}

function flatten(style: unknown, into: Record<string, unknown> = {}): Record<string, unknown> {
  if (Array.isArray(style)) for (const s of style) flatten(s, into)
  else if (style && typeof style === 'object') Object.assign(into, style)
  return into
}

/** "300ms", "0.3s" or 300 → 300; the first of a list. */
export function cssMs(v: unknown): number | undefined {
  if (Array.isArray(v)) return cssMs(v[0])
  if (typeof v === 'number') return v
  if (typeof v !== 'string') return undefined
  const m = /^\s*(-?[\d.]+)\s*(ms|s)?\s*$/.exec(v)
  return m ? Number(m[1]) * (m[2] === 's' ? 1000 : 1) : undefined
}

const isKeyframes = (o: object) => Object.keys(o).length > 0 && Object.keys(o).every((k) => /^(from|to|[\d.]+%?)$/.test(k))

/** What an animationName animates: its name, or the properties its keyframes set. */
function animationTarget(name: unknown): string {
  if (typeof name === 'string') return name
  if (Array.isArray(name)) return name.map(animationTarget).join(', ')
  if (name && typeof name === 'object') {
    if (isKeyframes(name)) {
      const props = new Set<string>()
      for (const frame of Object.values(name)) if (frame && typeof frame === 'object') for (const k of Object.keys(frame)) props.add(k)
      return [...props].join(', ') || 'keyframes'
    }
    const n = (name as { name?: unknown }).name
    if (typeof n === 'string') return n
  }
  return 'keyframes'
}

const CSS_KEY = /^(animation|transition)[A-Z]/
const stable = (v: unknown) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v))

type CssInstance = { anim: string; values: Record<string, string>; raw: Record<string, unknown> }
type CssShared = { __KF_CSS__?: Map<string, { pass: number; n: number; last: CssInstance[] }> }
const cssSites = ((globalThis as CssShared).__KF_CSS__ ??= new Map())
let cssPass = 0
let cssPassQueued = false

/**
 * The style of an animated element, wrapped by the Babel plugin in files that use CSS animations or
 * transitions. Returns it as it is; while an inspector listens, reports a CSS animation when one
 * starts (mount, or a new animationName) and a CSS transition when a property it transitions
 * changes. Elements rendered from the same line (a list's rows) are told apart by their order in a
 * render pass.
 */
export function __kfCss<S>(style: S, site: MotionSite): S {
  if ((globalThis as HookGlobal).__KF_INSPECTOR__ === undefined) return style
  try {
    trackCss(flatten(style), site)
  } catch {
    // A style the inspector cannot read is still the app's to render.
  }
  return style
}

function trackCss(s: Record<string, unknown>, site: MotionSite): void {
  const hasAnim = s.animationName != null && s.animationName !== 'none'
  const hasTransition = s.transitionProperty != null || s.transitionDuration != null
  if (!hasAnim && !hasTransition) return
  if (!cssPassQueued) {
    cssPassQueued = true
    Promise.resolve().then(() => {
      cssPass++
      cssPassQueued = false
    })
  }
  let st = cssSites.get(site.id)
  if (!st) cssSites.set(site.id, (st = { pass: -1, n: 0, last: [] }))
  if (st.pass !== cssPass) {
    st.pass = cssPass
    st.n = 0
  }
  const i = st.n++
  const prev = st.last[i]
  const anim = hasAnim
    ? stable([s.animationName, s.animationDuration, s.animationDelay, s.animationIterationCount, s.animationDirection, s.animationTimingFunction])
    : ''
  const props = s.transitionProperty == null || s.transitionProperty === 'all' ? null : ([] as unknown[]).concat(s.transitionProperty).map(String)
  const values: Record<string, string> = {}
  const raw: Record<string, unknown> = {}
  if (hasTransition) {
    for (const k of props ?? Object.keys(s)) {
      if (CSS_KEY.test(k) || !(k in s) || typeof s[k] === 'function') continue
      values[k] = stable(s[k])
      raw[k] = s[k]
    }
  }
  st.last[i] = { anim, values, raw }
  if (hasAnim && anim !== prev?.anim) {
    reportMotion(site, 'CSS animation', animationTarget(s.animationName), {
      animationName: s.animationName,
      duration: cssMs(s.animationDuration) ?? 0,
      delay: cssMs(s.animationDelay) ?? 0,
      iterationCount: s.animationIterationCount ?? 1,
      ...(s.animationDirection != null && { direction: s.animationDirection }),
      ...(s.animationTimingFunction != null && { timingFunction: s.animationTimingFunction }),
    })
  }
  if (hasTransition && prev) {
    const changed = Object.keys(values).filter((k) => k in prev.values && prev.values[k] !== values[k])
    if (changed.length) {
      const from: Record<string, unknown> = {}
      const to: Record<string, unknown> = {}
      for (const k of changed) {
        from[k] = prev.raw[k]
        to[k] = raw[k]
      }
      reportMotion(site, 'CSS transition', changed.join(', '), {
        from,
        to,
        duration: cssMs(s.transitionDuration) ?? 0,
        delay: cssMs(s.transitionDelay) ?? 0,
        ...(s.transitionTimingFunction != null && { timingFunction: s.transitionTimingFunction }),
      })
    }
  }
}

/** "FadeIn", with its duration and delay, from a layout animation builder (a class, an instance or a worklet). */
export function describeLayoutAnimation(builder: unknown): { animation: string; duration: number; delay: number; spring?: boolean } {
  if (builder == null) return { animation: 'none', duration: 0, delay: 0 }
  const ctor = typeof builder === 'function' ? builder : (builder as { constructor?: unknown }).constructor
  const preset = (ctor as { presetName?: unknown } | undefined)?.presetName
  const ctorName = (ctor as { name?: unknown } | undefined)?.name
  const animation =
    typeof preset === 'string' && preset
      ? preset
      : typeof builder === 'object' && typeof ctorName === 'string' && ctorName && ctorName !== 'Object'
        ? ctorName
        : 'custom'
  const b = builder as { durationV?: number; delayV?: number; type?: { name?: string }; getDuration?: () => number }
  let duration = typeof b.durationV === 'number' ? b.durationV : 300
  if (typeof b.durationV !== 'number' && typeof b.getDuration === 'function') {
    try {
      duration = b.getDuration()
    } catch {
      // A builder that cannot say keeps the default.
    }
  }
  const spring = b.type?.name === 'withSpring' || undefined
  return { animation, duration, delay: typeof b.delayV === 'number' ? b.delayV : 0, ...(spring && { spring }) }
}

type LayoutKind = 'entering' | 'exiting' | 'layout'
type MotionShared = {
  __KF_LAYOUT_ANIMS__?: Map<string, Partial<Record<LayoutKind, unknown>>>
  __KF_MOTION_REFS__?: Map<string, { prev: unknown; ref: (i: unknown) => unknown }>
  __KF_LAYOUT_MOVES__?: Map<string, { prev: unknown; fn: (e: unknown) => void }>
  __KF_LAYOUT_RECTS__?: Map<unknown, string>
}
const layoutAnims = ((globalThis as MotionShared).__KF_LAYOUT_ANIMS__ ??= new Map())
const motionRefs = ((globalThis as MotionShared).__KF_MOTION_REFS__ ??= new Map())
const layoutMoves = ((globalThis as MotionShared).__KF_LAYOUT_MOVES__ ??= new Map())
const layoutRects = ((globalThis as MotionShared).__KF_LAYOUT_RECTS__ ??= new Map())
const liveViews = new WeakSet<object>()
const leavingViews = new Set<object>()

/** An entering / exiting / layout prop, wrapped by the Babel plugin: returned as it is, remembered for its element. */
export function __kfLayoutAnim<B>(builder: B, kind: LayoutKind, site: MotionSite): B {
  let byKind = layoutAnims.get(site.id)
  if (!byKind) layoutAnims.set(site.id, (byKind = {}))
  byKind[kind] = builder
  return builder
}

function passRef(prev: unknown, instance: unknown): unknown {
  if (typeof prev === 'function') return (prev as (i: unknown) => unknown)(instance)
  if (prev && typeof prev === 'object' && 'current' in prev) (prev as { current: unknown }).current = instance
  return undefined
}

const pendingExits = new Map<string, number>()

/** A view of this element went: its exiting animation is reported after the commit, unless it comes back in it. */
function exitLater(site: MotionSite): void {
  const n = (pendingExits.get(site.id) ?? 0) + 1
  pendingExits.set(site.id, n)
  if (n > 1) return
  Promise.resolve().then(() => {
    const k = pendingExits.get(site.id) ?? 0
    pendingExits.delete(site.id)
    const exiting = layoutAnims.get(site.id)?.exiting
    if (exiting == null) return
    const d = describeLayoutAnimation(exiting)
    for (let i = 0; i < k; i++) reportMotion(site, 'exiting', d.animation, d)
  })
}

function cancelExit(site: MotionSite): void {
  const n = pendingExits.get(site.id) ?? 0
  if (n > 0) pendingExits.set(site.id, n - 1)
}

/**
 * The ref the Babel plugin gives an element with entering or exiting: reports the entering animation
 * when the view mounts and the exiting one when it goes, then passes the view on to the app's ref.
 * Detaching and re-attaching the same view in one commit (a ref that changes every render) is
 * neither. A view goes either by React 19's ref cleanup or by a call with null (what Reanimated's
 * animated components do with the ref they are given).
 */
export function __kfMotionRef(site: MotionSite, prev?: unknown): (instance: unknown) => unknown {
  const cached = motionRefs.get(site.id)
  if (cached && cached.prev === prev) return cached.ref
  const ref = (instance: unknown) => {
    if (!instance || typeof instance !== 'object') {
      if (instance === null) exitLater(site)
      return passRef(prev, instance)
    }
    if (leavingViews.delete(instance) || liveViews.has(instance)) cancelExit(site)
    else {
      const entering = layoutAnims.get(site.id)?.entering
      if (entering != null) reportMotion(site, 'entering', describeLayoutAnimation(entering).animation, describeLayoutAnimation(entering))
    }
    liveViews.add(instance)
    const theirs = passRef(prev, instance)
    return () => {
      liveViews.delete(instance)
      leavingViews.add(instance)
      exitLater(site)
      Promise.resolve().then(() => leavingViews.delete(instance))
      if (typeof theirs === 'function') (theirs as () => void)()
      else passRef(prev, null)
    }
  }
  motionRefs.set(site.id, { prev, ref })
  return ref
}

/**
 * The onLayout the Babel plugin gives an element with a `layout` transition: when a view it saw
 * before moves or resizes, the transition runs, and it is reported. Then the app's onLayout.
 */
export function __kfLayoutMoved(site: MotionSite, prev?: unknown): (e: unknown) => void {
  const cached = layoutMoves.get(site.id)
  if (cached && cached.prev === prev) return cached.fn
  const fn = (e: unknown) => {
    const ev = e as { currentTarget?: unknown; target?: unknown; nativeEvent?: { target?: unknown; layout?: { x: number; y: number; width: number; height: number } } }
    const rect = ev?.nativeEvent?.layout
    const key = ev?.currentTarget ?? ev?.target ?? ev?.nativeEvent?.target
    if (rect && key != null && (globalThis as HookGlobal).__KF_INSPECTOR__ !== undefined) {
      const now = `${rect.x},${rect.y},${rect.width},${rect.height}`
      const before = layoutRects.get(key)
      layoutRects.set(key, now)
      if (layoutRects.size > 2000) layoutRects.delete(layoutRects.keys().next().value)
      const layout = layoutAnims.get(site.id)?.layout
      if (before !== undefined && before !== now && layout != null) {
        const [x, y, width, height] = before.split(',').map(Number)
        reportMotion(site, 'layout', describeLayoutAnimation(layout).animation, { ...describeLayoutAnimation(layout), from: { x, y, width, height }, to: rect })
      }
    }
    if (typeof prev === 'function') (prev as (e: unknown) => void)(e)
  }
  layoutMoves.set(site.id, { prev, fn })
  return fn
}

// ─── Layout ───────────────────────────────────────────────────────────────────────
// Where each animated style's view sits on screen, for overlays that outline what moves. The Babel
// plugin passes `onLayout={__kfLayout(styleId, theirOnLayout)}` to the element that takes the style.

export type ScreenRect = { x: number; y: number; width: number; height: number }
const layouts = (shared.__KF_LAYOUTS__ ??= new Map<string, ScreenRect>())
type LayoutTarget = { measureInWindow?: (cb: (x: number, y: number, w: number, h: number) => void) => void }
// The views themselves, so a position can be measured again. onLayout fires when a view's own layout
// changes, not when it moves on screen: a ScrollView scrolling, a header inset applied after the first
// layout, or a screen transition all move a view without one, and a rect from onLayout alone went stale
// (outlines drawn a header's height above their views).
const layoutTargets = (shared.__KF_LAYOUT_TARGETS__ ??= new Map<string, LayoutTarget>())
// Their shadow nodes (Fabric), for measuring on the UI thread: Reanimated's measure() reads one there,
// synchronously, every frame. Taken from the host instance the way Reanimated's own refs do
// (fabricUtils' getShadowNodeWrapperFromRef). Absent on web and the old architecture.
const layoutNodes = (shared.__KF_LAYOUT_NODES__ ??= new Map<string, unknown>())

/** Start (or stop) recording where animated views are. Off by default: nothing is measured. */
export function watchLayouts(on: boolean): void {
  shared.__KF_LAYOUT_WATCH__ = on
  if (!on) {
    layouts.clear()
    layoutTargets.clear()
    layoutNodes.clear()
  }
}

/** Window rects of the views each animated style is on, by style id. */
export function getLayouts(): ReadonlyMap<string, ScreenRect> {
  return layouts
}

/** The shadow node of the view a style is on, for measure() on the UI thread; undefined without one. */
export function getLayoutNode(styleId: string): unknown {
  return layoutNodes.get(styleId)
}

/**
 * Measure these styles' views again, where they are now. Asynchronous, like measureInWindow: the
 * rects in getLayouts() change when the answers arrive. A view that answers with no size has gone
 * (unmounted, or off the tree), so it is forgotten.
 */
export function remeasureLayouts(styleIds: Iterable<string>): void {
  if (!shared.__KF_LAYOUT_WATCH__) return
  for (const id of styleIds) {
    const target = layoutTargets.get(id)
    target?.measureInWindow?.((x, y, width, height) => {
      if (width || height) layouts.set(id, { x, y, width, height })
      else {
        layouts.delete(id)
        layoutTargets.delete(id)
        layoutNodes.delete(id)
      }
    })
  }
}

type LayoutEventLike = { currentTarget?: unknown; target?: unknown }

export function __kfLayout(styleId: string, prev?: (e: never) => void): (e: LayoutEventLike) => void {
  return (e) => {
    ;(prev as ((e: LayoutEventLike) => void) | undefined)?.(e)
    if (!shared.__KF_LAYOUT_WATCH__) return
    const target = (e?.currentTarget ?? e?.target) as LayoutTarget | undefined
    if (target?.measureInWindow) layoutTargets.set(styleId, target)
    const node = (target as { __internalInstanceHandle?: { stateNode?: { node?: unknown } } } | undefined)?.__internalInstanceHandle?.stateNode?.node
    if (node) layoutNodes.set(styleId, node)
    target?.measureInWindow?.((x, y, width, height) => {
      if (width || height) layouts.set(styleId, { x, y, width, height })
    })
  }
}

export type InspectorOptions = {
  send: (event: InspectorEvent) => void
  now?: () => number
}

/** A JS-thread inspector: reports every animation and signal and applies live overrides. */
export function createInspector({ send: deliver, now = () => Date.now() }: InspectorOptions) {
  const send = (event: InspectorEvent) => {
    deliver(event)
    for (const tap of taps) tap(event)
  }
  let overrides: InspectorOverrides = {}
  let nextEid = 1
  // Animation objects this inspector has seen returned, so an outer call (withDelay(142, withTiming(…)))
  // can report its inner one by id instead of as an opaque object. Arguments run first, so the inner
  // call is always numbered before the outer one.
  const animIds = new WeakMap<object, number>()
  // On the JS thread of a native app Reanimated hands back the animation as a factory FUNCTION
  // (defineAnimation's `create`), on web as an object: both have to be remembered and recognised.
  const isRef = (v: unknown): v is object => (typeof v === 'object' && v !== null) || typeof v === 'function'
  const seenSignals = new WeakMap<object, string>()
  const seenStyles = new Set<string>()
  const seenHints = new Set<string>()
  const seenWorklets = new Set<string>()
  // Shared values by call site id, for recording and playing back gestures, sensors and scroll.
  const signals = new Map<string, { value: unknown }>()
  const hook: InspectorHook = {
    anim(fn, site, args) {
      const next = applyOverrides(args, overrides[site.id])
      const eid = nextEid++
      const reported = next.map((a) => (isRef(a) && animIds.has(a) ? { $anim: animIds.get(a)! } : a))
      send({ kind: 'anim', eid, site, at: now(), args: reported, thread: 'js' })
      if (site.prop) hintAnimationSite(site)
      const result = fn(...next)
      if (isRef(result)) animIds.set(result, eid)
      return result
    },
    hint(h) {
      const key = `${h.id}:${h.hint}`
      if (seenHints.has(key)) return
      seenHints.add(key)
      send({ kind: 'renderHint', ...h })
    },
    worklet(issue) {
      if (seenWorklets.has(issue.id)) return
      seenWorklets.add(issue.id)
      send({ kind: 'workletIssue', ...issue })
    },
    style(site) {
      if (seenStyles.has(site.id)) return
      seenStyles.add(site.id)
      send({ kind: 'style', site })
    },
    unsignal(id) {
      signals.delete(id)
      send({ kind: 'unsignal', id })
    },
    signal(sv, site) {
      if (sv && typeof sv === 'object' && 'value' in (sv as object)) signals.set(site.id, sv as { value: unknown })
      // Called on every render; report each shared value once per call site.
      if (sv && typeof sv === 'object') {
        if (seenSignals.get(sv) === site.id) return
        seenSignals.set(sv, site.id)
      }
      send({ kind: 'signal', site })
    },
  }
  return {
    hook,
    /** The live override table (the UI-thread hook gets a copy of it). */
    getOverrides: () => overrides,
    setOverrides(next: InspectorOverrides) {
      overrides = next
    },
    /** Shared values seen so far, by call site id. */
    signals: signals as ReadonlyMap<string, { value: unknown }>,
    /**
     * Report an animation that already ran elsewhere (the UI thread applies overrides itself and only
     * forwards what happened). Nested animations cannot be matched across threads, so their args go
     * as they are.
     */
    report(site: InspectorCallSite, args: unknown[]) {
      send({ kind: 'anim', eid: nextEid++, site, at: now(), args, thread: 'ui' })
      if (site.prop) hintAnimationSite(site)
    },
    install() {
      ;(globalThis as HookGlobal).__KF_INSPECTOR__ = hook
      // What rendered before this inspector was installed.
      const { signals: sv, styles, hints, worklets } = seen()
      for (const { sv: v, site } of sv.values()) hook.signal(v, site)
      for (const site of styles.values()) hook.style(site)
      for (const h of hints.values()) hook.hint!(h)
      for (const w of worklets.values()) hook.worklet!(w)
      // A worklet crash the plugin did not see coming: placed and reported before the red box.
      const unwatch = watchWorkletCrashes((issue) => hook.worklet!(issue), knownWorklets)
      return () => {
        unwatch()
        if ((globalThis as HookGlobal).__KF_INSPECTOR__ === hook) delete (globalThis as HookGlobal).__KF_INSPECTOR__
      }
    },
  }
}
