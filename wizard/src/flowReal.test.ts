/**
 * The wizard end to end with the real account, Vitals key, desktop, agents and verify steps, talking
 * to fakes.ts's fake fetch and sockets: nothing leaves the machine, no command runs, no port is bound.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { main } from './cli'
import type { Run } from './exec'
import { FakeSocket, fakeFetch, loggedIo, tick } from './fakes'
import type { SocketCtor } from './socket'
import { copyFixture } from './testFixtures'
import { packDevtools } from './verify'

const KEY = 'kfp_live_A1b2C3d4E5f6G7h8I9j0K1l2'
const Socket = FakeSocket as unknown as SocketCtor
const config = { enabled: true, sampleRate: 0.1, collect: { reduceMotion: false, deviceModel: true, development: true }, ttlSec: 86400 }
const hello = { type: 'hello', role: 'app', app: 'Tabs App', platform: 'ios', osVersion: '18.2', device: { name: 'iPhone 16 Pro', simulator: true }, sdk: { name: '@keyframerdev/inspector', version: '0.2.1' }, protocol: 1 }

/** Installs that run nothing. */
const run: Run = async () => ({ code: 0, stdout: '', stderr: '' })

/** Waits until a socket to `url` exists. */
async function socketTo(url: string): Promise<FakeSocket> {
  for (let i = 0; i < 400; i++) {
    const s = FakeSocket.sockets.find((x) => x.url === url && !x.closed)
    if (s) return s
    await tick(5)
  }
  throw new Error(`no socket to ${url}`)
}

beforeEach(() => FakeSocket.reset())

describe('end to end, with the real steps', () => {
  it("expo-router, Expo dev tools: the key checked, the agents' config written, the app's hello over Metro, the first session", async () => {
    const dir = copyFixture('expo-router', { expoSdk: 57 })
    const sessions = { at: null as string | null }
    const f = fakeFetch([
      ['GET', `/v1/config/${KEY}`, { body: config }],
      ['GET', `/v1/status/${KEY}`, () => ({ body: { lastSessionAt: sessions.at, developmentDroppedAt: null } })],
    ])
    const io = loggedIo([], { interactive: false })
    const done = main(['--yes', '--products', 'inspector,vitals', '--key', KEY, '--view', 'devtools', '--metro', 'http://localhost:8081', '--agents', 'claude-code', '--root', dir], {
      io,
      run,
      fetch: f,
      WebSocket: Socket,
      platform: 'darwin',
      verifyTimeoutMs: 10_000,
    })
    // The app reloads and says hello on Metro's broadcast socket.
    const metro = await socketTo('ws://localhost:8081/expo-dev-plugins/broadcast')
    metro.open()
    metro.say(packDevtools(hello as never))
    // Then goes to the background, and its first session arrives.
    sessions.at = new Date().toISOString()
    expect(await done).toBe(0)
    const log = io.log.join('\n')
    expect(log).toContain('success: Inspector: Hello from Tabs App on iOS 18.2, iPhone 16 Pro (simulator), @keyframerdev/inspector 0.2.1')
    expect(log).toContain('success: Motion Vitals: The first session arrived')
    expect(log).toContain('Send the app to the background')
    const mcp = JSON.parse(readFileSync(path.join(dir, '.mcp.json'), 'utf8'))
    expect(mcp.mcpServers['keyframer-inspector'].args).toEqual(expect.arrayContaining(['@keyframerdev/inspector', 'mcp']))
    expect(existsSync(path.join(dir, 'keyframer.ts'))).toBe(true)
    // Only the fakes were asked: the Vitals Worker, and Metro's /status (which project it serves).
    expect(f.calls.every((c) => c.url.startsWith('https://vitals.keyframer.dev/') || /^http:\/\/[^/]+\/status$/.test(c.url))).toBe(true)
  })

  it('bare React Native, the desktop app: its relay found running, the app joins it', async () => {
    const dir = copyFixture('react-navigation')
    const f = fakeFetch([['GET', /127\.0\.0\.1:8790\/api\/apps/, { body: { apps: [] } }]])
    const io = loggedIo([], { interactive: false })
    const done = main(['--yes', '--products', 'inspector', '--view', 'desktop', '--no-agents', '--root', dir], { io, run, fetch: f, WebSocket: Socket, platform: 'darwin', verifyTimeoutMs: 10_000 })
    const relay = await socketTo('ws://127.0.0.1:8790/editor')
    relay.open()
    relay.say({ type: 'apps', apps: [{ id: 'a1', name: 'NavApp', platform: 'ios', address: '127.0.0.1', connectedAt: 1, editors: 1 }], attached: 'a1', mode: 'auto' })
    relay.say({ ...hello, app: 'NavApp' })
    expect(await done).toBe(0)
    const log = io.log.join('\n')
    expect(log).toContain('Keyframer Inspector is running')
    expect(log).toContain('success: Inspector: Hello from NavApp on iOS 18.2')
    expect(readFileSync(path.join(dir, 'keyframer.ts'), 'utf8')).toContain("connectInspector({apiUrl: 'http://127.0.0.1:8790', code: 'DESKTOP', app: 'NavApp'})")
  })

  it('Vitals without --key, unattended: it does not try to sign in, and names --key (exit 2)', async () => {
    const dir = copyFixture('expo-blank')
    const io = loggedIo([], { interactive: false })
    const code = await main(['--yes', '--products', 'vitals', '--no-agents', '--skip-verify', '--root', dir], { io, run, fetch: fakeFetch([]), platform: 'darwin' })
    expect(code).toBe(2)
    expect(io.log.join('\n')).toContain('--key')
    expect(io.log.join('\n')).not.toContain('Waiting for you to approve')
  })

  it('Vitals with --auth browser, and a sign-in that fails: a clear message naming --key, exit 1', async () => {
    const dir = copyFixture('expo-blank')
    const io = loggedIo([], { interactive: false })
    const code = await main(['--yes', '--products', 'vitals', '--auth', 'browser', '--no-agents', '--skip-verify', '--root', dir], { io, run, fetch: fakeFetch([]), platform: 'darwin' })
    // The API (here, a fake that knows nothing) refuses to start the sign-in.
    expect(code).toBe(1)
    expect(io.log.join('\n')).toContain("error: Couldn't get a Motion Vitals key: Couldn't start signing in")
    expect(io.log.join('\n')).toContain('run the wizard again with --key kfp_live_…')
    expect(io.log.join('\n')).toContain('outro: Nothing was changed.')
  })
})
