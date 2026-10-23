/**
 * Motion tracking: what animates in the app now, counted from what the inspector already hears. A
 * window of the last few seconds (two buckets, so nothing is kept per event) of animation starts per
 * call site, frames drawn, shared-value slots claimed and freed, and UI work per worklet; and, read
 * when asked, what is mounted (shared values and animated styles, per screen when the app says).
 *
 * Information, never a problem: Motion Scan shows it, the app sends it to editors (`samples.tracking`)
 * and the MCP server's inspector_status prints it. The problems engine reads recordings (issues.ts).
 *
 * Pure: no React Native, no clock of its own (every call says when). Counting is a counter bump per
 * event; the per-site entries are made once, the first time a site is seen.
 */

import type { InspectorCallSite, InspectorMotionTracking, InspectorSignalSite, InspectorStyleSite, InspectorUiWork } from '../../protocol/inspector'

/** Two buckets of this long make the window, ms: rates are read over the last 2.5 to 5 s. */
export const TRACKING_BUCKET_MS = 2500
/** A slot claimed or freed this soon after a finger moved or a list scrolled counts as while scrolling, ms. */
const ACTIVITY_MS = 500
/** How many entries each list keeps. */
const TOP = 8
/** A worklet that ran this many times a frame, on average, runs in a list's cells. */
const CELL_INSTANCES = 2
/** Layout animations a view runs as it mounts, leaves or moves: a new view each time, not a restart. */
const MOUNT_MOTIONS = new Set(['entering', 'exiting', 'layout'])
/** Worklet kinds that run per view (an animated style or props, a derived value or a reaction in a cell). */
const CELL_KINDS = new Set(['style', 'props', 'derived', 'reaction'])

/** This bucket's count, and the one before's. */
type Pair = { a: number; b: number }
const pair = (): Pair => ({ a: 0, b: 0 })
const both = (p: Pair) => p.a + p.b

type RunEntry = { runs: Pair; site: Pick<InspectorCallSite, 'id' | 'file' | 'line' | 'fn' | 'target' | 'prop'> }
type ChurnEntry = { claimed: Pair; freed: Pair; busy: Pair; name: string | null; component: string | null }
type WorkEntry = { ms: Pair; calls: Pair; rows: Pair; name: string | null; kind: string }

/** `app/feed.tsx:20:8#3` → `app/feed.tsx:20:8`: an instance's call site. */
export function baseSiteOf(id: string): string {
  const i = id.lastIndexOf('#')
  return i > 0 && /^\d+$/.test(id.slice(i + 1)) ? id.slice(0, i) : id
}

/** `appear #3` → `appear`: an instance's name as written. */
const baseName = (name: string | null) => (name ? name.replace(/ #\d+$/, '') : name)

/** What a summary reads besides the window: what is mounted now, and where. */
export type TrackingContext = {
  /** The screen to describe (the current route), or null. */
  screen: string | null
  /** Mounted shared-value instances (`<site>`, `<site>#2`…). */
  values: Iterable<InspectorSignalSite>
  /** The screen each instance mounted on, when the app tracks navigation. */
  routeOf?: (id: string) => string | undefined
  /** The animated style call sites (the catalog). */
  styles: Iterable<InspectorStyleSite>
  /** Mounted instances per style call site and the screens they are on; without it, each style in the catalog counts once. */
  styleInstances?: ReadonlyMap<string, { readonly count: number; readonly routes: ReadonlyMap<string, number> }>
  /** The display's refresh rate, for the frames of a window nobody counted. */
  hz?: number
}

export class MotionTracking {
  private start = Number.NaN
  private rotated = false
  private firstAt = Number.NaN
  private frames = pair()
  private framesCounted = false
  private workSeen = pair()
  private activeUntil = -Infinity
  private readonly runs = new Map<string, RunEntry>()
  private readonly churn = new Map<string, ChurnEntry>()
  private readonly work = new Map<string, WorkEntry>()

  /** Moves the window on to `now`: a bucket that ended becomes the one before, an older one is dropped. */
  tick(now: number): void {
    if (Number.isNaN(this.start)) {
      this.start = now
      this.firstAt = now
      return
    }
    if (now - this.start < TRACKING_BUCKET_MS) return
    const idle = now - this.start >= 2 * TRACKING_BUCKET_MS
    const roll = (p: Pair) => {
      p.b = idle ? 0 : p.a
      p.a = 0
    }
    roll(this.frames)
    roll(this.workSeen)
    for (const e of this.runs.values()) roll(e.runs)
    for (const e of this.churn.values()) {
      roll(e.claimed)
      roll(e.freed)
      roll(e.busy)
    }
    for (const e of this.work.values()) {
      roll(e.ms)
      roll(e.calls)
      roll(e.rows)
    }
    this.start = idle ? now : this.start + TRACKING_BUCKET_MS
    this.rotated = true
  }

  /** An animation started (an `anim` event). */
  onRun(site: RunEntry['site'], now: number): void {
    if (MOUNT_MOTIONS.has(site.fn)) return
    this.tick(now)
    let e = this.runs.get(site.id)
    if (!e) this.runs.set(site.id, (e = { runs: pair(), site: { id: site.id, file: site.file, line: site.line, fn: site.fn, target: site.target, prop: site.prop } }))
    e.runs.a++
  }

  /** `n` frames drawn on the frame thread (when the app counts them; otherwise the display's rate stands in). */
  onFrames(n: number, now: number): void {
    this.tick(now)
    this.frames.a += n
    this.framesCounted = true
  }

  /** A finger moved, or a list scrolled: slots claimed and freed around now are scrolling's. */
  onActivity(now: number): void {
    this.activeUntil = now + ACTIVITY_MS
  }

  /** `n` instances of a shared-value call site mounted (`site` is the call site, not an instance). */
  onClaim(site: Pick<InspectorSignalSite, 'id' | 'name' | 'component'>, n: number, now: number): void {
    if (n <= 0) return
    this.tick(now)
    const e = this.churnOf(baseSiteOf(site.id), baseName(site.name ?? null), site.component ?? null)
    e.claimed.a += n
    if (now <= this.activeUntil) e.busy.a += n
  }

  /** `n` instances of a call site (or an instance id) unmounted. */
  onFree(siteId: string, n: number, now: number): void {
    if (n <= 0) return
    this.tick(now)
    const e = this.churnOf(baseSiteOf(siteId), null, null)
    e.freed.a += n
    if (now <= this.activeUntil) e.busy.a += n
  }

  /** UI-thread work rows (one per worklet and frame), as the frame loop sums them. */
  onWork(rows: Iterable<Pick<InspectorUiWork, 'kind' | 'site' | 'name' | 'ms' | 'calls'>>, now: number): void {
    for (const r of rows) this.onWorkRow(r.kind, r.site, r.name ?? null, r.ms, r.calls, now)
  }

  /** One worklet's work in one frame (the frame loop's row, taken apart: nothing to allocate). */
  onWorkRow(kind: string, site: string, name: string | null, ms: number, calls: number, now: number): void {
    this.tick(now)
    this.workSeen.a++
    if (!CELL_KINDS.has(kind)) return
    const key = `${kind}|${site}`
    let e = this.work.get(key)
    if (!e) this.work.set(key, (e = { ms: pair(), calls: pair(), rows: pair(), name, kind }))
    e.ms.a += ms
    e.calls.a += calls
    e.rows.a++
  }

  private churnOf(site: string, name: string | null, component: string | null): ChurnEntry {
    let e = this.churn.get(site)
    if (!e) this.churn.set(site, (e = { claimed: pair(), freed: pair(), busy: pair(), name, component }))
    if (name && !e.name) e.name = name
    if (component && !e.component) e.component = component
    return e
  }

  /** How long the window covers at `now`, ms. */
  windowMs(now: number): number {
    if (Number.isNaN(this.start)) return 0
    return Math.max(0, now - (this.rotated ? this.start - TRACKING_BUCKET_MS : this.firstAt))
  }

  /** What animates now, on the context's screen. */
  summary(now: number, ctx: TrackingContext): InspectorMotionTracking {
    this.tick(now)
    const windowMs = this.windowMs(now)
    const counted = both(this.frames)
    const frames = this.framesCounted && counted > 0 ? counted : Math.round((windowMs * (ctx.hz && ctx.hz > 0 ? ctx.hz : 60)) / 1000)
    const onScreen = (route: string | undefined) => !ctx.screen || route === undefined || route === ctx.screen

    // Shared values mounted on the screen, per call site.
    const valueSites = new Map<string, { site: string; name: string | null; component: string | null; instances: number }>()
    let values = 0
    for (const v of ctx.values) {
      if (!onScreen(ctx.routeOf?.(v.id))) continue
      values++
      const base = baseSiteOf(v.id)
      const e = valueSites.get(base)
      if (e) e.instances++
      else valueSites.set(base, { site: base, name: baseName(v.name), component: v.component, instances: 1 })
    }

    // Animated styles mounted on the screen, and the values that drive them.
    const styles: InspectorMotionTracking['styles'] = []
    const drivers = new Map<string, { name: string; site: string | null; styles: number; props: number }>()
    let styleCount = 0
    let props = 0
    for (const st of ctx.styles) {
      const live = ctx.styleInstances?.get(st.id)
      const n = !ctx.styleInstances ? 1 : !live ? 0 : ctx.screen && live.routes.size ? (live.routes.get(ctx.screen) ?? 0) : live.count
      if (n <= 0) continue
      const keys = new Set(st.links.map((l) => l.prop))
      styles.push({ site: st.id, name: st.name, component: st.component, instances: n, props: keys.size })
      styleCount += n
      props += n * keys.size
      // One style reading a value for three properties is one style it drives.
      const byDriver = new Map<string, { name: string; site: string | null; props: number }>()
      for (const l of st.links) {
        const key = l.id ?? `${st.component ?? ''}|${l.signal}`
        const d = byDriver.get(key)
        if (d) d.props++
        else byDriver.set(key, { name: l.signal, site: l.id ?? null, props: 1 })
      }
      for (const [key, d] of byDriver) {
        const e = drivers.get(key)
        if (e) {
          e.styles += n
          e.props += n * d.props
        } else drivers.set(key, { name: d.name, site: d.site, styles: n, props: n * d.props })
      }
    }

    // Worklets that ran in several instances a frame: list cells. Measured only while UI work was sampled.
    const cells: NonNullable<InspectorMotionTracking['cells']> = []
    for (const [key, e] of this.work) {
      const rows = both(e.rows)
      const calls = both(e.calls)
      if (!rows || calls / rows < CELL_INSTANCES) continue
      const ms = both(e.ms)
      cells.push({ site: key.slice(key.indexOf('|') + 1), name: e.name, kind: e.kind, instances: Math.round(calls / rows), msPerCell: round3(ms / calls), msPerFrame: round3(ms / rows) })
    }

    const restarts: InspectorMotionTracking['restarts'] = []
    for (const e of this.runs.values()) {
      const runs = both(e.runs)
      if (!runs || !frames) continue
      restarts.push({ site: e.site.id, fn: e.site.fn, what: e.site.target ?? e.site.prop ?? null, where: `${e.site.file}:${e.site.line}`, runs, perFrame: round3(runs / frames) })
    }

    // Mounted instances per call site, on every screen: what remounts are measured against.
    const mounted = new Map<string, number>()
    for (const v of ctx.values) mounted.set(baseSiteOf(v.id), (mounted.get(baseSiteOf(v.id)) ?? 0) + 1)
    const churn: InspectorMotionTracking['churn'] = []
    for (const [site, e] of this.churn) {
      const claimed = both(e.claimed)
      const freed = both(e.freed)
      if (!claimed && !freed) continue
      churn.push({ site, name: e.name, component: e.component, claimed, freed, whileScrolling: both(e.busy), instances: mounted.get(site) ?? 0 })
    }

    return {
      screen: ctx.screen,
      windowMs: Math.round(windowMs),
      frames,
      inventory: { styles: styleCount, values, propsPerView: styleCount ? round3(props / styleCount) : 0 },
      values: [...valueSites.values()].sort((a, b) => b.instances - a.instances).slice(0, TOP),
      styles: styles.sort((a, b) => b.instances * b.props - a.instances * a.props).slice(0, TOP),
      drivers: [...drivers.values()].sort((a, b) => b.styles - a.styles || b.props - a.props).slice(0, TOP),
      cells: both(this.workSeen) ? cells.sort((a, b) => b.msPerFrame - a.msPerFrame).slice(0, TOP) : null,
      restarts: restarts.sort((a, b) => b.perFrame - a.perFrame).slice(0, TOP),
      churn: churn.sort((a, b) => b.claimed + b.freed - (a.claimed + a.freed)).slice(0, TOP),
    }
  }
}

const round3 = (x: number) => Math.round(x * 1000) / 1000
const short = (site: string) => site.split('/').pop() ?? site
const fixed = (x: number, d = 1) => (Math.round(x * 10 ** d) / 10 ** d).toString()

/** More than this many starts a frame at one call site is several views restarting together (issues.ts restart-storm). */
const STORM_PER_FRAME = 3
/** Starts a frame worth a line: one every five frames or more. */
const LISTED_PER_FRAME = 0.2
/** Mounts and unmounts in the window worth a line. */
const LISTED_CHURN = 6
/** Each mounted instance mounted again this many times in the window: every row remounts, not a list windowing its rows. */
const REMOUNTS_PER_ROW = 3

/**
 * The summary as lines of text (inspector_status, Motion Scan's list). Only what has something to
 * say: the inventory always, then fan-out, the heaviest cells, restarts and remounts when there are.
 */
export function trackingLines(t: InspectorMotionTracking, opts: { full?: boolean } = {}): string[] {
  const lines: string[] = []
  const secs = fixed(t.windowMs / 1000)
  lines.push(`Motion now${t.screen ? ` on ${t.screen}` : ''} (last ${secs} s, ${t.frames} frames):`)
  lines.push(
    `  Mounted: ${t.inventory.styles} animated ${t.inventory.styles === 1 ? 'style' : 'styles'}, ${t.inventory.values} shared ${t.inventory.values === 1 ? 'value' : 'values'}, ${fixed(t.inventory.propsPerView)} animated properties a view.`,
  )
  const many = t.values.filter((v) => v.instances > 1).slice(0, opts.full ? TOP : 3)
  if (many.length) lines.push(`  Shared values per call site: ${many.map((v) => `${v.name ?? '(unnamed)'}${v.component ? ` in ${v.component}` : ''} ×${v.instances} (${v.site})`).join(', ')}.`)
  const drivers = t.drivers.filter((d) => d.styles > 1).slice(0, opts.full ? TOP : 3)
  if (drivers.length) {
    const total = t.drivers.reduce((n, d) => n + d.styles, 0)
    lines.push(
      `  Fan-out (info): ${drivers.map((d) => `${d.name} feeds ${d.styles} styles (${d.props} properties)`).join(', ')}; ${fixed(t.drivers.length ? total / t.drivers.length : 0)} styles a driving value, ${fixed(t.inventory.propsPerView)} properties a view.`,
    )
  }
  if (t.cells === null) lines.push('  Cost per cell: not measured in this window (UI work is sampled).')
  else if (t.cells.length) {
    const c = t.cells[0]!
    lines.push(`  Heaviest cell: ${c.name ?? c.kind} (${c.site}) ${fixed(c.msPerCell, 2)} ms a cell × ${c.instances} cells = ${fixed(c.msPerFrame, 2)} ms a frame.`)
    for (const x of t.cells.slice(1, opts.full ? TOP : 3)) lines.push(`    then ${x.name ?? x.kind} (${x.site}) ${fixed(x.msPerCell, 2)} ms × ${x.instances} = ${fixed(x.msPerFrame, 2)} ms a frame`)
  }
  const restarts = t.restarts.filter((r) => r.perFrame >= LISTED_PER_FRAME).slice(0, opts.full ? TOP : 3)
  for (const r of restarts) {
    const storm = r.perFrame > STORM_PER_FRAME
    lines.push(
      `  Restarts: ${r.fn}${r.what ? ` → ${r.what}` : ''} (${short(r.where)}) ${fixed(r.perFrame)} a frame (${r.runs} starts)${storm ? ': several views restart it every frame, a restart storm' : r.perFrame >= 0.8 ? ': one view following a value every frame' : ''}.`,
    )
  }
  for (const c of t.churn.filter((x) => x.claimed + x.freed >= LISTED_CHURN).slice(0, opts.full ? TOP : 3)) {
    const again = c.claimed / Math.max(1, c.instances)
    const remounts = c.claimed >= LISTED_CHURN && again >= REMOUNTS_PER_ROW
    lines.push(
      `  Remount churn: ${c.name ?? '(unnamed)'}${c.component ? ` in ${c.component}` : ''} (${c.site}) ${c.claimed} mounted, ${c.freed} unmounted${c.whileScrolling ? ` (${c.whileScrolling} while scrolling)` : ''}, ${c.instances} mounted now${remounts ? `: every row mounted again about ${Math.round(again)} times, so its component is remade (a renderItem component made inline, or keys that change), not a list bringing rows into view` : ''}.`,
    )
  }
  return lines
}
