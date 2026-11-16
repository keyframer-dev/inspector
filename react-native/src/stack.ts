/** Stacks for the trace: where an animation was called, or a timer scheduled. */

import { enterInspector, leaveInspector } from './ownTime'

const taken = new WeakMap<object, string | undefined>()

/**
 * The stack of one reported event, taken once however many listeners want it (a live recording and the
 * device recorder both keep it): reading `.stack` formats every frame, on the JS thread, at the start
 * of the animation. Both ask synchronously from the instrumented call, so the stack is the same.
 */
export function stackOf(event: object): string | undefined {
  if (!taken.has(event)) taken.set(event, captureStack())
  return taken.get(event)
}

const MAX_STACK_CHARS = 4000

/**
 * The JS stack where an animation was called, raw (bundle URLs and lines; the reader symbolicates it
 * through Metro). Asks for more frames than the default 10: the inspector's own come first. Taking it
 * is the inspector's own work (ownTime.ts).
 */
export function captureStack(): string | undefined {
  const E = Error as { stackTraceLimit?: number }
  const limit = E.stackTraceLimit
  enterInspector()
  try {
    E.stackTraceLimit = 40
    return new Error().stack?.slice(0, MAX_STACK_CHARS)
  } catch {
    return undefined
  } finally {
    E.stackTraceLimit = limit
    leaveInspector()
  }
}

