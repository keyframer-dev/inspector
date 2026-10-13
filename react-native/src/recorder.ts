/**
 * Records a session on the device, with no panel connected: what a tester runs when they see a glitch,
 * and what they send the developer. The result is an InspectorRecording, one JSON file the panel (and
 * the MCP server) open like a live recording.
 *
 * It samples every shared value the app rendered, measures both threads' frames, keeps every
 * animation that starts (with its JS stack) and every React commit, takes a screenshot now and then,
 * and takes markers from outside: touches, navigation, app state, keyboard, logs.
 *
 * Pure TypeScript with the clock, frame loop, UI-thread meter and screenshot function injected, so it
 * runs under vitest; recordNative.ts wires it to React Native.
 */

import type {
  InspectorCommit,
  InspectorFrameDrop,
  InspectorFrameStat,
  InspectorMarker,
  InspectorRecordedAnim,
  InspectorRecording,
  InspectorRect,
  InspectorSample,
  InspectorScreenshot,
  InspectorTask,
  InspectorUiWork,
} from '../../protocol/inspector'
import { captureStack, sanitizeArgs, type CaptureScreen } from './client'
import { watchCommits } from './commits'
import { createFrameMeter, tickFrameMeter } from './frameMeter'
import { createInspector, isInspectorInstalled, registeredSignals, registeredStyles, restingOffsets, tapInspector, tapScrollMounts } from './runtime'
import { watchTasks } from './tasks'

/** Measures the UI thread's frames until the returned function is called; `at` is the UI clock's time of the latest frame. */
export type UiFrameMeter = (onFrames: (stats: InspectorFrameStat[], drops: InspectorFrameDrop[], at: number) => void) => () => void

export type RecorderOptions = {
  app: InspectorRecording['app']
  screen: InspectorRecording['screen']
  now?: () => number
  wallClock?: () => Date
  requestFrame?: (cb: () => void) => unknown
  /** Installs an inspector when none is (returns its uninstall); the default installs a JS-only one. */
  ensureInspector?: () => (() => void) | null
  measureUiFrames?: UiFrameMeter
  /** The last offset each list reported (native.ts snapshotScroll): where they rest when recording starts. */
  scrollSnapshot?: (onSnapshot: (last: Record<string, number[]>) => void) => void
  /** Scroll offsets of lists per frame (native.ts watchUiScroll): recorded as `<id>:x` / `<id>:y` tracks. */
  watchUiScroll?: (onRows: (rows: Array<[number, string, number, number]>) => void) => () => void
  /** Timed worklet runs on the UI thread per frame (native.ts watchUiWork). */
  watchUiWork?: (onRows: (rows: Array<[number, string, string, string | null, number, number]>) => void) => () => void
  /** Reads shared values on the UI thread every frame (native.ts sampleUiValues); a JS timer when absent. */
  sampleUi?: (values: unknown[], onRows: (rows: number[][]) => void) => () => void
  captureScreen?: CaptureScreen
  /**
   * Where text inputs are on screen when a screenshot is taken (record.ts: the focused one), in
   * points: kept with the screenshot so a shared copy can blur them (redact.ts).
   */
  inputRegions?: () => Promise<InspectorRect[]> | InspectorRect[]
  /** How often to take a screenshot, ms. 0 turns them off. Default 1500. */
  screenshotEveryMs?: number
  sampleMs?: number
  /** Stops by itself after this long, ms. Default 120 000. */
  maxDurationMs?: number
  onAutoStop?: (rec: InspectorRecording) => void
}

export type Recorder = {
  /** ms since the recording started. */
  elapsed(): number
  /** Adds a touch, navigation, app state, keyboard, log or note marker, timed now (or at `t`). */
  mark(marker: DistributiveOmit<InspectorMarker, 't'>, t?: number): void
  stop(note?: string): InspectorRecording
}
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

const MAX_MARKERS = 20_000
const MAX_ITEMS = 5000
const MAX_SAMPLES = 120_000

export function startRecorder(opts: RecorderOptions): Recorder {
  const now = opts.now ?? (() => Date.now())
  const startedAt = (opts.wallClock ?? (() => new Date()))().toISOString()
  const t0 = now()
  const elapsed = () => Math.round(now() - t0)
  const requestFrame =
    opts.requestFrame ?? (globalThis as { requestAnimationFrame?: (cb: () => void) => unknown }).requestAnimationFrame?.bind(globalThis)

  const samples: InspectorSample[] = []
  const frames: InspectorFrameStat[] = []
  const drops: InspectorFrameDrop[] = []
  const anims: InspectorRecordedAnim[] = []
  const commits: InspectorCommit[] = []
  const markers: InspectorMarker[] = []
  const screenshots: InspectorScreenshot[] = []
  const tasks: InspectorTask[] = []
  const work: InspectorUiWork[] = []
  const sampled = new Set<string>()
  let stopped = false

  // Animations are reported through the inspector hook: install one when nothing else has.
  const uninstall = isInspectorInstalled()
    ? null
    : (opts.ensureInspector ?? (() => createInspector({ send: () => {} }).install()))()

  const untap = tapInspector((e) => {
    if (e.kind !== 'anim' || anims.length >= MAX_ITEMS) return
    const thread = e.thread ?? 'js'
    // Taps run synchronously inside the instrumented call: the stack still holds the app code.
    anims.push({ t: elapsed(), thread, site: e.site, args: sanitizeArgs(e.args), ...(thread === 'js' ? { stack: captureStack() } : {}) })
  })

  // Shared values: on the UI thread every frame (what was on screen, at the frame's time) when the
  // platform can, else from JS on a timer. New screens register new values: the UI sampler restarts
  // with them.
  const isValue = (sv: unknown) => !!sv && typeof sv === 'object' && 'value' in (sv as object)
  let stopUiSampling: (() => void) | null = null
  let sampledValues: unknown[] = []
  let sampleOffset = Infinity
  const startUiSampling = () => {
    const entries = [...registeredSignals()].filter(([, x]) => isValue(x.sv))
    // Restart when a value mounted, or one was replaced (a screen re-mounted: same call site, new
    // shared value); the old one no longer moves.
    if (entries.length === sampledValues.length && entries.every(([, x], i) => x.sv === sampledValues[i])) return
    sampledValues = entries.map(([, x]) => x.sv)
    stopUiSampling?.()
    const ids = entries.map(([id]) => id)
    stopUiSampling = opts.sampleUi!(
      entries.map(([, x]) => x.sv),
      (rows) => {
        if (stopped || samples.length >= MAX_SAMPLES) return
        const t = elapsed()
        for (const row of rows) sampleOffset = Math.min(sampleOffset, t - row[0]!)
        for (const row of rows) {
          const at = Math.round(row[0]! + sampleOffset)
          for (let i = 0; i < ids.length; i++) {
            const v = row[i + 1]!
            if (!Number.isFinite(v)) continue
            samples.push({ id: ids[i]!, t: at, v })
            sampled.add(ids[i]!)
          }
        }
      },
    )
  }
  const sampleTimer = opts.sampleUi
    ? setInterval(startUiSampling, 250)
    : setInterval(() => {
        if (samples.length >= MAX_SAMPLES) return
        const t = elapsed()
        for (const [id, { sv }] of registeredSignals()) {
          const v = (sv as { value?: unknown } | null)?.value
          if (typeof v !== 'number' || !Number.isFinite(v)) continue
          samples.push({ id, t, v })
          sampled.add(id)
        }
      }, opts.sampleMs ?? 16)
  if (opts.sampleUi) startUiSampling()

  // JS thread frames.
  const jsMeter = createFrameMeter('js')
  const jsFrame = () => {
    if (stopped) return
    tickFrameMeter(jsMeter, elapsed())
    if (frames.length < MAX_ITEMS) frames.push(...jsMeter.stats.splice(0))
    else jsMeter.stats.length = 0
    if (drops.length < MAX_ITEMS) drops.push(...jsMeter.drops.splice(0))
    else jsMeter.drops.length = 0
    requestFrame?.(jsFrame)
  }
  requestFrame?.(jsFrame)

  // UI thread frames, mapped onto the recording's clock by the smallest offset seen.
  let uiOffset = Infinity
  const stopUi = opts.measureUiFrames?.((stats, ds, at) => {
    uiOffset = Math.min(uiOffset, elapsed() - at)
    if (frames.length < MAX_ITEMS) for (const x of stats) frames.push({ ...x, t: Math.round(x.t + uiOffset) })
    if (drops.length < MAX_ITEMS) for (const d of ds) drops.push({ ...d, t: Math.round(d.t + uiOffset) })
  })

  // JS tasks (handlers, effects, timers) on the wall clock, and UI-thread worklets per frame on the UI clock.
  const unwatchTasks = watchTasks(({ end, ...task }) => {
    if (tasks.length < MAX_ITEMS) tasks.push({ ...task, t: Math.max(0, Math.round(elapsed() - (Date.now() - end))) })
  })
  let workOffset = Infinity
  const unwatchWork = opts.watchUiWork?.((rows) => {
    const t = elapsed()
    for (const r of rows) workOffset = Math.min(workOffset, t - r[0])
    for (const [ut, kind, site, name, ms, calls] of rows) {
      if (work.length >= MAX_ITEMS * 4) break
      work.push({ t: Math.round(ut + workOffset), ms: Math.round(ms * 100) / 100, calls, kind, site, name })
    }
  })

  // Lists' scroll offsets, so playback can scroll the real list. A track counts once it moved.
  let scrollOffset = Infinity
  const scrollFirst = new Map<string, number>()
  const scrollMoved = new Set<string>()
  // Lists report only while they move: where they rest now is the recording's first frame.
  opts.scrollSnapshot?.((last) => {
    for (const { id, x, y } of restingOffsets(last)) {
      for (const [axis, v] of [['x', x], ['y', y]] as const) {
        samples.push({ id: `${id}:${axis}`, t: 0, v })
        if (!scrollFirst.has(`${id}:${axis}`)) scrollFirst.set(`${id}:${axis}`, v)
      }
    }
  })
  // A list that mounts while recording starts at rest, at 0.
  const offScrollMounts = tapScrollMounts((id) => {
    const t = elapsed()
    for (const axis of ['x', 'y']) samples.push({ id: `${id}:${axis}`, t, v: 0 })
  })
  const unwatchScroll = opts.watchUiScroll?.((rows) => {
    if (stopped || samples.length >= MAX_SAMPLES) return
    const t = elapsed()
    for (const r of rows) scrollOffset = Math.min(scrollOffset, t - r[0])
    for (const [ut, id, x, y] of rows) {
      const at = Math.round(ut + scrollOffset)
      for (const [axis, v] of [['x', x], ['y', y]] as const) {
        const track = `${id}:${axis}`
        samples.push({ id: track, t: at, v })
        if (!scrollFirst.has(track)) scrollFirst.set(track, v)
        else if (scrollFirst.get(track) !== v) scrollMoved.add(track)
      }
    }
  })

  const unwatchCommits = watchCommits((c) => {
    if (commits.length < MAX_ITEMS) commits.push(c)
  }, elapsed)

  // Screenshots: one right away, then every few seconds; never two at once.
  let shooting = false
  const shoot = async () => {
    if (!opts.captureScreen || shooting || stopped) return
    shooting = true
    const t = elapsed()
    try {
      const [data, inputs] = await Promise.all([
        opts.captureScreen({ format: 'jpg', quality: 0.45, result: 'base64', width: Math.round(opts.screen.width) }),
        Promise.resolve(opts.inputRegions?.()).catch(() => undefined),
      ])
      if (!stopped) screenshots.push({ t, ms: elapsed() - t, data, format: 'jpg', ...(inputs?.length ? { inputs } : {}) })
    } catch {
      // A screenshot is a nice-to-have: the recording goes on without it.
    } finally {
      shooting = false
    }
  }
  const every = opts.screenshotEveryMs ?? 1500
  const shotTimer = opts.captureScreen && every > 0 ? setInterval(shoot, every) : null
  void shoot()

  const finish = (note?: string): InspectorRecording => {
    stopped = true
    clearInterval(sampleTimer)
    stopUiSampling?.()
    if (shotTimer) clearInterval(shotTimer)
    if (autoStop) clearTimeout(autoStop)
    untap()
    stopUi?.()
    unwatchCommits()
    unwatchTasks()
    unwatchWork?.()
    unwatchScroll?.()
    offScrollMounts()
    uninstall?.()
    const sites = [...registeredSignals().values()].map((x) => x.site).filter((x) => sampled.has(x.id))
    for (const track of scrollMoved) {
      const [, file, line] = /^scroll:(.*):(\d+):[xy]$/.exec(track) ?? []
      sites.push({ id: track, file: file ?? track, line: Number(line ?? 0), component: null, name: `scroll ${track.slice(-1)}` })
    }
    return {
      format: 'keyframer-recording',
      version: 1,
      app: opts.app,
      startedAt,
      duration: elapsed(),
      screen: opts.screen,
      signals: sites,
      samples,
      frames,
      drops,
      anims,
      commits,
      // Touches are timed by the screen, the rest when JS saw them: one order for the file.
      markers: markers.sort((a, b) => a.t - b.t),
      screenshots,
      tasks,
      work,
      styles: [...registeredStyles().values()],
      ...(note ? { note } : {}),
    }
  }

  let result: InspectorRecording | null = null
  const stop = (note?: string) => (result ??= finish(note))
  const autoStop = setTimeout(() => opts.onAutoStop?.(stop()), opts.maxDurationMs ?? 120_000)

  return {
    elapsed,
    mark(m, t) {
      if (stopped || markers.length >= MAX_MARKERS) return
      markers.push({ ...m, t: t ?? elapsed() } as InspectorMarker)
    },
    stop,
  }
}
