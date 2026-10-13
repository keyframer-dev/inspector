/**
 * Share links for recordings: upload one to keyframer.dev and send a link instead of a .kfrec.json
 * file. The same rules on both sides: the panel and the device upload with uploadRecording, the API
 * (apps/api/src/routes/inspectorRecordings.ts) checks with checkRecording and summarizeRecording.
 *
 *   POST   /inspector/recordings          the JSON (application/json) or gzipped (application/gzip),
 *                                         Authorization: Bearer <session token or kf_ key>
 *   GET    /inspector/recordings          the caller's own, newest first
 *   GET    /inspector/recordings/:id      the recording's JSON, for anyone with the id, until it expires
 *   GET    /inspector/recordings/:id/meta what the page shows before loading it
 *   DELETE /inspector/recordings/:id      its owner only
 *
 * Redact first (./redact): nothing in here takes anything out.
 */

import type { InspectorRecording, InspectorSharedRecording } from '../../protocol/inspector'

export type { InspectorSharedRecording } from '../../protocol/inspector'

export const DEFAULT_SHARE_API = 'https://api.keyframer.dev'

export const SHARE_LIMITS = {
  /** The recording's JSON, before compression. */
  maxJsonBytes: 20 * 1024 * 1024,
  defaultExpiryDays: 30,
  maxExpiryDays: 30,
} as const

/** The recording, checked enough to be stored and opened later, or why it is not one. */
export function checkRecording(value: unknown): InspectorRecording | string {
  const rec = value as Partial<InspectorRecording> | null
  if (!rec || typeof rec !== 'object') return 'not_a_recording'
  if (rec.format !== 'keyframer-recording') return 'not_a_recording'
  if (rec.version !== 1) return 'unsupported_version'
  if (!rec.app || typeof rec.app.name !== 'string' || typeof rec.app.platform !== 'string') return 'missing_app'
  for (const k of ['signals', 'samples', 'frames', 'drops', 'anims', 'commits', 'markers', 'screenshots'] as const) {
    if (!Array.isArray(rec[k])) return `missing_${k}`
  }
  return rec as InspectorRecording
}

/** What the API keeps about a recording beside the file (short strings: they are listed and shown). */
export function summarizeRecording(rec: InspectorRecording): { app: string; platform: string; framework: string | null; durationMs: number } {
  const clip = (s: string, n: number) => s.trim().slice(0, n)
  const duration = Number(rec.duration)
  return {
    app: clip(rec.app.name, 80) || 'app',
    platform: clip(rec.app.platform, 24) || 'unknown',
    framework: rec.app.framework ? clip(String(rec.app.framework), 32) : null,
    durationMs: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : 0,
  }
}

/** An expiry in days, as asked (`?expires=`), clamped to what is allowed. */
export function expiryDays(asked: unknown): number {
  const n = Math.floor(Number(asked))
  if (!Number.isFinite(n) || n < 1) return SHARE_LIMITS.defaultExpiryDays
  return Math.min(SHARE_LIMITS.maxExpiryDays, n)
}

/** A link id: 128 random bits, base64url (22 characters). Unguessable is the whole access check. */
export function newRecordingId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export const isRecordingId = (id: string) => /^[A-Za-z0-9_-]{22}$/.test(id)

export type ShareError = 'sign_in' | 'too_large' | 'rate_limited' | 'not_a_recording' | 'network' | 'server'

export class ShareFailed extends Error {
  constructor(
    readonly code: ShareError,
    message: string,
  ) {
    super(message)
  }
}

const MESSAGES: Record<ShareError, string> = {
  sign_in: 'Sign in again: the API did not accept this account.',
  too_large: 'The recording is over 20 MB. Drop the screenshots or share a shorter one.',
  rate_limited: 'Too many links for now. Try again later.',
  not_a_recording: 'The API did not accept this as a recording.',
  network: 'Could not reach the Keyframer API.',
  server: 'The upload failed.',
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string | Uint8Array | ArrayBuffer }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

/** Gzips when the platform can (browsers, Node): recordings with screenshots shrink a lot less than ones without, but always some. */
async function gzip(text: string): Promise<Uint8Array | null> {
  const CS = (globalThis as { CompressionStream?: new (format: string) => unknown }).CompressionStream
  const B = (globalThis as { Blob?: new (parts: string[]) => { stream?: () => { pipeThrough(t: unknown): unknown } } }).Blob
  const R = (globalThis as { Response?: new (body: unknown) => { arrayBuffer(): Promise<ArrayBuffer> } }).Response
  if (!CS || !B || !R) return null
  try {
    const blob = new B([text])
    if (!blob.stream) return null
    return new Uint8Array(await new R(blob.stream().pipeThrough(new CS('gzip'))).arrayBuffer())
  } catch {
    return null
  }
}

/** Uploads a (redacted) recording; resolves with its link. */
export async function uploadRecording(
  recording: InspectorRecording | string,
  opts: { apiUrl?: string; token: string; expiresInDays?: number; fetch?: FetchLike },
): Promise<InspectorSharedRecording> {
  const json = typeof recording === 'string' ? recording : JSON.stringify(recording)
  if (json.length > SHARE_LIMITS.maxJsonBytes) throw new ShareFailed('too_large', MESSAGES.too_large)
  const api = (opts.apiUrl ?? DEFAULT_SHARE_API).replace(/\/+$/, '')
  const gz = await gzip(json)
  const doFetch = opts.fetch ?? (globalThis.fetch as unknown as FetchLike)
  const expires = opts.expiresInDays ? `?expires=${expiryDays(opts.expiresInDays)}` : ''
  let res: Awaited<ReturnType<FetchLike>>
  try {
    res = await doFetch(`${api}/inspector/recordings${expires}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.token}`, 'Content-Type': gz ? 'application/gzip' : 'application/json' },
      body: gz ?? json,
    })
  } catch {
    throw new ShareFailed('network', MESSAGES.network)
  }
  const body = (await res.json().catch(() => null)) as (InspectorSharedRecording & { error?: string }) | null
  if (res.ok && body?.url) return body
  const code: ShareError =
    res.status === 401 ? 'sign_in' : res.status === 413 ? 'too_large' : res.status === 429 ? 'rate_limited' : res.status === 400 ? 'not_a_recording' : 'server'
  throw new ShareFailed(code, MESSAGES[code])
}
