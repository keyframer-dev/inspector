/**
 * The app side of motion tracking (tracking.ts): one MotionTracking per app, fed while anyone holds it
 * (Motion Scan, a connection with an editor in the room). It listens to the inspector's events
 * (animation starts), touches and JS scrolls (what counts as scrolling), and reads the runtime's
 * registries when asked for a summary (what is mounted, on which screen, slot claims and frees).
 *
 * UI work (the cost per list cell) is sampled: a second of it every ten, through the UI-thread frame
 * loop a holder passes in (`watchWork`), and only while a holder asks for it. Nothing runs per frame
 * otherwise; the per-event work is a counter.
 */

import type { InspectorMotionTracking } from '../../protocol/inspector'
import { MotionTracking } from './tracking'
import { currentRoute, liveStyles, registeredSignals, registeredStyles, signalRoutes, slotChurn, tapInspector, tapJsScroll, tapTouches } from './runtime'

/** The UI-thread frame loop's work rows: [uiTime, kind, site, name, ms, calls]. */
export type WorkRowsWatcher = (onRows: (rows: Array<[number, string, string, string | null, number, number]>) => void) => () => void

/** Sample UI work this long… */
const SAMPLE_MS = 1000
/** …every this long, ms. */
const SAMPLE_EVERY_MS = 10_000
/** How often slot claims and frees are read from the runtime's counters, ms. */
const CHURN_EVERY_MS = 1000

type Holder = { sampling: boolean; watchWork?: WorkRowsWatcher; hz?: () => number }
type State = { tracker: MotionTracking; holders: Set<Holder>; stop: () => void }
type Shared = { __KF_TRACKING__?: State | null }

export type TrackingHandle = {
  /** What animates now, on the current screen. */
  summary(): InspectorMotionTracking
  /** Frames the caller counted on the frame thread (Motion Scan does): rates read against them instead of the display's rate. */
  noteFrames(n: number): void
  /** Sample UI work (a second in ten) while on, for the cost per list cell. */
  sampleWork(on: boolean): void
  release(): void
}

/** Starts tracking (or joins it). `watchWork`: the UI-thread work rows, for sampling; `hz`: the display's rate. */
export function holdTracking(opts: { watchWork?: WorkRowsWatcher; hz?: () => number } = {}): TrackingHandle {
  const g = globalThis as Shared
  const state = (g.__KF_TRACKING__ ??= start())
  const holder: Holder = { sampling: false, ...(opts.watchWork ? { watchWork: opts.watchWork } : {}), ...(opts.hz ? { hz: opts.hz } : {}) }
  state.holders.add(holder)
  return {
    summary: () => summarize(state),
    noteFrames: (n) => state.tracker.onFrames(n, Date.now()),
    sampleWork: (on) => {
      holder.sampling = on
    },
    release: () => {
      if (!state.holders.delete(holder) || state.holders.size) return
      state.stop()
      if (g.__KF_TRACKING__ === state) g.__KF_TRACKING__ = null
    },
  }
}

function start(): State {
  const tracker = new MotionTracking()
  const holders = new Set<Holder>()
  const untapEvents = tapInspector((e) => {
    if (e.kind === 'anim') tracker.onRun(e.site, Date.now())
  })
  const untapTouches = tapTouches((t) => {
    if (t.phase === 'move') tracker.onActivity(Date.now())
  })
  const untapScroll = tapJsScroll(() => tracker.onActivity(Date.now()))
  // Slots claimed and freed since the last read, per call site.
  const seen = new Map<string, { claimed: number; freed: number }>()
  const readChurn = (baseline = false) => {
    const now = Date.now()
    for (const [site, c] of slotChurn()) {
      let was = seen.get(site)
      if (!was) seen.set(site, (was = baseline ? { claimed: c.claimed, freed: c.freed } : { claimed: 0, freed: 0 }))
      // What was claimed before tracking started is not this window's.
      if (baseline) continue
      const s = registeredSignals().get(site)?.site
      tracker.onClaim({ id: site, name: s?.name ?? null, component: s?.component ?? null }, c.claimed - was.claimed, now)
      tracker.onFree(site, c.freed - was.freed, now)
      was.claimed = c.claimed
      was.freed = c.freed
    }
  }
  readChurn(true)
  const churnTimer = setInterval(() => readChurn(), CHURN_EVERY_MS)
  // UI work, a second at a time, while a holder wants it and can watch the UI thread.
  let stopSample: (() => void) | null = null
  const sample = () => {
    const by = [...holders].find((h) => h.sampling && h.watchWork)
    if (!by || stopSample) return
    stopSample = by.watchWork!((rows) => {
      const now = Date.now()
      for (const r of rows) tracker.onWorkRow(r[1], r[2], r[3], r[4], r[5], now)
    })
    setTimeout(() => {
      stopSample?.()
      stopSample = null
    }, SAMPLE_MS)
  }
  const firstSample = setTimeout(sample, 200)
  const sampleTimer = setInterval(sample, SAMPLE_EVERY_MS)
  return {
    tracker,
    holders,
    stop: () => {
      untapEvents()
      untapTouches()
      untapScroll()
      clearInterval(churnTimer)
      clearTimeout(firstSample)
      clearInterval(sampleTimer)
      stopSample?.()
      stopSample = null
    },
  }
}

function summarize(state: State): InspectorMotionTracking {
  const hz = [...state.holders].map((h) => h.hz?.() ?? 0).find((x) => x > 0)
  const live = liveStyles()
  return state.tracker.summary(Date.now(), {
    screen: currentRoute()?.route ?? null,
    values: [...registeredSignals().values()].map((x) => x.site),
    routeOf: (id) => signalRoutes().get(id),
    styles: registeredStyles().values(),
    // A build whose plugin predates useKfStyle counts no instances: each style in the catalog counts once.
    ...(live.size ? { styleInstances: live } : {}),
    ...(hz ? { hz } : {}),
  })
}
