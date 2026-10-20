/**
 * Motion Vitals' session lifecycle (production.md 2.1), with everything it touches injected so it is
 * tested without React Native: the clocks, randomness, fetch, timers, the storage adapter and the
 * frame meters.
 *
 * - Nothing runs before `start`. Then, per session (a foreground period; it ends after 30 s in the
 *   background): a nonce made in memory, sampling decided once, at most 3 reported sessions per device
 *   per day (counted in storage, never sent).
 * - A sampled session measures inside motion windows only (`MotionGate`), cuts a report when it goes
 *   to the background or fills 10 minutes of foreground, and checkpoints the open window at most once
 *   a minute while something moves (a checkpoint left behind is sent on the next launch with
 *   `ended: 'unknown'`).
 * - Failed uploads wait in a retry store (5 reports, 100 KB, 7 days), retried 10 s after start, then
 *   after 1, 5 and 30 minutes, only in the foreground.
 * - Config comes from every upload response and from `GET /v1/config/<key>` at most once per its TTL;
 *   `stop`, a 401 or a 410 turn the SDK off on this device for 7 days; `minSdk` above this version and
 *   `enabled: false` turn it off.
 * - `setEnabled(false)` stops at once and drops what is pending.
 */

import {
  VITALS_DEFAULT_SAMPLE_RATE,
  VITALS_ENDPOINT,
  VITALS_MAX_SESSIONS_PER_DAY,
  VITALS_SESSION_GAP_MS,
  VITALS_WINDOW_MS,
  type VitalsConfig,
  type VitalsReport,
  type VitalsThread,
  type VitalsTier,
} from '../../protocol/vitals'
import { Collector, MotionGate, type SiteInfo } from './collector'
import { encodeReport, hasData, type ReportContext } from './encode'
import { estimateMs, type EstimateEvent } from './estimate'
import { VITALS_MAX_HZ } from '../../protocol/vitals-validate'
import { SDK_NAME, SDK_VERSION } from './version'

/** Where the SDK keeps its config cache, checkpoint, retry store and day counter: AsyncStorage, an MMKV wrapper… */
export type VitalsStorage = {
  getItem(key: string): string | null | undefined | Promise<string | null | undefined>
  setItem(key: string, value: string): void | Promise<void>
  removeItem(key: string): void | Promise<void>
}

export type VitalsDevice = {
  /** Raw model identifier (`Device.modelId` on iOS, `Device.modelName` on Android from expo-device). */
  model?: string | null
  memoryBytes?: number | null
  memoryGb?: number | null
  tier?: VitalsTier
  /** The display's refresh rate, when the app knows it. */
  displayHz?: number
}

export type ControllerOptions = {
  /** The project's public field key, `kfp_live_…`. */
  key: string
  appVersion: string
  build?: string
  environment?: 'production' | 'development'
  /** Share of sessions that report, until the project's config says otherwise. Default 0.1. */
  sampleRate?: number
  storage?: VitalsStorage
  device?: VitalsDevice
  /** Ingest origin. Default https://vitals.keyframer.dev. */
  endpoint?: string
  /** Bundle id or package name. */
  appId?: string
  /**
   * Logs what this device measures and sends, with console.log: the sampling decision, when the frame
   * meters run, frames a second per thread with their gaps, and each report against the server's
   * limits. For development builds; leave it off in production.
   */
  debug?: boolean
}

type HttpResponse = { status: number; json(): Promise<unknown> }

export type ControllerEnv = {
  /** Monotonic ms, the clock frames and animations are stamped with. */
  now(): number
  /** Wall-clock ms: day counting, config age, retry age. Never sent. */
  wall(): number
  random(): number
  fetch(url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<HttpResponse>
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  platform: { os: 'ios' | 'android'; osMajor: number }
  /** Local calendar day of a wall time, `YYYY-MM-DD`. */
  day?(wall: number): string
  /** Warnings (refusals, kill switch), notes for the developer ('info') and, with `debug`, the trace ('debug'). */
  log?(message: string, level?: 'warn' | 'info' | 'debug'): void
}

/** The frame meters and the instrumentation hooks, as the platform runs them. */
export type Meters = {
  /** Install the animation hooks (JS and UI runtimes): call sites start reporting. */
  install(): void
  uninstall(): void
  /** Start the JS and UI frame loops; each stops itself when the gate closes. */
  start(): void
  /** Keep the UI loop running at least `ms` more (it keeps its own clock). */
  extendUi(ms: number): void
  stop(): void
}

export const STORAGE_KEYS = {
  config: 'kfv:config',
  stop: 'kfv:stop',
  day: 'kfv:day',
  checkpoint: 'kfv:checkpoint',
  queue: 'kfv:queue',
} as const

export const CHECKPOINT_MS = 60_000
export const STOP_MS = 7 * 24 * 3600_000
export const RETRY = { max: 5, bytes: 100 * 1024, ageMs: 7 * 24 * 3600_000, delays: [10_000, 60_000, 5 * 60_000, 30 * 60_000] } as const
/** First config fetch and first retry happen this long after start, never blocking it. */
export const START_DELAY_MS = 10_000
const MAX_EVENTS = 500
/** The UI runtime numbers its animation calls from here, so its ids never meet the JS thread's. */
export const UI_EVENT_BASE = 1_000_000_000

type QueueItem = { body: string; at: number }
type CachedConfig = { config: VitalsConfig; at: number }

const isRef = (v: unknown): v is { $anim: number } => !!v && typeof v === 'object' && typeof (v as { $anim?: unknown }).$anim === 'number'

/** Compares dotted versions numerically: -1, 0 or 1. Pre-release tags are ignored. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((x) => Number.parseInt(x, 10))
  const pb = b.split(/[.+-]/).map((x) => Number.parseInt(x, 10))
  for (let i = 0; i < 3; i++) {
    const x = Number.isFinite(pa[i]) ? pa[i]! : 0
    const y = Number.isFinite(pb[i]) ? pb[i]! : 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

const NONCE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
function makeNonce(random: () => number): string {
  let s = ''
  for (let i = 0; i < 16; i++) s += NONCE_CHARS[Math.floor(random() * NONCE_CHARS.length) % NONCE_CHARS.length]
  return s
}

function localDay(wall: number): string {
  const d = new Date(wall)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

async function read<T>(storage: VitalsStorage | undefined, key: string): Promise<T | null> {
  if (!storage) return null
  try {
    const raw = await storage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

async function write(storage: VitalsStorage | undefined, key: string, value: unknown): Promise<void> {
  if (!storage) return
  try {
    if (value === null) await storage.removeItem(key)
    else await storage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage is best effort: a full disk never breaks the app.
  }
}

/** Every log line's tag, like RevenueCat's `[RevenueCat]`: Metro labels the line DEBUG, INFO or WARN by its level. */
const TAG = '[Keyframer.dev]'

export class VitalsController {
  readonly collector = new Collector()
  readonly gate = new MotionGate()
  private opts: ControllerOptions | null = null
  private enabled = false
  /** Bumped by every start and stop: async work from an older run checks it and gives up. */
  private run = 0
  private config: VitalsConfig | null = null
  private sampled = false
  private nonce = ''
  private seq = 0
  private sampleRate = VITALS_DEFAULT_SAMPLE_RATE
  private foreground = true
  private backgroundAt: number | null = null
  private dayCount: { day: string; n: number } | null = null
  private events = new Map<number, EstimateEvent>()
  private nextEid = 1
  private uiKnownUntil = -Infinity
  private checkpointTimer: unknown = null
  private retryTimer: unknown = null
  private retryStep = 0
  /** Reports waiting in the retry store (no retry timer while it is empty). */
  private queued = 0
  private configTimer: unknown = null
  private meters: Meters | null = null
  private screen = 'app'
  private reduceMotion = false
  /**
   * debug: frames per thread, printed about once a second. Each thread keeps its own span (its earliest
   * frame start to its latest end): UI frames reach the JS side in batches of about half a second, so a
   * shared span would halve one thread's rate.
   */
  private traced: Partial<Record<VitalsThread, { n: number; sum: number; min: number; max: number; since: number; last: number }>> = {}
  private tracedAnims = 0
  /** debug: between "meters on" and "meters off", so each is logged once per motion window. */
  private metering = false
  /** False while the app is in the foreground but not active (iOS 'inactive'): nothing is measured. */
  private drawing = true
  /** What this launch last told the developer about the project keeping development builds. */
  private toldDevelopment: boolean | null = null

  constructor(private readonly env: ControllerEnv) {}

  get isSampled(): boolean {
    return this.sampled
  }

  get isEnabled(): boolean {
    return this.enabled
  }

  get session(): { nonce: string; seq: number; sampleRate: number } {
    return { nonce: this.nonce, seq: this.seq, sampleRate: this.sampleRate }
  }

  /** Starts reporting. Resolves when the session is set up (storage read, sampling decided). */
  async start(opts: ControllerOptions, meters: Meters): Promise<void> {
    if (this.enabled) this.stop(false)
    this.opts = opts
    this.meters = meters
    this.enabled = true
    const run = ++this.run
    const storage = opts.storage
    const stopUntil = await read<number>(storage, STORAGE_KEYS.stop)
    const cached = await read<CachedConfig>(storage, STORAGE_KEYS.config)
    if (run !== this.run) return
    if (typeof stopUntil === 'number' && stopUntil > this.env.wall()) {
      this.log('stopped on this device by the project until ' + new Date(stopUntil).toISOString())
      this.enabled = false
      return
    }
    // A development build asks the server on every launch: a cached "development builds off" would keep it
    // silent for up to a day after someone turns them on.
    const dev = opts.environment === 'development'
    this.config = dev ? null : (cached?.config ?? null)
    if (!this.allowed()) {
      this.enabled = false
      return
    }
    // Last launch's leftovers: a checkpoint (the app was killed with a window open) and failed uploads.
    const checkpoint = await read<VitalsReport>(storage, STORAGE_KEYS.checkpoint)
    if (run !== this.run) return
    if (checkpoint) {
      await write(storage, STORAGE_KEYS.checkpoint, null)
      // Periodic checkpoints are written with `ended: 'unknown'`; a window caught mid-upload keeps its own.
      await this.enqueue(JSON.stringify(checkpoint))
    }
    this.queued = ((await read<QueueItem[]>(storage, STORAGE_KEYS.queue)) ?? []).length
    if (run !== this.run) return
    this.retryStep = 0
    this.scheduleRetry()
    const fresh = !dev && cached && this.env.wall() - cached.at < Math.max(60, cached.config.ttlSec) * 1000
    if (!fresh) this.configTimer = this.env.setTimeout(() => void this.fetchConfig(run), START_DELAY_MS)
    await this.beginSession(run)
  }

  /** setVitalsEnabled: false stops at once and drops what is pending; true starts again. */
  async setEnabled(on: boolean): Promise<void> {
    if (!on) return this.stop(true)
    if (this.enabled || !this.opts || !this.meters) return
    await this.start(this.opts, this.meters)
  }

  /** Stops measuring and reporting. `drop`: the open window, the checkpoint and the retry store go too. */
  async stop(drop: boolean): Promise<void> {
    this.run++
    this.enabled = false
    this.endSampling()
    this.clearTimers()
    if (drop) this.queued = 0
    if (drop && this.opts?.storage) {
      await write(this.opts.storage, STORAGE_KEYS.checkpoint, null)
      await write(this.opts.storage, STORAGE_KEYS.queue, null)
    }
  }

  // ── Session ───────────────────────────────────────────────────────────────────────

  private async beginSession(run: number): Promise<void> {
    const now = this.env.now()
    this.nonce = makeNonce(this.env.random)
    this.seq = 0
    this.sampleRate = this.rate()
    const env = this.opts!.environment ?? 'production'
    const dev = env === 'development'
    const devOk = !dev || !this.config || this.config.collect.development
    const draw = this.env.random()
    let sampled = devOk && this.sampleRate > 0 && draw < this.sampleRate
    let capped = false
    // The daily cap spares people's phones in the field; a development build is someone testing.
    if (sampled && !dev) {
      const day = (this.env.day ?? localDay)(this.env.wall())
      if (!this.dayCount || this.dayCount.day !== day) {
        const saved = await read<{ day: string; n: number }>(this.opts!.storage, STORAGE_KEYS.day)
        if (run !== this.run) return
        this.dayCount = saved && saved.day === day ? saved : { day, n: 0 }
      }
      if (this.dayCount.n >= VITALS_MAX_SESSIONS_PER_DAY) {
        sampled = false
        capped = true
      } else {
        this.dayCount.n++
        await write(this.opts!.storage, STORAGE_KEYS.day, this.dayCount)
        if (run !== this.run) return
      }
    }
    this.sampled = sampled
    const why = sampled
      ? ''
      : !devOk
        ? ': the project does not keep development builds'
        : capped
          ? `: ${VITALS_MAX_SESSIONS_PER_DAY} sessions already reported today on this device (the daily cap)`
          : `: drew ${draw.toFixed(2)} against the rate`
    this.debug(
      `Motion Vitals ${SDK_VERSION}, session ${this.nonce.slice(0, 6)}: ${sampled ? 'sampled' : 'not sampled'} (rate ${this.sampleRate}, environment ${env})${why}`,
    )
    if (!sampled) return
    this.collector.clear()
    this.collector.setReduceMotion(this.reduceMotion)
    this.collector.setScreen(this.screen, now, false)
    if (this.foreground) this.collector.foreground(true, now)
    this.gate.reset()
    this.events.clear()
    this.meters!.install()
  }

  private endSampling(): void {
    this.metering = false
    if (this.sampled) {
      this.meters?.stop()
      this.meters?.uninstall()
    }
    this.sampled = false
    this.gate.reset()
    this.collector.clear()
    this.events.clear()
    this.uiKnownUntil = -Infinity
    if (this.checkpointTimer !== null) {
      this.env.clearTimeout(this.checkpointTimer)
      this.checkpointTimer = null
    }
  }

  /**
   * AppState. `active`: in the foreground (iOS 'inactive' counts, the app is still on screen). `drawing`:
   * 'active' itself; while it is false the meters stop and motion does not start them (jsLoop.ts).
   */
  appState(active: boolean, drawing = active): void {
    if (!this.enabled) return
    const now = this.env.now()
    if (this.drawing !== drawing) {
      this.drawing = drawing
      if (!drawing && this.sampled && this.foreground) {
        this.pauseMeters(now)
        this.debug('app inactive: meters paused until it is active again')
      }
    }
    if (!active && this.foreground) {
      this.foreground = false
      this.backgroundAt = now
      if (this.retryTimer !== null) {
        this.env.clearTimeout(this.retryTimer)
        this.retryTimer = null
      }
      if (this.sampled) {
        this.pauseMeters(now)
        this.collector.foreground(false, now)
        void this.closeWindow('background')
      }
    } else if (active && !this.foreground) {
      this.foreground = true
      const away = this.backgroundAt === null ? 0 : now - this.backgroundAt
      this.backgroundAt = null
      this.scheduleRetry()
      if (away > VITALS_SESSION_GAP_MS) {
        // A new session: new nonce, sampled again.
        this.endSampling()
        void this.beginSession(this.run)
      } else if (this.sampled) this.collector.foreground(true, now)
    }
  }

  setScreen(name: string): void {
    this.screen = name
    if (this.sampled) this.collector.setScreen(name, this.env.now())
  }

  setReduceMotion(on: boolean): void {
    this.reduceMotion = on && !!this.config?.collect.reduceMotion
    this.collector.setReduceMotion(this.reduceMotion)
  }

  // ── Motion ────────────────────────────────────────────────────────────────────────

  /** A new id for an animation call on the JS thread (the UI runtime numbers its own from UI_EVENT_BASE). */
  eid(): number {
    return this.nextEid++
  }

  /**
   * An animation call started at `t` (the JS clock). `args` are slimmed (`slimArg`): numbers, nested
   * calls as `{ $anim: eid }`, and config timing keys.
   */
  anim(site: SiteInfo, args: unknown[], eid: number, thread: VitalsThread, t = this.env.now()): void {
    if (!this.sampled || !this.foreground) return
    const ev: EstimateEvent = { site: { fn: site.fn }, args }
    this.events.set(eid, ev)
    if (this.events.size > MAX_EVENTS) this.events.delete(this.events.keys().next().value!)
    const ms = estimateMs(ev, (id) => this.events.get(id))
    for (const a of args) if (isRef(a)) this.collector.consume(a.$anim)
    this.collector.animStart(site, t, ms, thread, eid)
    if (this.opts?.debug) this.tracedAnims++
    this.motion(t + ms, t)
  }

  /**
   * A layout animation started (entering, exiting, layout). Reanimated's builders keep their timing in
   * `durationV` / `delayV`; a builder class passed as it is (`entering={FadeIn}`) runs its default 300 ms.
   */
  layout(site: SiteInfo, kind: 'entering' | 'exiting' | 'layout', builder: unknown, t = this.env.now()): void {
    const read = (k: string): number | undefined => {
      try {
        const v = (builder as Record<string, unknown> | null)?.[k]
        return typeof v === 'number' && Number.isFinite(v) ? v : undefined
      } catch {
        return undefined
      }
    }
    this.anim({ ...site, fn: kind }, [{ duration: read('durationV') ?? 300, delay: read('delayV') ?? 0 }], this.eid(), 'js', t)
  }

  scroll(t = this.env.now()): void {
    if (!this.sampled || !this.foreground) return
    this.collector.scroll(t)
    this.motion(t, t)
  }

  touch(down: boolean, t = this.env.now()): void {
    if (!this.sampled || !this.foreground) return
    this.collector.touch(down, t)
    if (!this.drawing) return
    if (this.gate.touch(down, t)) this.opened(t)
    this.keepUi(t)
  }

  private motion(end: number, now: number): void {
    if (!this.drawing) return
    if (this.gate.note(end, now)) this.opened(now)
    this.keepUi(now)
    this.checkWindow(now)
  }

  /** Meters off and the gate shut: measured time stops at `now`; the next motion starts them again. */
  private pauseMeters(now: number): void {
    this.gate.reset()
    this.meters?.stop()
    this.collector.measure(false, now)
    if (this.metering && this.opts?.debug) {
      this.flushTrace()
      this.debug('meters off: the app left the screen')
    }
    this.metering = false
    this.uiKnownUntil = -Infinity
  }

  private opened(now: number): void {
    if (!this.metering) this.debug('meters on: something moves')
    this.metering = true
    this.collector.measure(true, now)
    this.meters?.start()
    this.scheduleCheckpoint()
  }

  /** The UI loop keeps its own time: tell it how long the gate stays open when that grows. */
  private keepUi(now: number): void {
    const closes = this.gate.closesAt()
    const want = closes === Infinity ? now + 2000 : closes
    if (want > this.uiKnownUntil + 50 && want > now) {
      this.uiKnownUntil = want
      this.meters?.extendUi(want - now)
    }
  }

  /**
   * One JS-thread frame. Returns whether the JS loop goes on: false once the gate has closed (the
   * meters stop themselves, nothing keeps a timer).
   */
  jsFrame(t: number, dt: number, budget: number): boolean {
    if (!this.sampled || !this.foreground || !this.drawing) return false
    if (dt > 0) {
      this.collector.frame('js', t, dt, budget)
      if (this.opts?.debug) this.traceFrame('js', dt, t)
    }
    if (!this.gate.open(t)) {
      this.collector.measure(false, Math.min(t, this.gate.until))
      if (this.metering && this.opts?.debug) {
        this.flushTrace()
        this.debug('meters off: the motion window closed')
      }
      this.metering = false
      return false
    }
    this.keepUi(t)
    this.checkWindow(t)
    return true
  }

  /** UI-thread frames as `[t, dt, budget, …]`, `t` already on the JS clock. */
  uiFrames(buf: number[]): void {
    if (!this.sampled) return
    for (let i = 0; i + 2 < buf.length; i += 3) this.collector.frame('ui', buf[i]!, buf[i + 1]!, buf[i + 2]!)
    if (this.opts?.debug) for (let i = 0; i + 2 < buf.length; i += 3) this.traceFrame('ui', buf[i + 1]!, buf[i]!)
  }

  // ── debug ─────────────────────────────────────────────────────────────────────────

  private traceFrame(thread: VitalsThread, dt: number, t: number): void {
    const cur = this.traced[thread]
    // A second's worth on this thread, or a gap since its last frame (the meters were off): print first.
    if (cur && (t - cur.since >= 1000 || t - dt > cur.last + 100)) this.flushTrace()
    const s = (this.traced[thread] ??= { n: 0, sum: 0, min: Infinity, max: 0, since: t - dt, last: t })
    s.n++
    s.sum += dt
    if (dt < s.min) s.min = dt
    if (dt > s.max) s.max = dt
    s.since = Math.min(s.since, t - dt)
    s.last = Math.max(s.last, t)
  }

  /** One line: frames a second per thread (60, 90 or 120 when the meters are right) and their gaps. */
  private flushTrace(): void {
    const all = Object.values(this.traced)
    if (!all.length) return
    const ms = (v: number) => (Math.round(v * 10) / 10).toString()
    const part = (th: VitalsThread) => {
      const s = this.traced[th]
      if (!s) return `${th}: no frames`
      const span = Math.max(1, s.last - s.since)
      return `${th}: ${s.n} frames in ${Math.round(span)} ms, ${Math.round((s.n * 1000) / span)}/s (gap min ${ms(s.min)}, avg ${ms(s.sum / s.n)}, max ${ms(s.max)} ms)`
    }
    this.debug(`on ${this.collector.currentScreen}, ${this.tracedAnims} animation starts. ${part('js')}; ${part('ui')}`)
    this.traced = {}
    this.tracedAnims = 0
  }

  private traceReport(report: VitalsReport): void {
    const frames: Partial<Record<VitalsThread, number>> = {}
    for (const s of report.screens) for (const [th, st] of Object.entries(s.threads) as Array<[VitalsThread, { frames: number } | undefined]>) frames[th] = (frames[th] ?? 0) + (st?.frames ?? 0)
    const measured = report.session.measuredMs
    const cap = Math.ceil((measured * VITALS_MAX_HZ) / 1000)
    const over = (Object.entries(frames) as Array<[VitalsThread, number]>).filter(([, n]) => n > cap).map(([th]) => th)
    this.debug(
      `report ${report.session.seq} (${report.session.ended}): measured ${measured} ms of ${report.session.foregroundMs} ms in the foreground, ` +
        `so at most about ${cap} frames a thread; js ${frames.js ?? 0}, ui ${frames.ui ?? 0}` +
        `${over.length ? ` (too many on ${over.join(' and ')}: the server will refuse it)` : ''}; ` +
        `${report.screens.length} screens, ${report.sites.length} animation sites`,
    )
  }

  // ── Windows, checkpoints, uploads ─────────────────────────────────────────────────

  private checkWindow(now: number): void {
    if (this.collector.foregroundAt(now) >= VITALS_WINDOW_MS) void this.closeWindow('window')
  }

  /** The report the open window would send now, or null when it holds nothing. */
  report(ended: VitalsReport['session']['ended'], now = this.env.now()): VitalsReport | null {
    if (!this.opts) return null
    const snap = this.collector.snapshot(now)
    if (!hasData(snap)) return null
    return encodeReport(snap, this.context(ended))
  }

  private async closeWindow(ended: 'background' | 'window'): Promise<void> {
    if (!this.sampled) return
    const now = this.env.now()
    const report = this.report(ended, now)
    this.collector.reset(now)
    if (this.checkpointTimer !== null) {
      this.env.clearTimeout(this.checkpointTimer)
      this.checkpointTimer = null
    }
    const storage = this.opts?.storage
    if (!report) {
      this.debug(`window closed (${ended}) with nothing to report`)
      await write(storage, STORAGE_KEYS.checkpoint, null)
      return
    }
    this.seq++
    if (this.opts?.debug) {
      this.flushTrace()
      this.traceReport(report)
    }
    // Kept until it is sent or queued: a process killed in the background sends it next launch.
    await write(storage, STORAGE_KEYS.checkpoint, report)
    await this.send(JSON.stringify(report))
    await write(storage, STORAGE_KEYS.checkpoint, null)
  }

  private scheduleCheckpoint(): void {
    if (this.checkpointTimer !== null || !this.opts?.storage) return
    this.checkpointTimer = this.env.setTimeout(() => {
      this.checkpointTimer = null
      void this.checkpoint()
    }, CHECKPOINT_MS)
  }

  /** Writes the open window to storage, sent on the next launch if this process never sends it. */
  async checkpoint(): Promise<void> {
    if (!this.sampled || !this.opts?.storage) return
    const report = this.report('unknown')
    if (report) await write(this.opts.storage, STORAGE_KEYS.checkpoint, report)
  }

  private context(ended: VitalsReport['session']['ended']): ReportContext {
    const o = this.opts!
    const d = o.device ?? {}
    const collect = this.config?.collect
    const memoryGb = d.memoryGb ?? (d.memoryBytes ? Math.round((d.memoryBytes / 1024 ** 3) * 10) / 10 : undefined)
    const device: VitalsReport['device'] = { os: this.env.platform.os, osMajor: this.env.platform.osMajor }
    if (d.model && collect?.deviceModel !== false) device.model = String(d.model).slice(0, 64)
    if (d.tier) device.tier = d.tier
    if (memoryGb) device.memoryGb = memoryGb
    const app: VitalsReport['app'] = {
      ...(o.appId ? { id: o.appId } : {}),
      version: o.appVersion.slice(0, 64),
      ...(o.build ? { build: String(o.build).slice(0, 64) } : {}),
      platform: 'react-native',
      framework: 'React Native',
      environment: o.environment ?? 'production',
    }
    return {
      app,
      sdk: { name: SDK_NAME, version: SDK_VERSION },
      device,
      display: d.displayHz ? { hz: d.displayHz } : undefined,
      collectReduceMotion: !!collect?.reduceMotion,
      session: { nonce: this.nonce, seq: this.seq, sampleRate: this.sampleRate, ended },
    }
  }

  private endpoint(): string {
    return (this.opts?.endpoint ?? VITALS_ENDPOINT).replace(/\/+$/, '')
  }

  /** Posts a report; on a failure that may pass (offline, 429, 5xx), into the retry store. */
  private async send(body: string): Promise<void> {
    const run = this.run
    if ((await this.sendOnce(body)) === 'retry' && run === this.run) await this.enqueue(body)
  }

  private async enqueue(body: string): Promise<void> {
    const storage = this.opts?.storage
    if (!storage) return
    const queue = (await read<QueueItem[]>(storage, STORAGE_KEYS.queue)) ?? []
    queue.push({ body, at: this.env.wall() })
    const kept = this.trim(queue)
    await write(storage, STORAGE_KEYS.queue, kept)
    this.queued = kept.length
    this.scheduleRetry()
  }

  /** The retry store's limits: newest first kept, at most 5 reports, 100 KB, 7 days old. */
  private trim(queue: QueueItem[]): QueueItem[] {
    const wall = this.env.wall()
    const out: QueueItem[] = []
    let bytes = 0
    for (let i = queue.length - 1; i >= 0 && out.length < RETRY.max; i--) {
      const q = queue[i]!
      if (wall - q.at > RETRY.ageMs || typeof q.body !== 'string') continue
      if (bytes + q.body.length > RETRY.bytes) continue
      bytes += q.body.length
      out.unshift(q)
    }
    return out
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== null || !this.queued || !this.foreground || !this.enabled || !this.opts?.storage) return
    if (this.retryStep >= RETRY.delays.length) return
    const delay = RETRY.delays[this.retryStep]!
    this.retryTimer = this.env.setTimeout(() => {
      this.retryTimer = null
      this.retryStep++
      void this.retry()
    }, delay)
  }

  /** Sends what waits in the retry store, oldest first; what fails again stays for the next step. */
  async retry(): Promise<void> {
    const storage = this.opts?.storage
    if (!storage || !this.enabled) return
    const run = this.run
    const queue = this.trim((await read<QueueItem[]>(storage, STORAGE_KEYS.queue)) ?? [])
    await write(storage, STORAGE_KEYS.queue, null)
    this.queued = 0
    if (!queue.length) return
    const left: QueueItem[] = []
    for (const q of queue) {
      if (run !== this.run) return
      const r = await this.sendOnce(q.body)
      if (r === 'retry') left.push(q)
    }
    if (left.length && run === this.run) {
      const now = (await read<QueueItem[]>(storage, STORAGE_KEYS.queue)) ?? []
      const kept = this.trim([...left, ...now])
      await write(storage, STORAGE_KEYS.queue, kept)
      this.queued = kept.length
      this.scheduleRetry()
    }
  }

  private async sendOnce(body: string): Promise<'done' | 'retry'> {
    try {
      const res = await this.env.fetch(`${this.endpoint()}/v1/reports`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.opts!.key}`, 'Content-Type': 'application/json' },
        body,
      })
      if (res.status === 200) {
        this.debug('report accepted')
        const json = (await res.json().catch(() => null)) as { config?: VitalsConfig } | null
        if (json?.config) await this.applyConfig(json.config)
        return 'done'
      }
      if (res.status === 401 || res.status === 410) {
        await this.killSwitch()
        return 'done'
      }
      if (res.status === 429 || res.status >= 500) return 'retry'
      // 400, 413: this report will never pass. The server says why (the validator's first errors).
      const why = ((await res.json().catch(() => null)) as { error?: string } | null)?.error
      this.log(`report refused (${res.status})${why ? `: ${why}` : ''}`)
      return 'done'
    } catch {
      return 'retry'
    }
  }

  private async fetchConfig(run: number): Promise<void> {
    this.configTimer = null
    if (run !== this.run || !this.opts) return
    try {
      // A fresh URL each time: the server marks the answer no-store, but servers before that sent max-age,
      // and a phone's HTTP cache (URLSession, OkHttp) kept a stale "development builds off" for hours.
      const fresh = Math.round(this.env.wall()).toString(36)
      const res = await this.env.fetch(`${this.endpoint()}/v1/config/${encodeURIComponent(this.opts.key)}?t=${fresh}`, {
        method: 'GET',
        headers: { 'Cache-Control': 'no-cache' },
      })
      if (run !== this.run) return
      if (res.status === 200) {
        const config = (await res.json()) as VitalsConfig
        if (config && typeof config === 'object' && typeof config.sampleRate === 'number') {
          this.debug(`config: sample rate ${config.sampleRate}, development builds ${config.collect?.development ? 'collected' : 'not collected'}`)
          await this.applyConfig(config)
        }
      } else if (res.status === 401 || res.status === 410) await this.killSwitch()
    } catch {
      // Offline: the cached or compiled-in defaults stay.
    }
  }

  /** A config from the server: cached, and acted on (stop, disabled, a minimum SDK version). */
  async applyConfig(config: VitalsConfig): Promise<void> {
    this.config = config
    await write(this.opts?.storage, STORAGE_KEYS.config, { config, at: this.env.wall() } satisfies CachedConfig)
    if (config.stop) return this.killSwitch()
    if (!this.allowed()) {
      await this.stop(false)
      return
    }
    // Reduce Motion is reported only while the project collects it.
    if (!config.collect.reduceMotion) this.setReduceMotion(false)
    if (this.opts?.environment === 'development') this.developmentConfig(config.collect.development)
  }

  /**
   * A development build learns whether the project keeps its reports. Off: the developer is told once a
   * launch (the server would drop every report) and measuring stops; on: said under `debug`.
   */
  private developmentConfig(kept: boolean): void {
    if (this.toldDevelopment !== kept) {
      this.toldDevelopment = kept
      if (kept) this.debug("this project keeps development builds: this build's reports show in the dashboard's Development view")
      else
        this.env.log?.(
          `${TAG} This project does not keep reports from development builds, so this build sends nothing. ` +
            'To test here, turn on "Development builds" in the project\'s setup on keyframer.dev, then reload. Release builds are not affected.',
          'info',
        )
    }
    if (!kept && this.sampled) this.endSampling()
  }

  private async killSwitch(): Promise<void> {
    this.log('turned off on this device for 7 days by the project')
    const storage = this.opts?.storage
    await this.stop(true)
    await write(storage, STORAGE_KEYS.stop, this.env.wall() + STOP_MS)
  }

  private allowed(): boolean {
    const c = this.config
    if (!c) return true
    if (!c.enabled) return false
    const min = c.minSdk?.['react-native']
    if (min && compareVersions(SDK_VERSION, min) < 0) {
      this.log(`this SDK version (${SDK_VERSION}) is below the project's minimum (${min}): off`)
      return false
    }
    return true
  }

  /**
   * Release builds: the project's rate once its config is known, the app's until then. Development builds:
   * the app's own rate, else every session. Someone is testing, and the project's 10% left nine runs in
   * ten silent after the first session.
   */
  private rate(): number {
    const r =
      this.opts?.environment === 'development'
        ? (this.opts.sampleRate ?? 1)
        : this.config
          ? this.config.sampleRate
          : (this.opts?.sampleRate ?? VITALS_DEFAULT_SAMPLE_RATE)
    return Number.isFinite(r) ? Math.max(0, Math.min(1, r)) : VITALS_DEFAULT_SAMPLE_RATE
  }

  private clearTimers(): void {
    for (const k of ['checkpointTimer', 'retryTimer', 'configTimer'] as const) {
      if (this[k] !== null) {
        this.env.clearTimeout(this[k])
        this[k] = null
      }
    }
  }

  private log(message: string): void {
    this.env.log?.(`${TAG} ${message}`, 'warn')
  }

  private debug(message: string): void {
    if (this.opts?.debug) this.env.log?.(`${TAG} ${message}`, 'debug')
  }
}
