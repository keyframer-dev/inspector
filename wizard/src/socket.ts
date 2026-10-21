/**
 * The WebSocket the checks connect with: the global one where there is one (Node 22, Bun), else the
 * `ws` package (Node 20 has none; it is bundled). A pairing room needs an Authorization header, which
 * only `ws` (and Bun) can send, so `headers` picks `ws` when it is installed.
 */

export type SocketLike = {
  readyState: number
  send(data: string): void
  close(code?: number): void
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: { code?: number; reason?: string }) => void) | null
  onerror: ((ev: unknown) => void) | null
}

export type SocketCtor = new (url: string, init?: { headers?: Record<string, string> }) => SocketLike

export async function socketCtor(opts: { headers?: boolean } = {}): Promise<SocketCtor> {
  const global = (globalThis as { WebSocket?: SocketCtor }).WebSocket
  const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'
  if (global && (!opts.headers || isBun)) return global
  try {
    const mod = (await import('ws')) as unknown as { default?: SocketCtor; WebSocket?: SocketCtor }
    const ws = mod.WebSocket ?? mod.default
    if (ws) return ws
  } catch {
    // Not installed: the global one, if any.
  }
  if (global) return global
  throw new Error('No WebSocket here: run the wizard on Node 20 or later.')
}

/** A frame's text: the global socket hands strings, `ws` may hand a Buffer. */
export function frameText(data: unknown): string | null {
  if (typeof data === 'string') return data
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data)
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data)
  return null
}
