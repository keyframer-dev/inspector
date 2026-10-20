/**
 * The app's navigation container, for code outside components (the scenarios): set by the root layout.
 */
type NavState = { index?: number; routes: Array<{ name: string; state?: NavState }> }
type Container = { getRootState?: () => NavState | undefined }

let container: Container | null = null

export function setNavigation(ref: Container | null): void {
  container = ref
}

/** The screen at the bottom of the stack the app is in, or null while the navigator is not ready. */
export function bottomScreen(): string | null {
  try {
    let s = container?.getRootState?.()
    // expo-router nests the app's stack in its own root: go down the focused branch to it.
    while (s) {
      const focused = s.routes[s.index ?? s.routes.length - 1]
      if (!focused?.state) return s.routes[0]?.name ?? null
      s = focused.state
    }
    return null
  } catch {
    return null
  }
}
