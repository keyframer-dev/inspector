/**
 * Signing in to keyframer.dev from the terminal: the device grant the Figma plugin and the inspector
 * panel use (apps/api/src/auth.ts). The wizard asks for a code, opens keyframer.dev/device where the
 * person approves it, polls, and gets a session token for `Authorization: Bearer`. Nothing is written
 * to disk.
 *
 * It signs in as the inspector's client (`keyframer-inspector`, allowed by the API's validateClient),
 * and the approval page words it as the setup wizard (`client=wizard`, apps/web device.tsx).
 */
import { Cancelled, NeedsAnswer, type Io } from './io'
import { requestJson, sleep as realSleep, trimUrl, type Fetch } from './http'

export const DEVICE_CLIENT_ID = 'keyframer-inspector'

export type SignInOptions = {
  api: string
  app: string
  io: Io
  fetch?: typeof fetch
  /** Stops waiting (Cancelled). */
  signal?: AbortSignal
  /**
   * The flag that stands in for signing in, named when no browser can be opened and nobody can be asked
   * (non-interactive): `--key` for Motion Vitals. Without it the wizard prints the link and waits.
   */
  flag?: string
  /** For tests: the wait between polls, and the clock the code expires on. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  now?: () => number
}

type Grant = { device_code: string; user_code: string; verification_uri: string; verification_uri_complete?: string; expires_in?: number; interval?: number }
type TokenAnswer = { access_token?: string; error?: string }

/** Who a session token belongs to: the account's email (or name), false when the API refuses it, null when it could not be asked. */
export async function sessionUser(api: string, token: string, fetchImpl: Fetch = fetch): Promise<string | false | null> {
  const res = await requestJson<{ user?: { email?: string; name?: string } } | null>(fetchImpl, `${trimUrl(api)}/api/auth/get-session`, { token })
  if (res.status === 0 || res.status >= 500) return null
  if (res.status !== 200) return false
  const user = res.data?.user
  return user ? (user.email ?? user.name ?? 'your account') : false
}

/** The session token, once approved in the browser. Throws when it is denied or the code expires. */
export async function signIn(opts: SignInOptions): Promise<string> {
  const { io, signal } = opts
  const fetchImpl = opts.fetch ?? fetch
  const sleep = opts.sleep ?? realSleep
  const now = opts.now ?? Date.now
  const api = trimUrl(opts.api)

  const start = await requestJson<Grant>(fetchImpl, `${api}/api/auth/device/code`, { method: 'POST', body: { client_id: DEVICE_CLIENT_ID }, signal })
  if (!start.data) {
    throw new Error(start.status === 0 ? `Couldn't reach ${api} to sign in (${start.error}).` : `Couldn't start signing in: ${api} answered ${start.status}.`)
  }
  const grant = start.data
  const page = grant.verification_uri_complete ?? `${grant.verification_uri}?user_code=${encodeURIComponent(grant.user_code)}`
  const url = `${page}${page.includes('?') ? '&' : '?'}client=wizard`

  io.note(`${grant.user_code}\n\nCheck that the page shows this code, then approve it.`, 'Your sign-in code')
  const opened = await io.open(url)
  if (!opened) {
    if (!io.interactive && opts.flag) throw new NeedsAnswer('Signing in needs a browser, and none could be opened', opts.flag)
    io.info(`Open this link in a browser where you're signed in to Keyframer: ${url}`)
  }

  const spin = io.spinner('Waiting for you to approve the code in the browser')
  const deadline = now() + (grant.expires_in ?? 600) * 1000
  let interval = (grant.interval ?? 5) * 1000
  let token: string | null = null
  try {
    while (!token) {
      if (now() >= deadline) throw new Error('The sign-in code expired. Run the wizard again for a new one.')
      await sleep(interval, signal)
      const poll = await requestJson<TokenAnswer>(fetchImpl, `${api}/api/auth/device/token`, {
        method: 'POST',
        body: { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: grant.device_code, client_id: DEVICE_CLIENT_ID },
        signal,
      })
      // Offline for a moment: keep polling until the code expires.
      if (poll.status === 0 || poll.status >= 500) continue
      if (poll.data?.access_token) {
        token = poll.data.access_token
        break
      }
      // A refused poll comes back as 400 with the reason, which requestJson keeps in `error`.
      const reason = poll.error
      if (reason === 'authorization_pending') continue
      if (reason === 'slow_down') {
        interval += 5000
        continue
      }
      if (reason === 'access_denied') throw new Error('Signing in was denied in the browser.')
      if (reason === 'expired_token') throw new Error('The sign-in code expired. Run the wizard again for a new one.')
      throw new Error(`Signing in to Keyframer failed (${reason ?? poll.status}).`)
    }
  } catch (e) {
    spin.stop(e instanceof Cancelled ? 'Stopped signing in' : (e as Error).message, false)
    throw e
  }

  const who = await sessionUser(api, token, fetchImpl)
  if (who === false) {
    spin.stop('keyframer.dev did not accept the new session', false)
    throw new Error("keyframer.dev didn't accept the session it just gave out. Try signing in again.")
  }
  spin.stop(who ? `Signed in as ${who}` : 'Signed in', true)
  return token
}
