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
 *   - `time` runs the app's animations slower, pauses or steps them, where a bridge can (React Native's
 *     UI thread), and is answered with the speed now. A connection that ends, or loses its last
 *     editor, puts the speed back to normal.
 *   - While an editor is in the room, what animates now (trackingRuntime.ts: what is mounted, restarts,
 *     remounts, the cost per list cell) goes with `samples` every `trackingMs`.
 *
 * Pure TypeScript with the socket and timers injected, so it runs under vitest. React Native apps
 * import `connectInspector` from '@keyframerdev/inspector/native', which adds the UI-thread hook.
 */

import type {
  InspectorAccessibility,
  InspectorAppMessage,
  InspectorBuild,
  InspectorCallSite,
  InspectorCapability,
  InspectorCommit,
  InspectorDevice,
  InspectorDisplay,
  InspectorEditorMessage,
  InspectorEvent,
  InspectorFrameDrop,
  InspectorFrameStat,
  InspectorMarker,
  InspectorMotionTracking,
  InspectorOverrides,
  InspectorPresenceMessage,
  InspectorRoute,
  InspectorSample,
  InspectorTask,
  InspectorUiWork,
} from '../../protocol/inspector'
import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_TIMEOUT_MS, inspectorRoomUrl, PING, PONG } from './room'
import { clampScale, clampStep } from './clock'
import { watchCommits } from './commits'
import { closeSamplerWindow, inSamplerWindow, samplerWindow, type SamplerWindow } from './samplerWindow'
import { createFrameMeter, tickFrameMeter } from './frameMeter'
import { REACT_NATIVE_THREADS } from './platforms'
import {
  applyScrollSamples,
  createInspector,
  emitTimeScale,
  navigateTo,
  jsScrollOffsets,
  restingOffsets,
  setCapturing,
  tapJsScroll,
  tapScrollMounts,
  timeScale,
} from './runtime'
import { PROTOCOL, SDK } from './version'
import { runScenario, scenarioNames, watchScenarios } from './scenarios'
import { watchTasks } from './tasks'
import { captureStack } from './stack'
import { holdTracking, type TrackingHandle } from './trackingRuntime'

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
/** What the app says about the device in its hello, once it knows: measured or read when it connects. */
export type AppFacts = {
  display?: InspectorDisplay
  accessibility?: InspectorAccessibility
  /** Capabilities only the device can vouch for (`time`, where the UI runtime can run the clock). */
  capabilities?: InspectorCapability[]
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
  /**
   * Touches, gestures, screens, logs and the device's settings as markers on the recording's clock
   * (`elapsed`), until the returned function is called. `said`: what the hello said, so a setting
   * that changed since is marked at the start.
   */
  watchMarkers?(elapsed: () => number, onMarker: (m: InspectorMarker) => void, said?: AppFacts): () => void
  /** What the hello says about the device; the hello waits for it (up to `factsTimeoutMs`). */
  facts?(): Promise<AppFacts>
  /** Runs animations at `scale` (0: paused), then moves them on `step` frames. False when it cannot here. */
  setTime?(scale: number, step: number): boolean
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
  /**
   * Which device it runs on, so a relay or a CI run tells two apps apart. Only a simulator's or an
   * emulator's `name` and `id`; a physical device says its `model` (see InspectorDevice).
   */
  device?: InspectorDevice
  /** The project folder on the developer's machine: call-site paths resolve against it to open in an editor. */
  root?: string
  /** Defaults to the global WebSocket. */
  WebSocket?: SocketConstructor
  batchMs?: number
  /** How often what animates now (`samples.tracking`) goes to the editors while any is in the room, ms. 0: never. Default 2000. */
  trackingMs?: number
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
  /** The longest the hello waits for what the bridges measure about the device (the display), ms. Default 1500. */
  factsTimeoutMs?: number
  /**
   * Where the one note goes when nothing has answered at `apiUrl` after a few tries (the desktop app is
   * closed, or the app points at a port the relay does not listen on). Default console.warn; null for none.
   */
  warn?: ((line: string) => void) | null
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

/** How long a reload through Expo may take before DevSettings is tried: a reload ends this JavaScript. */
export const RELOAD_FALLBACK_MS = 1500

/**
 * A reload in a development build: Expo's reloadAppAsync where Expo runs (in Expo Go, React Native's
 * own DevSettings module restarts JavaScript without Expo's native modules), else DevSettings.reload().
 * Expo's can do nothing at all: on Android it returns at once when the activity is not a ReactActivity
 * (Expo Go's is not). So when it fails, or this JavaScript is still running a moment later, DevSettings
 * reloads instead. Null where there is neither (release builds, Node).
 */
function defaultReload(): (() => void) | null {
  const g = globalThis as NativeGlobals
  if (g.__DEV__ !== true) return null
  const viaDevSettings = () => {
    const m = devSettings()
    if (m?.reloadWithReason) m.reloadWithReason('keyframer-inspect')
    else m?.reload?.()
  }
  if (typeof g.expo?.reloadAppAsync === 'function') {
    return () => {
      let fellBack = false
      const fallBack = () => {
        if (fellBack) return
        fellBack = true
        clearTimeout(timer)
        viaDevSettings()
      }
      const timer = setTimeout(fallBack, RELOAD_FALLBACK_MS)
      try {
        void g.expo!.reloadAppAsync!('keyframer-inspect').catch(fallBack)
      } catch {
        fallBack()
      }
    }
  }
  return devSettings() ? viaDevSettings : null
}

/** react-native-view-shot's captureScreen, as far as the inspector uses it. */
export type CaptureScreen = (options: { format: 'jpg' | 'png'; quality: number; result: 'base64'; width?: number }) => Promise<string>

const OPEN = 1
const MAX_QUEUED_EVENTS = 2000
const MAX_BACKOFF_MS = 10_000
/** Failed tries (0.5 + 1 + 2 s apart) before saying nothing answers. */
const UNREACHABLE_TRIES = 3
/** The port the desktop app's relay listens on unless its settings say another. */
const RELAY_PORT = '8790'
/** This machine or the local network: the desktop app's relay, not the Keyframer room. */
const LOCAL_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\]$)|\.local$/i

/**
 * What to say once when nothing answers at `apiUrl`: for a local address, whether the desktop app is
 * open and on that port; for anything else, the network. Null for the dev tools channel, which says its
 * own. Parsed by hand: React Native's URL has no hostname or port outside Expo.
 */
export function unreachableNote(apiUrl: string, platform?: string): string | null {
  const m = /^([a-z]+):\/\/(\[[^\]]+\]|[^/:?#]+)(?::(\d+))?/i.exec(apiUrl.trim())
  if (!m) return null
  const [, scheme, host, port = /^(https|wss)$/i.test(scheme) ? '443' : '80'] = m
  if (host === 'devtools') return null
  const at = `${scheme}://${host}${m[3] ? `:${m[3]}` : ''}`
  if (!LOCAL_HOST.test(host)) return `keyframer-inspector: cannot reach ${at}, still trying. Check the network and the API address.`
  let note = `keyframer-inspector: nothing answers at ${at}, still trying. Is Keyframer Inspector (the desktop app) open?`
  if (port !== RELAY_PORT) note += ` Its relay listens on ${RELAY_PORT} unless its settings name another port (its status bar shows the port), and this app points at ${port}.`
  if (platform === 'android' && /^(localhost|127\.)/.test(host)) note += ` On an Android emulator, run adb reverse tcp:${port} tcp:${port} first.`
  return note
}

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
  // Who records what (declared before the inspector installs: it replays signals into enqueue). Each
  // editor's recorder (`record`'s `recorder`; '' for editors that send none, which share it) has its
  // ids, or `*`: every value, also ones that mount meanwhile. The app records while any recorder does,
  // and samples the union, so one editor stopping does not stop another's recording.
  const recorders = new Map<string, Set<string> | '*'>()
  const recording = new Set<string>()
  let recordAll = false
  const isRecording = () => recorders.size > 0
  // Signal and style sites are reported once; an editor that joins later still needs them.
  const catalog = new Map<string, InspectorEvent>()
  const enqueue = (e: InspectorEvent) => {
    if (e.kind === 'anim') {
      e = { ...e, args: sanitizeArgs(e.args) }
      // While recording, place it on the recording's clock and keep where it was called from. Called
      // synchronously from the hook, so the stack still holds the app code that started it.
      if (isRecording()) {
        e.t = Math.round(now() - recordStart)
        if (e.thread !== 'ui') e.stack = captureStack()
      }
    } else if (e.kind === 'unsignal') {
      // Gone (its screen unmounted): a panel that connects later is not told about it.
      catalog.delete(`signal:${e.id}`)
      // While recording, when: the value's history ends here (a remount starts a new one).
      if (isRecording()) {
        e = { ...e, t: Math.round(now() - recordStart) }
        valueMoved(e.id, e.t!)
      }
    } else if (e.kind === 'workletIssue') {
      // Kept for panels that connect later. A crash goes out now: the red box comes right after it.
      catalog.set(`workletIssue:${e.id}`, e)
      if (e.error) setTimeout(() => flush(), 0)
    } else {
      // As reported: a panel that connects later gets no recording time with it.
      catalog.set(e.kind === 'renderHint' ? `renderHint:${e.id}:${e.hint}` : `${e.kind}:${e.site.id}`, e)
      // A shared value reported while recording is new, or replaces one (a screen re-mounted: same
      // call site, new value): sampling follows it. Recording everything, a new one joins.
      if (e.kind === 'signal' && isRecording()) {
        e = { ...e, t: Math.round(now() - recordStart) }
        valueMoved(e.site.id, e.t!)
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
        if (!isRecording()) return
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
  // The socket the hello went out on: nothing else goes before it. And what it said about the device.
  let greeted: SocketLike | null = null
  let said: AppFacts = {}

  const sendRaw = (msg: unknown) => {
    if (socket && socket.readyState === OPEN) socket.send(JSON.stringify(msg))
  }

  const flush = () => {
    if (!socket || socket.readyState !== OPEN || greeted !== socket) return
    if (queue.length) {
      sendRaw({ type: 'events', events: queue })
      queue = []
    }
    if (samples.length || frames.length || drops.length || commits.length || markers.length || tasks.length || work.length || trackingDue) {
      sendRaw({
        type: 'samples',
        samples,
        ...(frames.length ? { frames } : {}),
        ...(drops.length ? { drops } : {}),
        ...(commits.length ? { commits } : {}),
        ...(markers.length ? { markers } : {}),
        ...(tasks.length ? { tasks } : {}),
        ...(work.length ? { work } : {}),
        ...(trackingDue ? { tracking: trackingDue } : {}),
      })
      trackingDue = null
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

  // ── What animates now, for the editors in the room ─────────────────────
  // Held while any editor is in the room (presence): its summary goes with the next flush every
  // trackingMs, and UI work is sampled for the cost per list cell where a bridge can watch it.
  const trackingMs = opts.trackingMs ?? 2000
  let tracking: TrackingHandle | null = null
  let trackingTimer: ReturnType<typeof setInterval> | null = null
  let trackingDue: InspectorMotionTracking | null = null
  const followTracking = (on: boolean) => {
    if (on && !tracking && trackingMs > 0 && !disposed) {
      const watchWork = bridges.find((b) => b.watchWork)?.watchWork
      tracking = holdTracking({ ...(watchWork ? { watchWork: (onRows) => watchWork(onRows) } : {}), hz: () => said.display?.hz ?? 0 })
      tracking.sampleWork(true)
      const t = tracking
      trackingTimer = setInterval(() => {
        try {
          trackingDue = t.summary()
        } catch {
          // What the app has mounted could not be read this time: the next one will be.
        }
      }, trackingMs)
    } else if (!on && tracking) {
      tracking.release()
      tracking = null
      if (trackingTimer) clearInterval(trackingTimer)
      trackingTimer = null
      trackingDue = null
    }
  }
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
  // When each value last mounted or went away while recording, and the samplers whose rows may still
  // arrive: a sampler reads the shared values it started with, so once an id is re-registered (a
  // remount) or gone, its rows for that id are an old instance's and are not recorded under the id.
  const movedAt = new Map<string, number>()
  const samplers = new Set<SamplerWindow>()
  const valueMoved = (id: string, t: number) => {
    movedAt.set(id, t)
    for (const w of samplers) if (w.ids.includes(id) && !w.until.has(id)) w.until.set(id, t)
  }
  const startUiSampling = () => {
    stopUiSampling?.()
    stopUiSampling = null
    const ids = [...recording].filter((id) => inspector.signals.has(id))
    if (!ids.length || !uiSampler?.sampleValues) return
    const w = samplerWindow(ids, movedAt)
    samplers.add(w)
    let offset = Infinity
    const stop = uiSampler.sampleValues(
      ids.map((id) => inspector.signals.get(id)),
      (rows) => {
        const t = now() - recordStart
        for (const row of rows) offset = Math.min(offset, t - row[0]!)
        for (const row of rows) {
          const at = Math.round(row[0]! + offset)
          for (let i = 0; i < ids.length; i++) {
            const v = row[i + 1]!
            if (Number.isFinite(v) && inSamplerWindow(w, i, at)) samples.push({ id: ids[i]!, t: at, v })
          }
        }
      },
    )
    stopUiSampling = () => {
      stop()
      // Rows already on their way from before the stop still count; later ones are the next sampler's.
      closeSamplerWindow(w, Math.round(now() - recordStart))
      samplers.delete(w)
    }
  }
  // New shared values join a running sampler: restarted once per tick, however many mount together.
  let restartQueued = false
  const restartSampling = () => {
    if (!uiSampler || restartQueued) return
    restartQueued = true
    setTimeout(() => {
      restartQueued = false
      if (isRecording()) startUiSampling()
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
          said,
        ) ?? null
      // Without a bridge that watches (node, tests), the speed is marked here.
      if (!withMarkers && timeScale() !== 1) markers.push({ kind: 'time', t: 0, scale: timeScale() })
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
  /** What the recorders ask for, together: every mounted value when one records everything. */
  const deriveRecording = () => {
    recordAll = [...recorders.values()].includes('*')
    recording.clear()
    if (recordAll) for (const id of inspector.signals.keys()) recording.add(id)
    for (const ids of recorders.values()) if (ids !== '*') for (const id of ids) recording.add(id)
  }
  /** After the recorders changed: sampling, frames and the recording's clock follow them. */
  const recordersChanged = (was: boolean) => {
    const on = isRecording()
    // A recording starts when the first recorder does: its clock, and which values mounted when.
    if (on && !was) {
      recordStart = now()
      movedAt.clear()
    }
    deriveRecording()
    if (uiSampler) {
      if (on) startUiSampling()
      else {
        stopUiSampling?.()
        stopUiSampling = null
      }
    } else {
      if (on && !sampleTimer) sampleTimer = setInterval(sampleOnce, sampleMs)
      if (!on && sampleTimer) {
        clearInterval(sampleTimer)
        sampleTimer = null
      }
    }
    if (was !== on) measureFrames(on)
    // What the runtime saw about how views are drawn is reported once per JavaScript session: each
    // recording gets it again, so a recording made after another (a warm-up run) still has it.
    if (on && !was) for (const e of catalog.values()) if (e.kind === 'renderHint') queue.push(e)
  }
  const setRecording = (ids: string[], on: boolean, recorder = '') => {
    const was = isRecording()
    const all = ids.includes('*')
    const mine = recorders.get(recorder)
    if (on) {
      if (all) recorders.set(recorder, '*')
      else if (mine !== '*') recorders.set(recorder, new Set([...(mine ?? []), ...ids]))
    } else if (mine !== undefined) {
      // Only this recorder's ids: another editor's recording goes on.
      if (all) recorders.delete(recorder)
      else if (mine !== '*') {
        for (const id of ids) mine.delete(id)
        if (!mine.size) recorders.delete(recorder)
      }
    }
    recordersChanged(was)
  }
  /** Every recorder stops (no editor is left to receive what they record). */
  const stopRecorders = () => {
    if (!isRecording()) return
    recorders.clear()
    recordersChanged(true)
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
      if (msg.route && navigateTo(msg.route.route, msg.route.params)) await new Promise<void>((r) => setTimeout(r, 700))
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

  // ── time: the speed the app's animations run at ─────────────────────────
  const clockBridge = bridges.find((b) => b.setTime)
  const setSpeed = (scale: number, step = 0) => {
    if (!clockBridge?.setTime?.(scale, step)) return
    if (scale !== timeScale()) {
      emitTimeScale(scale)
      // A bridge that watches markers marks it (for a recording on the device too); without one, here.
      if (isRecording() && !bridges.some((b) => b.watchMarkers) && markers.length < MAX_QUEUED_EVENTS) {
        markers.push({ kind: 'time', t: Math.round(now() - recordStart), scale })
      }
    }
    // Each step while paused is marked where it happened (after the pause it may come with): the
    // analysis moves the app's clock on there.
    if (step > 0 && isRecording() && markers.length < MAX_QUEUED_EVENTS) {
      markers.push({ kind: 'time', t: Math.round(now() - recordStart), scale: 0, step })
    }
  }
  /** Back to normal speed: nobody is left to see the app slowed or paused, or to resume it. */
  const normalSpeed = () => {
    if (timeScale() === 1) return
    setSpeed(1)
    // Said, so a relay or an editor still listening does not keep showing the old speed: at once while
    // the connection is open (the last editor left, or it is disposed), else right after the next hello
    // (the connection dropped).
    if (socket && greeted === socket) sendRaw({ type: 'time', scale: timeScale() })
    else timeDue = true
  }
  // An editor that joined before the hello went out gets the catalog right after it, and a `time`
  // asked before it is answered right after it.
  let catalogDue = false
  let timeDue = false

  const onMessage = (data: unknown) => {
    if (typeof data !== 'string' || data === PONG) return
    let msg: InspectorEditorMessage | InspectorPresenceMessage
    try {
      msg = JSON.parse(data)
    } catch {
      return
    }
    switch (msg.type) {
      case 'time': {
        // The rules every SDK shares (clock.ts): an invalid scale changes nothing, a step only counts
        // while paused.
        const scale = clampScale(msg.scale)
        if (scale !== null) setSpeed(scale, clampStep(msg.step, scale))
        // Answered every time, with the speed now (1 where the app cannot change it).
        if (greeted === socket) sendRaw({ type: 'time', scale: timeScale() })
        else timeDue = true
        break
      }
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
        setRecording(msg.signalIds ?? [], !!msg.on, typeof msg.recorder === 'string' ? msg.recorder : '')
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
        if (msg.editors > editors) {
          if (greeted === socket) {
            // Editors that join a room with no other editor in it never heard the hello (it went to
            // nobody, or to editors that have left): it goes again, for them alone. With other editors
            // still there it does not: to them a second hello is the app restarting.
            if (editors === 0) sendRaw(helloMessage(said))
            // A new editor missed the one-off signal and style reports: send it the catalog. (An app is
            // at normal speed with no editor in the room, so a lone editor needs no `time` after it.)
            if (catalog.size) sendRaw({ type: 'events', events: [...catalog.values()] })
          } else if (catalog.size) catalogDue = true
        }
        // The last editor left: animations go back to normal speed, and no recorder is left.
        if (msg.editors === 0 && editors > 0) {
          normalSpeed()
          stopRecorders()
        }
        editors = msg.editors
        followTracking(editors > 0)
        break
    }
  }

  /** What the app says when it connects: who it is, what it can do, what it measured about the device. */
  const helloMessage = (facts: AppFacts) => {
    const capabilities: InspectorCapability[] = ['playback', 'overrides', 'replay', 'scenarios', 'recordings', ...(opts.captureScreen ? ['capture'] : []), ...(reload ? ['reload'] : [])]
    for (const c of facts.capabilities ?? []) if (!capabilities.includes(c)) capabilities.push(c)
    return {
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
      ...(opts.device ? { device: opts.device } : {}),
      ...(build ? { build } : {}),
      ...(opts.root ? { root: opts.root } : {}),
      threads: REACT_NATIVE_THREADS,
      capabilities,
      ...(facts.display ? { display: facts.display } : {}),
      ...(facts.accessibility ? { accessibility: facts.accessibility } : {}),
    }
  }

  /** Merges what the bridges measured, giving up on any that take longer than `factsTimeoutMs`. */
  const factsTimeoutMs = opts.factsTimeoutMs ?? 1500
  const gatherFacts = (from: InspectorBridge[]): Promise<AppFacts> => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const each = Promise.all(from.map((b) => b.facts!().catch(() => ({}) as AppFacts)))
    const late = new Promise<AppFacts[]>((resolve) => (timer = setTimeout(() => resolve([]), factsTimeoutMs)))
    return Promise.race([each, late]).then((all) => {
      if (timer) clearTimeout(timer)
      const out: AppFacts = {}
      for (const f of all) {
        if (f.display) out.display = f.display
        if (f.accessibility) out.accessibility = f.accessibility
        if (f.capabilities?.length) out.capabilities = [...new Set([...(out.capabilities ?? []), ...f.capabilities])]
      }
      return out
    })
  }

  let heartbeat: ReturnType<typeof setInterval> | null = null
  const warn = opts.warn === undefined ? (line: string) => console.warn(line) : opts.warn
  // Whether any socket has opened, and how many tries failed before one did.
  let reached = false
  let failures = 0
  const connect = () => {
    if (disposed) return
    const s = new Socket(url)
    socket = s
    let lastHeard = now()
    const closed = () => {
      if (heartbeat) clearInterval(heartbeat)
      heartbeat = null
      if (socket === s) socket = null
      // Whoever slowed the app down cannot see it or resume it any more, and no editor is left to get
      // what a recorder asked for: the next connection starts at normal speed, recording nothing.
      normalSpeed()
      stopRecorders()
      if (disposed) return
      // Never reached after a few tries: said once, so a closed desktop app or a wrong port is not silent.
      if (!reached && ++failures === UNREACHABLE_TRIES) {
        const note = unreachableNote(opts.apiUrl, opts.platform)
        if (note) warn?.(note)
      }
      reconnectTimer = setTimeout(connect, backoff)
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
    }
    const hello = (facts: AppFacts) => {
      if (socket !== s || s.readyState !== OPEN || greeted === s) return
      said = facts
      s.send(JSON.stringify(helloMessage(facts)))
      greeted = s
      flush()
      if (catalogDue && catalog.size) sendRaw({ type: 'events', events: [...catalog.values()] })
      catalogDue = false
      // A hello means normal speed: an app still slowed or paused says so right after it.
      if (timeDue || timeScale() !== 1) sendRaw({ type: 'time', scale: timeScale() })
      timeDue = false
    }
    s.onopen = () => {
      backoff = 500
      if (!reached && failures >= UNREACHABLE_TRIES) warn?.(`keyframer-inspector: reached ${opts.apiUrl}`)
      reached = true
      lastHeard = now()
      // The hello carries what the bridges measure about the device (the display's refresh rate takes
      // a moment of frames): it waits for them, and nothing else goes out before it.
      const measuring = bridges.filter((b) => b.facts)
      if (measuring.length) void gatherFacts(measuring).then(hello)
      else hello({})
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
    normalSpeed()
    followTracking(false)
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
