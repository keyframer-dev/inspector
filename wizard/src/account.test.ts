import { describe, expect, it } from 'vitest'
import { DEVICE_CLIENT_ID, signIn } from './account'
import { fakeFetch, loggedIo } from './fakes'
import { Cancelled, NeedsAnswer } from './io'

const API = 'https://api.test'
const APP = 'https://app.test'
const grant = { device_code: 'dev-1', user_code: 'ABCD1234', verification_uri: `${APP}/device`, verification_uri_complete: `${APP}/device?user_code=ABCD1234`, expires_in: 600, interval: 3 }
const session = { status: 200, body: { user: { email: 'ada@example.com' }, session: { id: 's' } } }

/** Answers the token polls in order (the last one repeats). */
function device(polls: Array<{ status: number; body: unknown }>, getSession: { status: number; body: unknown } = session) {
  return fakeFetch([
    ['POST', '/api/auth/device/code', { body: grant }],
    ['POST', '/api/auth/device/token', (_c, n) => polls[Math.min(n, polls.length - 1)]!],
    ['GET', '/api/auth/get-session', getSession],
  ])
}
const pending = { status: 400, body: { error: 'authorization_pending' } }
const approved = { status: 200, body: { access_token: 'tok_123', token_type: 'Bearer' } }

function clock() {
  let t = 0
  const waits: number[] = []
  return { now: () => t, sleep: async (ms: number) => void (waits.push(ms), (t += ms)), waits }
}

describe('signIn', () => {
  it('shows the code, opens the approval page, polls until approved and checks the session', async () => {
    const f = device([pending, pending, approved])
    const io = loggedIo()
    const c = clock()
    expect(await signIn({ api: API, app: APP, io, fetch: f, ...c })).toBe('tok_123')
    expect(f.calls[0]!.body).toEqual({ client_id: DEVICE_CLIENT_ID })
    expect(f.calls.filter((x) => x.url.endsWith('/device/token'))).toHaveLength(3)
    expect(f.calls.at(-1)!.headers.authorization).toBe('Bearer tok_123')
    expect(c.waits).toEqual([3000, 3000, 3000])
    expect(io.log).toContain(`open: ${APP}/device?user_code=ABCD1234&client=wizard`)
    expect(io.log.join('\n')).toContain('ABCD1234')
    expect(io.log.at(-1)).toBe('spinner done: Signed in as ada@example.com')
  })

  it('waits 5 s longer after each slow_down', async () => {
    const c = clock()
    await signIn({ api: API, app: APP, io: loggedIo(), fetch: device([{ status: 400, body: { error: 'slow_down' } }, { status: 400, body: { error: 'slow_down' } }, approved]), ...c })
    expect(c.waits).toEqual([3000, 8000, 13000])
  })

  it('keeps polling through a network error or a 5xx', async () => {
    const f = fakeFetch([
      ['POST', '/api/auth/device/code', { body: grant }],
      ['POST', '/api/auth/device/token', (_c, n) => (n === 0 ? Promise.reject(new Error('offline')) : n === 1 ? { status: 502 } : approved)],
      ['GET', '/api/auth/get-session', session],
    ])
    expect(await signIn({ api: API, app: APP, io: loggedIo(), fetch: f, ...clock() })).toBe('tok_123')
  })

  it('denied in the browser', async () => {
    const io = loggedIo()
    await expect(signIn({ api: API, app: APP, io, fetch: device([pending, { status: 400, body: { error: 'access_denied' } }]), ...clock() })).rejects.toThrow('Signing in was denied in the browser.')
    expect(io.log.at(-1)).toBe('spinner failed: Signing in was denied in the browser.')
  })

  it('expired: by the server, or by the clock', async () => {
    await expect(signIn({ api: API, app: APP, io: loggedIo(), fetch: device([{ status: 400, body: { error: 'expired_token' } }]), ...clock() })).rejects.toThrow('The sign-in code expired.')
    await expect(signIn({ api: API, app: APP, io: loggedIo(), fetch: device([pending]), ...clock() })).rejects.toThrow('The sign-in code expired.')
  })

  it('a session the API refuses afterwards is an error', async () => {
    await expect(signIn({ api: API, app: APP, io: loggedIo(), fetch: device([approved], { status: 401, body: null }), ...clock() })).rejects.toThrow("didn't accept the session")
  })

  it('cancel: the abort signal stops the wait', async () => {
    const ctl = new AbortController()
    const io = loggedIo()
    const p = signIn({ api: API, app: APP, io, fetch: device([pending]), signal: ctl.signal })
    setTimeout(() => ctl.abort(), 20)
    await expect(p).rejects.toBeInstanceOf(Cancelled)
    expect(io.log.at(-1)).toBe('spinner failed: Stopped signing in')
  })

  it('no browser: prints the link, or names the flag when nobody can be asked', async () => {
    const io = loggedIo([], { open: () => false })
    await signIn({ api: API, app: APP, io, fetch: device([approved]), ...clock() })
    expect(io.log.some((l) => l.startsWith('info: Open this link'))).toBe(true)
    const quiet = loggedIo([], { interactive: false, open: () => false })
    const err = await signIn({ api: API, app: APP, io: quiet, fetch: device([approved]), flag: '--key', ...clock() }).catch((e) => e)
    expect(err).toBeInstanceOf(NeedsAnswer)
    expect(err.flag).toBe('--key')
  })

  it('says so when the API cannot start a grant', async () => {
    const f = fakeFetch([['POST', '/api/auth/device/code', { status: 400, body: { error: 'invalid_client' } }]])
    await expect(signIn({ api: API, app: APP, io: loggedIo(), fetch: f })).rejects.toThrow('answered 400')
  })
})
