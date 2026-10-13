/**
 * React commits while recording, read from the React DevTools global hook that development builds of
 * React Native install: when each one finished, how long it rendered and which components rendered
 * the most. A JS frame drop next to a 40 ms commit of `ProductList` says what kept the thread busy.
 *
 * Only on while something records, and every step is guarded: a React that does not time renders
 * (no profiler timer) still reports which components rendered, with 0 ms.
 */

import type { InspectorCommit, InspectorCommitComponent } from '../../protocol/inspector'
import { appComponentFile } from './runtime'

/** The parts of a React fiber this reads. */
type Hook = { memoizedState: unknown; queue: unknown; next: Hook | null }
type Fiber = {
  tag: number
  type: unknown
  flags?: number
  child: Fiber | null
  sibling: Fiber | null
  return?: Fiber | null
  alternate: Fiber | null
  actualDuration?: number
  selfBaseDuration?: number
  memoizedProps?: Record<string, unknown> | null
  memoizedState?: unknown
}
type DevToolsHook = { onCommitFiberRoot?: (id: unknown, root: { current?: Fiber }, ...rest: unknown[]) => unknown }

// Function, class, forwardRef, memo and simple memo components: what a person wrote.
const COMPONENT_TAGS = new Set([0, 1, 11, 14, 15])
const FUNCTION_TAGS = new Set([0, 11, 15])
const PERFORMED_WORK = 1
const MAX_FIBERS = 8000
const TOP = 6

function nameOf(type: unknown): string | null {
  if (!type) return null
  if (typeof type === 'function') {
    const f = type as { displayName?: string; name?: string }
    return f.displayName || f.name || null
  }
  if (typeof type === 'object') {
    const o = type as { displayName?: string; type?: unknown; render?: unknown }
    return o.displayName || nameOf(o.type) || nameOf(o.render)
  }
  return null
}

/** Why an app component rendered again: changed props, its own state, or its parent re-rendering it with equal props. */
function whyRendered(f: Fiber): string[] {
  const prev = f.alternate
  if (!prev) return ['mount']
  const why: string[] = []
  const a = prev.memoizedProps ?? {}
  const b = f.memoizedProps ?? {}
  const changed = Object.keys({ ...a, ...b }).filter((k) => k !== 'children' && a[k] !== b[k])
  if (changed.length) why.push(`props: ${changed.slice(0, 4).join(', ')}`)
  if (FUNCTION_TAGS.has(f.tag)) {
    // useState / useReducer hooks have a queue; their memoizedState is the state.
    let h = f.memoizedState as Hook | null
    let g = prev.memoizedState as Hook | null
    for (let i = 0; h && g && i < 100; i++, h = h.next, g = g.next) {
      if (h.queue !== null && h.memoizedState !== g.memoizedState) {
        why.push('state')
        break
      }
    }
  } else if (f.tag === 1 && f.memoizedState !== prev.memoizedState) why.push('state')
  if (!why.length) why.push(prev.memoizedProps === f.memoizedProps ? 'context' : 'parent')
  return why
}

type Totals = { ms: number; count: number; file?: string; why: Map<string, number> }

/**
 * The components that rendered in this commit, slowest first. A library component's time (View,
 * Text, a navigator) goes to the nearest component the app wrote above it (the Babel plugin lists
 * them, appComponentFile), so the names are ones to fix; each app component says why it rendered.
 * Subtrees React reused are skipped.
 */
export function renderedComponents(root: Fiber, appFile: (name: string) => string | undefined = appComponentFile): InspectorCommitComponent[] {
  const totals = new Map<string, Totals>()
  const owners = new Map<Fiber, string | null>()
  const ownerOf = (f: Fiber): string | null => {
    const seen: Fiber[] = []
    let found: string | null = null
    for (let p: Fiber | null | undefined = f; p; p = p.return) {
      const cached = owners.get(p)
      if (cached !== undefined) {
        found = cached
        break
      }
      seen.push(p)
      if (COMPONENT_TAGS.has(p.tag)) {
        const n = nameOf(p.type)
        if (n && appFile(n)) {
          found = n
          break
        }
      }
    }
    for (const s of seen) owners.set(s, found)
    return found
  }
  // Expo Router names screens "Feed(./feed.tsx)": the name the app wrote is enough.
  const clean = (n: string) => (appFile(n) ? n.replace(/\(.*\)$/, '') : n)
  const total = (raw: string): Totals => {
    const name = clean(raw)
    let t = totals.get(name)
    if (!t) totals.set(name, (t = { ms: 0, count: 0, file: appFile(name), why: new Map() }))
    return t
  }
  const stack: Fiber[] = [root]
  let visited = 0
  while (stack.length && visited < MAX_FIBERS) {
    const f = stack.pop()!
    visited++
    if ((f.flags ?? 0) & PERFORMED_WORK) {
      const own = COMPONENT_TAGS.has(f.tag) ? nameOf(f.type) : null
      const isApp = !!own && !!appFile(own)
      const owner = isApp ? own : ownerOf(f)
      const name = owner ?? (COMPONENT_TAGS.has(f.tag) ? own : null)
      if (name) {
        const t = total(name)
        t.ms += f.selfBaseDuration ?? 0
        if (isApp) {
          t.count++
          for (const w of whyRendered(f)) t.why.set(w, (t.why.get(w) ?? 0) + 1)
        } else if (!owner && own) t.count++
      }
    }
    if (f.sibling) stack.push(f.sibling)
    // A child list shared with the previous tree was not rendered again.
    if (f.child && !(f.alternate && f.alternate.child === f.child)) stack.push(f.child)
  }
  return [...totals]
    .filter(([, t]) => t.count > 0 || t.ms > 0)
    .map(([name, t]) => ({
      name,
      ms: Math.round(t.ms * 10) / 10,
      ...(t.file ? { file: t.file } : {}),
      ...(t.count ? { count: t.count } : {}),
      ...(t.why.size ? { why: [...t.why].sort((a, b) => b[1] - a[1]).map(([w, n]) => (n > 1 ? `${w} (${n})` : w)) } : {}),
    }))
    .sort((a, b) => Number(!!b.file) - Number(!!a.file) || b.ms - a.ms)
    .slice(0, TOP)
}

/**
 * Calls `onCommit` after every React commit until the returned function is called. `now` is the
 * recording's clock. Does nothing when there is no DevTools hook (a release build).
 */
export function watchCommits(onCommit: (commit: InspectorCommit) => void, now: () => number, hook?: DevToolsHook): () => void {
  const h = hook ?? (globalThis as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: DevToolsHook }).__REACT_DEVTOOLS_GLOBAL_HOOK__
  if (!h || typeof h.onCommitFiberRoot !== 'function') return () => {}
  const prev = h.onCommitFiberRoot
  const wrapped: NonNullable<DevToolsHook['onCommitFiberRoot']> = function (this: unknown, id, root, ...rest) {
    try {
      const current = root?.current
      if (current) {
        const components = renderedComponents(current)
        const ms = Math.round((current.actualDuration ?? 0) * 10) / 10
        if (components.length || ms > 0) onCommit({ t: Math.round(now()), ms, components })
      }
    } catch {
      // A React whose fibers look different: skip this commit rather than break the app's.
    }
    return prev.call(this, id, root, ...rest)
  }
  h.onCommitFiberRoot = wrapped
  return () => {
    if (h.onCommitFiberRoot === wrapped) h.onCommitFiberRoot = prev
  }
}
