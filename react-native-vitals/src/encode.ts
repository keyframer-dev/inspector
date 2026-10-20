/**
 * A session window's counters as the report the ingest Worker takes (`VitalsReport`), within every
 * limit of `VITALS_LIMITS`: 40 screens (the collector folds the rest into `other`), 200 sites (the ones
 * that drew the most frames), 5 worst frames, 64-character screen names and 32 KB of JSON (sites with
 * the fewest frames go first until it fits).
 */

import {
  VITALS_FORMAT,
  VITALS_LIMITS,
  VITALS_VERSION,
  VITALS_WINDOW_MS,
  type VitalsReport,
  type VitalsSite,
  type VitalsThreadStats,
  type VitalsWorstFrame,
} from '../../protocol/vitals'
import type { SiteStats, Snapshot } from './collector'
import { screenName } from './mask'

/** What the report says about the app, the device and the session, beside the counters. */
export type ReportContext = {
  app: VitalsReport['app']
  sdk: VitalsReport['sdk']
  device: VitalsReport['device']
  /** The display's rate when the app knows it; else the fastest the meters saw. */
  display?: { hz?: number; adaptive?: boolean }
  state?: { lowPower?: boolean; thermal?: VitalsReport['state']['thermal'] }
  /** The project collects Reduce Motion (config `collect.reduceMotion`). */
  collectReduceMotion: boolean
  session: Pick<VitalsReport['session'], 'nonce' | 'seq' | 'sampleRate' | 'ended'>
  /** Worst frames sent (the protocol allows 10, SDKs send 5). */
  worst?: number
}

const r1 = (x: number) => Math.round(x * 10) / 10
const MAX_FOREGROUND = VITALS_WINDOW_MS + 60_000

/** True when the window holds anything worth a request: frames measured or animations run. */
export function hasData(s: Snapshot): boolean {
  return s.sites.some((x) => x.runs > 0 || x.frames > 0) || s.screens.some((x) => Object.values(x.threads).some((t) => t && t.frames > 0))
}

export function encodeReport(snap: Snapshot, ctx: ReportContext): VitalsReport {
  const ranked = snap.sites.filter((s) => s.runs > 0 || s.frames > 0).sort((a, b) => b.frames - a.frames || b.runs - a.runs)
  let keep = Math.min(ranked.length, VITALS_LIMITS.sites)
  for (;;) {
    const report = build(snap, ctx, ranked.slice(0, keep))
    if (keep === 0 || JSON.stringify(report).length <= VITALS_LIMITS.bytes) return report
    keep = Math.max(0, keep - Math.max(1, Math.ceil(keep / 10)))
  }
}

function build(snap: Snapshot, ctx: ReportContext, kept: SiteStats[]): VitalsReport {
  const screens: VitalsReport['screens'] = []
  const screenIndex = new Map<string, number>()
  const screenOf = (name: string): number => {
    let i = screenIndex.get(name)
    if (i === undefined) {
      if (screens.length >= VITALS_LIMITS.screens) return screenIndex.get('other') ?? 0
      i = screens.length
      screenIndex.set(name, i)
      screens.push({ name: screenName(name), ms: 0, threads: {} })
    }
    return i
  }
  for (const s of snap.screens.slice(0, VITALS_LIMITS.screens)) {
    const i = screenOf(s.name)
    const threads: Partial<Record<'ui' | 'js', VitalsThreadStats>> = {}
    for (const [t, st] of Object.entries(s.threads) as Array<['ui' | 'js', VitalsThreadStats | undefined]>) {
      if (st && st.frames > 0) threads[t] = { ...st, hist: [...st.hist], hitchMs: r1(st.hitchMs) }
    }
    screens[i] = { name: screenName(s.name), ms: Math.round(s.ms), threads }
  }

  const siteIndex = new Map<SiteStats, number>()
  const sites: VitalsSite[] = kept.map((s, i) => {
    siteIndex.set(s, i)
    let where = ''
    let most = -1
    for (const [name, n] of s.screens) {
      if (n > most) {
        most = n
        where = name
      }
    }
    const site: VitalsSite = {
      ref: s.info.ref,
      ...(s.info.key !== undefined ? { key: s.info.key } : {}),
      fn: s.info.fn,
      component: s.info.component ?? null,
      prop: s.info.prop ?? null,
      // A site that only ran into this window from the last one has no runs here: the first screen.
      screen: screenOf(where || snap.screens[0]?.name || 'unknown'),
      runs: s.runs,
      activeMs: Math.round(Math.min(s.activeMs, MAX_FOREGROUND)),
      frames: s.frames,
      missed: s.missed,
      hitchMs: r1(s.hitchMs),
      worstMs: r1(s.worstMs),
    }
    if (ctx.collectReduceMotion) site.runsReduceMotion = s.runsReduceMotion
    return site
  })

  const worst: VitalsWorstFrame[] = snap.worst.slice(0, ctx.worst ?? 5).map((w) => ({
    thread: w.thread,
    ms: r1(w.ms),
    missed: w.missed,
    screen: screenOf(w.screen),
    sites: w.sites.map((s) => siteIndex.get(s)).filter((i): i is number => i !== undefined),
    cause: w.cause,
    ...(w.afterNavMs !== undefined ? { afterNavMs: w.afterNavMs } : {}),
  }))

  const foregroundMs = Math.round(Math.min(snap.foregroundMs, MAX_FOREGROUND))
  const measuredMs = Math.round(Math.min(snap.measuredMs, foregroundMs))
  const state: VitalsReport['state'] = {}
  if (ctx.collectReduceMotion) state.reduceMotion = snap.reduceMotion
  if (ctx.state?.lowPower !== undefined) state.lowPower = ctx.state.lowPower
  if (ctx.state?.thermal !== undefined) state.thermal = ctx.state.thermal
  const hz = ctx.display?.hz ?? snap.maxHz

  return {
    format: VITALS_FORMAT,
    version: VITALS_VERSION,
    app: ctx.app,
    sdk: ctx.sdk,
    device: ctx.device,
    display: { hz: Math.max(hz, snap.targetHz), ...(ctx.display?.adaptive !== undefined ? { adaptive: ctx.display.adaptive } : {}), targetHz: snap.targetHz },
    state,
    session: { ...ctx.session, foregroundMs, measuredMs },
    screens,
    sites,
    worst,
  }
}
