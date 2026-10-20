/**
 * Motion Vitals: the one validator of `VitalsReport`, used by the ingest Worker (`apps/vitals`) and by
 * every SDK's golden tests. Pure and import-free apart from the protocol's own types and limits.
 *
 * `validateVitalsReport(x)` checks the shape, closed enums, string lengths, numeric ranges, the caps of
 * `VITALS_LIMITS` (all but `bytes`, which ingest checks on the body) and the consistency rules below.
 * On success it returns a clean copy that holds only the fields the protocol defines: an unknown field
 * from a newer SDK is dropped, never stored, so nothing the protocol does not name reaches storage.
 *
 * Consistency rules:
 * - every histogram has VITALS_BUCKETS.length entries and they add up to the thread's `frames`;
 * - `frozen`, `idleFrames` <= `frames`; `measuredMs` <= `foregroundMs` (plus 1 s of clock slack);
 * - a thread's frames over all screens fit `measuredMs` at 240 Hz (VITALS_MAX_HZ), plus one second;
 * - a site's `screen`, a worst frame's `screen` and `sites`, and a `native` ref's `image` point inside
 *   their arrays; `runsReduceMotion` <= `runs`;
 * - `seq` 0 is the first window; `sampleRate` is in (0, 1].
 */
import {
  VITALS_BUCKETS,
  VITALS_FORMAT,
  VITALS_LIMITS,
  VITALS_VERSION,
  VITALS_WINDOW_MS,
  type VitalsImage,
  type VitalsReport,
  type VitalsSite,
  type VitalsSiteRef,
  type VitalsThreadStats,
  type VitalsWorstFrame,
} from './vitals'

export type VitalsValidation = { ok: true; report: VitalsReport } | { ok: false; errors: string[] }

/** No display refreshes faster than this; frame counts above it are made up. */
export const VITALS_MAX_HZ = 240
/** Longest string accepted for site ids, files, class names. Screen names use VITALS_LIMITS.screenName. */
export const VITALS_MAX_ID = 160
const MAX_SHORT = 64
const MAX_FRAME_MS = 10 * 60 * 1000
/** Clock slack between the meters and the window timer. */
const SLACK_MS = 1000

const PLATFORMS = ['react-native', 'ios', 'android', 'flutter'] as const
const OSES = ['ios', 'android'] as const
const THREADS = ['ui', 'js'] as const
const TIERS = ['low', 'mid', 'high'] as const
const THERMALS = ['nominal', 'fair', 'serious', 'critical'] as const
const CAUSES = ['screen-mount', 'burst', 'busy-start', 'scroll', 'gesture', 'js-task', 'ui-work', 'slow-render', 'unknown'] as const
const ENDED = ['background', 'window', 'unknown'] as const
const ENVIRONMENTS = ['production', 'development'] as const
const IMAGE_KINDS = ['macho', 'elf'] as const

type Obj = Record<string, unknown>
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x)

class Checker {
  errors: string[] = []
  fail(path: string, msg: string): undefined {
    if (this.errors.length < 50) this.errors.push(`${path}: ${msg}`)
    return undefined
  }
  obj(x: unknown, path: string): Obj | undefined {
    return isObj(x) ? x : this.fail(path, 'expected an object')
  }
  str(x: unknown, path: string, max: number, opts: { min?: number; re?: RegExp } = {}): string | undefined {
    if (typeof x !== 'string') return this.fail(path, 'expected a string')
    if (x.length < (opts.min ?? 1)) return this.fail(path, 'too short')
    if (x.length > max) return this.fail(path, `longer than ${max}`)
    if (opts.re && !opts.re.test(x)) return this.fail(path, 'bad format')
    return x
  }
  optStr(x: unknown, path: string, max: number, opts: { min?: number; re?: RegExp } = {}): string | undefined {
    return x === undefined ? undefined : this.str(x, path, max, opts)
  }
  /** string, null or absent: absent stays absent. */
  nullStr(x: unknown, path: string, max: number): string | null | undefined {
    if (x === null) return null
    return this.optStr(x, path, max)
  }
  num(x: unknown, path: string, min: number, max: number, int = false): number | undefined {
    if (typeof x !== 'number' || !Number.isFinite(x)) return this.fail(path, 'expected a finite number')
    if (int && !Number.isInteger(x)) return this.fail(path, 'expected an integer')
    if (x < min || x > max) return this.fail(path, `out of range ${min}..${max}`)
    return x
  }
  optNum(x: unknown, path: string, min: number, max: number, int = false): number | undefined {
    return x === undefined ? undefined : this.num(x, path, min, max, int)
  }
  bool(x: unknown, path: string): boolean | undefined {
    return typeof x === 'boolean' ? x : this.fail(path, 'expected a boolean')
  }
  optBool(x: unknown, path: string): boolean | undefined {
    return x === undefined ? undefined : this.bool(x, path)
  }
  oneOf<T extends string>(x: unknown, path: string, values: readonly T[]): T | undefined {
    return typeof x === 'string' && (values as readonly string[]).includes(x) ? (x as T) : this.fail(path, `expected one of ${values.join(', ')}`)
  }
  arr(x: unknown, path: string, max: number): unknown[] | undefined {
    if (!Array.isArray(x)) return this.fail(path, 'expected an array')
    if (x.length > max) return this.fail(path, `more than ${max} entries`)
    return x
  }
}

/** Omits undefined values so the clean copy has no `key: undefined` entries. */
function compact<T extends Obj>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k]
  return o
}

const HEX = /^[0-9a-f]+$/
const NONCE = /^[A-Za-z0-9_-]{8,64}$/
const BIG = 1e12

function threadStats(c: Checker, x: unknown, path: string): VitalsThreadStats | undefined {
  const o = c.obj(x, path)
  if (!o) return undefined
  const frames = c.num(o.frames, `${path}.frames`, 0, BIG, true)
  const histIn = c.arr(o.hist, `${path}.hist`, VITALS_BUCKETS.length)
  let hist: number[] | undefined
  if (histIn) {
    if (histIn.length !== VITALS_BUCKETS.length) c.fail(`${path}.hist`, `expected ${VITALS_BUCKETS.length} buckets`)
    else {
      const h = histIn.map((v, i) => c.num(v, `${path}.hist[${i}]`, 0, BIG, true))
      if (h.every((v) => v !== undefined)) hist = h as number[]
    }
  }
  const frozen = c.num(o.frozen, `${path}.frozen`, 0, BIG, true)
  const hitchMs = c.num(o.hitchMs, `${path}.hitchMs`, 0, BIG)
  const idleFrames = c.num(o.idleFrames, `${path}.idleFrames`, 0, BIG, true)
  const idleMissed = c.num(o.idleMissed, `${path}.idleMissed`, 0, BIG, true)
  if (frames === undefined || !hist || frozen === undefined || hitchMs === undefined || idleFrames === undefined || idleMissed === undefined) return undefined
  if (hist.reduce((a, b) => a + b, 0) !== frames) c.fail(`${path}.hist`, `buckets add up to ${hist.reduce((a, b) => a + b, 0)}, not frames (${frames})`)
  if (frozen > frames) c.fail(`${path}.frozen`, 'more than frames')
  if (idleFrames > frames) c.fail(`${path}.idleFrames`, 'more than frames')
  return { frames, hist, frozen, hitchMs, idleFrames, idleMissed }
}

function siteRef(c: Checker, x: unknown, path: string, imageCount: number): VitalsSiteRef | undefined {
  const o = c.obj(x, path)
  if (!o) return undefined
  switch (o.kind) {
    case 'source': {
      const file = c.str(o.file, `${path}.file`, VITALS_MAX_ID)
      const line = c.num(o.line, `${path}.line`, 0, 10_000_000, true)
      const column = c.optNum(o.column, `${path}.column`, 0, 10_000_000, true)
      return file !== undefined && line !== undefined ? compact({ kind: 'source' as const, file, line, column }) : undefined
    }
    case 'hashed': {
      const hash = c.str(o.hash, `${path}.hash`, 64, { min: 8, re: HEX })
      return hash !== undefined ? { kind: 'hashed', hash } : undefined
    }
    case 'name': {
      const name = c.str(o.name, `${path}.name`, VITALS_MAX_ID)
      const type = c.optStr(o.type, `${path}.type`, VITALS_MAX_ID)
      return name !== undefined ? compact({ kind: 'name' as const, name, type }) : undefined
    }
    case 'native': {
      const image = c.num(o.image, `${path}.image`, 0, VITALS_LIMITS.images - 1, true)
      const offset = c.num(o.offset, `${path}.offset`, 0, Number.MAX_SAFE_INTEGER, true)
      const type = c.optStr(o.type, `${path}.type`, VITALS_MAX_ID)
      if (image !== undefined && image >= imageCount) c.fail(`${path}.image`, 'not in images')
      return image !== undefined && offset !== undefined ? compact({ kind: 'native' as const, image, offset, type }) : undefined
    }
    case 'jvm': {
      const className = c.str(o.className, `${path}.className`, VITALS_MAX_ID)
      const method = c.str(o.method, `${path}.method`, MAX_SHORT * 2)
      const line = c.optNum(o.line, `${path}.line`, 0, 10_000_000, true)
      const file = c.optStr(o.file, `${path}.file`, VITALS_MAX_ID)
      return className !== undefined && method !== undefined ? compact({ kind: 'jvm' as const, className, method, line, file }) : undefined
    }
    default:
      return c.fail(`${path}.kind`, 'expected source, hashed, name, native or jvm')
  }
}

function image(c: Checker, x: unknown, path: string): VitalsImage | undefined {
  const o = c.obj(x, path)
  if (!o) return undefined
  const debugId = c.str(o.debugId, `${path}.debugId`, 64, { min: 16, re: HEX })
  const kind = c.oneOf(o.kind, `${path}.kind`, IMAGE_KINDS)
  const name = c.str(o.name, `${path}.name`, 128)
  const arch = c.optStr(o.arch, `${path}.arch`, 16)
  if (name !== undefined && (name.startsWith('/') || name.includes('\\') || name.split('/').length > 3)) c.fail(`${path}.name`, 'a file name, not a path')
  return debugId !== undefined && kind !== undefined && name !== undefined ? compact({ debugId, kind, name, arch }) : undefined
}

export function validateVitalsReport(x: unknown): VitalsValidation {
  const c = new Checker()
  const r = c.obj(x, 'report')
  if (!r) return { ok: false, errors: c.errors }
  if (r.format !== VITALS_FORMAT) c.fail('format', `expected ${VITALS_FORMAT}`)
  if (r.version !== VITALS_VERSION) c.fail('version', `expected ${VITALS_VERSION}`)

  const appIn = c.obj(r.app, 'app')
  const app = appIn && compact({
    id: c.optStr(appIn.id, 'app.id', 200),
    version: c.str(appIn.version, 'app.version', MAX_SHORT),
    build: c.optStr(appIn.build, 'app.build', MAX_SHORT),
    platform: c.oneOf(appIn.platform, 'app.platform', PLATFORMS),
    framework: c.optStr(appIn.framework, 'app.framework', 32),
    environment: c.oneOf(appIn.environment, 'app.environment', ENVIRONMENTS),
    debugId: c.optStr(appIn.debugId, 'app.debugId', MAX_SHORT, { re: /^[A-Za-z0-9._+-]+$/ }),
  })

  const sdkIn = c.obj(r.sdk, 'sdk')
  const sdk = sdkIn && { name: c.str(sdkIn.name, 'sdk.name', MAX_SHORT), version: c.str(sdkIn.version, 'sdk.version', 32) }

  const devIn = c.obj(r.device, 'device')
  const device = devIn && compact({
    os: c.oneOf(devIn.os, 'device.os', OSES),
    osMajor: c.num(devIn.osMajor, 'device.osMajor', 0, 1000, true),
    model: c.optStr(devIn.model, 'device.model', MAX_SHORT),
    tier: devIn.tier === undefined ? undefined : c.oneOf(devIn.tier, 'device.tier', TIERS),
    memoryGb: c.optNum(devIn.memoryGb, 'device.memoryGb', 0, 1024),
  })

  const dispIn = c.obj(r.display, 'display')
  const display = dispIn && compact({
    hz: c.num(dispIn.hz, 'display.hz', 1, VITALS_MAX_HZ),
    adaptive: c.optBool(dispIn.adaptive, 'display.adaptive'),
    targetHz: c.num(dispIn.targetHz, 'display.targetHz', 1, VITALS_MAX_HZ),
  })

  const stIn = c.obj(r.state, 'state')
  const state = stIn && compact({
    reduceMotion: c.optBool(stIn.reduceMotion, 'state.reduceMotion'),
    lowPower: c.optBool(stIn.lowPower, 'state.lowPower'),
    thermal: stIn.thermal === undefined ? undefined : c.oneOf(stIn.thermal, 'state.thermal', THERMALS),
  })

  const sesIn = c.obj(r.session, 'session')
  const session = sesIn && {
    nonce: c.str(sesIn.nonce, 'session.nonce', 64, { min: 8, re: NONCE }),
    seq: c.num(sesIn.seq, 'session.seq', 0, 10_000, true),
    sampleRate: c.num(sesIn.sampleRate, 'session.sampleRate', 0, 1),
    foregroundMs: c.num(sesIn.foregroundMs, 'session.foregroundMs', 0, VITALS_WINDOW_MS + 60_000),
    measuredMs: c.num(sesIn.measuredMs, 'session.measuredMs', 0, VITALS_WINDOW_MS + 60_000),
    ended: c.oneOf(sesIn.ended, 'session.ended', ENDED),
  }
  if (session?.sampleRate === 0) c.fail('session.sampleRate', 'must be above 0')
  if (session?.foregroundMs !== undefined && session.measuredMs !== undefined && session.measuredMs > session.foregroundMs + SLACK_MS) c.fail('session.measuredMs', 'more than foregroundMs')

  const imgIn = r.images === undefined ? undefined : c.arr(r.images, 'images', VITALS_LIMITS.images)
  const images = imgIn?.map((im, i) => image(c, im, `images[${i}]`))
  const imageCount = images?.length ?? 0

  const scrIn = c.arr(r.screens, 'screens', VITALS_LIMITS.screens)
  const framesPerThread: Record<string, number> = {}
  const screens = scrIn?.map((s, i) => {
    const p = `screens[${i}]`
    const o = c.obj(s, p)
    if (!o) return undefined
    const name = c.str(o.name, `${p}.name`, VITALS_LIMITS.screenName)
    const ms = c.num(o.ms, `${p}.ms`, 0, VITALS_WINDOW_MS + 60_000)
    const thIn = c.obj(o.threads, `${p}.threads`)
    const threads: Partial<Record<(typeof THREADS)[number], VitalsThreadStats>> = {}
    if (thIn) {
      for (const k of Object.keys(thIn)) {
        const t = c.oneOf(k, `${p}.threads`, THREADS)
        if (!t) continue
        const st = threadStats(c, thIn[k], `${p}.threads.${t}`)
        if (st) {
          threads[t] = st
          framesPerThread[t] = (framesPerThread[t] ?? 0) + st.frames
        }
      }
    }
    if (session?.foregroundMs !== undefined && ms !== undefined && ms > session.foregroundMs + SLACK_MS) c.fail(`${p}.ms`, 'more than foregroundMs')
    return name !== undefined && ms !== undefined ? { name, ms, threads } : undefined
  })
  if (session?.measuredMs !== undefined) {
    const cap = Math.ceil(((session.measuredMs + SLACK_MS) * VITALS_MAX_HZ) / 1000)
    for (const [t, n] of Object.entries(framesPerThread)) if (n > cap) c.fail(`screens.threads.${t}`, `${n} frames do not fit ${session.measuredMs} ms measured`)
  }
  const screenCount = screens?.length ?? 0

  const siteIn = c.arr(r.sites, 'sites', VITALS_LIMITS.sites)
  const sites = siteIn?.map((s, i): VitalsSite | undefined => {
    const p = `sites[${i}]`
    const o = c.obj(s, p)
    if (!o) return undefined
    const ref = siteRef(c, o.ref, `${p}.ref`, imageCount)
    const site = compact({
      ref,
      key: c.optStr(o.key, `${p}.key`, VITALS_MAX_ID),
      fn: c.str(o.fn, `${p}.fn`, MAX_SHORT * 2),
      component: c.nullStr(o.component, `${p}.component`, MAX_SHORT * 2),
      prop: c.nullStr(o.prop, `${p}.prop`, MAX_SHORT),
      screen: c.num(o.screen, `${p}.screen`, 0, VITALS_LIMITS.screens - 1, true),
      runs: c.num(o.runs, `${p}.runs`, 0, BIG, true),
      activeMs: c.num(o.activeMs, `${p}.activeMs`, 0, VITALS_WINDOW_MS + 60_000),
      frames: c.num(o.frames, `${p}.frames`, 0, BIG, true),
      missed: c.num(o.missed, `${p}.missed`, 0, BIG, true),
      hitchMs: c.num(o.hitchMs, `${p}.hitchMs`, 0, BIG),
      worstMs: c.num(o.worstMs, `${p}.worstMs`, 0, MAX_FRAME_MS),
      runsReduceMotion: c.optNum(o.runsReduceMotion, `${p}.runsReduceMotion`, 0, BIG, true),
    })
    if (site.screen !== undefined && site.screen >= screenCount) c.fail(`${p}.screen`, 'not in screens')
    if (site.runsReduceMotion !== undefined && site.runs !== undefined && site.runsReduceMotion > site.runs) c.fail(`${p}.runsReduceMotion`, 'more than runs')
    if (session?.measuredMs !== undefined && site.frames !== undefined) {
      const cap = Math.ceil(((session.measuredMs + SLACK_MS) * VITALS_MAX_HZ) / 1000)
      if (site.frames > cap) c.fail(`${p}.frames`, `do not fit ${session.measuredMs} ms measured`)
    }
    return site as VitalsSite
  })
  const siteCount = sites?.length ?? 0

  const worstIn = c.arr(r.worst, 'worst', VITALS_LIMITS.worst)
  const worst = worstIn?.map((w, i): VitalsWorstFrame | undefined => {
    const p = `worst[${i}]`
    const o = c.obj(w, p)
    if (!o) return undefined
    const sitesOf = c.arr(o.sites, `${p}.sites`, VITALS_LIMITS.sites)?.map((v, j) => {
      const n = c.num(v, `${p}.sites[${j}]`, 0, VITALS_LIMITS.sites - 1, true)
      if (n !== undefined && n >= siteCount) c.fail(`${p}.sites[${j}]`, 'not in sites')
      return n
    })
    const frame = compact({
      thread: c.oneOf(o.thread, `${p}.thread`, THREADS),
      ms: c.num(o.ms, `${p}.ms`, 0, MAX_FRAME_MS),
      missed: c.num(o.missed, `${p}.missed`, 0, BIG, true),
      screen: c.num(o.screen, `${p}.screen`, 0, VITALS_LIMITS.screens - 1, true),
      sites: sitesOf as number[] | undefined,
      cause: c.oneOf(o.cause, `${p}.cause`, CAUSES),
      afterNavMs: c.optNum(o.afterNavMs, `${p}.afterNavMs`, 0, MAX_FRAME_MS),
    })
    if (frame.screen !== undefined && frame.screen >= screenCount) c.fail(`${p}.screen`, 'not in screens')
    return frame as VitalsWorstFrame
  })

  if (c.errors.length) return { ok: false, errors: c.errors }
  const report = compact({
    format: VITALS_FORMAT,
    version: VITALS_VERSION,
    app: app as VitalsReport['app'],
    sdk: sdk as VitalsReport['sdk'],
    device: device as VitalsReport['device'],
    display: display as VitalsReport['display'],
    state: state as VitalsReport['state'],
    session: session as VitalsReport['session'],
    screens: screens as VitalsReport['screens'],
    sites: sites as VitalsSite[],
    worst: worst as VitalsWorstFrame[],
    images: images as VitalsImage[] | undefined,
  }) as VitalsReport
  return { ok: true, report }
}
