/**
 * Test doubles for the steps that talk to the outside: a fetch that answers from a route table (and
 * keeps every call), and a WebSocket class whose instances a test drives by hand. Nothing here opens a
 * connection.
 */
import { scriptedIo, type Spinner } from './io'
import type { Project, WizardOptions } from './types'

export const testProject: Project = {
  root: '/work/shop',
  name: 'Acme Shop',
  pm: 'bun',
  expo: { sdk: 54 },
  reactNative: '0.81.0',
  navigation: 'expo-router',
  deps: {},
  babelConfig: null,
  entry: '/work/shop/app/_layout.tsx',
  monorepoRoot: null,
  git: { clean: true },
}

export const testOptions = (o: Partial<WizardOptions> = {}): WizardOptions => ({
  root: '/work/shop',
  products: ['inspector', 'vitals'],
  yes: false,
  inspectorView: null,
  vitalsKey: null,
  vitalsAuth: null,
  api: 'https://api.test',
  app: 'https://app.test',
  skipInstall: false,
  skipVerify: false,
  dryRun: false,
  agents: null,
  vitalsEndpoint: 'https://vitals.test',
  ...o,
})

export type FakeCall = { method: string; url: string; body: unknown; headers: Record<string, string> }
type Answer = { status?: number; body?: unknown } | Response
type Handler = Answer | ((call: FakeCall, nth: number) => Answer | Promise<Answer>)

/**
 * Routes are a method and a path (the whole pathname, or a prefix when it ends in /) or a RegExp on the
 * URL; the first match answers. Unmatched requests answer 404.
 */
export function fakeFetch(routes: Array<[string, string | RegExp, Handler]>) {
  const calls: FakeCall[] = []
  const counts = new Map<number, number>()
  const impl = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input)
    const method = (init.method ?? 'GET').toUpperCase()
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]))
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    const call = { method, url, body, headers }
    calls.push(call)
    const path = new URL(url).pathname
    const i = routes.findIndex(([m, p]) => m === method && (typeof p === 'string' ? path === p || (p.endsWith('/') && path.startsWith(p)) : p.test(url)))
    if (i < 0) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
    const n = counts.get(i) ?? 0
    counts.set(i, n + 1)
    const h = routes[i]![2]
    const a = typeof h === 'function' ? await h(call, n) : h
    if (a instanceof Response) return a
    return new Response(a.body === undefined ? null : JSON.stringify(a.body), { status: a.status ?? 200, headers: { 'content-type': 'application/json' } })
  }
  return Object.assign(impl as typeof fetch, { calls })
}

/** A WebSocket a test drives: `sockets` lists every one made; open, say and drop them from the test. */
export class FakeSocket {
  static sockets: FakeSocket[] = []
  static reset() {
    FakeSocket.sockets = []
  }
  readyState = 0
  sent: string[] = []
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  closed = false
  constructor(
    readonly url: string,
    readonly init?: { headers?: Record<string, string> },
  ) {
    FakeSocket.sockets.push(this)
  }
  send(data: string) {
    this.sent.push(data)
  }
  close() {
    this.closed = true
    this.readyState = 3
  }
  open() {
    this.readyState = 1
    this.onopen?.({})
  }
  say(data: unknown) {
    this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) })
  }
  drop(code?: number) {
    this.readyState = 3
    this.onclose?.({ code })
  }
}

/** Waits for the microtasks and a turn of timers to run. */
export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

/**
 * scriptedIo that also keeps one ordered transcript of what was said and asked (with the answer), for
 * reading a step the way the person would see it: `io.log.join('\n')`.
 */
export function loggedIo(answers: Parameters<typeof scriptedIo>[0] = [], opts: Parameters<typeof scriptedIo>[1] = {}) {
  const io = scriptedIo(answers, opts)
  const log: string[] = []
  const box = io as unknown as Record<string, (...a: unknown[]) => unknown>
  for (const kind of ['intro', 'outro', 'step', 'info', 'warn', 'success', 'error'] as const) {
    const say = box[kind]!
    box[kind] = (text: unknown) => {
      log.push(`${kind}: ${String(text)}`)
      return say(text)
    }
  }
  const note = box.note!
  box.note = (body: unknown, title: unknown) => {
    log.push(`note${title ? ` (${String(title)})` : ''}:\n  ${String(body).split('\n').join('\n  ')}`)
    return note(body, title)
  }
  for (const kind of ['select', 'multiselect', 'text', 'confirm'] as const) {
    const ask = box[kind]!
    box[kind] = async (message: unknown, ...rest: unknown[]) => {
      try {
        const v = await ask(message, ...rest)
        log.push(`ask: ${String(message)} → ${JSON.stringify(v)}`)
        return v
      } catch (e) {
        log.push(`ask: ${String(message)} → ${(e as Error).name}: ${(e as Error).message}`)
        throw e
      }
    }
  }
  const spinner = box.spinner!
  box.spinner = (message: unknown) => {
    log.push(`spinner: ${String(message)}`)
    const s = spinner(message) as Spinner
    return {
      update: (m: string) => s.update(m),
      stop: (m?: string, ok?: boolean) => {
        if (m) log.push(`spinner ${ok === false ? 'failed' : 'done'}: ${m}`)
        s.stop(m, ok)
      },
    }
  }
  const open = box.open!
  box.open = (url: unknown) => {
    log.push(`open: ${String(url)}`)
    return open(url)
  }
  return Object.assign(io, { log })
}
