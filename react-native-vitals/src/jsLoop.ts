// The JS-thread frame loop: one requestAnimationFrame chain while a motion window is open.
//
// Each start gets its own generation. stop() cannot cancel a callback that is already scheduled, so
// without the generation a stop followed by a start before that callback ran left two chains alive,
// and every quick stop and start added one more: frames were counted many times over.
//
// A tick is a display frame only when it comes at a display's pace. On iOS, React Native drives JS
// timers from the display link, and on UIApplicationWillResignActive (app switcher, home swipe,
// Control Center, a call) it stops the link and fires them from a plain NSTimer: a zero-delay
// requestAnimationFrame then runs again at once, tens of thousands of times a second (RCTTiming.mm).
// 0.1.1 and 0.1.2 counted those ticks as frames and the server refused the reports. A tick sooner than
// MIN_FRAME_GAP_MS after the last frame is not counted, and the loop waits on `later` instead of
// spinning; the controller stops the loop itself once AppState says inactive.

/** The shortest gap between two display frames: 240 Hz, the server's limit (VITALS_MAX_HZ). */
export const MIN_FRAME_GAP_MS = 1000 / 240

export type JsLoopDeps = {
  raf: (cb: () => void) => unknown
  /** Waits about a frame without the display (setTimeout): used when requestAnimationFrame stops waiting for it. */
  later: (cb: () => void) => unknown
  now: () => number
  /** One frame that ended at `t`: return false to end the loop (the motion window closed). */
  frame: (t: number) => boolean
}

export function createJsLoop({ raf, later, now, frame }: JsLoopDeps) {
  let running = false
  let gen = 0
  let last = -1
  const chain = (mine: number) => {
    const tick = () => {
      if (!running || mine !== gen) return
      const t = now()
      if (last >= 0 && t - last < MIN_FRAME_GAP_MS) {
        later(tick)
        return
      }
      last = t
      if (frame(t)) raf(tick)
      else running = false
    }
    return tick
  }
  return {
    get running() {
      return running
    },
    /** Starts the loop unless it is already running. Returns true when it started a new chain. */
    start(): boolean {
      if (running) return false
      running = true
      gen++
      last = -1
      raf(chain(gen))
      return true
    },
    stop(): void {
      running = false
      gen++
    },
  }
}
