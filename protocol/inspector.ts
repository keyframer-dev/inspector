/**
 * The runtime inspector's own types: what the Babel plugin bakes into call sites, what an app reports,
 * and the messages of the live pairing room. Kept in a file of their own, with no imports, so the
 * published @keyframerdev/inspector package can ship them as its type definitions (re-exported from
 * index.ts like every other type here).
 */

// ─── Runtime inspector ──────────────────────────────────────────────────────────
// A dev-only Babel plugin (react-native) tags every Reanimated animation call and shared value
// in an app with where it was written, so a running app can report its motion and take edits back.

/** A numeric literal argument the inspector can show, tweak live and write back to the source. */
export type InspectorParam = {
  /** Argument index, then object keys: "0" is the first argument, "1.duration" a config field. */
  path: string
  value: number
}

/** Static facts about one animation call site, baked in by the Babel plugin. */
export type InspectorCallSite = {
  /** `relative/file.tsx:line:column` of the call; stable until the file is edited. */
  id: string
  file: string
  line: number
  column: number
  /** withTiming, withSpring, withDelay, withSequence, withRepeat, withDecay, withClamp */
  fn: string
  /** Nearest enclosing component or hook name, e.g. "WelcomeDemo". */
  component: string | null
  /** The shared value being assigned (`logoScale.value = …`), when there is one. */
  target: string | null
  /** The style key it animates when written inline in a style object (`{ scale: withSpring(1) }`). */
  prop: string | null
  params: InspectorParam[]
}

/**
 * Static facts about one animated value: a useSharedValue on React Native, an AnimationController on
 * Flutter, a layer property on iOS, an animator on Android. Gestures and sensors write to them.
 */
export type InspectorSignalSite = {
  id: string
  file: string
  /** 0 when the platform cannot say (an iOS stack without debug info). */
  line: number
  column?: number
  component: string | null
  name: string | null
  /**
   * `scroll`: a list's offset (playback scrolls the real list). Ids of React Native scroll tracks also
   * say so (`scroll:file:line:x`). `time`: an animation's play time (ms), the track playback writes to
   * replay an animator whose value is read-only. Not a value on screen: the motion problems (unseen,
   * jumps, two writers, Reduce Motion) skip it.
   */
  kind?: 'value' | 'scroll' | 'time'
  /**
   * The property it animates, when the SDK knows one (a Flutter implicit animation: 'opacity',
   * 'scale', 'position'; several comma-joined, 'size,color'). The problems engine reads 'opacity',
   * 'alpha' and colors as fades, which Reduce Motion allows.
   */
  prop?: string
  /** False when playback cannot write it back (a value the platform only reads). */
  writable?: boolean
}

/** One useAnimatedStyle: which shared value feeds which style key (`transform: [{ scale: logoScale.value }]`). */
export type InspectorStyleSite = {
  id: string
  file: string
  line: number
  component: string | null
  /** The variable it is assigned to, e.g. "logoStyle". */
  name: string | null
  links: Array<{ signal: string; prop: string }>
}

/** One gesture callback, baked in by the Babel plugin: `Gesture.Pan().onUpdate(…)` → Pan, onUpdate. */
export type InspectorGestureSite = { id: string; file: string; line: number; component: string | null; gesture: string; on: string }

/** Stands in for an animation passed as an argument (withDelay(142, withTiming(…))): the inner call's event id. */
export type InspectorAnimRef = { $anim: number }

/** Live edits keyed by call site id: param path → value. Applied the next time that call runs. */
export type InspectorOverrides = Record<string, Record<string, number>>

/**
 * The two threads every platform reports on, by role:
 * - `js`, the app thread: where the app's own code runs (handlers, effects, builds and renders). React
 *   Native's JS thread, Flutter's UI isolate, the main thread on iOS and Android.
 * - `ui`, the frame thread: where frames are put together. React Native's UI thread, Flutter's raster
 *   thread, Android's RenderThread. A platform that cannot see it (iOS: the render server) leaves it out.
 * The ids stay `js` and `ui` so recordings from every platform read alike; the app's hello says what
 * they are called there and which one drives animations.
 */
export type InspectorThread = 'ui' | 'js'

/** What one thread is on this platform: its name, and whether animations run on it. */
export type InspectorThreadInfo = {
  /** "JS", "Main", "UI isolate", "Raster", "RenderThread". */
  label: string
  /** Animations are driven here, so a long frame on it freezes them (true for the app thread on iOS, Android and Flutter). */
  animates?: boolean
}

/** Which threads the app has; a missing entry is one the platform does not measure. Without it: React Native's JS and UI threads. */
export type InspectorThreads = Partial<Record<InspectorThread, InspectorThreadInfo>>

/** The UI framework an app is written with: what the problems engine words its fixes for. */
export type InspectorFramework = 'react-native' | 'flutter' | 'uikit' | 'swiftui' | 'android-views' | 'compose' | (string & {})

/** What an app said about itself in its hello, kept with a session and a recording. */
export type InspectorAppInfo = {
  name: string
  /** The OS: "ios", "android", "macos", "web". Older React Native apps and SDKs may send a framework name here. */
  platform: string
  framework?: InspectorFramework
  osVersion?: string
  threads?: InspectorThreads
  /** How it was built: frame times in a debug build are inflated (see InspectorBuild). */
  build?: InspectorBuild
  display?: InspectorDisplay
  accessibility?: InspectorAccessibility
  device?: InspectorDevice
}

/**
 * The device the app runs on, so a runner can tell apps apart on one relay (one check on several
 * simulators at once). `id`: SIMULATOR_UDID on an iOS simulator, the AVD name on an Android emulator.
 * `model`: hw.machine on iOS, Build.MODEL on Android.
 *
 * Privacy: `name` and `id` are only for simulators and emulators. A physical device reports `model`
 * (and `simulator: false`) but never its user-given name ("Catalin's iPhone"), since recordings get
 * shared.
 */
export type InspectorDevice = { name?: string; model?: string; id?: string; simulator?: boolean }

/**
 * The screen the app draws on. Its refresh rate sets the frame budget (1000 / hz ms: 16.7 ms at 60 Hz,
 * 8.3 ms at 120 Hz), and frames are counted as dropped against it. `adaptive`: the rate follows the
 * content (ProMotion, Android's variable refresh), and `hz` is the highest it runs at. Without it: 60 Hz.
 */
export type InspectorDisplay = { hz: number; adaptive?: boolean }

/**
 * The person's motion settings: Reduce Motion on iOS and macOS, Remove animations on Android (an
 * animator duration scale of 0), `disableAnimations` in Flutter, `prefers-reduced-motion` on the web.
 * An animation that still runs while it is on is a problem, an accessibility one.
 */
export type InspectorAccessibility = { reduceMotion: boolean }

/**
 * Something about how an animated view is drawn that costs the frame thread or the GPU more than it
 * needs to, seen by the SDK on the view itself: a shadow without a path, a mask or a blur over moving
 * content, group opacity forcing an offscreen pass, Flutter's Opacity animating where a FadeTransition
 * would not repaint. `id` is the signal (or call site) it belongs to; `hint` a stable key the problems
 * engine words a fix for ("shadow-path", "mask", "blur", "group-opacity", "opacity-widget",
 * "layer-alpha", "rasterize"); `detail` says what the SDK saw.
 */
export type InspectorRenderHint = { id: string; hint: string; detail?: string }

/**
 * How the app was built. A debug build runs extra checks (React Native's dev mode, Flutter's JIT and
 * asserts, unoptimized native code), so its frames are slower than a release build's: the problems
 * are real, the numbers are inflated.
 */
export type InspectorBuild = 'debug' | 'profile' | 'release'

/**
 * What an app can do besides reporting: the panel and the MCP server only offer what it has.
 * `widget-sites` (Flutter): widget creation tracking is on, so implicit animations, Hero sites and
 * render-hint locations are reported; a Flutter app without it reports none of them.
 */
export type InspectorCapability = 'capture' | 'playback' | 'scrub' | 'overrides' | 'replay' | 'reload' | 'scenarios' | 'recordings' | 'time' | 'widget-sites' | (string & {})

/** What the app reports while it runs. */
export type InspectorEvent =
  /** `eid` numbers each call; nested animations among `args` are replaced by an InspectorAnimRef. */
  | {
      kind: 'anim'
      eid: number
      site: InspectorCallSite
      at: number
      args: unknown[]
      /** Which thread started it (see InspectorThread): on React Native, 'ui' for calls made inside worklets (gestures, reactions, scroll). */
      thread?: InspectorThread
      /** While recording: when it started, on the recording's clock (the same one samples use). */
      t?: number
      /** While recording, for JS-thread calls: the raw JS stack of the call, symbolicated by the reader. */
      stack?: string
      /** The stack already mapped to source (native SDKs know their frames; React Native leaves it to Metro). */
      frames?: InspectorStackFrame[]
      /** How long it runs, delay included, when the app knows: otherwise the reader estimates it from `fn` and `args`. */
      durationMs?: number
    }
  /**
   * A value was registered. `t`, while recording: when, on the recording's clock (the same one samples
   * use). A screen that remounts registers its values again under the same ids: from `t` on, samples
   * under the id are the new instance's (see InspectorMount).
   */
  | { kind: 'signal'; site: InspectorSignalSite; t?: number }
  /** A value that went away (its screen closed): it leaves the catalog. Recordings keep what they sampled. `t`, while recording: when it went away. */
  | { kind: 'unsignal'; id: string; t?: number }
  | { kind: 'style'; site: InspectorStyleSite }
  /** See InspectorRenderHint. Sent once per view and hint, when the SDK first sees it. */
  | ({ kind: 'renderHint' } & InspectorRenderHint)

// ─── Live inspector protocol ────────────────────────────────────────────────────
// Three parties meet in one pairing room (a Durable Object on the API, joined with a short code):
//   app    — an instrumented React Native app (react-native runtime + Babel plugin)
//   editor — the Keyframer editor's Inspector panel
//   cli    — `keyframer-inspect`, a local command next to the app's source that writes edits to disk
// Every message is JSON with a `type`. The room relays app messages to editors, editor messages to the
// app and the cli, and cli messages to editors.

export type InspectorRole = 'app' | 'editor' | 'cli'

/** A shared value sampled while it moves (gestures, sensors, scroll): the "live signal" view. */
export type InspectorSample = { id: string; t: number; v: number }

/** How smoothly a thread ran over the window that ended at `t` (same clock as samples), while recording. */
export type InspectorFrameStat = { t: number; thread: InspectorThread; fps: number; dropped: number }
/** One long frame on a thread: it ended at `t`, took `ms` and skipped `dropped` frames. */
export type InspectorFrameDrop = { t: number; thread: InspectorThread; ms: number; dropped: number }
/** The frames a recording saw, kept beside its samples in the editor. */
export type InspectorRecordedFrames = { stats: InspectorFrameStat[]; drops: InspectorFrameDrop[] }
/** One React commit while recording: it ended at `t`, rendered for `ms`, and the components that rendered most. */
/**
 * A component in a React commit. Time spent in library components (View, Text, navigators) is charged
 * to the app component that rendered them, so `name` is one the app wrote whenever the Babel plugin
 * saw it (`file` then says where).
 */
export type InspectorCommitComponent = {
  name: string
  ms: number
  file?: string
  /** How many instances rendered in this commit. */
  count?: number
  /** Why it rendered again: "props: tick", "state", "parent" (re-rendered with equal props), "mount". */
  why?: string[]
}
/** One React commit while recording: it ended at `t`, rendered for `ms`, and the components that rendered most. */
export type InspectorCommit = { t: number; ms: number; components: InspectorCommitComponent[] }

/**
 * App code that ran on the JS thread while recording, timed by the Babel plugin and the runtime: an
 * event handler (onPress), an effect, a timer callback. Only tasks of a few ms are kept: what can
 * explain a long JS frame. `t` is when it ended.
 */
export type InspectorTask = {
  t: number
  ms: number
  /** Native SDKs add their own (a run loop source, a message on the main Looper). */
  kind: 'handler' | 'effect' | 'timer' | 'scenario' | (string & {})
  /** onPress, useEffect, setTimeout, requestAnimationFrame… */
  name: string
  /** `file:line` where it is written (handlers, effects); timers carry the stack that scheduled them instead. */
  site: string | null
  component: string | null
  stack?: string
  frames?: InspectorStackFrame[]
}

/**
 * Work on the frame thread in one frame, with its total time in that frame. On React Native: an
 * animated style, a derived value, a reaction, a scroll handler, a gesture callback or a scheduleOnUI
 * call (worklets). Other frameworks report their own kinds (Flutter: build, layout, paint).
 */
export type InspectorUiWork = { t: number; ms: number; calls: number; kind: string; site: string; name: string | null }

// ─── Recordings ─────────────────────────────────────────────────────────────────
// A session recorded on the device, with no panel connected, saved as one JSON file a tester can send
// to a developer. It holds everything the panel shows live, plus what the person did (touches) and
// what the app did besides animating (navigation, app state, keyboard, errors), and a few screenshots.

/** Something that happened while recording besides motion. Coordinates are screen points. */
export type InspectorMarker =
  /** `lost`: the end was never seen (the view under the finger went away mid-touch, so the app could not see it lift). */
  | { kind: 'touch'; t: number; phase: 'start' | 'move' | 'end' | 'cancel'; id: number; x: number; y: number; lost?: boolean }
  | { kind: 'navigation'; t: number; route: string; params?: Record<string, unknown> }
  | { kind: 'appState'; t: number; state: string }
  | { kind: 'keyboard'; t: number; visible: boolean; height: number }
  | { kind: 'log'; t: number; level: 'error' | 'warn'; message: string; stack?: string; frames?: InspectorStackFrame[] }
  | { kind: 'note'; t: number; text: string }
  /**
   * A react-native-gesture-handler callback ran (the Babel plugin wraps them): which gesture, which
   * callback, where the finger was on screen. Touches the gesture took over continue here.
   */
  | { kind: 'gesture'; t: number; gesture: string; on: string; handler: number; x: number | null; y: number | null; site: string; component: string | null }
  /** The person's motion settings changed while recording (see InspectorAccessibility). */
  | { kind: 'accessibility'; t: number; reduceMotion: boolean }
  /** The refresh rate changed while recording: low power mode, ProMotion dropping to 60 Hz. */
  | { kind: 'display'; t: number; hz: number }
  /**
   * An animated value's view left the screen or came back: scrolled away, covered by another screen,
   * hidden (alpha 0, isHidden, Visibility.GONE), removed from the window. A value that keeps moving
   * while its view is not visible spends frames nobody sees. `id` is a signal id. The app going to the
   * background is an `appState` marker instead.
   */
  | { kind: 'visibility'; t: number; id: string; visible: boolean; reason?: 'offscreen' | 'hidden' | 'detached' | 'covered' }
  /**
   * The editor changed the app's animation speed while recording (the `time` message): durations on
   * the recording's clock between this marker and the next are stretched by 1 / scale. 0: paused.
   * `step`, while paused: the app advanced this many frames at once (the `time` message's step), at
   * the display's rate, at `t`; one marker per step.
   */
  | { kind: 'time'; t: number; scale: number; step?: number }

/**
 * A value mounting or going away while recording (from `signal` and `unsignal` events with `t`). A
 * screen that remounts gives its values new instances under the same ids: samples from a mount's `t`
 * on are that instance's, a series of their own (the jump from the old instance's last value to the
 * new one's first is not motion).
 */
export type InspectorMount = { id: string; t: number; mounted: boolean }

/** A screen the app was on: what playback navigates back to. */
export type InspectorRoute = { t: number; route: string; params?: Record<string, unknown> }

/** A part of the screen, in points. */
export type InspectorRect = { x: number; y: number; width: number; height: number }

/**
 * A screenshot taken while recording: base64 image data, and how long taking it held the app up.
 * `inputs`: where a text input the person was typing in sat on screen (blurred when shared).
 */
export type InspectorScreenshot = { t: number; ms: number; data: string; format: 'jpg' | 'png'; inputs?: InspectorRect[] }

/**
 * One frame of a stack, mapped to its source. `collapse`: a library frame. `lineNumber` 0: not known
 * yet; a native frame then carries `image` and `offset`, which the Mac resolves with the app's
 * binary (atos), and `symbol`, the raw symbol name.
 */
export type InspectorStackFrame = {
  methodName: string
  file: string
  lineNumber: number
  column: number
  collapse?: boolean
  image?: string
  offset?: number
  symbol?: string
}

/**
 * An animation that started while recording. `frames` is `stack` already symbolicated, by the app when
 * it saved the recording through Metro: right for that build, where mapping the raw stack later
 * through a newer bundle would point at the wrong lines.
 */
export type InspectorRecordedAnim = {
  /**
   * The `anim` event's `eid`, when it was kept: an animation whose call another one's arguments point
   * at (an InspectorAnimRef) is written inside that one (withDelay(…, withTiming(…)) is one write).
   */
  eid?: number
  t: number
  thread: InspectorThread
  site: InspectorCallSite
  args: unknown[]
  stack?: string
  frames?: InspectorStackFrame[]
  durationMs?: number
}

export type InspectorRecording = {
  format: 'keyframer-recording'
  version: 1
  app: InspectorAppInfo
  /** ISO time the recording started. */
  startedAt: string
  duration: number
  /** The screen in points (touches use it) and its pixel scale. */
  screen: { width: number; height: number; scale: number }
  signals: InspectorSignalSite[]
  samples: InspectorSample[]
  frames: InspectorFrameStat[]
  drops: InspectorFrameDrop[]
  anims: InspectorRecordedAnim[]
  commits: InspectorCommit[]
  markers: InspectorMarker[]
  screenshots: InspectorScreenshot[]
  /** JS tasks and UI-thread work while recording (newer recordings). */
  tasks?: InspectorTask[]
  work?: InspectorUiWork[]
  /** The animated styles and which shared value feeds which style property (layout properties cost a layout pass). */
  styles?: InspectorStyleSite[]
  /** What the SDK saw about how animated views are drawn (newer recordings). */
  hints?: InspectorRenderHint[]
  /** When values mounted and went away while recording (newer recordings; see InspectorMount). */
  mounts?: InspectorMount[]
  /** What the person who recorded it wrote about it. */
  note?: string
  /** What was taken out before it was shared as a link (see redactRecording). */
  redaction?: InspectorRedaction
}

// ─── Shared recordings ──────────────────────────────────────────────────────────
// A recording uploaded to keyframer.dev and opened from a link instead of a file. What leaves the
// device or the panel is redacted first (react-native/src/redact.ts), with these choices.

export type InspectorRedaction = {
  /** `downscale`: kept, at most 360 px wide. `blur`: the whole frame, small and blurred. */
  screenshots: 'keep' | 'downscale' | 'blur' | 'drop'
  /** Text inputs the recorder saw on screen (InspectorScreenshot.inputs). */
  inputs: 'keep' | 'blur'
  /** Error and warning messages: `mask` replaces emails, long numbers and tokens. */
  logs: 'keep' | 'mask' | 'drop'
  /** Navigation params (ids, search text, anything the app passed between screens). */
  params: 'keep' | 'drop'
  note: 'keep' | 'drop'
}

/** A shared recording, as the API lists it. Times are ISO strings. */
export type InspectorSharedRecording = {
  id: string
  /** The page that shows it (keyframer.dev/r/<id>). */
  url: string
  /** The recording's JSON. */
  dataUrl: string
  app: string
  platform: string
  framework: string | null
  durationMs: number
  /** Stored size (gzipped). */
  bytes: number
  visibility: 'link'
  createdAt: string
  expiresAt: string
}

/** app → editors */
export type InspectorAppMessage =
  /** `capture`: the app can snapshot its screen (it passed `captureScreen`), so a recording can be exported. */
  | {
      type: 'hello'
      role: 'app'
      app: string
      /** The OS ("ios", "android", "macos"). */
      platform: string
      capture?: boolean
      screen?: { width: number; height: number; scale: number }
      /** Scenarios the app registered (registerScenario): interactions an agent can run to reproduce a problem. */
      scenarios?: string[]
      /** The version of this protocol the app speaks (1). */
      protocol?: number
      /** The SDK reporting, e.g. { name: '@keyframerdev/inspector', version: '0.1.0' } or keyframer_inspector for Flutter. */
      sdk?: { name: string; version: string }
      /** Without it: react-native. */
      framework?: InspectorFramework
      osVersion?: string
      /** debug, profile or release. Without it: not known (older apps). */
      build?: InspectorBuild
      /** What its two threads are (see InspectorThread). Without it: React Native's JS and UI threads. */
      threads?: InspectorThreads
      /** Without it: what React Native does (capture when `capture` is true). */
      capabilities?: InspectorCapability[]
      /**
       * The app's source folder on the developer's machine (development builds): relative call-site
       * paths (`app/feed.tsx`, `lib/main.dart`) resolve against it to open in an editor.
       */
      root?: string
      /** The display's refresh rate (see InspectorDisplay). Without it: 60 Hz. */
      display?: InspectorDisplay
      /** The person's motion settings (see InspectorAccessibility); a change while running is a marker. */
      accessibility?: InspectorAccessibility
      /** Which device it runs on (see InspectorDevice for what a physical device may say). */
      device?: InspectorDevice
    }
  /** The registered scenarios changed. */
  | { type: 'scenarios'; names: string[] }
  /** A scenario an editor asked for finished (or failed). */
  | { type: 'scenarioDone'; name: string; ms: number; error?: string }
  | { type: 'events'; events: InspectorEvent[] }
  /** `frames` and `drops` ride along while recording, so a scrubbed recording shows where frames dropped. */
  /** `commits` are the React renders that ran while recording, for telling what kept the JS thread busy. */
  | {
      type: 'samples'
      samples: InspectorSample[]
      frames?: InspectorFrameStat[]
      drops?: InspectorFrameDrop[]
      commits?: InspectorCommit[]
      /** Touches and gesture callbacks while recording (with Motion Scan around the app for touches). */
      markers?: InspectorMarker[]
      tasks?: InspectorTask[]
      work?: InspectorUiWork[]
    }
  /** A recording made on the device (from Motion Scan or startRecording), handed to a connected panel. */
  | { type: 'recording'; recording: InspectorRecording }
  /** The answer to `capture`: the screen as a base64 image, or why there is none. `format` may differ from the one asked for. */
  | { type: 'frame'; id: string; data?: string; format?: 'jpg' | 'png'; error?: string }
  /** The app's animation speed now, after a `time` message (or on hello, when it is not 1): every editor shows the same. */
  | { type: 'time'; scale: number }

/** editor → app (and cli for `apply`) */
export type InspectorEditorMessage =
  | { type: 'hello'; role: 'editor' }
  | { type: 'overrides'; overrides: InspectorOverrides }
  /** Ask the app to run its registered replay (re-mount the screen, re-fire the entrance). */
  | { type: 'replay' }
  /**
   * Restart the app's JavaScript from scratch (React Native: DevSettings.reload(), development builds
   * only), so each measured run starts from a clean state. The app says hello again once it is back.
   * Only for apps with the `reload` capability.
   */
  | { type: 'reload' }
  /**
   * Start / stop recording samples for these signal ids. `['*']`: every shared value, including those
   * that mount while recording (a screen opened mid-recording).
   *
   * `recorder`: who is recording, an id the editor picks and keeps for its connection (the MCP server,
   * ci, the panel, the e2e fixture). The app keeps the recorders that are on and records while any is,
   * sampling the union of their signal ids (`*` in any of them: every value, including ones that mount
   * meanwhile). `on: false` stops only that recorder: its listed ids, or all of it with `*`. Requests
   * without `recorder` share one anonymous recorder, so older editors still behave as before among
   * themselves. When the last editor leaves (presence editors 0), the app drops every recorder.
   * Samples, frames and the rest still go to every editor; an editor keeps what arrives while its own
   * recorder is on.
   */
  | { type: 'record'; signalIds: string[]; on: boolean; recorder?: string }
  /** Run a registered scenario; the app answers with scenarioDone. */
  | { type: 'scenario'; name: string }
  /**
   * Play recorded samples back into the app's shared values, in time order: a gesture replayed exactly.
   * `routes` are the screen changes along the way (the first one is the screen it starts on), on the
   * samples' clock: the app navigates as it plays.
   */
  | { type: 'playback'; samples: InspectorSample[]; routes?: InspectorRoute[] }
  /**
   * Set these shared values (one sample each), wait for the screen to show them and snapshot it: one
   * frame of an exported recording. `width` scales the image; the app answers with `frame` and the same id.
   */
  | { type: 'capture'; id: string; samples: InspectorSample[]; format?: 'jpg' | 'png'; quality?: number; width?: number; route?: InspectorRoute }
  /**
   * Show the app as it was at `t` ms on the last recording's clock, from the platform's own animation
   * timeline (iOS scrubs Core Animation), between what samples can show. `null` hands it back. Only
   * for apps with the `scrub` capability; the others get `playback` with one sample per value.
   */
  | { type: 'scrub'; t: number | null }
  /**
   * Run the app's animations at another speed, pause them or step them, for apps with the `time`
   * capability. `scale`: 1 is normal, 0.25 a quarter of the speed, 0 paused. `step`, sent while paused:
   * advance this many frames at the display's rate, then hold again. Each platform uses its own clock:
   * React Native Reanimated's frame timestamps, Flutter's timeDilation (and its scheduler while paused),
   * the key window layer's speed on iOS, the animator duration scale on Android. The app answers with
   * `time`, so every editor shows the same state.
   */
  | { type: 'time'; scale: number; step?: number }
  /** Write tuned values to the source files (handled by the cli). */
  | { type: 'apply'; edits: Array<{ file: string; line: number; column: number; fn: string; path: string; value: number }> }
  /** Ask the cli for these source files (paths as call sites report them), to rebuild the screen's views. */
  | { type: 'source'; files: string[] }

/** cli → editors */
export type InspectorCliMessage =
  | { type: 'hello'; role: 'cli'; root: string }
  | { type: 'applied'; results: Array<{ file: string; applied: number; skipped: Array<{ path: string; reason: string }> }> }
  /** One requested source file: its text, or why it was not sent. One message per file keeps each small. */
  | { type: 'sources'; file: string; text: string | null; reason?: string }

/** room → everyone: who is connected. */
export type InspectorPresenceMessage = { type: 'presence'; app: boolean; editors: number; cli: boolean }

// ─── Local relay (the desktop app, ws://127.0.0.1:8790) ─────────────────────────
// Apps connect to /app?name=&platform=, editors to /editor[?app=<id>]. Several apps can be connected;
// each editor shows one: the newest by default, or the one it selects. Keep-alive: WebSocket ping
// frames, or a text `ping` the relay answers with `pong` (the room's heartbeat); both work.

/** One app connected to the relay. */
export type InspectorRelayApp = {
  id: string
  name: string
  platform: string
  /** From the app's hello, once it said it. */
  framework?: InspectorFramework
  osVersion?: string
  address: string
  connectedAt: number
  editors: number
}

export type InspectorRelayMessage =
  /** relay → editor, on connect and on every change: the connected apps and the one this editor shows. */
  | { type: 'apps'; apps: InspectorRelayApp[]; attached: string | null; mode: 'auto' | 'pinned' }
  /** editor → relay: show this app (null: back to the newest). */
  | { type: 'select'; app: string | null }

export type InspectorMessage = InspectorAppMessage | InspectorEditorMessage | InspectorCliMessage | InspectorPresenceMessage | InspectorRelayMessage
