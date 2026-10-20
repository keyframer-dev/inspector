/**
 * Scenarios: named interactions an app registers so a tool can reproduce them on demand (an agent
 * checking a fix, the panel re-running what a tester did). A scenario navigates, presses, scrolls,
 * whatever the app's own code does; it resolves when done.
 *
 *   registerScenario('feed: scroll with slow rows', async () => {
 *     router.navigate('/feed')
 *     await feedBus.scrollToEnd()
 *   })
 *
 * On globalThis: one registry however the modules were loaded.
 */

type Scenario = { name: string; run: () => unknown }
type ScenarioState = { scenarios: Map<string, Scenario>; listeners: Set<(names: string[]) => void> }
const g = globalThis as { __KF_SCENARIOS__?: ScenarioState }
const state = (g.__KF_SCENARIOS__ ??= { scenarios: new Map(), listeners: new Set() })

const notify = () => {
  const names = scenarioNames()
  for (const l of state.listeners) l(names)
}

/** Registers a scenario under a name (replacing one of the same name). Returns the unregister. */
export function registerScenario(name: string, run: () => unknown): () => void {
  const entry = { name, run }
  state.scenarios.set(name, entry)
  notify()
  return () => {
    if (state.scenarios.get(name) === entry) {
      state.scenarios.delete(name)
      notify()
    }
  }
}

export function scenarioNames(): string[] {
  return [...state.scenarios.keys()]
}

/** Calls `fn` with the names whenever the registry changes. Returns the unsubscribe. */
export function watchScenarios(fn: (names: string[]) => void): () => void {
  state.listeners.add(fn)
  return () => {
    state.listeners.delete(fn)
  }
}

/** Runs one: resolves with how long it took, or why it failed. */
export async function runScenario(name: string, now: () => number = () => Date.now()): Promise<{ ms: number; error?: string }> {
  const s = state.scenarios.get(name)
  const t0 = now()
  if (!s) return { ms: 0, error: `No scenario named "${name}". Registered: ${scenarioNames().join(', ') || 'none'}.` }
  try {
    await s.run()
    return { ms: Math.round(now() - t0) }
  } catch (e) {
    return { ms: Math.round(now() - t0), error: e instanceof Error ? e.message : String(e) }
  }
}

// ─── Driving the app from a scenario ──────────────────────────────────────────────
// Find an element by its testID in React's tree (through the DevTools hook development builds have)
// and call its handlers, the way a person's press would: the same onPress the app wrote runs, so the
// inspector times it like a real one.

type Fiber = { memoizedProps?: Record<string, unknown> | null; child: Fiber | null; sibling: Fiber | null }
type DevToolsHook = { renderers?: Map<number, unknown>; getFiberRoots?: (id: number) => Set<{ current: Fiber }> }

/** The props of the first element with this testID that has `prop` (onPress by default; null: any), or null. */
export function findByTestId(testID: string, prop: string | null = 'onPress', hook?: DevToolsHook): Record<string, unknown> | null {
  const h = hook ?? (globalThis as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: DevToolsHook }).__REACT_DEVTOOLS_GLOBAL_HOOK__
  if (!h?.renderers || !h.getFiberRoots) return null
  for (const id of h.renderers.keys()) {
    for (const root of h.getFiberRoots(id)) {
      const stack: Fiber[] = [root.current]
      while (stack.length) {
        const f = stack.pop()!
        const props = f.memoizedProps
        if (props && props.testID === testID && (prop === null || typeof props[prop] === 'function')) return props
        if (f.sibling) stack.push(f.sibling)
        if (f.child) stack.push(f.child)
      }
    }
  }
  return null
}

const fakeEvent = () => ({ nativeEvent: { timestamp: Date.now(), pageX: 0, pageY: 0, locationX: 0, locationY: 0 }, persist() {}, preventDefault() {}, stopPropagation() {} })

/** Calls a handler prop of the element with this testID. Throws when there is none. */
export function fire(testID: string, prop: string, ...args: unknown[]): unknown {
  const props = findByTestId(testID, prop)
  if (!props) throw new Error(`No element with testID "${testID}" and ${prop}`)
  return (props[prop] as (...a: unknown[]) => unknown)(...(args.length ? args : [fakeEvent()]))
}

/** Presses the element with this testID: onPressIn, onPress, onPressOut, like a quick tap. */
export function press(testID: string): void {
  const props = findByTestId(testID, 'onPress') ?? findByTestId(testID, 'onPressIn')
  if (!props) throw new Error(`No pressable element with testID "${testID}"`)
  const e = fakeEvent()
  for (const p of ['onPressIn', 'onPress', 'onPressOut']) (props[p] as ((e: unknown) => void) | undefined)?.(e)
}

/** Resolves once an element with this testID (and `prop`) is on screen: after navigating to it. */
export async function waitForTestId(testID: string, opts: { prop?: string | null; timeoutMs?: number } = {}): Promise<void> {
  const end = Date.now() + (opts.timeoutMs ?? 4000)
  while (!findByTestId(testID, opts.prop === undefined ? 'onPress' : opts.prop)) {
    if (Date.now() > end) throw new Error(`"${testID}" did not appear within ${opts.timeoutMs ?? 4000} ms`)
    await new Promise<void>((r) => setTimeout(r, 50))
  }
}
