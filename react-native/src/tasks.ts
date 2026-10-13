/**
 * JS tasks while recording: the app code that ran on the JS thread long enough to matter, so a long
 * JS frame can be traced to what ran in it.
 *
 *   - event handlers and effects the Babel plugin wrapped (runtime.ts __kfHandler / __kfEffect)
 *     report themselves through `__KF_TASKS__`, with where they are written;
 *   - timer callbacks (setTimeout, setInterval, requestAnimationFrame) are timed by wrapping the
 *     globals while something listens, and carry the stack that scheduled them.
 *
 * Only tasks of at least `minMs` are kept. Pure JS (the globals are passed in for tests), shared by a
 * live recording (client.ts) and one made on the device (recorder.ts).
 */

import type { InspectorTask } from '../../protocol/inspector'
import { captureStack } from './stack'
import { __kfNow } from './runtime'

/** A task as it ended: `end` on the wall clock (Date.now), the same on every thread. */
export type TaskReport = Omit<InspectorTask, 't'> & { end: number }

type Timers = {
  setTimeout: (cb: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => unknown
  setInterval: (cb: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => unknown
  requestAnimationFrame?: (cb: (t: number) => void) => unknown
}
type TasksGlobal = Timers & { __KF_TASKS__?: (kind: InspectorTask['kind'], name: string, site: string | null, component: string | null, ms: number) => void }

const listeners = new Set<(t: TaskReport) => void>()
let minMs = 4
let restore: (() => void) | null = null

const emit = (t: TaskReport) => {
  for (const l of listeners) l(t)
}

function install(g: TasksGlobal) {
  g.__KF_TASKS__ = (kind, name, site, component, ms) => {
    if (ms >= minMs) emit({ kind, name, site, component, ms: Math.round(ms * 10) / 10, end: Date.now() })
  }
  const original = { setTimeout: g.setTimeout, setInterval: g.setInterval, requestAnimationFrame: g.requestAnimationFrame }
  // The stack that scheduled a callback, taken once per callback function (a requestAnimationFrame
  // loop passes the same one every frame).
  const stacks = new WeakMap<object, string | undefined>()
  const wrap = <A extends unknown[]>(name: string, cb: (...a: A) => void): ((...a: A) => void) => {
    if (typeof cb !== 'function') return cb
    let stack = stacks.get(cb)
    if (!stacks.has(cb)) {
      stack = captureStack()
      stacks.set(cb, stack)
    }
    return (...a: A) => {
      const t0 = __kfNow()
      try {
        cb(...a)
      } finally {
        const ms = __kfNow() - t0
        if (ms >= minMs) emit({ kind: 'timer', name, site: null, component: null, ms: Math.round(ms * 10) / 10, end: Date.now(), ...(stack ? { stack } : {}) })
      }
    }
  }
  g.setTimeout = ((cb: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => original.setTimeout(wrap('setTimeout', cb), ms, ...args)) as Timers['setTimeout']
  g.setInterval = ((cb: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => original.setInterval(wrap('setInterval', cb), ms, ...args)) as Timers['setInterval']
  if (original.requestAnimationFrame) {
    const raf = original.requestAnimationFrame
    g.requestAnimationFrame = ((cb: (t: number) => void) => raf(wrap('requestAnimationFrame', cb))) as Timers['requestAnimationFrame']
  }
  return () => {
    delete g.__KF_TASKS__
    g.setTimeout = original.setTimeout
    g.setInterval = original.setInterval
    if (original.requestAnimationFrame) g.requestAnimationFrame = original.requestAnimationFrame
  }
}

/** Calls `onTask` for every JS task of at least `min` ms until the returned function is called. */
export function watchTasks(onTask: (t: TaskReport) => void, opts: { min?: number; global?: object } = {}): () => void {
  listeners.add(onTask)
  if (opts.min !== undefined) minMs = opts.min
  if (listeners.size === 1) restore = install((opts.global ?? globalThis) as TasksGlobal)
  return () => {
    if (!listeners.delete(onTask)) return
    if (listeners.size === 0) {
      restore?.()
      restore = null
    }
  }
}
