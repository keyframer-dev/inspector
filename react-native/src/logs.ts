/**
 * Warnings and errors while recording: console.warn / console.error and uncaught errors (the global
 * handler), passed on untouched to whatever was there (LogBox, a crash reporter). One wrap however
 * many recordings listen, undone when the last stops. Pure JS: the console and ErrorUtils are passed
 * in for tests.
 */

export type LogReport = { level: 'warn' | 'error'; message: string; stack?: string }

type Console = Record<'warn' | 'error', (...a: unknown[]) => void>
type ErrorUtilsLike = { getGlobalHandler(): (e: unknown, fatal?: boolean) => void; setGlobalHandler(h: (e: unknown, fatal?: boolean) => void): void }

const listeners = new Set<(l: LogReport) => void>()
let restore: (() => void) | null = null

function describe(a: unknown): string {
  if (typeof a === 'string') return a
  if (a instanceof Error) return a.message
  try {
    return JSON.stringify(a)
  } catch {
    return String(a)
  }
}

const emit = (l: LogReport) => {
  for (const fn of listeners) fn(l)
}

function install(con: Console, eu: ErrorUtilsLike | undefined): () => void {
  const undo: Array<() => void> = []
  for (const level of ['warn', 'error'] as const) {
    const original = con[level]
    const wrapped = (...args: unknown[]) => {
      const err = args.find((a): a is Error => a instanceof Error)
      emit({ level, message: args.map(describe).join(' ').slice(0, 2000), ...(err?.stack ? { stack: err.stack.slice(0, 4000) } : {}) })
      original.apply(con, args)
    }
    con[level] = wrapped
    undo.push(() => {
      if (con[level] === wrapped) con[level] = original
    })
  }
  if (eu) {
    const previous = eu.getGlobalHandler()
    const handler = (e: unknown, fatal?: boolean) => {
      const err = e instanceof Error ? e : new Error(String(e))
      emit({ level: 'error', message: `${fatal ? 'Fatal: ' : ''}${err.message}`, ...(err.stack ? { stack: err.stack.slice(0, 4000) } : {}) })
      previous(e, fatal)
    }
    eu.setGlobalHandler(handler)
    undo.push(() => {
      if (eu.getGlobalHandler() === handler) eu.setGlobalHandler(previous)
    })
  }
  return () => undo.forEach((u) => u())
}

/** Calls `onLog` for each warning and error until the returned function is called. */
export function watchLogs(onLog: (l: LogReport) => void, env: { console?: Console; errorUtils?: ErrorUtilsLike } = {}): () => void {
  listeners.add(onLog)
  if (listeners.size === 1) {
    const g = globalThis as { ErrorUtils?: ErrorUtilsLike }
    restore = install(env.console ?? (console as unknown as Console), env.errorUtils ?? g.ErrorUtils)
  }
  return () => {
    if (!listeners.delete(onLog)) return
    if (listeners.size === 0) {
      restore?.()
      restore = null
    }
  }
}
