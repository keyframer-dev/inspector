/**
 * The JS runtime's hook: what `__kfvAnim` and the layout and scroll helpers call into once startVitals
 * installed it. Runs the app's call first (its result is what the app gets, whatever happens here),
 * then notes the start with the arguments slimmed to timing numbers.
 */

import type { VitalsController } from './controller'
import { slimArg } from './estimate'
import type { VitalsHook } from './runtime'

export function createJsHook(controller: VitalsController, onMotion?: () => void): VitalsHook {
  // Animation objects seen returned, so an outer call (withDelay(…, withTiming(…))) names its inner one by id.
  const ids = new WeakMap<object, number>()
  const isObj = (r: unknown): r is object => (typeof r === 'object' && r !== null) || typeof r === 'function'
  return {
    anim(fn, site, args, via, viaSite) {
      const r = via ? via(fn, viaSite, ...args) : fn(...args)
      try {
        const eid = controller.eid()
        const slim = args.map((a) => slimArg(a, (x) => ids.get(x)))
        if (isObj(r)) ids.set(r, eid)
        controller.anim(site, slim, eid, 'js')
        onMotion?.()
      } catch {
        // Never let measuring break the app.
      }
      return r
    },
    scroll() {
      controller.scroll()
    },
    layout(site, kind, builder) {
      controller.layout(site, kind, builder)
    },
  }
}
