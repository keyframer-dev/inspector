/**
 * Uploading a symbol set: PUT /v1/symbols/<kind>/<debugId>/<chunk> for each chunk (gzipped JSON), a
 * few at a time, then POST /v1/symbols/<kind>/<debugId>/manifest, so the set is visible only when
 * complete. Retries with backoff on network errors, 429 and 5xx; 401, 403 and 413 stop at once with
 * what to do about them.
 */
import { gzipSync } from 'node:zlib'
import type { SymbolSet } from './symbols'

/** A chunk over this many bytes gzipped is refused before it is sent (the Worker's limit too). */
export const MAX_CHUNK_GZIP = 256 * 1024

export type UploadOptions = {
  endpoint: string
  key: string
  concurrency?: number
  retries?: number
  /** Milliseconds before the first retry; doubled each time. */
  backoffMs?: number
  fetch?: typeof fetch
  log?: (line: string) => void
}

export class UploadError extends Error {}

export function gzipChunk(json: string): Buffer {
  return gzipSync(Buffer.from(json, 'utf8'), { level: 9 })
}

function explain(status: number, what: string, body: string): string {
  const detail = body.trim() ? `: ${body.trim().slice(0, 300)}` : ''
  if (status === 401 || status === 403) return `the upload key was refused (${status}) for ${what}. Use the project's CI upload key (kft_…) from the Motion Vitals dashboard, in --key or KEYFRAMER_VITALS_UPLOAD_KEY${detail}`
  if (status === 413) return `${what} is too large for the server (413)${detail}`
  return `${what} failed with ${status}${detail}`
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function send(url: string, init: RequestInit, what: string, o: UploadOptions): Promise<void> {
  const doFetch = o.fetch ?? fetch
  const retries = o.retries ?? 4
  let wait = o.backoffMs ?? 500
  for (let attempt = 0; ; attempt++) {
    let status = 0
    let body = ''
    let retryAfter = 0
    try {
      const res = await doFetch(url, init)
      if (res.ok) return
      status = res.status
      body = await res.text().catch(() => '')
      retryAfter = Number(res.headers.get('retry-after')) || 0
    } catch (e) {
      body = e instanceof Error ? e.message : String(e)
    }
    const retryable = status === 0 || status === 429 || status >= 500
    if (!retryable || attempt >= retries) {
      throw new UploadError(status === 0 ? `${what} could not reach ${new URL(url).origin}: ${body}` : explain(status, what, body))
    }
    o.log?.(`  retrying ${what} (${status || 'network error'})`)
    await sleep(Math.max(wait, retryAfter * 1000))
    wait *= 2
  }
}

export async function uploadSet(set: SymbolSet, o: UploadOptions): Promise<void> {
  const base = `${o.endpoint.replace(/\/+$/, '')}/v1/symbols/${encodeURIComponent(set.kind)}/${encodeURIComponent(set.debugId)}`
  const auth = { authorization: `Bearer ${o.key}` }
  const bodies = set.chunks.map((c) => ({ file: c.file, body: new Uint8Array(gzipChunk(c.json)) }))
  for (const b of bodies) {
    if (b.body.length > MAX_CHUNK_GZIP) throw new UploadError(`chunk ${b.file} is ${b.body.length} bytes gzipped, over the ${MAX_CHUNK_GZIP} byte limit`)
  }
  let next = 0
  const worker = async () => {
    while (next < bodies.length) {
      const b = bodies[next++]
      await send(`${base}/${encodeURIComponent(b.file)}`, { method: 'PUT', headers: { ...auth, 'content-type': 'application/json', 'content-encoding': 'gzip' }, body: b.body }, `chunk ${b.file} of ${set.kind} ${set.debugId}`, o)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(o.concurrency ?? 4, bodies.length)) }, worker))
  await send(`${base}/manifest`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: set.manifestJson }, `the manifest of ${set.kind} ${set.debugId}`, o)
}
