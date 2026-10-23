/**
 * Motion Scan: react-scan for motion. Outlines every view while it animates, coloured by the frames
 * its animation cost, with a small panel of UI / JS frame rates and the call sites that dropped the
 * most frames. No Keyframer, no pairing, no server: the Babel plugin plus this component.
 *
 *   import { MotionScan } from '@keyframerdev/inspector/scan'
 *
 *   export default function Root() {
 *     return (
 *       <MotionScan enabled={__DEV__}>
 *         <App />
 *       </MotionScan>
 *     )
 *   }
 *
 * Wrap the app (rather than render it beside it) so the scan starts listening before your screens
 * render: their first animations and styles are then reported too. When a Keyframer inspector is
 * already connected the scan listens to it; otherwise it installs a local one (JS + UI thread).
 *
 * With `recorder`, a record button sits next to the pill: a tester taps it, uses the app, taps again,
 * and shares one file the developer opens in the dev tools panel (see record.ts).
 *
 * Frames are counted on the UI thread (Reanimated's frame callback) and on the JS thread
 * (requestAnimationFrame). A frame that took 2.5 refresh intervals dropped 2 frames, and those frames
 * are charged to every animation running at that moment.
 *
 * The list under the pill also says what animates now (tracking.ts): animated styles and shared values
 * mounted on the screen, what each value drives, restarts per frame, rows that remount, and, while the
 * list is open, the cost per list cell (UI work sampled a second in ten). A restart storm or rows that
 * remount put a word on the pill.
 */

import { createElement as h, useEffect, useRef, useState, type ReactNode } from 'react'
import { Platform, Pressable, StyleSheet, Text, View, type GestureResponderEvent } from 'react-native'
import Animated, { useAnimatedStyle, useFrameCallback, useSharedValue, type SharedValue } from 'react-native-reanimated'
import { scheduleOnRN } from 'react-native-worklets'
import { setCaptureRoot } from './capture'
import { MotionTracker, droppedFrames, frameIntervalOf } from './motionStats'
import { currentRefreshRate, noteDisplay, uiThreadBridge, watchDisplay, watchUiWork } from './native'
import { createDisplayMeter, frameBudget, tickDisplayMeter, type DisplayMeter } from './display'
import { configureRecorder, isRecording, recordingElapsed, recordTouches, startRecording, stopRecording, watchRecording, watchSaved, type RecorderConfig } from './record'
import { realFrameTime } from './clock'
import { createInspector, getLayoutNode, getLayouts, isCapturing, isInspectorInstalled, remeasureLayouts, tapInspector, targetValues, tapTimeScale, timeScale, watchCapturing, watchLayouts } from './runtime'
import type { InspectorMotionTracking } from '../../protocol/inspector'
import { trackingLines } from './tracking'
import { holdTracking, type TrackingHandle } from './trackingRuntime'

export { isInstrumented } from './runtime'

export type MotionScanProps = {
  children?: ReactNode
  /** Off: renders the children only, measures nothing. */
  enabled?: boolean
  /** How long an outline lingers after its animation ends (ms). */
  fadeMs?: number
  /** Show the frame-rate pill (and its list of the worst call sites). */
  showPanel?: boolean
  /** Also show the UI thread's shortest and longest frame of the last half second. */
  debug?: boolean
  /**
   * A record button for testers: records everything (values, frames, animations, touches, navigation,
   * logs, screenshots) and shares one file. `true` uses what configureRecorder set.
   */
  recorder?: boolean | RecorderConfig
  /** Where the pill sits. Top right by default; move it when it covers a navigation header. */
  corner?: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left'
  /**
   * Whether outlines start on. The square next to the pill turns them on and off while the app runs;
   * off, nothing is measured or drawn, and the pill keeps counting frames.
   */
  outlines?: boolean
}

const CORNERS = {
  'top-right': { top: 54, right: 10, alignItems: 'flex-end' },
  'top-left': { top: 54, left: 10, alignItems: 'flex-start' },
  // Stacked upward from the corner: the list opens above the pill.
  'bottom-right': { bottom: 40, right: 10, alignItems: 'flex-end', flexDirection: 'column-reverse' },
  'bottom-left': { bottom: 40, left: 10, alignItems: 'flex-start', flexDirection: 'column-reverse' },
} as const

type Session = { tracker: MotionTracker; tracking: TrackingHandle; refs: number; stop: () => void }
let session: Session | null = null

/** One listening session per app, shared by every MotionScan mounted. Starts synchronously. */
function acquire(): Session {
  if (session) {
    session.refs++
    return session
  }
  const tracker = new MotionTracker()
  let uninstall: (() => void) | null = null
  if (!isInspectorInstalled()) {
    const local = createInspector({ send: () => {} })
    const removeHook = local.install()
    const bridge = Platform.OS === 'web' ? null : uiThreadBridge({ report: local.report, overrides: {} })
    uninstall = () => {
      bridge?.dispose?.()
      removeHook()
    }
  }
  watchLayouts(true)
  const untap = tapInspector((ev) => tracker.onEvent(ev, Date.now()))
  // What animates now: UI work for the cost per cell comes from the UI thread's frame loop (none on web).
  const tracking = holdTracking({ ...(Platform.OS === 'web' ? {} : { watchWork: watchUiWork }), hz: currentRefreshRate })
  session = {
    tracker,
    tracking,
    refs: 1,
    stop: () => {
      untap()
      tracking.release()
      watchLayouts(false)
      uninstall?.()
    },
  }
  return session
}

function release(s: Session) {
  s.refs--
  if (s.refs > 0) return
  s.stop()
  if (session === s) session = null
}

const COLORS = { ok: '#4ade80', warn: '#fbbf24', bad: '#f43f5e' }

/** Starts a frame at one call site past which several views restart it together (issues.ts restart-storm). */
const STORM_PER_FRAME = 3

/** A word on the pill for what tracking found: views restarting an animation every frame, or rows that remount. */
function motionWord(t: InspectorMotionTracking | null): string | null {
  if (!t) return null
  if (t.restarts.some((r) => r.perFrame > STORM_PER_FRAME)) return 'restarts'
  if (t.churn.some((c) => c.claimed >= 6 && c.claimed >= 3 * Math.max(1, c.instances))) return 'remounts'
  return null
}

/** Outlines drawn at once; past this the least recent are left out. */
const MAX_OUTLINES = 32
const OFF = -10000

type Measured = { pageX: number; pageY: number; width: number; height: number } | null

/**
 * One outline, placed on the UI thread: its rect is slot `index` of `rects` (x, y, width, height), which
 * a frame callback writes from Reanimated's measure() every frame. Colour, fade and badge come from JS.
 */
function OutlineSlot({ index, rects, color, opacity, dropped }: { index: number; rects: SharedValue<number[]>; color: string; opacity: number; dropped: number }) {
  const place = useAnimatedStyle(() => {
    'worklet'
    const r = rects.value
    const i = index * 4
    const x = r[i] ?? OFF
    const y = r[i + 1] ?? OFF
    // Position as a transform (no layout pass); the size only changes when the view's does.
    return { transform: [{ translateX: x }, { translateY: y }], width: r[i + 2] ?? 0, height: r[i + 3] ?? 0 }
  }, [rects, index])
  return h(
    Animated.View,
    { pointerEvents: 'none', style: [styles.outline, { left: 0, top: 0, borderColor: color, opacity }, place] },
    dropped > 0 ? h(Text, { style: [styles.badge, { backgroundColor: color }] }, `${dropped}`) : null,
  )
}
const tone = (dropped: number) => (dropped === 0 ? COLORS.ok : dropped <= 3 ? COLORS.warn : COLORS.bad)
const short = (file: string) => file.split('/').pop() ?? file

export function MotionScan({ children, enabled = true, fadeMs = 700, showPanel = true, debug = false, recorder, corner = 'top-right', outlines: outlinesAtStart = true }: MotionScanProps) {
  // Started during the first render, before the children render, so nothing they do is missed.
  const sessionRef = useRef<Session | null>(null)
  if (enabled && !sessionRef.current) sessionRef.current = acquire()
  useEffect(() => {
    if (!enabled) return
    if (!sessionRef.current) sessionRef.current = acquire()
    const s = sessionRef.current
    return () => {
      release(s)
      sessionRef.current = null
    }
  }, [enabled])

  const [rates, setRates] = useState({ ui: 0, js: 0, dropped: 0 })
  const [gaps, setGaps] = useState({ min: 0, max: 0 })
  const [, setTick] = useState(0)
  const [open, setOpen] = useState(false)
  const [showOutlines, setShowOutlines] = useState(outlinesAtStart)
  const showOutlinesRef = useRef(showOutlines)
  showOutlinesRef.current = showOutlines
  // Hidden while the inspector snapshots the screen for an export.
  const [hidden, setHidden] = useState(isCapturing)
  useEffect(() => watchCapturing(setHidden), [])
  // The speed an inspector runs animations at: shown on the pill while it is not normal, so a paused
  // app does not look frozen for no reason.
  const [speed, setSpeed] = useState(timeScale)
  useEffect(() => tapTimeScale(setSpeed), [])

  // ── Recorder ──
  const [rec, setRec] = useState(isRecording)
  const [recMs, setRecMs] = useState(0)
  useEffect(() => {
    if (recorder && typeof recorder === 'object') configureRecorder(recorder)
  }, [recorder])
  useEffect(() => watchRecording(setRec), [])
  // Where the last recording went, shown under the button for a few seconds.
  const [saved, setSaved] = useState<string | null>(null)
  useEffect(
    () =>
      watchSaved((info) => {
        setSaved(info.projectFile ? `Saved to ${info.projectFile}` : info.sentToPanel ? 'Sent to the inspector panel' : null)
        setTimeout(() => setSaved(null), 5000)
      }),
    [],
  )
  useEffect(() => {
    if (!rec) return
    const id = setInterval(() => setRecMs(recordingElapsed()), 500)
    return () => clearInterval(id)
  }, [rec])
  const totals = useRef({ dropped: 0 })

  // ── UI thread frames ──
  const uiFrames = useSharedValue(0)
  const uiWindowStart = useSharedValue(0)
  const uiMinDt = useSharedValue(1000)
  const uiMaxDt = useSharedValue(0)
  const uiLastTs = useSharedValue(0)
  const uiFast = useSharedValue(0)
  const uiMid = useSharedValue(0)
  const uiInterval = useSharedValue(1000 / 60)
  // The display's refresh rate as far as it is known (a connection measures it, so does a recording):
  // the UI thread runs at it, so its drops are counted against it. Its own frames say it too (below).
  const knownHz = useSharedValue(currentRefreshRate())
  useEffect(() => watchDisplay((hz) => knownHz.set(hz)), [knownHz])
  const onUiDrop = (uiTs: number, frames: number, dt: number) => {
    // UI timestamps run on their own clock: line them up with JS time by the smallest lag seen.
    const lag = Date.now() - uiTs
    clock.current = Math.min(clock.current, lag)
    totals.current.dropped += frames
    sessionRef.current?.tracker.onDrop(uiTs + clock.current, frames, dt)
  }
  const clock = useRef(Number.POSITIVE_INFINITY)
  const onUiRate = (fps: number, minDt: number, maxDt: number, frames: number) => {
    sessionRef.current?.tracking.noteFrames(frames)
    setRates((r) => (r.ui === fps && r.dropped === totals.current.dropped ? r : { ...r, ui: fps, dropped: totals.current.dropped }))
    if (debug) setGaps({ min: Math.round(minDt * 10) / 10, max: Math.round(maxDt * 10) / 10 })
  }
  useFrameCallback((info) => {
    'worklet'
    // The gap since the last callback, measured from timestamps so a skipped callback shows as one long
    // frame. Real time: frame callbacks get the inspector's slowed clock while it controls the speed.
    const ts = realFrameTime(info.timestamp)
    // The display, read from these frames: kept on the UI runtime (an object in a shared value or a
    // closure cannot be changed in place). What it learns goes to the rest of the inspector too.
    const g = globalThis as { __KF_SCAN_DISPLAY__?: DisplayMeter }
    let d = g.__KF_SCAN_DISPLAY__
    if (d === undefined) {
      d = createDisplayMeter()
      g.__KF_SCAN_DISPLAY__ = d
    }
    if (tickDisplayMeter(d, ts)) scheduleOnRN(noteDisplay, d.hz, d.changes)
    const last = uiLastTs.value
    uiLastTs.value = ts
    if (last === 0) return
    const dt = ts - last
    if (dt <= 0) return
    if (dt < uiMinDt.value) uiMinDt.value = dt
    if (dt > uiMaxDt.value) uiMaxDt.value = dt
    if (dt < 10.5) uiFast.value += 1
    else if (dt < 13) uiMid.value += 1
    // One refresh of the display once it is known; until then, the guess from the last window.
    const interval = frameBudget(d, knownHz.value, uiInterval.value)
    const lost = Math.max(0, Math.round(dt / interval) - 1)
    if (lost > 0) scheduleOnRN(onUiDrop, ts, lost, dt)
    uiFrames.value += 1
    if (uiWindowStart.value === 0) uiWindowStart.value = ts
    const span = ts - uiWindowStart.value
    if (span >= 500) {
      // Until the display's rate is known: what most frames of the last window took, snapped to 60/90/120 Hz.
      const m = uiMinDt.value
      const n = uiFrames.value
      uiInterval.value = uiFast.value * 2 > n ? 1000 / 120 : (uiFast.value + uiMid.value) * 2 > n ? 1000 / 90 : 1000 / 60
      uiFast.value = 0
      uiMid.value = 0
      scheduleOnRN(onUiRate, Math.round((uiFrames.value * 1000) / span), m, uiMaxDt.value, uiFrames.value)
      uiFrames.value = 0
      uiWindowStart.value = ts
      uiMinDt.value = 1000
      uiMaxDt.value = 0
    }
  }, enabled)

  // ── JS thread frames ──
  useEffect(() => {
    if (!enabled) return
    let raf = 0
    let last = 0
    let frames = 0
    let windowStart = 0
    let recent: number[] = []
    let interval = 1000 / 60
    const loop = (ts: number) => {
      if (last) {
        const dt = ts - last
        recent.push(dt)
        const lost = droppedFrames(dt, interval)
        if (lost > 0) {
          totals.current.dropped += lost
          sessionRef.current?.tracker.onDrop(Date.now(), lost, dt)
        }
      }
      last = ts
      frames++
      if (!windowStart) windowStart = ts
      if (ts - windowStart >= 500) {
        // Its own rate, never faster than the display: React Native's JS thread often runs at 60 on a
        // 120 Hz screen, and is judged at the rate it runs (frameIntervalOf takes the median).
        interval = frameIntervalOf(recent, currentRefreshRate() || null)
        const fps = Math.round((frames * 1000) / (ts - windowStart))
        setRates((r) => (r.js === fps && r.dropped === totals.current.dropped ? r : { ...r, js: fps, dropped: totals.current.dropped }))
        frames = 0
        windowStart = ts
        recent = []
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [enabled])

  // What animates now: read every 2 s (a second while the list is open, which also samples UI work for
  // the cost per cell). Reading walks the mounted values and styles; nothing runs per frame.
  const [motionNow, setMotionNow] = useState<InspectorMotionTracking | null>(null)
  useEffect(() => {
    const tracking = sessionRef.current?.tracking
    if (!enabled || !tracking) return
    tracking.sampleWork(open)
    const read = () => {
      try {
        setMotionNow(tracking.summary())
      } catch {
        // Read again next time.
      }
    }
    read()
    const id = setInterval(read, open ? 1000 : 2000)
    return () => {
      clearInterval(id)
      tracking.sampleWork(false)
    }
  }, [enabled, open])

  // Redraw the outlines a few times a second, and only while there is something to outline (or one just
  // faded out): an idle scan commits nothing, so it costs the UI thread no frames of its own.
  const drawn = useRef(0)
  // The last value each endless loop's target had, to tell a running loop from one that stopped.
  const lastValues = useRef(new Map<string, string>())
  useEffect(() => {
    if (!enabled) return
    const id = setInterval(() => {
      const tracker = sessionRef.current?.tracker
      // Endless loops stay outlined while their value keeps changing (a few reads a second, off render).
      tracker?.keepEndless(Date.now(), (site) => {
        const key = site.id
        const now = JSON.stringify(targetValues(site)) ?? ''
        const changed = now !== '[]' && lastValues.current.get(key) !== now
        lastValues.current.set(key, now)
        return changed
      })
      // Outlines off: nothing to measure or draw (one last redraw clears what was on screen).
      const live = showOutlinesRef.current ? (tracker?.outlines(Date.now(), fadeMs) ?? []) : []
      if (live.length === 0 && drawn.current === 0) return
      drawn.current = live.length
      // Where the outlined views are now: they move without a layout event (scrolling, a header inset,
      // a transition). The answers land before the next redraw.
      remeasureLayouts(live.map((o) => o.styleId))
      setTick((t) => t + 1)
    }, 125)
    return () => clearInterval(id)
  }, [enabled, fadeMs])

  // Outlines follow their views on the UI thread. JS decides what to outline and how (colour, fade, the
  // badge) a few times a second; every frame, the UI thread measures each outlined view (Reanimated's
  // measure, on the view's shadow node) and the slot follows through an animated style. So an outline
  // keeps up with scrolling and transitions, and still moves while the JS thread is blocked (which is
  // one of the things the scan reports). A view without a shadow node (web, the old architecture) or one
  // measure cannot read (flattened on Android) uses the JS measurement instead.
  const slotOf = useRef(new Map<string, number>())
  const slotNodes = useSharedValue<unknown[]>([])
  const slotFallback = useSharedValue<number[]>([])
  const slotRects = useSharedValue<number[]>([])
  const placer = useFrameCallback(() => {
    'worklet'
    const nodes = slotNodes.value
    const fallback = slotFallback.value
    const measureNode = (globalThis as { _measure?: (node: unknown) => Measured })._measure
    const out: number[] = []
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]
      let m: Measured = null
      if (node && measureNode) {
        try {
          m = measureNode(node)
        } catch {
          m = null
        }
      }
      if (m && !isNaN(m.pageX) && (m.width > 0 || m.height > 0)) out.push(m.pageX, m.pageY, m.width, m.height)
      else out.push(fallback[i * 4] ?? OFF, fallback[i * 4 + 1] ?? OFF, fallback[i * 4 + 2] ?? 0, fallback[i * 4 + 3] ?? 0)
    }
    slotRects.value = out
  }, false)
  const pendingSlots = useRef<{ nodes: unknown[]; fallback: number[]; measured: boolean }>({ nodes: [], fallback: [], measured: false })
  useEffect(() => {
    const { nodes, fallback, measured } = pendingSlots.current
    slotNodes.value = nodes
    slotFallback.value = fallback
    // Nothing to measure on the UI thread: the JS rects are the rects, and the callback sleeps.
    if (!measured) slotRects.value = fallback
    placer.setActive(measured)
  })

  // Touches reach the recorder from the root, before any child handles them. Bubbling props: they
  // never take the responder from the app.
  const touches = {
    onTouchStart: (e: GestureResponderEvent) => recordTouches('start', e),
    onTouchMove: (e: GestureResponderEvent) => recordTouches('move', e),
    onTouchEnd: (e: GestureResponderEvent) => recordTouches('end', e),
    onTouchCancel: (e: GestureResponderEvent) => recordTouches('cancel', e),
  }
  if (!enabled || hidden) return h(View, { ref: setCaptureRoot, style: styles.fill, pointerEvents: 'box-none', ...touches }, children)

  const tracker = sessionRef.current?.tracker
  const now = Date.now()
  const layouts = getLayouts()
  // Each outlined style keeps its slot while it is outlined, so its animated style is not handed to
  // another view mid-frame.
  const live = (tracker && showOutlines ? tracker.outlines(now, fadeMs) : []).filter((o) => layouts.has(o.styleId) || getLayoutNode(o.styleId))
  const slots = slotOf.current
  for (const id of [...slots.keys()]) if (!live.some((o) => o.styleId === id)) slots.delete(id)
  const taken = new Set(slots.values())
  const nodes: unknown[] = []
  const fallback: number[] = []
  const outlines = live.flatMap((o) => {
    let slot = slots.get(o.styleId)
    if (slot === undefined) {
      for (let i = 0; i < MAX_OUTLINES; i++) {
        if (!taken.has(i)) {
          slot = i
          break
        }
      }
      if (slot === undefined) return []
      slots.set(o.styleId, slot)
      taken.add(slot)
    }
    const r = layouts.get(o.styleId)
    nodes[slot] = getLayoutNode(o.styleId) ?? null
    fallback.splice(slot * 4, 4, r?.x ?? OFF, r?.y ?? OFF, r?.width ?? 0, r?.height ?? 0)
    const color = tone(o.dropped)
    const opacity = o.live ? 1 : Math.max(0, 1 - o.age / fadeMs)
    return [h(OutlineSlot, { key: o.styleId, index: slot, rects: slotRects, color, opacity, dropped: o.dropped })]
  })
  const size = Math.max(0, ...[...taken].map((i) => i + 1))
  for (let i = 0; i < size; i++) {
    nodes[i] ??= null
    for (let k = 0; k < 4; k++) fallback[i * 4 + k] ??= k < 2 ? OFF : 0
  }
  pendingSlots.current = { nodes, fallback, measured: Platform.OS !== 'web' && nodes.some(Boolean) }

  const worst = tracker?.worst(5) ?? []
  const recClock = `${Math.floor(recMs / 60000)}:${String(Math.floor(recMs / 1000) % 60).padStart(2, '0')}`
  const recButton = recorder
    ? h(
        Pressable,
        {
          onPress: () => {
            if (isRecording()) void stopRecording()
            else {
              setRecMs(0)
              startRecording()
            }
          },
          accessibilityRole: 'button',
          accessibilityLabel: rec ? 'Stop recording and share' : 'Record this session',
          style: [styles.pill, styles.recPill, rec ? styles.recOn : null],
        },
        h(View, { style: rec ? styles.recSquare : styles.recDot }),
        h(Text, { style: [styles.pillText, { color: rec ? '#fff' : '#fafafa' }] }, rec ? recClock : 'REC'),
      )
    : null
  const outlineToggle = h(
    Pressable,
    {
      onPress: () => setShowOutlines((v) => !v),
      accessibilityRole: 'switch',
      accessibilityLabel: 'Outlines',
      accessibilityState: { checked: showOutlines },
      hitSlop: 6,
      style: [styles.pill, styles.togglePill],
    },
    h(View, { style: [styles.toggleSquare, showOutlines ? styles.toggleOn : styles.toggleOff] }),
  )
  const savedNote = saved ? h(Text, { style: styles.saved, numberOfLines: 2 }, saved) : null
  const panel = showPanel
    ? h(
        View,
        { style: [styles.panelWrap, CORNERS[corner]], pointerEvents: 'box-none' },
        savedNote,
        h(View, { style: styles.pillRow, pointerEvents: 'box-none' }, recButton, outlineToggle, h(
          Pressable,
          { onPress: () => setOpen((v) => !v), style: styles.pill },
          h(Text, { style: [styles.pillText, { color: rates.ui && rates.ui < 50 ? COLORS.bad : COLORS.ok }] }, `UI ${rates.ui || '–'}`),
          h(Text, { style: [styles.pillText, { color: rates.js && rates.js < 50 ? COLORS.bad : COLORS.ok }] }, `JS ${rates.js || '–'}`),
          h(Text, { style: [styles.pillText, { color: rates.dropped ? COLORS.warn : '#a1a1aa' }] }, `${rates.dropped} dropped`),
          debug ? h(Text, { style: [styles.pillText, { color: '#a1a1aa' }] }, `${gaps.min}–${gaps.max}ms`) : null,
          speed !== 1 ? h(Text, { style: [styles.pillText, { color: COLORS.warn }] }, speed === 0 ? 'Paused' : `${speed}×`) : null,
          motionWord(motionNow) ? h(Text, { style: [styles.pillText, { color: COLORS.warn }] }, motionWord(motionNow)) : null,
        )),
        open
          ? h(
              View,
              { style: styles.list },
              worst.length
                ? worst.map((s) =>
                    h(
                      View,
                      { key: s.site.id, style: styles.row },
                      h(Text, { style: styles.rowTitle, numberOfLines: 1 }, `${short(s.site.file)}:${s.site.line} · ${s.site.fn}`),
                      h(Text, { style: [styles.rowMeta, { color: tone(s.dropped) }] }, `${s.dropped} dropped · ${Math.round(s.worstFrameMs)}ms worst · ${s.calls}×`),
                    ),
                  )
                : h(Text, { style: styles.rowMeta }, 'No dropped frames while anything animated.'),
              motionNow ? h(View, { style: styles.motion }, ...trackingLines(motionNow).map((line, i) => h(Text, { key: `m${i}`, style: i === 0 ? styles.rowTitle : styles.rowMeta }, line.trim()))) : null,
            )
          : null,
      )
    : null

  return h(
    View,
    // The app's root: what a Skia capture draws.
    { ref: setCaptureRoot, style: styles.fill, pointerEvents: 'box-none', ...touches },
    children,
    h(View, { style: styles.overlay, pointerEvents: 'box-none' }, ...outlines, panel ?? (recButton ? h(View, { style: [styles.panelWrap, CORNERS[corner]], pointerEvents: 'box-none' }, savedNote, recButton) : null)),
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  overlay: { ...StyleSheet.absoluteFill, zIndex: 99999, elevation: 99999 },
  outline: { position: 'absolute', borderWidth: 2, borderRadius: 4 },
  badge: { position: 'absolute', top: -10, right: -10, minWidth: 20, paddingHorizontal: 4, borderRadius: 10, fontSize: 11, fontWeight: '700', color: '#111', textAlign: 'center', overflow: 'hidden' },
  panelWrap: { position: 'absolute', gap: 6 },
  pill: { flexDirection: 'row', gap: 8, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14, backgroundColor: 'rgba(17,17,20,0.88)' },
  pillText: { fontSize: 11, fontWeight: '700', fontVariant: ['tabular-nums'] },
  pillRow: { flexDirection: 'row', gap: 6 },
  recPill: { alignItems: 'center', gap: 6 },
  recOn: { backgroundColor: 'rgba(225,29,72,0.92)' },
  recDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#f43f5e' },
  saved: { maxWidth: 260, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10, overflow: 'hidden', fontSize: 11, color: '#fafafa', backgroundColor: 'rgba(17,17,20,0.88)' },
  recSquare: { width: 8, height: 8, borderRadius: 2, backgroundColor: '#fff' },
  togglePill: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  toggleSquare: { width: 12, height: 12, borderRadius: 3, borderWidth: 2 },
  toggleOn: { borderColor: COLORS.ok, backgroundColor: 'rgba(74,222,128,0.25)' },
  toggleOff: { borderColor: '#71717a' },
  list: { width: 260, padding: 10, gap: 8, borderRadius: 12, backgroundColor: 'rgba(17,17,20,0.92)' },
  row: { gap: 2 },
  rowTitle: { color: '#fafafa', fontSize: 12, fontWeight: '600' },
  rowMeta: { color: '#a1a1aa', fontSize: 11 },
  motion: { gap: 3, paddingTop: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#3f3f46' },
})
