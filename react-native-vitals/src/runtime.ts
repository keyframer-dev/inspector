/**
 * What the Babel plugin's rewritten calls run into (`@keyframerdev/vitals/babel`). Until `startVitals`
 * installs a hook, and after `setVitalsEnabled(false)`, each one is a straight pass-through: one global
 * read, then the original call, so an instrumented app behaves exactly like the original.
 *
 * `__kfvAnim` and `__kfvScroll` are worklets: animation calls are often made inside gesture callbacks,
 * reactions and scroll handlers, which run on the UI runtime, where the hook is a second one installed
 * there (native.ts). Nothing here reads an argument's value: the hook keeps only what an animation's
 * length is estimated from.
 */

import type { SiteInfo } from './collector'

type AnimFn = (...args: unknown[]) => unknown

export type VitalsHook = {
  /** Runs the animation call (through `via`, the inspector's `__kfAnim`, when both plugins ran) and notes its start. */
  anim(fn: AnimFn, site: SiteInfo, args: unknown[], via: AnimFn | null, viaSite: unknown): unknown
  scroll(): void
  /** JS runtime only: a layout animation (entering, exiting, layout) started. */
  layout?(site: SiteInfo, kind: LayoutKind, builder: unknown): void
}

export type LayoutKind = 'entering' | 'exiting' | 'layout'

type HookGlobal = { __KF_VITALS__?: VitalsHook | null }

/** `withSpring(1, cfg)` → `__kfvAnim(withSpring, site, 1, cfg)`. */
export function __kfvAnim(fn: AnimFn, site: SiteInfo, ...args: unknown[]): unknown {
  'worklet'
  const hook = (globalThis as HookGlobal).__KF_VITALS__
  if (hook === undefined || hook === null) return fn(...args)
  return hook.anim(fn, site, args, null, null)
}

/**
 * The same, for a call the inspector's development plugin wrapped first:
 * `__kfAnim(withSpring, isite, 1, cfg)` → `__kfvAnimVia(__kfAnim, site, withSpring, isite, 1, cfg)`.
 */
export function __kfvAnimVia(via: AnimFn, site: SiteInfo, fn: AnimFn, viaSite: unknown, ...args: unknown[]): unknown {
  'worklet'
  const hook = (globalThis as HookGlobal).__KF_VITALS__
  if (hook === undefined || hook === null) return via(fn, viaSite, ...args)
  return hook.anim(fn, site, args, via, viaSite)
}

/** First statement of every useAnimatedScrollHandler worklet: a scroll keeps the meters running. */
export function __kfvScroll(): void {
  'worklet'
  const hook = (globalThis as HookGlobal).__KF_VITALS__
  if (hook !== undefined && hook !== null) hook.scroll()
}

const scrollWrappers = new WeakMap<object, unknown>()

/** A plain JS `onScroll` handler: same, then the app's handler. Anything that is not a function goes through untouched. */
export function __kfvScrollJs<F>(fn: F): F {
  if (typeof fn !== 'function') return fn
  const cached = scrollWrappers.get(fn)
  if (cached) return cached as F
  const wrapped = function (this: unknown, ...args: unknown[]) {
    const hook = (globalThis as HookGlobal).__KF_VITALS__
    if (hook) hook.scroll()
    return (fn as unknown as AnimFn).apply(this, args)
  }
  scrollWrappers.set(fn, wrapped)
  return wrapped as unknown as F
}

// ─── Layout animations ────────────────────────────────────────────────────────────
// entering / exiting / layout props: the builder is remembered per call site when the element renders,
// and its animation starts when the view mounts (entering), goes (exiting) or moves (layout).

type Builders = Partial<Record<LayoutKind, unknown>>
type Shared = {
  __KFV_BUILDERS__?: Map<string, Builders>
  __KFV_REFS__?: Map<string, { prev: unknown; ref: (instance: unknown) => unknown }>
  __KFV_MOVES__?: Map<string, { prev: unknown; fn: (e: unknown) => void }>
}
// On globalThis because Metro can load this module twice (the CommonJS and ESM builds).
const g = globalThis as Shared
const builders = (g.__KFV_BUILDERS__ ??= new Map())
const refs = (g.__KFV_REFS__ ??= new Map())
const moves = (g.__KFV_MOVES__ ??= new Map())
const liveViews = new WeakSet<object>()
const pendingExits = new Map<string, number>()
/** Views (instances or tags) laid out once already. Capped: a long list mounts many. */
const laidOut = new Set<unknown>()

const idOf = (site: SiteInfo) => site.key ?? JSON.stringify(site.ref)
const jsHook = () => (globalThis as HookGlobal).__KF_VITALS__ ?? null

/** An entering / exiting / layout prop: returned as it is, remembered for its element. */
export function __kfvLayout<B>(builder: B, kind: LayoutKind, site: SiteInfo): B {
  if (builder == null) return builder
  const id = idOf(site)
  let byKind = builders.get(id)
  if (!byKind) builders.set(id, (byKind = {}))
  byKind[kind] = builder
  return builder
}

function startLayout(site: SiteInfo, kind: LayoutKind): void {
  const hook = jsHook()
  const builder = builders.get(idOf(site))?.[kind]
  if (hook?.layout && builder != null) hook.layout(site, kind, builder)
}

function passRef(prev: unknown, instance: unknown): unknown {
  if (typeof prev === 'function') return (prev as (i: unknown) => unknown)(instance)
  if (prev && typeof prev === 'object' && 'current' in prev) (prev as { current: unknown }).current = instance
  return undefined
}

/** A view of this element went: its exiting animation starts after the commit, unless it came back in it. */
function exitLater(id: string, exiting: SiteInfo | null): void {
  const n = (pendingExits.get(id) ?? 0) + 1
  pendingExits.set(id, n)
  if (n > 1) return
  Promise.resolve().then(() => {
    const k = pendingExits.get(id) ?? 0
    pendingExits.delete(id)
    if (exiting) for (let i = 0; i < k; i++) startLayout(exiting, 'exiting')
  })
}

/**
 * The ref of an element with `entering` or `exiting`: the entering animation starts when a new view
 * mounts, the exiting one when a view goes; detaching and re-attaching the same view in one commit (a
 * ref that changes every render) is neither. The app's own ref gets the view as before.
 */
export function __kfvMotionRef(entering: SiteInfo | null, exiting: SiteInfo | null, prev?: unknown): (instance: unknown) => unknown {
  const id = `${entering ? idOf(entering) : ''}|${exiting ? idOf(exiting) : ''}`
  const cached = refs.get(id)
  if (cached && cached.prev === prev) return cached.ref
  const ref = (instance: unknown) => {
    if (!instance || typeof instance !== 'object') {
      if (instance === null) exitLater(id, exiting)
      return passRef(prev, instance)
    }
    if (liveViews.has(instance)) {
      const n = pendingExits.get(id) ?? 0
      if (n > 0) pendingExits.set(id, n - 1)
    } else {
      liveViews.add(instance)
      if (entering) startLayout(entering, 'entering')
    }
    const theirs = passRef(prev, instance)
    // React 19 calls a returned cleanup instead of the ref with null.
    return () => {
      exitLater(id, exiting)
      if (typeof theirs === 'function') (theirs as () => void)()
      else passRef(prev, null)
    }
  }
  refs.set(id, { prev, ref })
  return ref
}

/** The onLayout of an element with `layout`: every layout after a view's first is a layout animation. */
export function __kfvLayoutMoved(site: SiteInfo, prev?: unknown): (e: unknown) => void {
  const id = idOf(site)
  const cached = moves.get(id)
  if (cached && cached.prev === prev) return cached.fn
  const fn = (e: unknown) => {
    const ev = e as { target?: unknown; nativeEvent?: { target?: unknown } } | null
    const target = ev?.target ?? ev?.nativeEvent?.target
    if (target != null) {
      if (!laidOut.has(target)) {
        if (laidOut.size > 1000) laidOut.clear()
        laidOut.add(target)
      } else startLayout(site, 'layout')
    }
    if (typeof prev === 'function') (prev as (e: unknown) => void)(e)
  }
  moves.set(id, { prev, fn })
  return fn
}
