/**
 * A stand-in for the desktop app's local relay, for testing the iOS SDK until that exists.
 *
 *   bun Tools/relay.ts [--port 8790] [--log /tmp/kf-relay.jsonl] [--quiet]
 *
 * The transport contract: apps connect to `/app?name=<app name>&platform=ios`, panels and CLIs to
 * `/editor`. Each text frame is one JSON InspectorMessage; app frames go to every editor, editor frames
 * to every app. Like the desktop app's relay, as far as `keyframer-inspect ci --relay` and the MCP
 * server need it: editors get `apps` (the newest app attached) on connect and on every change, then
 * that app's last hello and speed; apps get `presence` with the editor count. WebSocket pings are
 * answered by Bun. It listens on every interface so a device on the LAN can reach it.
 */
import type { ServerWebSocket } from 'bun'

type Peer = { role: 'app' | 'editor'; name: string; platform: string; id: string; address: string; connectedAt: number; hello?: string; time?: string }

const arg = (name: string) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const port = Number(arg('--port') ?? process.env.PORT ?? 8790)
const logPath = arg('--log')
const quiet = process.argv.includes('--quiet')
const log = logPath ? Bun.file(logPath).writer() : null

const apps = new Set<ServerWebSocket<Peer>>()
const editors = new Set<ServerWebSocket<Peer>>()
let nextId = 1

/** The app editors show: the newest. */
const newest = () => [...apps].at(-1)
const appsMessage = () =>
  JSON.stringify({
    type: 'apps',
    apps: [...apps].map((a) => ({ id: a.data.id, name: a.data.name, platform: a.data.platform, address: a.data.address, connectedAt: a.data.connectedAt, editors: editors.size })),
    attached: newest()?.data.id ?? null,
    mode: 'auto',
  })
const presence = () => JSON.stringify({ type: 'presence', app: true, editors: editors.size, cli: false })
/** What an editor needs to start: the apps, then the attached app's hello and speed. */
function greet(editor: ServerWebSocket<Peer>) {
  editor.send(appsMessage())
  const app = newest()
  if (app?.data.hello) editor.send(app.data.hello)
  if (app?.data.time) editor.send(app.data.time)
}

const say = (line: string) => {
  if (!quiet) console.log(`${new Date().toISOString().slice(11, 23)} ${line}`)
}

/** One line per message, without the payload: type, size, and what it carried. */
const describe = (raw: string) => {
  try {
    const m = JSON.parse(raw) as Record<string, unknown> & { type?: string }
    const n = (k: string) => (Array.isArray(m[k]) ? `${k}=${(m[k] as unknown[]).length}` : '')
    return [m.type, n('events'), n('samples'), n('frames'), n('drops'), n('markers'), `${raw.length}B`].filter(Boolean).join(' ')
  } catch {
    return `non-JSON ${raw.length}B`
  }
}

Bun.serve<Peer, undefined>({
  port,
  hostname: '0.0.0.0',
  fetch(req, server) {
    const url = new URL(req.url)
    const role = url.pathname === '/app' ? 'app' : url.pathname === '/editor' ? 'editor' : null
    if (!role) return new Response('Keyframer inspector relay: connect to /app or /editor\n', { status: 404 })
    const data: Peer = {
      role,
      name: url.searchParams.get('name') ?? role,
      platform: url.searchParams.get('platform') ?? '',
      id: String(nextId++),
      address: server.requestIP(req)?.address ?? '',
      connectedAt: Date.now(),
    }
    if (server.upgrade(req, { data })) return undefined
    return new Response('WebSocket only\n', { status: 426 })
  },
  websocket: {
    maxPayloadLength: 64 * 1024 * 1024,
    open(ws) {
      ;(ws.data.role === 'app' ? apps : editors).add(ws)
      say(`+ ${ws.data.role} ${ws.data.name}${ws.data.platform ? ` (${ws.data.platform})` : ''}  apps=${apps.size} editors=${editors.size}`)
      if (ws.data.role === 'editor') greet(ws)
      else for (const e of editors) e.send(appsMessage())
      for (const a of apps) a.send(presence())
    },
    message(ws, message) {
      const raw = typeof message === 'string' ? message : new TextDecoder().decode(message)
      if (raw === 'ping') return void ws.send('pong')
      if (ws.data.role === 'app') {
        const type = (() => {
          try {
            return (JSON.parse(raw) as { type?: string }).type
          } catch {
            return undefined
          }
        })()
        // Kept for editors that join later; a hello starts at normal speed.
        if (type === 'hello') {
          ws.data.hello = raw
          ws.data.time = undefined
        }
        if (type === 'time') ws.data.time = raw
      } else {
        try {
          // The relay's own message: there is one app to show, the newest.
          if ((JSON.parse(raw) as { type?: string }).type === 'select') return void ws.send(appsMessage())
        } catch {}
      }
      const to = ws.data.role === 'app' ? editors : apps
      for (const peer of to) peer.send(raw)
      say(`${ws.data.role === 'app' ? 'app → editors' : 'editor → app'}  ${describe(raw)}`)
      log?.write(`${JSON.stringify({ at: Date.now(), from: ws.data.role, raw })}\n`)
      log?.flush()
    },
    close(ws) {
      ;(ws.data.role === 'app' ? apps : editors).delete(ws)
      say(`- ${ws.data.role} ${ws.data.name}  apps=${apps.size} editors=${editors.size}`)
      if (ws.data.role === 'app') for (const e of editors) e.send(appsMessage())
      else for (const a of apps) a.send(presence())
    },
  },
})

say(`relay on ws://0.0.0.0:${port} (/app, /editor)`)
