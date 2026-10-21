/**
 * A worklet crash the Babel plugin did not see coming (workletLint.ts), placed when it happens. A
 * worklet that throws on the UI thread reaches the JS thread through react-native-worklets'
 * reportFatalRemoteError, which hands it to ErrorUtils' global handler (the red box in development).
 * Watched from that handler, before the red box: the error's message names the function or value, and
 * the plugin's findings and suspects (the functions each worklet calls that it could not see into) say
 * which worklet in the code uses that name. The app's error is passed on untouched.
 *
 * Pure, apart from the watch: the handler is passed in for tests.
 */

import type { InspectorWorkletIssue } from '../../protocol/inspector'

/** What the Babel plugin reports per file (see workletLint.ts WorkletSuspect), with the file. */
export type KnownSuspect = { file: string; name: string; key: string; line: number; column: number; worklet: NonNullable<InspectorWorkletIssue['worklet']> }
export type KnownWorklets = { issues: Iterable<InspectorWorkletIssue>; suspects: Iterable<KnownSuspect> }

type Crash = { kind: 'remote' | 'missing' | 'uninitialized'; name: string | null }

/** React's setters, as their function names come out ("bound dispatchSetState"). */
const SETTER_NAMES = new Set(['dispatchSetState', 'dispatchReducerAction', 'dispatchAction'])

/** What an error's message says went wrong in a worklet, and the name it gives; null: not one of these. */
export function crashOf(message: string): Crash | null {
  // react-native-worklets: `Tried to synchronously call a Remote Function. Called "setOpen" on the UI Runtime.`
  // Reanimated 3: "Tried to synchronously call a non-worklet function `setOpen` on the UI thread."
  const remote = /Tried to synchronously call a (?:non-worklet function|Remote Function)[^`"']*[`"']([^`"']*)[`"']/.exec(message)
  if (remote) return { kind: 'remote', name: clean(remote[1]) }
  if (/Tried to synchronously call a (?:non-worklet function|Remote Function)/.test(message)) return { kind: 'remote', name: null }
  const missing = /Property '([\w$]+)' doesn't exist|([\w$]+) is not defined|Can't find variable: ([\w$]+)/.exec(message)
  if (missing) return { kind: 'missing', name: missing[1] ?? missing[2] ?? missing[3] ?? null }
  const early = /Cannot access '([\w$]+)' before initialization|([\w$.]+) is not a function \(it is undefined\)/.exec(message)
  if (early) return { kind: 'uninitialized', name: early[1] ?? early[2]?.split('.').pop() ?? null }
  return null
}

function clean(name: string | undefined): string | null {
  const n = (name ?? '').replace(/^bound /, '').trim()
  return n && n !== 'anonymous' ? n : null
}

/** The worklet as a sentence starts: "The useAnimatedStyle worklet (logoStyle)", "The Pan.onUpdate callback", "The worklet clamp". */
export function workletLabel(w: { kind: string; name: string | null }): string {
  if (w.kind === "'worklet'") return `The worklet${w.name ? ` ${w.name}` : ''}`
  if (w.kind.includes('.') || /^with(Timing|Spring|Decay|Repeat)$/.test(w.kind)) return `The ${w.kind} callback`
  return `The ${w.kind} worklet${w.name ? ` (${w.name})` : ''}`
}

const MAX_PLACES = 3

/**
 * The problems to report for an error (empty: not a worklet crash this can place). A finding the
 * plugin made comes back with the error; a suspect becomes a problem of its own; a call of a function
 * that is not a worklet that matches nothing is still reported, without a place.
 */
export function attributeCrash(error: unknown, known: KnownWorklets): InspectorWorkletIssue[] {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : String((error as { message?: unknown })?.message ?? '')
  const crash = crashOf(message)
  if (!crash) return []
  const stack = error instanceof Error && error.stack ? error.stack.slice(0, 4000) : undefined
  const seen = { error: message.slice(0, 1000), ...(stack ? { stack } : {}) }
  const name = crash.name
  const issues = [...known.issues]
  // A React setter's function is anonymous to the error: it is one of the setters the plugin found.
  const setter = name !== null && SETTER_NAMES.has(name)
  const matches = issues.filter((i) => {
    if (setter) return i.issue === 'js-call' && /state setter|useReducer's dispatch/.test(i.message)
    if (name === null || (i.name !== name && !i.name.endsWith(`.${name}`))) return false
    return crash.kind === 'remote' ? i.issue === 'js-call' : true
  })
  if (matches.length) return matches.slice(0, MAX_PLACES).map((i) => ({ ...i, id: `${i.id}:crash`, ...seen }))
  const thread = 'the UI thread'
  const places = name === null || setter ? [] : [...known.suspects].filter((s) => s.key === name || s.name === name).slice(0, MAX_PLACES)
  if (places.length) {
    return places.map((s) => ({
      id: `crash:${s.file}:${s.line}:${s.column}:${s.name}`,
      issue: crash.kind === 'uninitialized' ? 'declared-after' : 'js-call',
      message:
        crash.kind === 'remote'
          ? `${workletLabel(s.worklet)} called ${s.name} on ${thread}, and ${s.name} is not a worklet`
          : crash.kind === 'missing'
            ? `${workletLabel(s.worklet)} uses ${s.name}, which ${thread} does not have`
            : `${workletLabel(s.worklet)} used ${s.name} before it was initialized`,
      fix:
        crash.kind === 'remote'
          ? `Call it on the JS thread with scheduleOnRN(${s.name}, ...args) (runOnJS(${s.name})(...args) in Reanimated 3), or add 'worklet' as the first line of ${s.name} where it is declared if it only computes or sets shared values.`
          : crash.kind === 'missing'
            ? `A worklet only has what it captures and the UI runtime's own globals: read ${s.name} into a constant outside the worklet and use that, or call the code that needs it with scheduleOnRN.`
            : `Declare ${s.name} before the worklet is created, or import it from a module that does not import this one back.`,
      file: s.file,
      line: s.line,
      column: s.column,
      name: s.name,
      worklet: s.worklet,
      ...seen,
    }))
  }
  if (crash.kind !== 'remote') return []
  const what = name ?? 'a function'
  return [
    {
      id: `crash:${name ?? 'anonymous'}`,
      issue: 'js-call',
      message: `A worklet called ${what} on ${thread}, and it is not a worklet`,
      fix: `Find the call in a worklet (a useAnimatedStyle, a gesture callback, a reaction, a scheduleOnUI function) and call it on the JS thread with scheduleOnRN(fn, ...args) (runOnJS(fn)(...args) in Reanimated 3), or make it a worklet. The stack says where it ran.`,
      file: null,
      line: 0,
      column: 0,
      name: name ?? 'anonymous',
      worklet: null,
      ...seen,
    },
  ]
}

type ErrorUtilsLike = { getGlobalHandler(): (e: unknown, fatal?: boolean) => void; setGlobalHandler(h: (e: unknown, fatal?: boolean) => void): void }

/**
 * Watches the global error handler for worklet crashes until the returned function is called: each
 * placed one goes to `report` first, then the error to whatever handled it before (the red box, a crash
 * reporter), as it came. Nothing happens where there is no ErrorUtils.
 */
export function watchWorkletCrashes(report: (issue: InspectorWorkletIssue) => void, known: () => KnownWorklets, errorUtils?: ErrorUtilsLike): () => void {
  const eu = errorUtils ?? (globalThis as { ErrorUtils?: ErrorUtilsLike }).ErrorUtils
  if (!eu?.getGlobalHandler || !eu.setGlobalHandler) return () => {}
  const previous = eu.getGlobalHandler()
  const handler = (e: unknown, fatal?: boolean) => {
    try {
      for (const issue of attributeCrash(e, known())) report(issue)
    } catch {
      // Never in the way of the app's own error.
    }
    previous?.(e, fatal)
  }
  eu.setGlobalHandler(handler)
  return () => {
    if (eu.getGlobalHandler() === handler) eu.setGlobalHandler(previous)
  }
}
