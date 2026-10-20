/**
 * The inspector protocol over Expo's dev tools plugin channel instead of a pairing room.
 *
 * connectInspector talks to a WebSocket-shaped object; this one sends each message through Metro's
 * dev tools connection (`sendMessage` / `addMessageListener`), so the panel that opens from Metro with
 * shift+m gets the same events, samples and frame stats an editor in a room would. No account, no
 * room code, nothing leaves the machine. It works in Expo Go: the channel is plain JS.
 *
 * What the room did on its own is done here:
 *   - PING is answered with PONG, so the client's heartbeat stays happy;
 *   - an editor's `hello` becomes a `presence` with one more editor, which makes the client re-send its
 *     catalog of signals and styles, and the app's own `hello` is re-sent so a panel opened after the
 *     app still learns its name, followed by its last `time` answer: a hello alone means normal speed,
 *     and an app left slowed or paused must not look like it runs at 1× in a panel opened later.
 *
 * Pure and injectable (the dev tools client is passed in) so it runs under vitest.
 */

import type { SocketConstructor, SocketLike } from './client'
import { PING, PONG } from './room'

/** The plugin name the panel connects with: the package name, as Expo's CLI lists it. */
export const DEVTOOLS_PLUGIN = '@keyframerdev/inspector'
/** Every inspector message travels as one JSON string under this method. */
export const DEVTOOLS_METHOD = 'inspector'

/** The part of Expo's DevToolsPluginClient this uses. */
export type DevToolsClientLike = {
  sendMessage(method: string, params: unknown): void
  addMessageListener(method: string, listener: (params: unknown) => void): { remove(): void }
  closeAsync?(): Promise<void>
}

const OPEN = 1
const CLOSED = 3

export function devToolsSocket(getClient: () => Promise<DevToolsClientLike>): SocketConstructor {
  return class DevToolsSocket implements SocketLike {
    readyState = 0
    onopen: ((ev: unknown) => void) | null = null
    onmessage: ((ev: { data: unknown }) => void) | null = null
    onclose: ((ev: unknown) => void) | null = null
    onerror: ((ev: unknown) => void) | null = null
    private client: DevToolsClientLike | null = null
    private sub: { remove(): void } | null = null
    private editors = 0
    private appHello: string | null = null
    private appTime: string | null = null

    constructor(_url: string) {
      getClient().then(
        (client) => {
          if (this.readyState === CLOSED) return
          this.client = client
          this.sub = client.addMessageListener(DEVTOOLS_METHOD, (params) => this.receive(params))
          this.readyState = OPEN
          this.onopen?.({})
        },
        (err: unknown) => {
          if (this.readyState === CLOSED) return
          this.readyState = CLOSED
          this.onerror?.(err)
          this.onclose?.({})
        },
      )
    }

    send(data: string) {
      if (data === PING) {
        setTimeout(() => this.deliver(PONG), 0)
        return
      }
      if (data.startsWith('{"type":"hello"')) {
        this.appHello = data
        // A new hello is a fresh start (a reload): the speed it ran at before is not this one's.
        this.appTime = null
      }
      if (data.startsWith('{"type":"time"')) this.appTime = data
      this.client?.sendMessage(DEVTOOLS_METHOD, data)
    }

    close() {
      if (this.readyState === CLOSED) return
      this.readyState = CLOSED
      this.sub?.remove()
      this.sub = null
      this.onclose?.({})
    }

    private deliver(data: string) {
      if (this.readyState === OPEN) this.onmessage?.({ data })
    }

    private receive(params: unknown) {
      if (typeof params !== 'string') return
      let type: unknown
      let role: unknown
      try {
        ;({ type, role } = JSON.parse(params) as { type?: unknown; role?: unknown })
      } catch {
        return
      }
      if (type === 'hello' && role === 'editor') {
        this.editors += 1
        if (this.appHello) this.client?.sendMessage(DEVTOOLS_METHOD, this.appHello)
        if (this.appHello && this.appTime) this.client?.sendMessage(DEVTOOLS_METHOD, this.appTime)
        this.deliver(JSON.stringify({ type: 'presence', app: true, editors: this.editors, cli: false }))
        return
      }
      this.deliver(params)
    }
  }
}
