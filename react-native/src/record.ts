/**
 * Recording on the device: for the tester who sees a glitch, with no panel and no Metro. They start
 * a recording (from Motion Scan's pill, or a button of your own), use the app, stop, and share one
 * file; the developer opens it in the dev tools panel (or hands it to the MCP server) and scrubs it like
 * a live recording: values, frames, animations with their source lines, React renders, touches,
 * navigation, logs and screenshots.
 *
 *   import { configureRecorder, trackNavigation } from '@keyframerdev/inspector/record'
 *   import { shareRecording } from '@keyframerdev/inspector/expo-share'
 *   import { captureScreen } from 'react-native-view-shot'
 *
 *   configureRecorder({ app: 'MyApp', captureScreen, share: shareRecording })
 *   trackNavigation(navigationRef)   // React Navigation, or expo-router's useNavigationContainerRef()
 *
 * Needs the Babel plugin in the build: development builds, or an internal preview build with the
 * plugin enabled. Release builds should leave it out.
 */

import type { InspectorRecording, InspectorRect, InspectorRedaction, InspectorSharedRecording } from '../../protocol/inspector'
import { Alert, Dimensions, NativeModules, PixelRatio, Platform, Share, TextInput } from 'react-native'
import { autoCaptureScreen } from './capture'
import { sendToEditors, type CaptureScreen } from './client'
import { markersWhileRecording, measureUiFrames, sampleUiValues, snapshotScroll, uiThreadBridge, watchUiScroll, watchUiWork } from './native'
import { startRecorder, type Recorder } from './recorder'
import { redactRecording, type ProcessScreenshot } from './redact'
import { createInspector, emitNavigation, emitTouch, registerNavigator, type TouchReport } from './runtime'
import { uploadRecording } from './share'
import { symbolicateRecording, symbolicateStack } from './symbolicate'
import { recordingFilename } from './trace'

export type { InspectorRecording } from '../../protocol/inspector'
export { fire, press, registerScenario, waitForTestId } from './scenarios'
export { isInstrumented } from './runtime'

export type RecorderConfig = {
  /** Shown in the panel; defaults to "app". */
  app?: string
  /**
   * Screenshots so the developer sees what the tester saw. Found on its own when
   * react-native-view-shot or Skia is installed; pass one to choose, or null for none.
   */
  captureScreen?: CaptureScreen | null
  /** How often to take a screenshot, ms (default 1500, 0 for none). Each one costs the UI thread a frame or two. */
  screenshotEveryMs?: number
  /**
   * Saves or sends the finished recording. `shareRecording` from '@keyframerdev/inspector/expo-share'
   * opens the share sheet. With Metro running, a copy is saved in the project too (.keyframer/recordings).
   */
  share?: (recording: InspectorRecording, json: string, filename: string) => Promise<void>
  /** Skip the share sheet when the recording was saved in the project (a developer recording for themselves). */
  shareOnlyWithoutMetro?: boolean
  /** Stops by itself after this long, ms (default 120 000). */
  maxDurationMs?: number
  /** Share links: offer to upload a redacted copy to keyframer.dev and send a link instead of the file. */
  shareLinks?: ShareLinksConfig
}

/**
 * Where share links are uploaded, and as whom. With it set, a finished recording asks "Share link or
 * Share file?" (unless `offer: false`; call shareRecordingLink yourself then).
 *
 *   configureRecorder({ shareLinks: { token: () => SecureStore.getItemAsync('keyframer-token') } })
 *
 * `token` is a Keyframer session token or a kf_ API key (Profile, API keys): links are created on
 * that account. A key built into an app is readable by anyone who has the build, and it can do
 * everything its account can, so hand it out only in internal builds, or fetch it from your own
 * backend for the person who is signed in.
 */
export type ShareLinksConfig = {
  /** Default https://api.keyframer.dev. */
  apiUrl?: string
  token: string | (() => string | null | Promise<string | null>)
  /** What to take out (redact.ts DEFAULT_REDACTION: logs masked, params dropped, screenshots small). */
  redaction?: Partial<InspectorRedaction>
  /**
   * Redraws a screenshot (downscale and blur), e.g. with expo-image-manipulator. Without it, device
   * screenshots (already point width, low quality) are kept as they are, and any that need a blur (a
   * focused text input, or `screenshots: 'blur'`) are left out.
   */
  processScreenshot?: ProcessScreenshot
  /** 1 to 30 days (default 30). */
  expiresInDays?: number
  /** Ask after each recording (default true). */
  offer?: boolean
  /** Open the share sheet with the link once it is made (default true). */
  shareSheet?: boolean
  onShared?: (shared: InspectorSharedRecording) => void
}

type NavRef = {
  addListener(event: 'state', cb: () => void): () => void
  getCurrentRoute(): { name: string; params?: object } | undefined
  navigate?: (name: string, params?: object) => void
}

/** Where a finished recording went. */
export type SavedRecording = { recording: InspectorRecording; filename: string; projectFile: string | null; sentToPanel: boolean }

type State = {
  config: RecorderConfig
  recorder: Recorder | null
  listeners: Set<(on: boolean) => void>
  saved: Set<(info: SavedRecording) => void>
  navRefs: Set<NavRef>
  stopHooks: Array<() => void>
  /** The last finished recording: what shareRecordingLink() shares by default. */
  last?: InspectorRecording | null
}
// On globalThis: one recorder per app however the modules were loaded.
const g = globalThis as { __KF_RECORDER__?: State }
const state = (g.__KF_RECORDER__ ??= { config: {}, recorder: null, listeners: new Set(), saved: new Set(), navRefs: new Set(), stopHooks: [] })

export function configureRecorder(config: RecorderConfig): void {
  state.config = { ...state.config, ...config }
}

export function isRecording(): boolean {
  return state.recorder !== null
}

/** ms since the recording started, or 0. */
export function recordingElapsed(): number {
  return state.recorder?.elapsed() ?? 0
}

/** Calls `fn` when a recording starts or stops. Returns the unsubscribe. */
export function watchRecording(fn: (on: boolean) => void): () => void {
  state.listeners.add(fn)
  return () => {
    state.listeners.delete(fn)
  }
}
/** Calls `fn` with where each finished recording went. Returns the unsubscribe. */
export function watchSaved(fn: (info: SavedRecording) => void): () => void {
  state.saved.add(fn)
  return () => {
    state.saved.delete(fn)
  }
}

const notify = () => {
  for (const fn of state.listeners) fn(state.recorder !== null)
}

/** Starts recording. Returns false when one is already running. */
export function startRecording(config: RecorderConfig = {}): boolean {
  if (state.recorder) return false
  const c = { ...state.config, ...config }
  const { width, height } = Dimensions.get('window')
  state.recorder = startRecorder({
    app: { name: c.app ?? 'app', platform: Platform.OS, osVersion: String(Platform.Version) },
    screen: { width, height, scale: PixelRatio.get() },
    captureScreen: c.captureScreen === null ? undefined : (c.captureScreen ?? autoCaptureScreen()),
    screenshotEveryMs: c.screenshotEveryMs,
    maxDurationMs: c.maxDurationMs,
    measureUiFrames: Platform.OS === 'web' ? undefined : measureUiFrames,
    sampleUi: Platform.OS === 'web' ? undefined : sampleUiValues,
    watchUiWork: Platform.OS === 'web' ? undefined : watchUiWork,
    watchUiScroll: Platform.OS === 'web' ? undefined : watchUiScroll,
    scrollSnapshot: Platform.OS === 'web' ? undefined : snapshotScroll,
    inputRegions: Platform.OS === 'web' ? undefined : focusedInputRegion,
    ensureInspector: () => {
      const local = createInspector({ send: () => {} })
      const remove = local.install()
      const bridge = Platform.OS === 'web' ? null : uiThreadBridge({ report: local.report, overrides: {} })
      return () => {
        bridge?.dispose?.()
        remove()
      }
    },
    onAutoStop: (rec) => void finish(rec),
  })
  installHooks()
  notify()
  return true
}

/** Stops recording and shares (or sends) the file. Resolves with the recording. */
export async function stopRecording(note?: string): Promise<InspectorRecording | null> {
  const r = state.recorder
  if (!r) return null
  return finish(r.stop(note))
}

async function finish(rec: InspectorRecording): Promise<InspectorRecording> {
  state.recorder = null
  for (const stop of state.stopHooks.splice(0)) stop()
  notify()
  try {
    await saveRecording(rec)
  } catch (e) {
    console.warn('[keyframer] could not save the recording', e)
  }
  return rec
}

/**
 * Hands a recording to whoever wants it: a connected panel gets it right away, Metro (when the app
 * was loaded from one) saves a copy in the project, and the configured `share` saves it (the share
 * sheet). With none of them, it goes to the system share sheet as text.
 */
export async function saveRecording(rec: InspectorRecording): Promise<SavedRecording> {
  await symbolicateInPlace(rec)
  const sentToPanel = sendToEditors({ type: 'recording', recording: rec })
  const json = JSON.stringify(rec)
  const filename = recordingFilename(rec)
  const projectFile = await saveToProject(json)
  const info: SavedRecording = { recording: rec, filename, projectFile, sentToPanel }
  state.last = rec
  for (const fn of state.saved) fn(info)
  const { share, shareOnlyWithoutMetro, shareLinks } = state.config
  const shareFile = async () => {
    if (share && !(shareOnlyWithoutMetro && projectFile)) await share(rec, json, filename)
    else if (!share && !sentToPanel && !projectFile) await Share.share({ title: filename, message: json })
  }
  if (shareLinks && shareLinks.offer !== false && Platform.OS !== 'web' && !(shareOnlyWithoutMetro && projectFile)) {
    Alert.alert('Recording saved', 'Send a link (personal details taken out) or the file?', [
      { text: 'Share link', onPress: () => void shareRecordingLink(rec).catch((e) => Alert.alert('Could not make a link', e instanceof Error ? e.message : String(e))) },
      { text: 'Share file', onPress: () => void shareFile().catch((e) => console.warn('[keyframer] could not share the recording', e)) },
      { text: 'Cancel', style: 'cancel' },
    ])
    return info
  }
  await shareFile()
  return info
}

/**
 * Uploads a redacted copy of a recording (the last one by default) as a share link and opens the share
 * sheet with it. Needs `configureRecorder({ shareLinks })`. Resolves with the link, or null when there
 * is no recording yet.
 */
export async function shareRecordingLink(rec?: InspectorRecording): Promise<InspectorSharedRecording | null> {
  const cfg = state.config.shareLinks
  if (!cfg) throw new Error('Share links are not set up: configureRecorder({ shareLinks: { token } }).')
  const recording = rec ?? state.last ?? null
  if (!recording) return null
  const token = typeof cfg.token === 'function' ? await cfg.token() : cfg.token
  if (!token) throw new Error('No Keyframer token to upload with.')
  const clean = await redactRecording(recording, cfg.redaction, cfg.processScreenshot)
  const shared = await uploadRecording(clean, { apiUrl: cfg.apiUrl, token, expiresInDays: cfg.expiresInDays })
  cfg.onShared?.(shared)
  if (cfg.shareSheet !== false) await Share.share({ message: shared.url, url: shared.url })
  return shared
}

/** Where the focused text input is, in points: kept with each screenshot so a shared copy blurs it. */
function focusedInputRegion(): Promise<InspectorRect[]> {
  type Measurable = { measureInWindow?: (cb: (x: number, y: number, width: number, height: number) => void) => void }
  const state = (TextInput as unknown as { State?: { currentlyFocusedInput?: () => Measurable | null } }).State
  const input = state?.currentlyFocusedInput?.()
  if (!input?.measureInWindow) return Promise.resolve([])
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve([]), 150)
    try {
      input.measureInWindow!((x, y, width, height) => {
        clearTimeout(timer)
        resolve(width > 0 && height > 0 ? [{ x, y, width, height }] : [])
      })
    } catch {
      clearTimeout(timer)
      resolve([])
    }
  })
}

/**
 * Maps the recording's stacks to source lines through the Metro that built this bundle, while it is
 * still this bundle: read later through a changed one, raw positions point at the wrong lines.
 * Without Metro (a tester's build) the raw stacks stay for whoever has that build's source maps.
 */
async function symbolicateInPlace(rec: InspectorRecording): Promise<void> {
  const origin = metroOrigin()
  if (origin) await symbolicateRecording(rec, (stack) => symbolicateStack(stack, origin))
}

/** The dev server this bundle came from (http://192.168.1.10:8081), or null in a release build. */
export function metroOrigin(): string | null {
  const source = NativeModules.SourceCode as { scriptURL?: string; getConstants?: () => { scriptURL?: string } } | undefined
  const url = source?.getConstants?.().scriptURL ?? source?.scriptURL
  const m = url ? /^(https?:\/\/[^/]+)\//.exec(url) : null
  return m ? m[1]! : null
}

/** Posts the recording to the inspector's handler in Metro, which writes it under the project. Its path, or null. */
async function saveToProject(json: string): Promise<string | null> {
  const origin = metroOrigin()
  if (!origin) return null
  try {
    const res = await fetch(`${origin}/_expo/plugins/@keyframerdev/inspector/recordings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: json,
    })
    if (!res.ok) return null
    const body = (await res.json()) as { file?: string }
    return body.file ?? null
  } catch {
    // Metro gone, or an older package without the handler: the share sheet still has it.
    return null
  }
}

// ─── Markers ──────────────────────────────────────────────────────────────────────

export function markNavigation(route: string, params?: Record<string, unknown>): void {
  emitNavigation({ route, ...(params ? { params: plain(params) } : {}) })
}

/** What the person who is recording wants the developer to know, timed now. */
export function markNote(text: string): void {
  state.recorder?.mark({ kind: 'note', text })
}

/**
 * Follows a navigation container: React Navigation's `createNavigationContainerRef()` or expo-router's
 * `useNavigationContainerRef()`. Every screen change while recording becomes a marker.
 */
export function trackNavigation(ref: NavRef): () => void {
  state.navRefs.add(ref)
  const off = ref.addListener('state', () => markRoute(ref))
  // Playback goes back to the screen a recording was on.
  const offNavigator = registerNavigator((route, params) => ref.navigate?.(route, params))
  // Where the app is now, for a recording that starts before the next screen change.
  markRoute(ref)
  return () => {
    off()
    offNavigator()
    state.navRefs.delete(ref)
  }
}
function markRoute(ref: NavRef) {
  let r: { name: string; params?: object } | undefined
  try {
    r = ref.getCurrentRoute?.()
  } catch {
    // The container is not ready yet: its first state change marks the route.
    return
  }
  // The container fires `state` more than once per screen change: markNavigation keeps one.
  if (r?.name) markNavigation(r.name, r.params as Record<string, unknown> | undefined)
}

/** Plain, JSON-safe params (navigation params can hold functions and objects). */
function plain(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(params)) {
    if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v
  }
  return out
}

type TouchEventLike = {
  nativeEvent?: { timestamp?: number; changedTouches?: ReadonlyArray<{ identifier?: string | number; pageX?: number; pageY?: number; timestamp?: number }> }
  target?: unknown
}

/** Hands the touches of a responder event to whoever records: Motion Scan passes its root view's touch events here. */
export function recordTouches(phase: TouchReport['phase'], e: TouchEventLike): void {
  for (const touch of e.nativeEvent?.changedTouches ?? []) {
    const stamp = touch.timestamp ?? e.nativeEvent?.timestamp
    emitTouch({
      phase,
      id: Number(touch.identifier ?? 0),
      x: Math.round(touch.pageX ?? 0),
      y: Math.round(touch.pageY ?? 0),
      stamp: typeof stamp === 'number' && Number.isFinite(stamp) ? stamp : null,
      ...(phase === 'start' && e.target ? { target: e.target } : {}),
    })
  }
}

// ─── What the app does besides animating ──────────────────────────────────────────

function installHooks() {
  // Touches, gestures, logs, app state and the keyboard, on the recording's clock (shared with a
  // live recording: native.ts markersWhileRecording).
  const r = state.recorder
  if (r) state.stopHooks.push(markersWhileRecording(r.elapsed, (m) => r.mark(m, m.t)))
}
