/**
 * Proof that it works, the way Sentry's wizard waits for a test error: after the code is in, the
 * person starts (or reloads) the app, and the wizard waits for the Inspector's first hello where they
 * chose to look at it, and for Motion Vitals' first session at the API.
 *
 * The Inspector, by view (small clients of the same channels the panel and the MCP server join):
 *   - devtools: Expo's dev server relays every message on /expo-dev-plugins/broadcast; the app's dev
 *     tools client frames each inspector message as `{ messageKey: { pluginName, method }, payload }`.
 *     An editor's hello there makes a running app say its hello again. Metro is looked for on
 *     8081-8090 unless the wizard knows the port.
 *   - desktop: the relay's /editor socket sends `apps` on connect and on every change, then the shown
 *     app's hello.
 *   - editor: the pairing room on the API, joined as an editor with a signed-in session (rooms let in
 *     signed-in editors only); the room hands a late editor the app's last hello.
 *
 * Motion Vitals: GET /v1/status/<field key> on the ingest Worker says when the project last received a
 * session, so a pasted key is enough. A development build reports every session (no sampling, no
 * daily cap), and sends when the app goes to the background, so the wizard asks for exactly that.
 */
import { realpathSync } from 'node:fs'
import path from 'node:path'
import type { InspectorDevice, InspectorEditorMessage, InspectorMessage, InspectorRelayApp } from '../../protocol/inspector'
import type { VitalsConfig, VitalsKeyStatus } from '../../protocol/vitals'
import { Cancelled, type Io } from './io'
import { clock, requestJson, sleep as realSleep, trimUrl, type Fetch } from './http'
import { frameText, socketCtor, type SocketCtor, type SocketLike } from './socket'
import type { InspectorView, Project, VerifyResult, VitalsKey, WizardOptions } from './types'
import { VITALS_ENDPOINT } from './vitalsKey'

export const DEFAULT_TIMEOUT_MS = 3 * 60_000
export const METRO_PORTS = [8081, 8082, 8083, 8084, 8085, 8086, 8087, 8088, 8089, 8090]
export const DESKTOP_RELAY = 'http://127.0.0.1:8790'
/** The dev tools plugin the panel opens (@keyframerdev/inspector's devtoolsSocket.ts). */
export const DEVTOOLS_PLUGIN = '@keyframerdev/inspector'
export const DEVTOOLS_METHOD = 'inspector'
/** The room's close code for a code another account owns (room.ts ROOM_TAKEN). */
const ROOM_TAKEN = 4003
const RECONNECT_MS = 2000
const PING_MS = 10_000

export type VerifyInspectorOptions = {
  project: Project
  view: InspectorView
  relay: string | null
  io: Io
  timeoutMs?: number
  signal?: AbortSignal
  /** Metro's URL when the wizard knows it (http://localhost:8082): only that one is watched. */
  metro?: string | null
  /** The ports looked at without `metro`. Default 8081-8090. */
  ports?: number[]
  /** editor: the room code the app joins. */
  code?: string | null
  /** editor: a Keyframer session token (from signIn) to join the room as an editor. */
  token?: string | null
  /** editor: the API the room is on, and the web app whose editor shows the panel. */
  api?: string
  app?: string
  WebSocket?: SocketCtor
  /** devtools: asks each Metro which project it serves (its /status). */
  fetch?: typeof fetch
}

type Hello = Extract<InspectorMessage, { type: 'hello'; role: 'app' }>
type Heard = { name: string; platform: string; osVersion?: string; device?: InspectorDevice; sdk?: { name: string; version: string }; where: string }

const OS_NAMES: Record<string, string> = { ios: 'iOS', android: 'Android', macos: 'macOS', web: 'the web' }

/** "MyApp on iOS 18.2, iPhone 16 Pro (simulator), @keyframerdev/inspector 0.2.1". */
export function describeApp(h: Omit<Heard, 'where'>): string {
  const os = [OS_NAMES[h.platform] ?? h.platform, h.osVersion].filter(Boolean).join(' ')
  const device = h.device?.name ?? h.device?.model
  const sim = h.device?.simulator ? (h.platform === 'android' ? 'emulator' : 'simulator') : null
  const on = device ? `, ${device}${sim ? ` (${sim})` : ''}` : sim ? `, ${sim === 'emulator' ? 'an' : 'a'} ${sim}` : ''
  return `${h.name} on ${os}${on}${h.sdk ? `, ${h.sdk.name} ${h.sdk.version}` : ''}`
}

const real = (p: string) => {
  try {
    return realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

/**
 * Whether a hello is this project's app, not another one on the same ports (a developer often runs
 * several Metros): by its folder when the hello says it, else by the name the wizard's start code gives.
 */
export function isThisApp(m: Pick<Hello, 'app' | 'root'>, project: Pick<Project, 'root' | 'name'>): boolean {
  return m.root ? real(m.root) === real(project.root) : m.app === project.name
}

/** The project a Metro serves, from its /status header; null when it doesn't say or doesn't answer. */
async function metroRoot(fetchImpl: Fetch, metro: string): Promise<string | null> {
  try {
    const res = await fetchImpl(`${metro}/status`, { signal: AbortSignal.timeout(1500) })
    return res.headers.get('x-react-native-project-root')
  } catch {
    return null
  }
}

const fromHello = (m: Hello, where: string): Heard => ({ name: m.app, platform: m.platform, osVersion: m.osVersion, device: m.device, sdk: m.sdk, where })

function parse(data: unknown): InspectorMessage | null {
  const text = frameText(data)
  if (!text || text === 'pong') return null
  try {
    return JSON.parse(text) as InspectorMessage
  } catch {
    return null
  }
}

/** The broadcast socket for a Metro origin. */
export function broadcastUrl(metro: string): string {
  const u = new URL(metro)
  return `${u.protocol === 'https:' ? 'wss' : 'ws'}://${u.host}/expo-dev-plugins/broadcast`
}

/** One inspector message, framed the way Expo's dev tools client frames it. */
export function packDevtools(msg: InspectorEditorMessage): string {
  return JSON.stringify({ messageKey: { pluginName: DEVTOOLS_PLUGIN, method: DEVTOOLS_METHOD }, payload: JSON.stringify(msg) })
}

/** The inspector message inside a broadcast frame, or null when the frame is someone else's. */
export function unpackDevtools(data: unknown): InspectorMessage | null {
  const text = frameText(data)
  if (!text) return null
  try {
    const frame = JSON.parse(text) as { messageKey?: { pluginName?: string; method?: string }; payload?: unknown }
    if (frame.messageKey?.pluginName !== DEVTOOLS_PLUGIN || frame.messageKey.method !== DEVTOOLS_METHOD || typeof frame.payload !== 'string') return null
    return JSON.parse(frame.payload) as InspectorMessage
  } catch {
    return null
  }
}

/** The relay's /editor socket for any form of its address. */
export function relayEditorUrl(relay: string): string {
  const u = new URL(/^[a-z]+:\/\//i.test(relay) ? relay : `ws://${relay}`)
  return `${u.protocol === 'https:' || u.protocol === 'wss:' ? 'wss' : 'ws'}://${u.host}/editor`
}

/** `http(s)://api` → `ws(s)://api/inspector/rooms/<code>/ws?role=editor`. */
export function roomEditorUrl(api: string, code: string): string {
  const base = trimUrl(api).replace(/^http(s?):\/\//, (_m, s: string) => `ws${s}://`)
  return `${base}/inspector/rooms/${encodeURIComponent(code)}/ws?role=editor`
}

type Watch = (heard: (h: Heard) => void, fail: (detail: string) => void) => () => void

/** Runs a watch until it hears the app, fails, times out or is stopped, with a spinner counting down. */
function waitFor(io: Io, label: string, timeoutMs: number, signal: AbortSignal | undefined, watch: Watch, onTimeout: () => VerifyResult, afterTimeout: () => void): Promise<VerifyResult> {
  const deadline = Date.now() + timeoutMs
  const spin = io.spinner(`${label} (${clock(timeoutMs)} left)`)
  return new Promise((resolve) => {
    let done = false
    let stop: () => void = () => {}
    const finish = (r: VerifyResult, line: string, then?: () => void) => {
      if (done) return
      done = true
      clearTimeout(timer)
      clearInterval(tick)
      signal?.removeEventListener('abort', onAbort)
      stop()
      spin.stop(line, r.ok)
      // After the spinner: a note printed under a running spinner garbles it.
      then?.()
      resolve(r)
    }
    const onAbort = () => finish({ ok: false, reason: 'skipped', detail: 'Stopped waiting.' }, 'Stopped waiting')
    const timer = setTimeout(() => {
      const r = onTimeout()
      finish(r, r.detail, afterTimeout)
    }, timeoutMs)
    const tick = setInterval(() => spin.update(`${label} (${clock(deadline - Date.now())} left)`), 1000)
    if (signal?.aborted) return onAbort()
    signal?.addEventListener('abort', onAbort, { once: true })
    stop = watch(
      (h) => {
        const detail = `Hello from ${describeApp(h)}`
        finish({ ok: true, detail }, `${detail}, through ${h.where}`)
      },
      (detail) => finish({ ok: false, reason: 'error', detail }, detail),
    )
  })
}

/**
 * Every Metro candidate's broadcast socket, kept open (and reopened) until this project's app says hello
 * on one. A Metro that says it serves another project is left alone (and asked again later), and
 * another app's hello is ignored, said once.
 */
function watchMetro(Socket: SocketCtor, metros: string[], project: Project, fetchImpl: Fetch, io: Io, seen: MetroSeen): Watch {
  return (heard) => {
    let closed = false
    const sockets = new Set<SocketLike>()
    const timers = new Set<ReturnType<typeof setTimeout>>()
    const others = new Set<string>()
    const later = (metro: string) => {
      const t = setTimeout(() => {
        timers.delete(t)
        void open(metro)
      }, RECONNECT_MS)
      timers.add(t)
    }
    const open = async (metro: string) => {
      if (closed) return
      const root = await metroRoot(fetchImpl, metro)
      if (closed) return
      if (root && real(root) !== real(project.root)) {
        seen.others.set(metro, root)
        return later(metro)
      }
      seen.others.delete(metro)
      if (root) seen.mine.add(metro)
      let s: SocketLike
      try {
        s = new Socket(broadcastUrl(metro))
      } catch {
        return
      }
      sockets.add(s)
      s.onopen = () => {
        seen.answered.add(metro)
        s.send(packDevtools({ type: 'hello', role: 'editor' }))
      }
      s.onmessage = (ev) => {
        const msg = unpackDevtools(ev.data)
        if (msg?.type !== 'hello' || msg.role !== 'app') return
        if (isThisApp(msg, project)) return heard(fromHello(msg, `Metro on ${metro}`))
        if (others.has(msg.app)) return
        others.add(msg.app)
        io.info(`Heard ${msg.app} on ${metro}, another app: still waiting for ${project.name}.`)
      }
      s.onerror = () => {}
      s.onclose = () => {
        sockets.delete(s)
        // Nothing on this port yet (or Metro restarted): look again in a moment.
        if (!closed) later(metro)
      }
    }
    for (const m of metros) void open(m)
    return () => {
      closed = true
      for (const t of timers) clearTimeout(t)
      for (const s of sockets) {
        s.onclose = null
        s.close()
      }
    }
  }
}

/** The desktop relay's editor socket: an app in `apps`, then its hello (or, after a moment, what `apps` said). */
function watchRelay(Socket: SocketCtor, relay: string, helloGraceMs = 1500): Watch {
  return (heard) => {
    let closed = false
    let s: SocketLike | null = null
    let retry: ReturnType<typeof setTimeout> | null = null
    let grace: ReturnType<typeof setTimeout> | null = null
    let ping: ReturnType<typeof setInterval> | null = null
    const where = `the desktop relay at ${relay.replace(/^ws(s?):/, 'http$1:')}`
    const open = () => {
      if (closed) return
      const sock = new Socket(relayEditorUrl(relay))
      s = sock
      sock.onopen = () => {
        sock.send(JSON.stringify({ type: 'hello', role: 'editor' }))
        ping = setInterval(() => sock.readyState === 1 && sock.send('ping'), PING_MS)
      }
      sock.onmessage = (ev) => {
        const msg = parse(ev.data)
        if (!msg) return
        if (msg.type === 'apps' && msg.apps.length && !grace) {
          const app: InspectorRelayApp = msg.apps.find((a) => a.id === msg.attached) ?? msg.apps[msg.apps.length - 1]!
          grace = setTimeout(() => heard({ name: app.name, platform: app.platform, osVersion: app.osVersion, where }), helloGraceMs)
        }
        if (msg.type === 'hello' && msg.role === 'app') heard(fromHello(msg, where))
      }
      sock.onerror = () => {}
      sock.onclose = () => {
        if (ping) clearInterval(ping)
        if (!closed) retry = setTimeout(open, RECONNECT_MS)
      }
    }
    open()
    return () => {
      closed = true
      for (const t of [retry, grace]) if (t) clearTimeout(t)
      if (ping) clearInterval(ping)
      if (s) {
        s.onclose = null
        s.close()
      }
    }
  }
}

/** The pairing room, as a signed-in editor: the app's hello (the room keeps the last one for late editors). */
function watchRoom(Socket: SocketCtor, api: string, code: string, token: string): Watch {
  return (heard, fail) => {
    let closed = false
    let s: SocketLike | null = null
    let retry: ReturnType<typeof setTimeout> | null = null
    let ping: ReturnType<typeof setInterval> | null = null
    let refused = 0
    const open = () => {
      if (closed) return
      let opened = false
      const sock = new Socket(roomEditorUrl(api, code), { headers: { Authorization: `Bearer ${token}` } })
      s = sock
      sock.onopen = () => {
        opened = true
        refused = 0
        ping = setInterval(() => sock.readyState === 1 && sock.send('ping'), PING_MS)
      }
      sock.onmessage = (ev) => {
        const msg = parse(ev.data)
        if (msg?.type === 'hello' && msg.role === 'app') heard(fromHello(msg, `room ${code}`))
      }
      sock.onerror = () => {}
      sock.onclose = (ev) => {
        if (ping) clearInterval(ping)
        if (closed) return
        if (ev?.code === ROOM_TAKEN) return fail(`Room ${code} belongs to another Keyframer account (the first editor to open a code owns it). Use the code your editor shows.`)
        // Refused before opening, again and again: the session, or the API, is not letting it in.
        if (!opened && ++refused >= 3) return fail(`Couldn't join room ${code} on ${api}. Check that you're signed in to the same account in the editor.`)
        retry = setTimeout(open, RECONNECT_MS)
      }
    }
    open()
    return () => {
      closed = true
      if (retry) clearTimeout(retry)
      if (ping) clearInterval(ping)
      if (s) {
        s.onclose = null
        s.close()
      }
    }
  }
}

const TIMEOUT_CAUSES: Record<InspectorView, string[]> = {
  devtools: [
    'The app has not reloaded since the code went in: press r in the terminal running Metro.',
    "Metro is on a port outside 8081-8090: pass it with --metro (or start Metro there).",
    'An Android emulator reaches Metro through adb: run adb reverse tcp:8081 tcp:8081 (expo run:android does it for you).',
    'connectDevTools runs only in development builds (__DEV__), from the entry file. Check it is imported there.',
  ],
  desktop: [
    'The app has not reloaded since the code went in: press r in the terminal running Metro.',
    "The app connects to the desktop app's relay on port 8790 (connectInspector's apiUrl http://127.0.0.1:8790), not to Metro's port.",
    'An Android emulator reaches the Mac at 10.0.2.2, or run adb reverse tcp:8790 tcp:8790.',
    "A physical device needs the Mac's LAN address, which the desktop app shows in its status bar.",
  ],
  editor: [
    'The app has not reloaded since the code went in: press r in the terminal running Metro.',
    "The app's room code matches the one the editor's Inspector panel shows.",
    'The app reaches the Keyframer API (a device on a network that blocks it cannot join).',
  ],
}

/** "3 minutes", "1 minute". */
const minutes = (ms: number) => {
  const m = Math.max(1, Math.round(ms / 60_000))
  return `${m} ${m === 1 ? 'minute' : 'minutes'}`
}

const timedOut = (timeoutMs: number): VerifyResult => ({ ok: false, reason: 'timeout', detail: `No hello from the app in ${minutes(timeoutMs)}.` })
const sayCauses = (io: Io, view: InspectorView, seen?: () => string | null) => () => {
  const first = seen?.()
  io.note([...(first ? [first] : []), ...TIMEOUT_CAUSES[view]].map((c) => `- ${c}`).join('\n'), 'No hello yet. The usual causes')
}

/** What the Metro watch saw, for the first line of the causes when no hello came. */
type MetroSeen = { mine: Set<string>; answered: Set<string>; others: Map<string, string> }

function metroSeenLine(seen: MetroSeen, where: string): string {
  const mine = [...seen.mine, ...[...seen.answered].filter((m) => !seen.others.has(m))]
  if (mine.length)
    return `Metro for this project is running (${[...new Set(mine)].join(', ')}), but the app never said hello: reload it there (press r). Expo Go may still show an app it had open before: close it and open this project again.`
  if (seen.others.size)
    return `Metro answered only for other projects (${[...seen.others].map(([m, root]) => `${m} serves ${path.basename(root)}`).join(', ')}): start this project's Metro (npx expo start), or pass --metro.`
  return `No Metro answered on ${where}: start it in this project (npx expo start).`
}

export async function verifyInspector(opts: VerifyInspectorOptions): Promise<VerifyResult> {
  const { io, view, signal } = opts
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const project = opts.project.name

  if (view === 'devtools') {
    const ports = opts.ports ?? METRO_PORTS
    const metros = opts.metro ? [trimUrl(opts.metro)] : ports.map((p) => `http://localhost:${p}`)
    const where = opts.metro ? trimUrl(opts.metro) : ports.length > 1 ? `Metro's ports ${ports[0]}-${ports[ports.length - 1]}` : `Metro's port ${ports[0]}`
    io.info(`Start the app (or reload it: press r in Metro). The wizard listens on ${where}.`)
    const Socket = opts.WebSocket ?? (await socketCtor())
    const seen: MetroSeen = { mine: new Set(), answered: new Set(), others: new Map() }
    const watch = watchMetro(Socket, metros, opts.project, opts.fetch ?? fetch, io, seen)
    return waitFor(io, `Waiting for ${project} to say hello in Expo dev tools`, timeoutMs, signal, watch, () => timedOut(timeoutMs), sayCauses(io, view, () => metroSeenLine(seen, where)))
  }

  if (view === 'desktop') {
    if (!opts.relay) return { ok: false, reason: 'skipped', detail: "The desktop app isn't running, so there is no relay to wait on." }
    io.info('Start the app (or reload it: press r in Metro). It shows up in Keyframer Inspector once it connects.')
    const Socket = opts.WebSocket ?? (await socketCtor())
    return waitFor(io, `Waiting for ${project} to join the desktop app`, timeoutMs, signal, watchRelay(Socket, opts.relay), () => timedOut(timeoutMs), sayCauses(io, view))
  }

  // The editor's Inspector panel: a pairing room on the API.
  const app = trimUrl(opts.app ?? 'https://keyframer.dev')
  if (!opts.code) return { ok: false, reason: 'skipped', detail: 'No room code to check: open the Inspector panel in the Keyframer editor and use the code it shows.' }
  io.info(`Open the Keyframer editor (${app}/app), then its Inspector panel with the code ${opts.code}. Start the app (or reload it: press r in Metro).`)
  if (!opts.token) return { ok: false, reason: 'skipped', detail: `Not checked: joining room ${opts.code} needs a Keyframer sign-in. The editor's Inspector panel shows the app when it joins.` }
  const Socket = opts.WebSocket ?? (await socketCtor({ headers: true }))
  const api = trimUrl(opts.api ?? 'https://api.keyframer.dev')
  return waitFor(io, `Waiting for ${project} to join room ${opts.code}`, timeoutMs, signal, watchRoom(Socket, api, opts.code, opts.token), () => timedOut(timeoutMs), sayCauses(io, view))
}

// ─── Motion Vitals ────────────────────────────────────────────────────────────────

export type VerifyVitalsOptions = {
  project: Project
  key: VitalsKey
  options: WizardOptions
  io: Io
  timeoutMs?: number
  signal?: AbortSignal
  fetch?: typeof fetch
  /** Between checks. Default 3 s. */
  pollMs?: number
  /** For tests. */
  now?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/** A key made a moment ago (the wizard may have just made it) can take this long to reach the ingest Worker everywhere. */
const NEW_KEY_GRACE_MS = 60_000

/** Sessions that arrived this long before the wizard started waiting still count: clocks differ, and a quick reload may beat it. */
const SINCE_SLACK_MS = 2 * 60_000

type Counts = { reported: number }

export async function verifyVitals(opts: VerifyVitalsOptions): Promise<VerifyResult> {
  const { io, key, options, signal } = opts
  const fetchImpl: Fetch = opts.fetch ?? fetch
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? realSleep
  const pollMs = opts.pollMs ?? 3000
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const endpoint = trimUrl(options.vitalsEndpoint ?? VITALS_ENDPOINT)
  const dashboard = key.workspaceId && key.projectId ? `${trimUrl(options.app)}/app/vitals/${key.workspaceId}/${key.projectId}/setup` : `${trimUrl(options.app)}/app/vitals`
  const started = now()
  const since = started - SINCE_SLACK_MS
  const vitalsApi = `${trimUrl(options.api)}/api/vitals`

  // A development build sends nothing the project keeps unless the project keeps development builds.
  const config = await requestJson<VitalsConfig>(fetchImpl, `${endpoint}/v1/config/${encodeURIComponent(key.key)}`, { signal })
  if (config.status === 410) return { ok: false, reason: 'error', detail: "This key's project was deleted. Run the wizard again for a live project's key." }
  let development = config.data?.collect.development ?? null
  if (development === false) {
    if (key.token && key.projectId) {
      const on = await io.confirm('This project ignores development builds, so a simulator run would send nothing it keeps. Keep them, to test from here? (Turn it off on the Setup page any time.)', {
        initial: true,
      })
      if (on) {
        const patched = await requestJson(fetchImpl, `${vitalsApi}/projects/${encodeURIComponent(key.projectId)}`, { method: 'PATCH', token: key.token, body: { collect: { development: true } }, signal })
        if (patched.status === 200) {
          development = true
          io.success('Development builds are on for this project. Reload the app so it reads the new setting.')
        } else if (patched.status === 403) io.warn(`Only owners and admins can change that. Ask one to turn on "Development builds" on ${dashboard}, or test with a release build.`)
        else io.warn(`Couldn't turn on development builds (${patched.error ?? patched.status}). Turn them on at ${dashboard}.`)
      }
    } else {
      io.warn(`This project ignores development builds. To test from a simulator, turn on "Development builds" on its Setup page (${dashboard}), then reload the app. Or test with a release build.`)
    }
  }

  io.note(
    [
      '1. Start the app, or reload it (press r in Metro).',
      '2. Scroll, or tap something that animates, for a few seconds.',
      '3. Send the app to the background: Home in the iOS Simulator is shift+cmd+H, on Android the Home button.',
      '',
      'A development build reports every session, and sends it when the app goes to the background.',
    ].join('\n'),
    'Send the first session',
  )

  // With the session from signing in, the dashboard's own numbers stand in for an older Worker without /v1/status.
  const overviewCount = async (): Promise<Counts | null> => {
    if (!key.token || !key.projectId) return null
    const total = { reported: 0 }
    for (const env of ['production', 'development']) {
      const r = await requestJson<{ reported?: number }>(fetchImpl, `${vitalsApi}/projects/${encodeURIComponent(key.projectId)}/overview?days=14&env=${env}`, { token: key.token, signal })
      if (!r.data) return null
      total.reported += r.data.reported ?? 0
    }
    return total
  }

  const spin = io.spinner(`Waiting for the first session (${clock(timeoutMs)} left)`)
  const deadline = started + timeoutMs
  let mode: 'status' | 'overview' = 'status'
  let baseline: Counts | null = null
  let toldAgain = false
  try {
    for (;;) {
      if (mode === 'status') {
        const r = await requestJson<VitalsKeyStatus>(fetchImpl, `${endpoint}/v1/status/${encodeURIComponent(key.key)}`, { signal })
        if (r.data) {
          const last = r.data.lastSessionAt ? Date.parse(r.data.lastSessionAt) : NaN
          if (last >= since) {
            const detail = `The first session arrived at ${new Date(last).toLocaleTimeString()}.`
            spin.stop(detail, true)
            return { ok: true, detail }
          }
          const dropped = r.data.developmentDroppedAt ? Date.parse(r.data.developmentDroppedAt) : NaN
          if (dropped >= since && development !== true) {
            const detail = 'The app reported from a development build, and the project dropped it: it ignores development builds.'
            spin.stop(detail, true)
            io.info(`It works. To see development sessions in the dashboard, turn on "Development builds" at ${dashboard}.`)
            return { ok: true, detail }
          }
          // Turned on a moment ago: the setting takes a minute or so to reach the ingest Worker everywhere.
          if (dropped >= since && development === true && !toldAgain) {
            toldAgain = true
            // Said in the spinner: a line printed under a running spinner garbles it.
            spin.update('One session came before the new setting took effect: bring the app back, then send it to the background again')
          }
        } else if (r.status === 401 && now() - started > NEW_KEY_GRACE_MS) {
          spin.stop("keyframer.dev doesn't know this key", false)
          return { ok: false, reason: 'error', detail: "keyframer.dev doesn't know this key (revoked, or not there yet). Check it on the project's Setup page." }
        } else if (r.status === 410) {
          spin.stop("This key's project was deleted", false)
          return { ok: false, reason: 'error', detail: "This key's project was deleted." }
        } else if (r.status === 404) {
          // A Worker older than the status route.
          baseline = await overviewCount()
          if (!baseline) {
            spin.stop("keyframer.dev can't tell the wizard about new sessions yet", false)
            io.info(`Watch for it on the project's page instead: ${dashboard}`)
            return { ok: false, reason: 'skipped', detail: `Not checked: look for the first session at ${dashboard}.` }
          }
          mode = 'overview'
        }
        // 429, 5xx, offline: try again.
      } else {
        const counts = await overviewCount()
        if (counts && baseline && counts.reported > baseline.reported) {
          const detail = 'The first session arrived.'
          spin.stop(detail, true)
          return { ok: true, detail }
        }
      }
      const left = deadline - now()
      if (left <= 0) break
      if (!toldAgain) spin.update(`Waiting for the first session (${clock(left)} left)`)
      await sleep(Math.min(pollMs, left), signal)
    }
  } catch (e) {
    if (e instanceof Cancelled) {
      spin.stop('Stopped waiting', false)
      return { ok: false, reason: 'skipped', detail: 'Stopped waiting.' }
    }
    throw e
  }

  spin.stop('No session yet', false)
  const causes = [
    'The app has not gone to the background yet: a session is sent when it does.',
    'Nothing moved: Motion Vitals measures while something animates, scrolls or is touched.',
    ...(development === false ? ['The project ignores development builds: turn them on at its Setup page, or test with a release build.'] : []),
    'startVitals is not reached: check that the entry file calls it, and rebuild or reload the app.',
    'A sampleRate below 1 in startVitals skips some development sessions too.',
  ]
  io.note(causes.map((c) => `- ${c}`).join('\n'), 'The usual causes')
  io.info(`The first session also shows on ${dashboard}`)
  return { ok: false, reason: 'timeout', detail: `No session in ${minutes(timeoutMs)}.` }
}
