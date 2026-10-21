/**
 * The little the steps share for talking to keyframer.dev: JSON requests through the injected fetch
 * (tests never reach the network), and a sleep that an abort signal cuts short.
 */
import { Cancelled } from './io'

export type Fetch = typeof fetch

export const trimUrl = (url: string) => url.replace(/\/+$/, '')

/** A response read as JSON: `status` 0 when the server could not be reached. */
export type JsonResult<T> = { status: number; data: T | null; error: string | null }

export async function requestJson<T>(
  fetchImpl: Fetch,
  url: string,
  init: { method?: string; token?: string | null; body?: unknown; signal?: AbortSignal } = {},
): Promise<JsonResult<T>> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (init.token) headers.Authorization = `Bearer ${init.token}`
  if (init.body !== undefined) headers['Content-Type'] = 'application/json'
  let res: Response
  try {
    res = await fetchImpl(url, { method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body), signal: init.signal })
  } catch (e) {
    if (init.signal?.aborted) throw new Cancelled()
    return { status: 0, data: null, error: (e as Error).message }
  }
  const data = (await res.json().catch(() => null)) as T | null
  const error = res.ok ? null : (((data as { error?: unknown } | null)?.error as string | undefined) ?? `${res.status}`)
  return { status: res.status, data: res.ok ? data : null, error: typeof error === 'string' ? error : String(error) }
}

/** Waits `ms`; an abort ends it at once with Cancelled. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Cancelled())
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(new Cancelled())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** "3:00", "0:45": what is left of a wait. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
