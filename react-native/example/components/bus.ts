/** A tiny event bus: scenarios reach into screens for what a press cannot do (scroll a list). */
const handlers = new Map<string, Set<(arg?: unknown) => void>>()

export function onBus(name: string, fn: (arg?: unknown) => void): () => void {
  const set = handlers.get(name) ?? new Set()
  set.add(fn)
  handlers.set(name, set)
  return () => {
    set.delete(fn)
  }
}

export function emitBus(name: string, arg?: unknown): void {
  for (const fn of handlers.get(name) ?? []) fn(arg)
}
