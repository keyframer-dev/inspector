/** Stacks for the trace: where an animation was called, or a timer scheduled. */

const MAX_STACK_CHARS = 4000

/**
 * The JS stack where an animation was called, raw (bundle URLs and lines; the reader symbolicates it
 * through Metro). Asks for more frames than the default 10: the inspector's own come first.
 */
export function captureStack(): string | undefined {
  const E = Error as { stackTraceLimit?: number }
  const limit = E.stackTraceLimit
  try {
    E.stackTraceLimit = 40
    return new Error().stack?.slice(0, MAX_STACK_CHARS)
  } catch {
    return undefined
  } finally {
    E.stackTraceLimit = limit
  }
}

