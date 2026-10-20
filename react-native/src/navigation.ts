/**
 * Takes a React Navigation container back to a screen, for playback and capture (record.ts
 * trackNavigation): to the copy already in a stack when there is one, never a new copy on top.
 *
 * React Navigation 7, and the copy of it expo-router bundles, changed `navigate`: it reuses only the
 * CURRENT route and pushes a new copy of any other, unless asked to `pop` back to it. React
 * Navigation 6 always went back to an existing route and ignores what 7 added. So the action is
 * NAVIGATE with `pop: true`, sent to the navigator that has the screen (`target`, which both
 * versions honour): the one with a copy of it in its state (the focused branch first), else the
 * deepest focused one that can show it. A container's own `navigate` only reaches the focused
 * navigator and the ones above it, and a screen's name alone is ambiguous (every expo-router folder
 * has an `index`).
 */

/** The parts of a navigation state this reads: `getRootState()` of a container. */
export type NavState = {
  key?: string
  index?: number
  routeNames?: string[]
  routes: Array<{ key?: string; name: string; state?: NavState }>
}

/** A container ref (React Navigation 6 or 7, expo-router's useNavigationContainerRef). */
export type NavContainer = {
  getRootState?(): NavState | undefined
  dispatch?(action: { type: string; payload?: object; target?: string }): void
  navigate?(name: string, params?: object, options?: { pop?: boolean }): void
}

/** The key of the navigator to send `name` to, or null when no navigator in `root` knows it. */
export function navigatorFor(root: NavState | undefined, name: string): string | null {
  type Found = { key: string; focused: boolean; depth: number }
  const withCopy: Found[] = []
  const canShow: Found[] = []
  const visit = (s: NavState, focused: boolean, depth: number) => {
    if (s.key) {
      if (s.routes.some((r) => r.name === name)) withCopy.push({ key: s.key, focused, depth })
      else if (s.routeNames?.includes(name)) canShow.push({ key: s.key, focused, depth })
    }
    const at = s.index ?? s.routes.length - 1
    s.routes.forEach((r, i) => r.state && visit(r.state, focused && i === at, depth + 1))
  }
  if (root?.routes) visit(root, true, 0)
  const best = (xs: Found[]) => {
    const deepest = (a: Found, b: Found) => b.depth - a.depth
    return xs.filter((f) => f.focused).sort(deepest)[0] ?? xs.slice().sort(deepest)[0]
  }
  return (best(withCopy) ?? best(canShow))?.key ?? null
}

/** Goes to `route`: back to its copy when one is open, else on top of the navigator that shows it. */
export function goBackTo(ref: NavContainer, route: string, params?: Record<string, unknown>): void {
  let target: string | null = null
  try {
    target = navigatorFor(ref.getRootState?.(), route)
  } catch {
    // Not ready yet: the container's own navigate below.
  }
  if (target && ref.dispatch) ref.dispatch({ type: 'NAVIGATE', payload: { name: route, params, pop: true }, target })
  else ref.navigate?.(route, params, { pop: true })
}
