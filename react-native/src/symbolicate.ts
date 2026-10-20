/**
 * JS stacks from the app, turned into source files and lines.
 *
 * The app sends `new Error().stack` as Hermes (or JSC, on web) prints it: frames point into the dev
 * bundle. Metro's `/symbolicate` endpoint maps them back through the bundle's source map, the same
 * way LogBox does, and marks library frames as collapsed. Frames from the inspector itself are
 * dropped: they are how the stack was taken, not why the animation ran.
 */

import type { InspectorRecording, InspectorStackFrame } from '../../protocol/inspector'

export type StackFrame = InspectorStackFrame

// Hermes / V8: "    at name (url:line:col)", "    at name (address at url:line:col)", "    at url:line:col"
const V8_FRAME = /^\s*at (?:(.+?) \()?(?:address at )?(.+?):(\d+):(\d+)\)?\s*$/
// JSC / Safari: "name@url:line:col"
const JSC_FRAME = /^(.*?)@(.+?):(\d+):(\d+)$/

/** The frames of a raw stack that point at a file. Native frames and the message line are skipped. */
export function parseStack(stack: string): StackFrame[] {
  const frames: StackFrame[] = []
  for (const line of stack.split('\n')) {
    const m = V8_FRAME.exec(line) ?? JSC_FRAME.exec(line.trim())
    if (!m) continue
    const [, name, file, ln, col] = m
    if (!file || file === 'native') continue
    frames.push({ methodName: name?.trim() || '<anonymous>', file, lineNumber: Number(ln), column: Number(col) })
  }
  return frames
}

/** A frame of the inspector's own code: how the stack was taken. */
export function isInspectorFrame(f: StackFrame): boolean {
  return /[/\\](?:@keyframerdev[/\\]inspector|packages[/\\]inspector[/\\]src)[/\\]/.test(f.file) || f.methodName === '__kfAnim' || f.methodName === 'captureStack'
}

/** A frame of a library (node_modules) or one Metro collapsed. */
export function isLibraryFrame(f: StackFrame): boolean {
  // Hermes's own JavaScript (InternalBytecode.js: Promise, timers, the module system) is not the app's.
  return !!f.collapse || /[/\\]node_modules[/\\]/.test(f.file) || /(^|[/\\])InternalBytecode\.js$/.test(f.file)
}

/**
 * The Metro that served a stack's bundle (React Native frames are bundle URLs), as this machine reaches
 * it: an Android emulator's alias for it (10.0.2.2) is localhost. Null when the stack names none.
 */
export function stackMetro(stack: string): string | null {
  const m = /\b(https?):\/\/([^/\s:)]+)(?::(\d+))?\/[^\s)]*\.bundle/.exec(stack)
  if (!m) return null
  const host = m[2] === '10.0.2.2' || m[2] === '10.0.3.2' ? '127.0.0.1' : m[2]!
  return `${m[1]}://${host}${m[3] ? `:${m[3]}` : ''}`
}

/**
 * Which Metro symbolicates a stack: the one given (--metro), the channel when it is Metro, else the one
 * that served the bundle (over the relay, the channel is the relay), else localhost:8081.
 */
export function metroFor(stack: string, given: string | null | undefined, channel: string | null | undefined): string {
  if (given) return given
  if (channel && /^https?:\/\//.test(channel)) return channel
  return stackMetro(stack) ?? 'http://localhost:8081'
}

/** `file` relative to the project when it is inside it. */
export function shortFile(file: string, root?: string): string {
  // Not symbolicated: a bundle URL with its query, shortened to the bundle's name.
  if (/^https?:\/\//.test(file)) {
    try {
      return new URL(file).pathname.split('//')[0]!.split('/').pop() || file
    } catch {
      return file
    }
  }
  if (root && file.startsWith(root)) return file.slice(root.length).replace(/^[/\\]/, '')
  const i = file.search(/[/\\]node_modules[/\\]/)
  return i >= 0 ? file.slice(i + 1) : file
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; json(): Promise<unknown> }>

const cache = new Map<string, Promise<StackFrame[]>>()

/**
 * The stack with each frame mapped to its source through Metro at `origin` (http://localhost:8081),
 * without the inspector's own frames. Falls back to the raw frames when Metro cannot symbolicate.
 * Cached per stack: the same call site run twice has the same stack.
 */
export function symbolicateStack(stack: string, origin: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<StackFrame[]> {
  const key = `${origin}\n${stack}`
  let hit = cache.get(key)
  if (!hit) {
    hit = run(stack, origin, fetchImpl)
    cache.set(key, hit)
    if (cache.size > 500) cache.delete(cache.keys().next().value!)
  }
  return hit
}

async function run(stack: string, origin: string, fetchImpl: FetchLike): Promise<StackFrame[]> {
  const raw = parseStack(stack)
  if (!raw.length) return []
  let frames = raw
  try {
    const res = await fetchImpl(`${origin.replace(/\/$/, '')}/symbolicate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stack: raw }),
    })
    if (res.ok) {
      const body = (await res.json()) as { stack?: StackFrame[] }
      if (Array.isArray(body.stack) && body.stack.length === raw.length) frames = body.stack
    }
  } catch {
    // Metro gone or not Metro: the raw frames still say something.
  }
  return withoutInspector(frames)
}

/** The app's frames: everything up to the instrumented call is the inspector taking the stack. */
export function withoutInspector(frames: StackFrame[]): StackFrame[] {
  const call = frames.findIndex((f) => /(^|\.)_?_kfAnim$/.test(f.methodName))
  return (call >= 0 ? frames.slice(call + 1) : frames).filter((f) => !isInspectorFrame(f))
}

/**
 * Fills `frames` from `stack` across a recording (animations, logs, JS tasks) with `resolve`: Metro
 * while the app runs, or the build's source map later. A recording can hold hundreds of stacks, mostly
 * the same few, so each distinct one is resolved once (up to `limit`). Returns how many it filled.
 */
export async function symbolicateRecording(
  rec: InspectorRecording,
  resolve: (stack: string) => Promise<StackFrame[]> | StackFrame[],
  { limit = 300, replace = false }: { limit?: number; replace?: boolean } = {},
): Promise<number> {
  const holders: Array<{ stack?: string; frames?: StackFrame[] }> = [...rec.anims, ...rec.markers.filter((m) => m.kind === 'log'), ...(rec.tasks ?? [])] as Array<{
    stack?: string
    frames?: StackFrame[]
  }>
  const stacks = new Set<string>()
  for (const h of holders) if (h.stack && (replace || !h.frames?.length)) stacks.add(h.stack)
  const resolved = new Map<string, StackFrame[]>()
  await Promise.all([...stacks].slice(0, limit).map(async (s) => resolved.set(s, await resolve(s))))
  let filled = 0
  for (const h of holders) {
    const frames = h.stack ? resolved.get(h.stack) : undefined
    if (frames?.length) {
      h.frames = frames
      filled++
    }
  }
  return filled
}
