/**
 * Motion Vitals: the wire format between the production reporters and the ingest Worker.
 *
 * Reporters: `@keyframerdev/vitals` (React Native), `KeyframerVitals` (iOS), `dev.keyframer:vitals`
 * (Android), `keyframer_vitals` (Flutter). Ingest: `https://vitals.keyframer.dev` (Keyframer's
 * `apps/vitals`). Symbols: produced by `@keyframerdev/vitals-cli`, read by the ingest Worker.
 *
 * Import-free, like inspector.ts, so every SDK can mirror it. Design: `inspector/docs/production.md`;
 * build plan and ownership: `inspector/docs/vitals-build.md`. Golden messages every SDK's tests check
 * against: `inspector/packages/protocol/fixtures/vitals/`.
 */

export const VITALS_FORMAT = 'keyframer-vitals' as const
export const VITALS_VERSION = 1 as const
export const VITALS_ENDPOINT = 'https://vitals.keyframer.dev'

/**
 * Histogram buckets of frames missed per frame, by lower bound: 0, 1, 2, 3-4, 5-8, 9-16, 17-32, 33+.
 * The same eight on every platform, so 60 and 120 Hz devices add up.
 */
export const VITALS_BUCKETS = [0, 1, 2, 3, 5, 9, 17, 33] as const
/** A frame this long or longer is frozen, in absolute time (Android vitals' definition). */
export const VITALS_FROZEN_MS = 700
/** A session window is at most this much foreground time; a longer session sends several windows. */
export const VITALS_WINDOW_MS = 10 * 60 * 1000
/** A session ends after this long in the background. */
export const VITALS_SESSION_GAP_MS = 30 * 1000
/** Hard caps per report. Ingest refuses a report over any of them (413 for bytes, 400 otherwise). */
export const VITALS_LIMITS = { screens: 40, sites: 200, worst: 10, images: 64, bytes: 32 * 1024, screenName: 64 } as const
/** At most this many reported sessions per device per day (counted on the device, never sent). */
export const VITALS_MAX_SESSIONS_PER_DAY = 3
/** Default share of sessions that report. The project's config can lower or raise it. */
export const VITALS_DEFAULT_SAMPLE_RATE = 0.1

export type VitalsPlatform = 'react-native' | 'ios' | 'android' | 'flutter'
export type VitalsOs = 'ios' | 'android'
/** Same roles as InspectorThread: `js` is the app thread (JS, main, UI isolate), `ui` the frame thread (RN UI, Android RenderThread, Flutter raster). */
export type VitalsThread = 'ui' | 'js'
export type VitalsTier = 'low' | 'mid' | 'high'
export type VitalsThermal = 'nominal' | 'fair' | 'serious' | 'critical'
/**
 * Why one of a window's worst frames was slow, computed on the device (production.md 1, "Attribution").
 * `js-task`, `ui-work` and `slow-render` need deep mode and are not sent in version 1.
 */
export type VitalsCause = 'screen-mount' | 'burst' | 'busy-start' | 'scroll' | 'gesture' | 'js-task' | 'ui-work' | 'slow-render' | 'unknown'

/** Frame counters of one thread on one screen. `hist` has VITALS_BUCKETS.length entries. */
export type VitalsThreadStats = {
  frames: number
  hist: number[]
  frozen: number
  /** Sum of max(0, frameMs - budget). Divided by measured seconds it is Apple's hitch time ratio. */
  hitchMs: number
  /** Frames and missed frames while no tracked animation ran: the screen's baseline. */
  idleFrames: number
  idleMissed: number
}

/**
 * Where a call site is in the app, and what the server needs to name it.
 * - `source`: exact file and line (React Native's Babel plugin; Flutter builds that keep positions).
 * - `hashed`: React Native with `hashSites`; named from the uploaded `rn-sites` manifest.
 * - `name`: a name the developer gave (`trace("card-expand")`, `kfTrack`, `KfAnimationController(name:)`), plus a type name when the build keeps it.
 * - `native`: an instruction offset in `images[image]` (iOS, Flutter AOT); named from an uploaded `macho` or `elf` symbol file.
 *   SDKs send the offset of the return address they captured, as is; the server looks up `offset - 1`
 *   (the call instruction). Flutter on iOS is a `macho` image (App.framework/App, LC_UUID = the Dart build id); on Android an `elf` one (libapp.so).
 * - `jvm`: an Android stack frame, possibly renamed by R8; named from an uploaded `r8` mapping.
 */
export type VitalsSiteRef =
  | { kind: 'source'; file: string; line: number; column?: number }
  | { kind: 'hashed'; hash: string }
  | { kind: 'name'; name: string; type?: string }
  | { kind: 'native'; image: number; offset: number; type?: string }
  | { kind: 'jvm'; className: string; method: string; line?: number; file?: string }

export type VitalsSite = {
  ref: VitalsSiteRef
  /**
   * Stable across versions when the SDK can tell: the site without line or column
   * (`app/feed.tsx#FeedCard#withSpring#scale#1`, the ordinal telling identical calls apart), or the
   * developer's name. Omitted for `native` and `jvm` refs: the server derives it after symbolication.
   */
  key?: string
  /** The animation API: withSpring, UIView.animate, animateFloatAsState, AnimationController.forward… */
  fn: string
  component?: string | null
  /** The animated property or target when known: scale, translateY, alpha… */
  prop?: string | null
  /** Index into `screens`: where it ran most in this window. */
  screen: number
  runs: number
  activeMs: number
  /** Frames drawn while it ran, and frames missed while it ran. */
  frames: number
  missed: number
  hitchMs: number
  worstMs: number
  /** Runs that started while Reduce Motion was on. Only when the project collects Reduce Motion. */
  runsReduceMotion?: number
}

export type VitalsWorstFrame = {
  thread: VitalsThread
  ms: number
  missed: number
  screen: number
  /** Indexes into `sites`: what was running in that frame. */
  sites: number[]
  cause: VitalsCause
  /** For `screen-mount`: how long after the navigation the frame ended. */
  afterNavMs?: number
}

/** A binary image the report's `native` refs point into: a Mach-O UUID or an ELF build id. */
export type VitalsImage = {
  /** Lowercase hex without dashes. */
  debugId: string
  kind: 'macho' | 'elf'
  /** File name only (`Acme`, `App.framework/App`, `libapp.so`), never a path with a user name in it. */
  name: string
  arch?: string
}

export type VitalsReport = {
  format: typeof VITALS_FORMAT
  version: typeof VITALS_VERSION
  app: {
    /** Bundle id or package name. Lets the server warn when a key is used by another app. */
    id?: string
    version: string
    build?: string
    platform: VitalsPlatform
    /** Free-form framework label for the dashboard: "SwiftUI", "Compose", "Views"… */
    framework?: string
    environment: 'production' | 'development'
    /** Android: the build id the Gradle plugin injects, matching the uploaded R8 mapping. */
    debugId?: string
  }
  sdk: { name: string; version: string }
  device: {
    os: VitalsOs
    osMajor: number
    /** Raw model identifier (iPhone15,3, SM-A146B) unless the project turns models off; the server maps it to a name and tier. */
    model?: string
    tier?: VitalsTier
    memoryGb?: number
  }
  display: { hz: number; adaptive?: boolean; targetHz: number }
  /** Any time true in this window. `reduceMotion` only when the project collects it. */
  state: { reduceMotion?: boolean; lowPower?: boolean; thermal?: VitalsThermal }
  session: {
    /** Random per session, in memory only, never written to disk or reused. Links the windows of one session. */
    nonce: string
    /** 0 for the first window of a session. Only seq 0 counts toward usage. */
    seq: number
    sampleRate: number
    foregroundMs: number
    measuredMs: number
    ended: 'background' | 'window' | 'unknown'
  }
  screens: Array<{ name: string; ms: number; threads: Partial<Record<VitalsThread, VitalsThreadStats>> }>
  sites: VitalsSite[]
  /** The longest frames of the window, at most VITALS_LIMITS.worst (SDKs send 5). */
  worst: VitalsWorstFrame[]
  images?: VitalsImage[]
}

/** Per-project settings every SDK reads: from upload responses and from GET /v1/config/<field key>. */
export type VitalsConfig = {
  enabled: boolean
  /** The rate to use now: base x the allowance factor x the release boost, already combined. */
  sampleRate: number
  /** ISO time. While boosted, sampleRate already includes the boost. */
  boostUntil?: string
  /** SDK versions below these stop reporting (a buggy release in the wild). */
  minSdk?: Partial<Record<VitalsPlatform, string>>
  collect: { reduceMotion: boolean; deviceModel: boolean; development: boolean }
  /** true: turn off on this device for 7 days. */
  stop?: boolean
  /** How long a device may keep this config before fetching again. */
  ttlSec: number
}

/**
 * POST /v1/reports, `Authorization: Bearer kfp_…`, JSON body (gzip with `Content-Encoding: gzip`
 * where the platform can). 200 answers this; 400 invalid; 401 unknown or revoked key and 410 deleted
 * project (the SDK stops for 7 days); 413 too large; 429 rate limited (retry later).
 */
export type VitalsIngestResponse = { ok: boolean; config: VitalsConfig; error?: string }

// ---------- symbols ----------

/** What a symbol upload is for. */
export type VitalsSymbolKind = 'macho' | 'elf' | 'r8' | 'rn-sites'

/**
 * Symbols are extracted on the developer's machine or CI by `keyframer-vitals symbols upload`, never on
 * the server: a manifest plus chunks, so the Worker reads one small chunk per lookup.
 *
 * Upload: PUT /v1/symbols/<kind>/<debugId>/<chunk file> (gzipped JSON body) for each chunk, then
 * POST /v1/symbols/<kind>/<debugId>/manifest with the manifest; both with `Authorization: Bearer kft_…`.
 * The manifest is written last, so a symbol set is visible only when complete.
 */
export type VitalsSymbolManifest = {
  format: 'keyframer-vitals-symbols'
  version: 1
  kind: VitalsSymbolKind
  /**
   * macho: LC_UUID; elf: GNU build id (both lowercase hex, no dashes); r8: the Gradle plugin's build id,
   * else `<app version>+<build>`; rn-sites: `<app version>+<build>`.
   */
  debugId: string
  name?: string
  arch?: string
  app?: { id?: string; version?: string; build?: string }
  /**
   * Name schemes left mangled in the chunks: `swift` when the upload ran without `swift-demangle`
   * (not on macOS). Absent when every name is demangled.
   */
  mangled?: Array<'swift'>
  /**
   * Sorted by `first`: the lowest offset or key in each chunk. macho/elf: the offset as 16 lowercase
   * hex digits (string order is numeric order); r8: the obfuscated class name; rn-sites: the hash.
   * A lookup reads only the last chunk whose `first` is at most the offset or key (code point order).
   * Chunk files are named `0000.json`, `0001.json`, ….
   */
  chunks: Array<{ file: string; first: string }>
  createdAt: string
  cli: { name: string; version: string }
}

/**
 * macho and elf chunks. Offsets are relative to the image's load address (the __TEXT segment's vmaddr
 * for Mach-O, the first PT_LOAD for ELF), which is what SDKs send in `native` refs.
 */
export type VitalsSymbolChunk = {
  names: string[]
  files: string[]
  /** Functions sorted by start: [start, end, name index]. Demangled. */
  fns: Array<[start: number, end: number, name: number]>
  /**
   * The line table, sorted by start: [start, file index, line]. Consecutive equal rows merged. Line 0:
   * no line information from that offset on. A chunk that starts inside a function or a row repeats
   * them (the function in `fns`, the row at the chunk's first offset), so one chunk answers.
   */
  lines: Array<[start: number, file: number, line: number]>
}

/**
 * r8 chunks: obfuscated class name to the original class, and its methods' line ranges. A line L in
 * obfStart..obfEnd resolves to `origStart` when `origEnd` equals it, else to `origStart + (L - obfStart)`
 * (`origEnd` absent: linear). All four 0: no line information. Rows sharing an obfuscated name and range
 * are an inline stack, innermost first. `original` is the method name, prefixed with its class when it
 * was inlined from another class (`com.acme.SpringsKt.cardScale`). `file`: the R8 source file name.
 */
export type VitalsR8Chunk = {
  classes: Record<string, { name: string; file?: string; methods: Array<[obfuscated: string, original: string, obfStart: number, obfEnd: number, origStart: number, origEnd?: number]> }>
}

/** rn-sites chunks: a hashed site id to the source site it stands for. */
export type VitalsSitesChunk = {
  sites: Record<string, { file: string; line: number; column?: number; fn: string; component?: string | null; prop?: string | null; key: string }>
}
