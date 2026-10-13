/**
 * What comes out of a recording before it leaves the device or the panel as a share link. A recording
 * can hold what a tester typed (on screenshots, in error messages, in navigation params) and what
 * they wrote about it; a link can be forwarded, so the defaults take out what is personal and keep
 * what explains the motion:
 *
 *   screenshots  downscaled (360 px wide), text inputs the recorder saw blurred
 *   logs         masked: emails, long numbers, ids and tokens replaced
 *   params       dropped
 *   note         kept (the person sharing wrote it to be read)
 *
 * Pure: the text part is synchronous (redactRecordingText), and pixels go through an injected
 * ProcessScreenshot (the panel draws on a canvas; on a device there is usually none). Without one,
 * whatever needs pixels changed is dropped rather than sent as it was.
 */

import type { InspectorMarker, InspectorRecording, InspectorRect, InspectorRedaction, InspectorScreenshot } from '../../protocol/inspector'

export type { InspectorRedaction } from '../../protocol/inspector'

export const DEFAULT_REDACTION: InspectorRedaction = { screenshots: 'downscale', inputs: 'blur', logs: 'mask', params: 'drop', note: 'keep' }

/** Widest a `downscale` screenshot is kept, px. */
export const SHARED_SCREENSHOT_WIDTH = 360
/** Width of a `blur` screenshot, px: small enough that text cannot be read back even before the blur. */
export const BLURRED_SCREENSHOT_WIDTH = 96

/** What to do to one screenshot's pixels. */
export type ScreenshotJob = {
  /** Scale down to at most this many px wide (never up). */
  maxWidth: number
  /** Blur the whole frame. */
  blurAll: boolean
  /** Blur these, in screen points: `screen` is what they are measured against (the image may be a different size). */
  regions: InspectorRect[]
  screen: { width: number; height: number }
}

/** Redraws a screenshot. Throwing drops it. */
export type ProcessScreenshot = (shot: InspectorScreenshot, job: ScreenshotJob) => Promise<Pick<InspectorScreenshot, 'data' | 'format'>>

export function normalizeRedaction(opts?: Partial<InspectorRedaction>): InspectorRedaction {
  return { ...DEFAULT_REDACTION, ...(opts ?? {}) }
}

// ─── Text ─────────────────────────────────────────────────────────────────────────

/** Applied in order: the specific shapes first, so a token is not half eaten by the number rule. */
const MASKS: Array<[RegExp, string]> = [
  // Secrets passed in URLs: ?token=…, &password=…
  [/([?&#](?:access_?token|refresh_?token|id_?token|token|key|api_?key|secret|password|passwd|pwd|code|auth|session|sig|signature)=)[^&\s#"']+/gi, '$1[redacted]'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[id]'],
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]'],
  // JWTs
  [/\beyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]*/g, '[token]'],
  [/\b(Bearer|Basic|Token)\s+[\w\-.~+/]{8,}=*/gi, '$1 [token]'],
  // Prefixed keys: kf_…, sk-…, pk_live_…, ghp_…, xoxb-…
  [/\b(?:kf|sk|pk|rk|ghp|gho|ghs|github_pat|xox[abpr]?|AKIA)[-_][\w-]{8,}/g, '[token]'],
  // Any long run of letters AND digits (api keys, hashes, session ids)
  [/\b(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[\w-]{24,}\b/g, '[token]'],
  // Phone and card numbers written in groups (4111 1111 1111 1111, +1 (555) 123-4567)
  [/\+?\(?\d{1,4}\)?(?:[ .-]\(?\d{2,4}\)?){2,}/g, '[number]'],
  // Any other 4+ digit run: ids, amounts, codes
  [/\d{4,}/g, '[number]'],
]

/** Replaces emails, long numbers, ids and tokens in `text`. */
export function maskText(text: string): string {
  let out = text
  for (const [re, by] of MASKS) out = out.replace(re, by)
  return out
}

/** A line of a JS stack that names a frame (V8 `    at fn (file:1:2)`, Hermes/JSC `fn@file:1:2`). */
const isFrameLine = (line: string) => /^\s+at\s/.test(line) || /^[^\s@]*@\S+:\d+(?::\d+)?\s*$/.test(line) || /^\s*\[native code\]\s*$/.test(line)

/**
 * A stack keeps its frames (code, not data) but not its message lines, which repeat the error's
 * message: `Error: could not load user ada@example.com`.
 */
export function redactStack(stack: string, mode: 'mask' | 'drop'): string {
  return stack
    .split('\n')
    .flatMap((line) => (isFrameLine(line) ? [line] : mode === 'mask' ? [maskText(line)] : []))
    .join('\n')
}

const REMOVED = '(removed before sharing)'

function redactMarker(m: InspectorMarker, o: InspectorRedaction): InspectorMarker | null {
  if (m.kind === 'log' && o.logs !== 'keep') {
    const stack = m.stack !== undefined ? redactStack(m.stack, o.logs) : undefined
    return { ...m, message: o.logs === 'mask' ? maskText(m.message) : REMOVED, ...(stack !== undefined ? { stack } : {}) }
  }
  if (m.kind === 'navigation' && o.params === 'drop' && m.params) {
    const { params: _params, ...rest } = m
    return rest
  }
  if (m.kind === 'note' && o.note === 'drop') return null
  return m
}

/** Everything but the pixels: logs, navigation params and notes. Screenshots are left as they are. */
export function redactRecordingText(rec: InspectorRecording, opts?: Partial<InspectorRedaction>): InspectorRecording {
  const o = normalizeRedaction(opts)
  const markers = rec.markers.flatMap((m) => {
    const r = redactMarker(m, o)
    return r ? [r] : []
  })
  const { note, ...rest } = rec
  return {
    ...rest,
    markers,
    ...(note !== undefined && o.note === 'keep' ? { note } : {}),
    redaction: o,
  }
}

// ─── Pixels ───────────────────────────────────────────────────────────────────────

/** The job one screenshot needs under these options, `null` to keep it untouched, `'drop'` to leave it out. */
export function screenshotJob(shot: InspectorScreenshot, o: InspectorRedaction, screen: { width: number; height: number }): ScreenshotJob | null | 'drop' {
  if (o.screenshots === 'drop') return 'drop'
  const regions = o.inputs === 'blur' ? (shot.inputs ?? []) : []
  if (o.screenshots === 'blur') return { maxWidth: BLURRED_SCREENSHOT_WIDTH, blurAll: true, regions: [], screen }
  const maxWidth = o.screenshots === 'downscale' ? SHARED_SCREENSHOT_WIDTH : Number.POSITIVE_INFINITY
  if (!regions.length && o.screenshots === 'keep') return null
  return { maxWidth, blurAll: false, regions, screen }
}

/**
 * The recording as it may be shared: text redacted, then each screenshot redrawn by `process`. Without
 * `process`, a screenshot that needs its pixels changed is kept only when the change is a downscale
 * and nothing on it needs blurring (a device's screenshots are already taken at point width, about
 * 400 px); a blur it cannot do drops the screenshot instead.
 */
export async function redactRecording(rec: InspectorRecording, opts?: Partial<InspectorRedaction>, process?: ProcessScreenshot): Promise<InspectorRecording> {
  const o = normalizeRedaction(opts)
  const out = redactRecordingText(rec, o)
  const screen = { width: rec.screen.width, height: rec.screen.height }
  const shots: InspectorScreenshot[] = []
  for (const shot of rec.screenshots) {
    const job = screenshotJob(shot, o, screen)
    if (job === 'drop') continue
    const { inputs: _inputs, ...plain } = shot
    if (job === null) {
      shots.push(o.inputs === 'blur' ? plain : shot)
      continue
    }
    if (!process) {
      if (!job.blurAll && !job.regions.length) shots.push(plain)
      continue
    }
    try {
      const { data, format } = await process(shot, job)
      shots.push({ ...plain, data, format })
    } catch {
      // Could not redraw it: leave it out rather than send it unredacted.
    }
  }
  return { ...out, screenshots: shots }
}

/** A one-line account of what was taken out, for the viewer ("Logs masked, params dropped"). */
export function describeRedaction(o: InspectorRedaction): string {
  const parts: string[] = []
  if (o.screenshots === 'drop') parts.push('no screenshots')
  else if (o.screenshots === 'blur') parts.push('screenshots blurred')
  else if (o.screenshots === 'downscale') parts.push('screenshots downscaled')
  if (o.screenshots !== 'drop' && o.screenshots !== 'blur' && o.inputs === 'blur') parts.push('text inputs blurred')
  if (o.logs === 'mask') parts.push('logs masked')
  else if (o.logs === 'drop') parts.push('logs removed')
  if (o.params === 'drop') parts.push('navigation params removed')
  if (o.note === 'drop') parts.push('note removed')
  if (!parts.length) return 'Shared as recorded'
  const text = parts.join(', ')
  return text[0]!.toUpperCase() + text.slice(1)
}
