// Pure, no React or Reanimated: the CLI and the trace read recordings with it, outside any app.

/** Recorded offsets are samples named `<scroll id>:x` and `<scroll id>:y`. */
export const isScrollSample = (id: string) => id.startsWith('scroll:') && (id.endsWith(':x') || id.endsWith(':y'))
