import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { beforeEach, describe, expect, it } from 'vitest'
import { WebSocket as WsSocket, WebSocketServer } from 'ws'
import { FakeSocket, fakeFetch, loggedIo, testOptions, testProject, tick } from './fakes'
import type { SocketCtor } from './socket'
import type { VerifyResult } from './types'
import { describeApp, isThisApp, packDevtools, verifyInspector, verifyVitals } from './verify'

const Socket = FakeSocket as unknown as SocketCtor
const reason = (r: VerifyResult) => (r.ok ? 'ok' : r.reason)
const hello = {
  type: 'hello',
  role: 'app',
  app: 'Acme Shop',
  platform: 'ios',
  osVersion: '18.2',
  device: { name: 'iPhone 16 Pro', simulator: true },
  sdk: { name: '@keyframerdev/inspector', version: '0.2.1' },
  protocol: 1,
} as const
/** What the app's dev tools client puts on Metro's broadcast socket. */
const fromApp = (msg: object) => packDevtools(msg as never)

beforeEach(() => FakeSocket.reset())

describe('describeApp', () => {
  it('names the app, its OS, device and SDK', () => {
    expect(describeApp({ ...hello, name: hello.app })).toBe('Acme Shop on iOS 18.2, iPhone 16 Pro (simulator), @keyframerdev/inspector 0.2.1')
    expect(describeApp({ name: 'Shop', platform: 'android', device: { simulator: true } })).toBe('Shop on Android, an emulator')
    expect(describeApp({ name: 'Shop', platform: 'android' })).toBe('Shop on Android')
  })
})

/** Metro's /status, unanswered: tests never reach a real Metro (the owner's run on 8081-8090). */
const noStatus = (async () => new Response('', { status: 404 })) as unknown as typeof fetch

describe('verifyInspector, Expo dev tools', () => {
  it("watches Metro's ports, says hello as an editor, and reports the app's hello", async () => {
    const io = loggedIo()
    const p = verifyInspector({ project: testProject, view: 'devtools', relay: null, io, WebSocket: Socket, fetch: noStatus, ports: [8081, 8082], timeoutMs: 5000 })
    await tick()
    const [a, b] = FakeSocket.sockets
    expect([a!.url, b!.url]).toEqual(['ws://localhost:8081/expo-dev-plugins/broadcast', 'ws://localhost:8082/expo-dev-plugins/broadcast'])
    a!.drop()
    b!.open()
    expect(JSON.parse(JSON.parse(b!.sent[0]!).payload)).toEqual({ type: 'hello', role: 'editor' })
    // Someone else's plugin, then the app.
    b!.say({ messageKey: { pluginName: 'other', method: 'x' }, payload: '{"type":"hello","role":"app","app":"Nope","platform":"ios"}' })
    setTimeout(() => b!.say(fromApp(hello)), 30)
    const r = await p
    expect(r).toEqual({ ok: true, detail: 'Hello from Acme Shop on iOS 18.2, iPhone 16 Pro (simulator), @keyframerdev/inspector 0.2.1' })
    expect(FakeSocket.sockets.every((s) => s.closed || s === a)).toBe(true)
    expect(io.log.at(-1)).toBe('spinner done: Hello from Acme Shop on iOS 18.2, iPhone 16 Pro (simulator), @keyframerdev/inspector 0.2.1, through Metro on http://localhost:8082')
  })

  it('over real sockets, with the global WebSocket and with ws (what Node 20 gets)', async () => {
    // A stand-in for Metro's broadcast on an ephemeral port: the app answers an editor's hello with its own.
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/expo-dev-plugins/broadcast' })
    await once(wss, 'listening')
    wss.on('connection', (sock) =>
      sock.on('message', (data) => {
        const frame = JSON.parse(String(data)) as { payload: string }
        if (JSON.parse(frame.payload).role === 'editor') sock.send(fromApp(hello))
      }),
    )
    const metro = `http://127.0.0.1:${(wss.address() as AddressInfo).port}`
    try {
      for (const WebSocket of [undefined, WsSocket as unknown as SocketCtor]) {
        const r = await verifyInspector({ project: testProject, view: 'devtools', relay: null, io: loggedIo(), metro, WebSocket, timeoutMs: 5000 })
        expect(r.ok).toBe(true)
      }
    } finally {
      wss.close()
    }
  })

  it('only the Metro it was given', async () => {
    const p = verifyInspector({ project: testProject, view: 'devtools', relay: null, io: loggedIo(), WebSocket: Socket, fetch: noStatus, metro: 'http://localhost:8095/', timeoutMs: 2000 })
    await tick()
    expect(FakeSocket.sockets.map((s) => s.url)).toEqual(['ws://localhost:8095/expo-dev-plugins/broadcast'])
    FakeSocket.sockets[0]!.open()
    FakeSocket.sockets[0]!.say(fromApp(hello))
    expect((await p).ok).toBe(true)
  })

  it('times out with the usual causes', async () => {
    const io = loggedIo()
    const r = await verifyInspector({ project: testProject, view: 'devtools', relay: null, io, WebSocket: Socket, fetch: noStatus, ports: [8081], timeoutMs: 60 })
    expect(r).toEqual({ ok: false, reason: 'timeout', detail: 'No hello from the app in 1 minute.' })
    const note = io.log.find((l) => l.startsWith('note (No hello yet'))!
    expect(note).toContain('press r in the terminal running Metro')
    expect(note).toContain('adb reverse tcp:8081 tcp:8081')
    expect(note).toContain("No Metro answered on Metro's port 8081: start it in this project (npx expo start).")
    expect(FakeSocket.sockets[0]!.closed).toBe(true)
  })

  it("times out saying what it saw: this project's Metro up but no hello, or only other projects' Metros", async () => {
    const status = (async (url: string) =>
      new Response('packager-status:running', { headers: { 'X-React-Native-Project-Root': url.includes(':8082') ? '/work/chalk' : '/work/shop' } })) as unknown as typeof fetch
    const io = loggedIo()
    const p = verifyInspector({ project: testProject, view: 'devtools', relay: null, io, WebSocket: Socket, fetch: status, ports: [8082, 8086], timeoutMs: 80 })
    await tick()
    FakeSocket.sockets[0]!.open()
    await p
    expect(io.log.find((l) => l.startsWith('note (No hello yet'))).toContain('Metro for this project is running (http://localhost:8086), but the app never said hello: reload it there (press r).')

    const io2 = loggedIo()
    const only = (async () => new Response('', { headers: { 'X-React-Native-Project-Root': '/work/chalk' } })) as unknown as typeof fetch
    await verifyInspector({ project: testProject, view: 'devtools', relay: null, io: io2, WebSocket: Socket, fetch: only, ports: [8082], timeoutMs: 60 })
    expect(io2.log.find((l) => l.startsWith('note (No hello yet'))).toContain('Metro answered only for other projects (http://localhost:8082 serves chalk)')
  })

  it('stops when the signal aborts', async () => {
    const ctl = new AbortController()
    const p = verifyInspector({ project: testProject, view: 'devtools', relay: null, io: loggedIo(), WebSocket: Socket, fetch: noStatus, ports: [8081], signal: ctl.signal })
    setTimeout(() => ctl.abort(), 20)
    expect(await p).toEqual({ ok: false, reason: 'skipped', detail: 'Stopped waiting.' })
  })

  it("ignores another app's hello (a second Metro, another project) and says so once", async () => {
    const io = loggedIo()
    const p = verifyInspector({ project: testProject, view: 'devtools', relay: null, io, WebSocket: Socket, fetch: noStatus, ports: [8082], timeoutMs: 2000 })
    await tick()
    const s = FakeSocket.sockets[0]!
    s.open()
    const chalk = fromApp({ ...hello, app: 'Chalk' })
    s.say(chalk)
    s.say(chalk)
    setTimeout(() => s.say(fromApp(hello)), 20)
    expect((await p).ok).toBe(true)
    expect(io.log.filter((l) => l.includes('Heard Chalk'))).toEqual(['info: Heard Chalk on http://localhost:8082, another app: still waiting for Acme Shop.'])
  })

  it('takes a hello by its folder when the app says it, whatever its name', async () => {
    expect(isThisApp({ app: 'Other name', root: '/work/shop' }, testProject)).toBe(true)
    expect(isThisApp({ app: 'Acme Shop', root: '/work/elsewhere' }, testProject)).toBe(false)
    expect(isThisApp({ app: 'Acme Shop' }, testProject)).toBe(true)
  })

  it("leaves a Metro that serves another project alone, and opens the one serving this app", async () => {
    const status = (async (url: string) =>
      new Response('packager-status:running', { headers: { 'X-React-Native-Project-Root': url.includes(':8082') ? '/work/chalk' : '/work/shop' } })) as unknown as typeof fetch
    const p = verifyInspector({ project: testProject, view: 'devtools', relay: null, io: loggedIo(), WebSocket: Socket, fetch: status, ports: [8082, 8086], timeoutMs: 2000 })
    await tick()
    expect(FakeSocket.sockets.map((s) => s.url)).toEqual(['ws://localhost:8086/expo-dev-plugins/broadcast'])
    FakeSocket.sockets[0]!.open()
    FakeSocket.sockets[0]!.say(fromApp(hello))
    expect((await p).ok).toBe(true)
  })
})

describe('verifyInspector, desktop relay', () => {
  it('joins /editor, sees the app in `apps`, and reports its hello', async () => {
    const p = verifyInspector({ project: testProject, view: 'desktop', relay: 'http://127.0.0.1:8790', io: loggedIo(), WebSocket: Socket, timeoutMs: 5000 })
    await tick()
    const s = FakeSocket.sockets[0]!
    expect(s.url).toBe('ws://127.0.0.1:8790/editor')
    s.open()
    expect(JSON.parse(s.sent[0]!)).toEqual({ type: 'hello', role: 'editor' })
    s.say({ type: 'apps', apps: [], attached: null, mode: 'auto' })
    s.say({ type: 'apps', apps: [{ id: 'a1', name: 'Acme Shop', platform: 'ios', address: '127.0.0.1', connectedAt: 1, editors: 1 }], attached: 'a1', mode: 'auto' })
    s.say(hello)
    expect(await p).toEqual({ ok: true, detail: 'Hello from Acme Shop on iOS 18.2, iPhone 16 Pro (simulator), @keyframerdev/inspector 0.2.1' })
  })

  it('an app in `apps` whose hello does not follow still counts', async () => {
    const p = verifyInspector({ project: testProject, view: 'desktop', relay: 'http://127.0.0.1:8790', io: loggedIo(), WebSocket: Socket, timeoutMs: 5000 })
    await tick()
    const s = FakeSocket.sockets[0]!
    s.open()
    s.say({ type: 'apps', apps: [{ id: 'a1', name: 'Acme Shop', platform: 'android', osVersion: '15', address: '10.0.2.2', connectedAt: 1, editors: 1 }], attached: 'a1', mode: 'auto' })
    expect(await p).toEqual({ ok: true, detail: 'Hello from Acme Shop on Android 15' })
  })

  it('no relay: skipped; a timeout names the relay port and adb reverse', async () => {
    expect(reason(await verifyInspector({ project: testProject, view: 'desktop', relay: null, io: loggedIo(), WebSocket: Socket }))).toBe('skipped')
    const io = loggedIo()
    expect(reason(await verifyInspector({ project: testProject, view: 'desktop', relay: 'http://127.0.0.1:8790', io, WebSocket: Socket, timeoutMs: 50 }))).toBe('timeout')
    const note = io.log.find((l) => l.startsWith('note (No hello yet'))!
    expect(note).toContain('port 8790')
    expect(note).toContain('adb reverse tcp:8790 tcp:8790')
  })
})

describe('verifyInspector, the editor (a pairing room)', () => {
  it('joins the room as a signed-in editor and reports the hello', async () => {
    const io = loggedIo()
    const p = verifyInspector({ project: testProject, view: 'editor', relay: null, io, WebSocket: Socket, code: 'ABC234', token: 'tok_1', api: 'https://api.test', app: 'https://app.test', timeoutMs: 5000 })
    await tick()
    const s = FakeSocket.sockets[0]!
    expect(s.url).toBe('wss://api.test/inspector/rooms/ABC234/ws?role=editor')
    expect(s.init?.headers?.Authorization).toBe('Bearer tok_1')
    s.open()
    s.say({ type: 'presence', app: true, editors: 1, cli: false })
    s.say(hello)
    expect((await p).ok).toBe(true)
    expect(io.log[0]).toBe('info: Open the Keyframer editor (https://app.test/app), then its Inspector panel with the code ABC234. Start the app (or reload it: press r in Metro).')
  })

  it("a room another account owns is an error; no code or no sign-in is skipped with why", async () => {
    const p = verifyInspector({ project: testProject, view: 'editor', relay: null, io: loggedIo(), WebSocket: Socket, code: 'ABC234', token: 'tok_1', timeoutMs: 5000 })
    await tick()
    FakeSocket.sockets[0]!.drop(4003)
    expect(await p).toMatchObject({ ok: false, reason: 'error', detail: expect.stringContaining('belongs to another Keyframer account') })
    expect(await verifyInspector({ project: testProject, view: 'editor', relay: null, io: loggedIo(), WebSocket: Socket, code: 'ABC234' })).toMatchObject({ reason: 'skipped', detail: expect.stringContaining('needs a Keyframer sign-in') })
    expect(reason(await verifyInspector({ project: testProject, view: 'editor', relay: null, io: loggedIo(), WebSocket: Socket }))).toBe('skipped')
  })
})

// ─── Motion Vitals ────────────────────────────────────────────────────────────────

const KEY = 'kfp_live_AbCdEfGhIjKlMnOpQrStUvWx'
const START = Date.parse('2026-10-21T12:00:00Z')
const config = (development: boolean) => ({ enabled: true, sampleRate: 0.1, collect: { reduceMotion: false, deviceModel: true, development }, ttlSec: 86400 })
const pasted = { key: KEY, projectId: null, workspaceId: null, token: null }
const signedIn = { key: KEY, projectId: 'p1', workspaceId: 'w1', token: 'tok_1' }

function clock() {
  let t = START
  return { now: () => t, sleep: async (ms: number) => void (t += ms) }
}
const status = (lastSessionAt: string | null, developmentDroppedAt: string | null = null) => ({ body: { lastSessionAt, developmentDroppedAt } })

describe('verifyVitals', () => {
  it('waits for the first session at /v1/status, with what to do in the app', async () => {
    const io = loggedIo()
    const f = fakeFetch([
      ['GET', `/v1/config/${KEY}`, { body: config(true) }],
      // An old session from before the wizard ran, then this one.
      ['GET', `/v1/status/${KEY}`, (_c, n) => status(n < 2 ? '2026-10-21T10:00:00Z' : '2026-10-21T12:00:07Z')],
    ])
    const r = await verifyVitals({ project: testProject, key: pasted, options: testOptions(), io, fetch: f, ...clock() })
    expect(r.ok).toBe(true)
    expect(f.calls.filter((c) => c.url.includes('/v1/status/'))).toHaveLength(3)
    expect(io.log.join('\n')).toContain('Send the app to the background')
  })

  it('a project that ignores development builds: offers to keep them when signed in, then waits', async () => {
    const io = loggedIo()
    const f = fakeFetch([
      ['GET', `/v1/config/${KEY}`, { body: config(false) }],
      ['PATCH', '/api/vitals/projects/p1', { body: { id: 'p1' } }],
      ['GET', `/v1/status/${KEY}`, status('2026-10-21T12:00:30Z')],
    ])
    expect((await verifyVitals({ project: testProject, key: signedIn, options: testOptions(), io, fetch: f, ...clock() })).ok).toBe(true)
    const patch = f.calls.find((c) => c.method === 'PATCH')!
    expect(patch.body).toEqual({ collect: { development: true } })
    expect(patch.headers.authorization).toBe('Bearer tok_1')
    expect(io.log).toContain('success: Development builds are on for this project. Reload the app so it reads the new setting.')
  })

  it('a pasted key on such a project: says where to turn them on, and a dropped development report still proves it works', async () => {
    const io = loggedIo()
    const f = fakeFetch([
      ['GET', `/v1/config/${KEY}`, { body: config(false) }],
      ['GET', `/v1/status/${KEY}`, status(null, '2026-10-21T12:01:00Z')],
    ])
    const r = await verifyVitals({ project: testProject, key: pasted, options: testOptions(), io, fetch: f, ...clock() })
    expect(r).toEqual({ ok: true, detail: 'The app reported from a development build, and the project dropped it: it ignores development builds.' })
    expect(io.log.some((l) => l.startsWith('warn: This project ignores development builds') && l.includes('https://app.test/app/vitals'))).toBe(true)
  })

  it('an older Worker without /v1/status: the dashboard numbers when signed in', async () => {
    let reported = 0
    const f = fakeFetch([
      ['GET', `/v1/config/${KEY}`, { body: config(true) }],
      ['GET', '/api/vitals/projects/p1/overview', (c) => ({ body: { reported: c.url.includes('env=development') ? reported++ : 4 } })],
    ])
    const r = await verifyVitals({ project: testProject, key: signedIn, options: testOptions(), io: loggedIo(), fetch: f, ...clock() })
    expect(r).toEqual({ ok: true, detail: 'The first session arrived.' })
  })

  it('an older Worker and a pasted key: skipped, with the dashboard to look at', async () => {
    const io = loggedIo()
    const f = fakeFetch([['GET', `/v1/config/${KEY}`, { body: config(true) }]])
    expect(await verifyVitals({ project: testProject, key: pasted, options: testOptions(), io, fetch: f, ...clock() })).toEqual({
      ok: false,
      reason: 'skipped',
      detail: 'Not checked: look for the first session at https://app.test/app/vitals.',
    })
  })

  it('times out with the usual causes', async () => {
    const io = loggedIo()
    const f = fakeFetch([
      ['GET', `/v1/config/${KEY}`, { body: config(true) }],
      ['GET', `/v1/status/${KEY}`, status(null)],
    ])
    const r = await verifyVitals({ project: testProject, key: signedIn, options: testOptions(), io, fetch: f, ...clock() })
    expect(r).toEqual({ ok: false, reason: 'timeout', detail: 'No session in 3 minutes.' })
    expect(io.log.find((l) => l.startsWith('note (The usual causes'))).toContain('has not gone to the background')
    expect(io.log.at(-1)).toBe('info: The first session also shows on https://app.test/app/vitals/w1/p1/setup')
  })

  it('an unknown key is an error; an abort is a skip', async () => {
    const f = fakeFetch([
      ['GET', `/v1/config/${KEY}`, { status: 401, body: {} }],
      ['GET', `/v1/status/${KEY}`, { status: 401, body: { error: 'unknown or revoked key' } }],
    ])
    expect(reason(await verifyVitals({ project: testProject, key: pasted, options: testOptions(), io: loggedIo(), fetch: f, ...clock() }))).toBe('error')
    const ctl = new AbortController()
    const g = fakeFetch([
      ['GET', `/v1/config/${KEY}`, { body: config(true) }],
      ['GET', `/v1/status/${KEY}`, status(null)],
    ])
    const p = verifyVitals({ project: testProject, key: pasted, options: testOptions(), io: loggedIo(), fetch: g, signal: ctl.signal, pollMs: 50 })
    setTimeout(() => ctl.abort(), 20)
    expect(await p).toEqual({ ok: false, reason: 'skipped', detail: 'Stopped waiting.' })
  })
})
