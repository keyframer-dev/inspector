/**
 * The app's side of the live inspector: joins a pairing room as `app`, reports what the instrumented
 * code does, and takes edits back.
 *
 *   - Every animation, shared value and animated style the Babel plugin tagged is reported to the
 *     editors, batched every ~100 ms.
 *   - `overrides` from an editor apply the next time each animation runs ("applies on next replay").
 *   - `replay` calls whatever the app registered with registerReplay (re-mount a screen, re-fire an
 *     entrance).
 *   - `record` samples the listed shared values at ~60 Hz and streams them back: gestures, sensors and
 *     scroll have no timeline, so this is how the editor sees them move.
 *   - `playback` writes recorded samples back into the same shared values in time order, so a recorded
 *     drag can be replayed exactly while a spring or an interpolate range is being tuned.
 *   - While recording, each animation carries when it started and (on the JS thread) its stack, and
 *     React commits are timed: what a frame drop can be traced back to.
 *   - `capture` sets shared values, waits for the screen to show them and snapshots it with the
 *     `captureScreen` the app passed in (react-native-view-shot's): one frame of an exported recording.
 *
 * Pure TypeScript with the socket and timers injected, so it runs under vitest. React Native apps
 * import `connectInspector` from '@keyframerdev/inspector/native', which adds the UI-thread hook.
 */

import type {
  InspectorAppMessage,
  InspectorBuild,
  InspectorCallSite,
  InspectorCommit,
  InspectorEditorMessage,
  InspectorEvent,
  InspectorFrameDrop,
  InspectorFrameStat,
  InspectorMarker,
  InspectorOverrides,
  InspectorPresenceMessage,
  InspectorRoute,
  InspectorSample,
  InspectorTask,
  InspectorUiWork,
} from '../../protocol/inspector'
import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_TIMEOUT_MS, inspectorRoomUrl, PING, PONG } from './room'
import { watchCommits } from './commits'
import { createFrameMeter, tickFrameMeter } from './frameMeter'
import { REACT_NATIVE_THREADS } from './platforms'
import { applyScrollSamples, createInspector, navigateTo, jsScrollOffsets, restingOffsets, setCapturing, tapJsScroll, tapScrollMounts } from './runtime'
import { PROTOCOL, SDK } from './version'
import { runScenario, scenarioNames, watchScenarios } from './scenarios'
import { watchTasks } from './tasks'
import { captureStack } from './stack'

export { captureStack } from './stack'

export type SocketLike = {
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: unknown) => void) | null
  onerror: ((ev: unknown) => void) | null
}
export type SocketConstructor = new (url: string) => SocketLike

/** What a bridge (the UI-thread hook) gets to work with. */
export type InspectorBridgeContext = {
  /** Report an animation that ran on another thread, with overrides already applied. */
  report(site: InspectorCallSite, args: unknown[]): void
  overrides: InspectorOverrides
  /**
   * Frame stats measured on another thread, timed by that thread's clock. `at` is that clock's time of
   * the latest frame, which maps them onto the recording's clock.
   */
  reportFrames?(stats: InspectorFrameStat[], drops: InspectorFrameDrop[], at: number): void
}
export type InspectorBridge = {
  setOverrides?(overrides: InspectorOverrides): void
  /** Start / stop measuring this thread's frames (on while anything records). */
  measureFrames?(on: boolean): void
  /**
   * Reads these shared values on the UI thread every frame until the returned function is called:
   * rows of `[uiTime, ...values]`. Recording uses it instead of a JS timer when a bridge has it.
   */
  sampleValues?(values: unknown[], onRows: (rows: number[][]) => void): () => void
  /** Touches and gesture callbacks as markers on the recording's clock (`elapsed`), until the returned function is called. */
  watchMarkers?(elapsed: () => number, onMarker: (m: InspectorMarker) => void): () => void
  /** Timed worklet runs on the UI thread, per frame: rows of [uiTime, kind, site, name, ms, calls]. */
  watchWork?(onRows: (rows: Array<[number, string, string, string | null, number, number]>) => void): () => void
  /** Where scrolled lists are, per frame: rows of [uiTime, scroll id, x, y]. */
  watchScroll?(onRows: (rows: Array<[number, string, number, number]>) => void): () => void
  /** The last offset each list reported, [x, y, Date.now()] by scroll id: where lists rest when recording starts. */
  scrollSnapshot?(onSnapshot: (last: Record<string, number[]>) => void): void
  dispose?(): void
}

export type ConnectInspectorOptions = {
  apiUrl: string
  code: string
  app?: string
  platform?: string
  /** The OS version, for the recording's header and the problems engine. */
  osVersion?: string
  /** The project folder on the developer's machine: call-site paths resolve against it to open in an editor. */
  root?: string
  /** Defaults to the global WebSocket. */
  WebSocket?: SocketConstructor
  batchMs?: number
  sampleMs?: number
  now?: () => number
  /** Schedules the JS frame loop measured while recording. Defaults to the global requestAnimationFrame. */
  requestFrame?: (cb: () => void) => unknown
  /** Extra hooks installed alongside the JS one (the native entry adds the UI-thread hook). */
  bridges?: Array<(ctx: InspectorBridgeContext) => InspectorBridge>
  /**
   * Snapshots the screen as base64, for exporting a recording as a GIF or MP4. On React Native it is
   * found without this when react-native-view-shot or Skia is installed (src/capture.ts); pass one to
   * choose, or null to turn capture off.
   */
  captureScreen?: CaptureScreen | null
  /** The screen in points, sent with hello so the panel can place touches on captured frames. */
  screen?: { width: number; height: number; scale: number }
  /** How the app was built, sent with hello. Default: `__DEV__ ? 'debug' : 'release'`. */
  build?: InspectorBuild
  /**
   * What `reload` from an editor runs: restart the JavaScript from a clean state (the fix loop and CI
   * reload between runs). Default: React Native's DevSettings.reload(), in development builds only.
   */
  reload?: (() => void) | null
}

/** `debug` when React Native's __DEV__ is on, `release` when it is off, unknown elsewhere. */
function defaultBuild(): InspectorBuild | undefined {
  const dev = (globalThis as { __DEV__?: unknown }).__DEV__
  return typeof dev === 'boolean' ? (dev ? 'debug' : 'release') : undefined
}

type DevSettingsModule = { reload?: () => void; reloadWithReason?: (reason: string) => void }
type NativeGlobals = {
  __DEV__?: unknown
  __turboModuleProxy?: (name: string) => unknown
  nativeModuleProxy?: Record<string, unknown>
  /** Expo's runtime (expo-modules-core): reloadAppAsync is what `import { reloadAppAsync } from 'expo'` calls. */
  expo?: { reloadAppAsync?: (reason: string) => Promise<void> }
}

/**
 * React Native's DevSettings native module, what DevSettings.reload() calls, found the way
 * TurboModuleRegistry finds it: the client stays free of a react-native import (tests, the web), and
 * a dynamic import('react-native') does not load in Expo Go.
 */
function devSettings(): DevSettingsModule | null {
  const g = globalThis as NativeGlobals
  try {
    const m = (g.__turboModuleProxy?.('DevSettings') ?? g.nativeModuleProxy?.DevSettings) as DevSettingsModule | undefined
    return m && (m.reloadWithReason || m.reload) ? m : null
  } catch {
    return null
  }
}

/**
 * A reload in a development build: Expo's reloadAppAsync where Expo runs (in Expo Go, React Native's
 * own DevSettings module restarts JavaScript without Expo's native modules), else DevSettings.reload().
 * Null where there is neither (release builds, Node).
 */
function defaultReload(): (() => void) | null {
  const g = globalThis as NativeGlobals
  if (g.__DEV__ !== true) return null
  if (typeof g.expo?.reloadAppAsync === 'function') return () => void g.expo!.reloadAppAsync!('keyframer-inspect').catch(() => {})
  if (!devSettings()) return null
  return () => {
    const m = devSettings()
    if (m?.reloadWithReason) m.reloadWithReason('keyframer-inspect')
    else m?.reload?.()
  }
}

/** react-native-view-shot's captureScreen, as far as the inspector uses it. */
export type CaptureScreen = (options: { format: 'jpg' | 'png'; quality: number; result: 'base64'; width?: number }) => Promise<string>

const OPEN = 1
const MAX_QUEUED_EVENTS = 2000
const MAX_BACKOFF_MS = 10_000

let replayFn: (() => void) | null = null

/** The live connection, if any, for sending to the editors from outside (a recording made on the device). */
type Connection = { send(msg: InspectorAppMessage): boolean }
const live = globalThis as { __KF_CONNECTION__?: Connection }

/** Sends a message to the connected panel or editor. False when nothing is connected. */
export function sendToEditors(msg: InspectorAppMessage): boolean {
  return live.__KF_CONNECTION__?.send(msg) ?? false
}

/** What `replay` from an editor runs. Returns a function that unregisters it. */
export function registerReplay(fn: () => void): () => void {
  replayFn = fn
  return () => {
    if (replayFn === fn) replayFn = null
  }
}

/** JSON-safe copy of animation arguments: numbers and plain fields survive, functions do not. */
export function sanitizeArgs(args: unknown[]): unknown[] {
  const clean = (v: unknown, depth: number): unknown => {
    if (v === null || typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v
    if (v === undefined) return null
    if (typeof v === 'function') return '[function]'
    if (Array.isArray(v)) return depth > 2 ? '[array]' : v.map((x) => clean(x, depth + 1))
    if (typeof v === 'object') {
      if (depth > 2) return '[object]'
      const out: Record<string, unknown> = {}
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (typeof x !== 'function') out[k] = clean(x, depth + 1)
      }
      return out
    }
    return String(v)
  }
  return args.map((a) => clean(a, 0))
}

export function connectInspector(opts: ConnectInspectorOptions): () => void {
  const Socket = opts.WebSocket ?? (globalThis as { WebSocket?: SocketConstructor }).WebSocket
  if (!Socket) throw new Error('connectInspector: no WebSocket available')
  const now = opts.now ?? (() => Date.now())
  const batchMs = opts.batchMs ?? 100
  const sampleMs = opts.sampleMs ?? 16
  const build = opts.build ?? defaultBuild()
  const reload = opts.reload === undefined ? defaultReload() : opts.reload
  const url = inspectorRoomUrl(opts.apiUrl, opts.code, 'app')

  let queue: InspectorEvent[] = []
  let samples: InspectorSample[] = []
  let frames: InspectorFrameStat[] = []
  let drops: InspectorFrameDrop[] = []
  let commits: InspectorCommit[] = []
  let markers: InspectorMarker[] = []
  let tasks: InspectorTask[] = []
  let work: InspectorUiWork[] = []
  // What is being recorded (declared before the inspector installs: it replays signals into enqueue).
  const recording = new Set<string>()
  let recordAll = false
  // Signal and style sites are reported once; an editor that joins later still needs them.
  const catalog = new Map<string, InspectorEvent>()
  const enqueue = (e: InspectorEvent) => {
    if (e.kind === 'anim') {
      e = { ...e, args: sanitizeArgs(e.args) }
      // While recording, place it on the recording's clock and keep where it was called from. Called
      // synchronously from the hook, so the stack still holds the app code that started it.
      if (recording.size) {
        e.t = Math.round(now() - recordStart)
        if (e.thread !== 'ui') e.stack = captureStack()
      }
    } else if (e.kind === 'unsignal') {
      // Gone (its screen unmounted): a panel that connects later is not told about it.
      catalog.delete(`signal:${e.id}`)
    } else {
      catalog.set(`${e.kind}:${e.site.id}`, e)
      // A shared value reported while recording is new, or replaces one (a screen re-mounted: same
      // call site, new value): sampling follows it. Recording everything, a new one joins.
      if (e.kind === 'signal' && recording.size) {
        if (recordAll) recording.add(e.site.id)
        if (recording.has(e.site.id)) restartSampling()
      }
    }
    queue.push(e)
    if (queue.length > MAX_QUEUED_EVENTS) queue = queue.slice(-MAX_QUEUED_EVENTS)
  }

  const inspector = createInspector({ send: enqueue, now })
  const uninstall = inspector.install()
  // Another thread's clock maps onto the recording's by the smallest offset seen: the report that
  // arrived with the least delay.
  let bridgeOffset = Infinity
  const bridges = (opts.bridges ?? []).map((make) =>
    make({
      report: (site, args) => inspector.report(site, sanitizeArgs(args)),
      overrides: inspector.getOverrides(),
      reportFrames: (stats, ds, at) => {
        if (!recording.size) return
        bridgeOffset = Math.min(bridgeOffset, now() - recordStart - at)
        const o = bridgeOffset
        for (const st of stats) frames.push({ ...st, t: Math.round(st.t + o) })
        for (const d of ds) drops.push({ ...d, t: Math.round(d.t + o) })
      },
    }),
  )

  let socket: SocketLike | null = null
  let disposed = false
  let backoff = 500
  let editors = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  const sendRaw = (msg: unknown) => {
    if (socket && socket.readyState === OPEN) socket.send(JSON.stringify(msg))
  }

  const flush = () => {
    if (!socket || socket.readyState !== OPEN) return
    if (queue.length) {
      sendRaw({ type: 'events', events: queue })
      queue = []
    }
    if (samples.length || frames.length || drops.length || commits.length || markers.length || tasks.length || work.length) {
      sendRaw({
        type: 'samples',
        samples,
        ...(frames.length ? { frames } : {}),
        ...(drops.length ? { drops } : {}),
        ...(commits.length ? { commits } : {}),
        ...(markers.length ? { markers } : {}),
        ...(tasks.length ? { tasks } : {}),
        ...(work.length ? { work } : {}),
      })
      samples = []
      frames = []
      drops = []
      commits = []
      markers = []
      tasks = []
      work = []
    }
  }
  const flushTimer = setInterval(flush, batchMs)
  const connection: Connection = {
    send(msg) {
      if (!socket || socket.readyState !== OPEN) return false
      socket.send(JSON.stringify(msg))
      return true
    },
  }
  live.__KF_CONNECTION__ = connection
  const unwatchScenarios = watchScenarios((names) => sendRaw({ type: 'scenarios', names }))

  // ── record: sample listed shared values ────────────────────────────────
  let recordStart = 0
  let sampleTimer: ReturnType<typeof setInterval> | null = null
  const sampleOnce = () => {
    const t = now() - recordStart
    for (const id of recording) {
      const v = inspector.signals.get(id)?.value
      if (typeof v === 'number' && Number.isFinite(v)) samples.push({ id, t, v })
    }
  }
  // On the UI thread every frame when a bridge can (React Native), mapped onto the recording's clock
  // by the smallest offset seen; a JS timer otherwise.
  const uiSampler = bridges.find((b) => b.sampleValues)
  let stopUiSampling: (() => void) | null = null
  let sampleOffset = Infinity
  const startUiSampling = () => {
    stopUiSampling?.()
    stopUiSampling = null
    const ids = [...recording].filter((id) => inspector.signals.has(id))
    if (!ids.length || !uiSampler?.sampleValues) return
    sampleOffset = Infinity
    stopUiSampling = uiSampler.sampleValues(
      ids.map((id) => inspector.signals.get(id)),
      (rows) => {
        const t = now() - recordStart
        for (const row of rows) sampleOffset = Math.min(sampleOffset, t - row[0]!)
        for (const row of rows) {
          const at = Math.round(row[0]! + sampleOffset)
          for (let i = 0; i < ids.length; i++) {
            const v = row[i + 1]!
            if (Number.isFinite(v)) samples.push({ id: ids[i]!, t: at, v })
          }
        }
      },
    )
  }
  // New shared values join a running sampler: restarted once per tick, however many mount together.
  let restartQueued = false
  const restartSampling = () => {
    if (!uiSampler || restartQueued) return
    restartQueued = true
    setTimeout(() => {
      restartQueued = false
      if (recording.size) startUiSampling()
    }, 0)
  }
  // The JS thread's frames, measured while recording; the UI thread's come from the bridges.
  const requestFrame =
    opts.requestFrame ?? (globalThis as { requestAnimationFrame?: (cb: () => void) => unknown }).requestAnimationFrame?.bind(globalThis)
  let jsMeter: ReturnType<typeof createFrameMeter> | null = null
  let unwatchCommits: (() => void) | null = null
  let unwatchMarkers: (() => void) | null = null
  let unwatchTasks: (() => void) | null = null
  let unwatchWork: (() => void) | null = null
  let unwatchScroll: (() => void) | null = null
  let workOffset = Infinity
  let scrollOffset = Infinity
  // A list's offsets are recorded as two tracks, `<id>:x` and `<id>:y`; each joins the catalog (a row
  // in the panel) once it moves.
  const scrollFirst = new Map<string, number>()
  const announced = new Set<string>()
  const jsFrame = () => {
    const m = jsMeter
    if (!m || disposed) return
    tickFrameMeter(m, now() - recordStart)
    if (m.stats.length) frames.push(...m.stats.splice(0))
    if (m.drops.length) drops.push(...m.drops.splice(0))
    requestFrame?.(jsFrame)
  }
  const measureFrames = (on: boolean) => {
    if (on && !jsMeter) {
      bridgeOffset = Infinity
      jsMeter = createFrameMeter('js')
      requestFrame?.(jsFrame)
      unwatchCommits = watchCommits(
        (c) => {
          if (commits.length < MAX_QUEUED_EVENTS) commits.push(c)
        },
        () => now() - recordStart,
      )
      const withMarkers = bridges.find((b) => b.watchMarkers)
      unwatchMarkers =
        withMarkers?.watchMarkers?.(
          () => now() - recordStart,
          (m) => {
            if (markers.length < MAX_QUEUED_EVENTS) markers.push(m)
          },
        ) ?? null
      // JS tasks (handlers, effects, timers), timed by the wall clock: mapped by how long ago they ended.
      unwatchTasks = watchTasks(({ end, ...task }) => {
        if (tasks.length < MAX_QUEUED_EVENTS) tasks.push({ ...task, t: Math.round(now() - recordStart - (Date.now() - end)) })
      })
      // UI-thread worklets per frame, on the UI clock: mapped by the smallest offset seen.
      workOffset = Infinity
      const withWork = bridges.find((b) => b.watchWork)
      unwatchWork =
        withWork?.watchWork?.((rows) => {
          const t = now() - recordStart
          for (const r of rows) workOffset = Math.min(workOffset, t - r[0])
          for (const [ut, kind, site, name, ms, calls] of rows) {
            if (work.length >= MAX_QUEUED_EVENTS * 4) break
            work.push({ t: Math.round(ut + workOffset), ms: Math.round(ms * 100) / 100, calls, kind, site, name })
          }
        }) ?? null
      scrollOffset = Infinity
      // A list's offset at `at` ms: a scroll track, announced as a row once it moves.
      const pushScroll = (at: number, id: string, x: number, y: number) => {
        for (const [axis, v] of [['x', x], ['y', y]] as const) {
          const track = `${id}:${axis}`
          samples.push({ id: track, t: at, v })
          if (!scrollFirst.has(track)) scrollFirst.set(track, v)
          else if (!announced.has(track) && scrollFirst.get(track) !== v) {
            announced.add(track)
            const [, file, line] = /^scroll:(.*):(\d+)$/.exec(id) ?? []
            enqueue({ kind: 'signal', site: { id: track, file: file ?? id, line: Number(line ?? 0), component: null, name: `scroll ${axis}` } })
          }
        }
      }
      // Lists report only while they move: where they rest now is the recording's first frame (the UI
      // thread knows the worklet-scrolled ones, this thread the ones with a JS onScroll).
      const rest = (last: Record<string, number[]>) => {
        for (const { id, x, y } of restingOffsets({ ...last, ...jsScrollOffsets() })) {
          for (const [axis, v] of [['x', x], ['y', y]] as const) {
            samples.push({ id: `${id}:${axis}`, t: 0, v })
            if (!scrollFirst.has(`${id}:${axis}`)) scrollFirst.set(`${id}:${axis}`, v)
          }
        }
      }
      const snapshot = bridges.find((b) => b.scrollSnapshot)
      if (snapshot) snapshot.scrollSnapshot!(rest)
      else rest({})
      // A list that mounts while recording starts at rest, at 0.
      const offMounts = tapScrollMounts((id) => {
        const t = Math.round(now() - recordStart)
        for (const axis of ['x', 'y']) samples.push({ id: `${id}:${axis}`, t, v: 0 })
      })
      const offJs = tapJsScroll((id, x, y) => pushScroll(Math.round(now() - recordStart), id, x, y))
      const stopWatching =
        bridges.find((b) => b.watchScroll)?.watchScroll?.((rows) => {
          const t = now() - recordStart
          for (const r of rows) scrollOffset = Math.min(scrollOffset, t - r[0])
          for (const [ut, id, x, y] of rows) pushScroll(Math.round(ut + scrollOffset), id, x, y)
        }) ?? null
      unwatchScroll = () => {
        offMounts()
        offJs()
        stopWatching?.()
      }
    } else if (!on) {
      jsMeter = null
      unwatchCommits?.()
      unwatchCommits = null
      unwatchMarkers?.()
      unwatchMarkers = null
      unwatchTasks?.()
      unwatchTasks = null
      unwatchWork?.()
      unwatchWork = null
      unwatchScroll?.()
      unwatchScroll = null
    }
    for (const b of bridges) b.measureFrames?.(on)
  }
  const setRecording = (ids: string[], on: boolean) => {
    const was = recording.size > 0
    const all = ids.includes('*')
    if (on) {
      if (recording.size === 0) recordStart = now()
      if (all) recordAll = true
      for (const id of all ? inspector.signals.keys() : ids) recording.add(id)
    } else if (all) {
      recordAll = false
      recording.clear()
    } else for (const id of ids) recording.delete(id)
    if (uiSampler) {
      if (recording.size) startUiSampling()
      else {
        stopUiSampling?.()
        stopUiSampling = null
      }
    } else {
      if (recording.size && !sampleTimer) sampleTimer = setInterval(sampleOnce, sampleMs)
      if (!recording.size && sampleTimer) {
        clearInterval(sampleTimer)
        sampleTimer = null
      }
    }
    if (was !== recording.size > 0) measureFrames(recording.size > 0)
  }

  // ── playback: write recorded samples back in time order ───────────────
  let playbackTimer: ReturnType<typeof setInterval> | null = null
  const playback = (recorded: InspectorSample[], routes: InspectorRoute[] = []) => {
    if (playbackTimer) clearInterval(playbackTimer)
    const ordered = recorded.slice().sort((a, b) => a.t - b.t)
    // The screen it starts on, then the screens it went to, on the samples' clock.
    const screens = routes.slice().sort((a, b) => a.t - b.t)
    if (!ordered.length) {
      if (screens[0]) navigateTo(screens[0].route, screens[0].params)
      return
    }
    const t0 = Math.min(ordered[0]!.t, screens[0]?.t ?? Infinity)
    let r = 0
    const start = now()
    let i = 0
    const lastScroll = new Map<string, { x: number; y: number }>()
    const step = () => {
      const elapsed = now() - start
      const due: InspectorSample[] = []
      while (r < screens.length && screens[r]!.t - t0 <= elapsed) {
        const s = screens[r++]!
        navigateTo(s.route, s.params)
      }
      while (i < ordered.length && ordered[i]!.t - t0 <= elapsed) {
        const s = ordered[i++]!
        due.push(s)
        const sv = inspector.signals.get(s.id)
        if (sv) sv.value = s.v
      }
      // Recorded lists scroll back too (their handlers then drive what they animate).
      applyScrollSamples(due, lastScroll)
      if (i >= ordered.length && r >= screens.length && playbackTimer) {
        clearInterval(playbackTimer)
        playbackTimer = null
      }
    }
    step()
    if (i < ordered.length || r < screens.length) playbackTimer = setInterval(step, sampleMs)
  }

  // ── capture: show these values, then snapshot the screen ───────────────
  // One at a time, in the order asked: an export waits for each frame before asking for the next.
  let captures: Promise<void> = Promise.resolve()
  // Overlays stay hidden across a run of captures (an export) and come back shortly after the last one.
  let showOverlays: ReturnType<typeof setTimeout> | null = null
  const nextFrame = () => new Promise<void>((resolve) => (requestFrame ? requestFrame(() => resolve()) : setTimeout(resolve, 16)))
  const capture = (msg: Extract<InspectorEditorMessage, { type: 'capture' }>) => {
    captures = captures.then(async () => {
      const format = msg.format ?? 'jpg'
      if (!opts.captureScreen) {
        sendRaw({ type: 'frame', id: msg.id, error: 'This app does not capture its screen: pass captureScreen from react-native-view-shot when connecting.' })
        return
      }
      if (playbackTimer) {
        clearInterval(playbackTimer)
        playbackTimer = null
      }
      if (showOverlays) clearTimeout(showOverlays)
      setCapturing(true)
      // The screen this moment was on: navigate there and let the transition finish first.
      if (msg.route && navigateTo(msg.route.route, msg.route.params)) await new Promise((r) => setTimeout(r, 700))
      for (const s of msg.samples ?? []) {
        const sv = inspector.signals.get(s.id)
        if (sv) sv.value = s.v
      }
      applyScrollSamples(msg.samples ?? [])
      // A JS write reaches the UI thread on its next frame and the screen on the one after: wait for both.
      await nextFrame()
      await nextFrame()
      await nextFrame()
      try {
        const data = await opts.captureScreen({ format, quality: msg.quality ?? 0.85, result: 'base64', ...(msg.width ? { width: msg.width } : {}) })
        sendRaw({ type: 'frame', id: msg.id, data, format })
      } catch (e) {
        sendRaw({ type: 'frame', id: msg.id, error: e instanceof Error ? e.message : String(e) })
      }
      showOverlays = setTimeout(() => setCapturing(false), 600)
    })
  }

  const onMessage = (data: unknown) => {
    if (typeof data !== 'string' || data === PONG) return
    let msg: InspectorEditorMessage | InspectorPresenceMessage
    try {
      msg = JSON.parse(data)
    } catch {
      return
    }
    switch (msg.type) {
      case 'overrides':
        inspector.setOverrides(msg.overrides ?? {})
        for (const b of bridges) b.setOverrides?.(msg.overrides ?? {})
        break
      case 'replay':
        replayFn?.()
        break
      case 'reload':
        reload?.()
        break
      case 'record':
        setRecording(msg.signalIds ?? [], !!msg.on)
        break
      case 'playback':
        playback(msg.samples ?? [], msg.routes ?? [])
        break
      case 'capture':
        capture(msg)
        break
      case 'scenario':
        void runScenario(msg.name, now).then((r) => sendRaw({ type: 'scenarioDone', name: msg.name, ...r }))
        break
      case 'presence':
        // A new editor missed the one-off signal and style reports: send it the catalog.
        if (msg.editors > editors && catalog.size) {
          sendRaw({ type: 'events', events: [...catalog.values()] })
        }
        editors = msg.editors
        break
    }
  }

  let heartbeat: ReturnType<typeof setInterval> | null = null
  const connect = () => {
    if (disposed) return
    const s = new Socket(url)
    socket = s
    let lastHeard = now()
    const closed = () => {
      if (heartbeat) clearInterval(heartbeat)
      heartbeat = null
      if (socket === s) socket = null
      if (disposed) return
      reconnectTimer = setTimeout(connect, backoff)
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
    }
    s.onopen = () => {
      backoff = 500
      lastHeard = now()
      s.send(
        JSON.stringify({
          type: 'hello',
          role: 'app',
          app: opts.app ?? 'app',
          platform: opts.platform ?? 'unknown',
          capture: !!opts.captureScreen,
          ...(opts.screen ? { screen: opts.screen } : {}),
          scenarios: scenarioNames(),
          protocol: PROTOCOL,
          sdk: SDK,
          framework: 'react-native',
          ...(opts.osVersion ? { osVersion: opts.osVersion } : {}),
          ...(build ? { build } : {}),
          ...(opts.root ? { root: opts.root } : {}),
          threads: REACT_NATIVE_THREADS,
          capabilities: ['playback', 'overrides', 'replay', 'scenarios', 'recordings', ...(opts.captureScreen ? ['capture'] : []), ...(reload ? ['reload'] : [])],
        }),
      )
      flush()
      heartbeat = setInterval(() => {
        if (now() - lastHeard > HEARTBEAT_TIMEOUT_MS) {
          // Silent for too long: the room dropped us without a close. Reconnect without waiting.
          s.onclose = null
          s.onmessage = null
          try {
            s.close()
          } catch {
            /* already gone */
          }
          closed()
          return
        }
        if (s.readyState === OPEN) s.send(PING)
      }, HEARTBEAT_INTERVAL_MS)
    }
    s.onmessage = (ev) => {
      lastHeard = now()
      onMessage(ev.data)
    }
    s.onerror = () => {}
    s.onclose = closed
  }
  connect()

  return () => {
    disposed = true
    if (live.__KF_CONNECTION__ === connection) delete live.__KF_CONNECTION__
    unwatchScenarios()
    clearInterval(flushTimer)
    if (sampleTimer) clearInterval(sampleTimer)
    stopUiSampling?.()
    if (playbackTimer) clearInterval(playbackTimer)
    if (showOverlays) clearTimeout(showOverlays)
    setCapturing(false)
    if (reconnectTimer) clearTimeout(reconnectTimer)
    if (heartbeat) clearInterval(heartbeat)
    if (jsMeter) measureFrames(false)
    for (const b of bridges) b.dispose?.()
    uninstall()
    try {
      socket?.close(1000, 'disconnect')
    } catch {
      /* already closed */
    }
    socket = null
  }
}
