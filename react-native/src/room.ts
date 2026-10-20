/**
 * The pairing room, as pure functions: room codes, the URL every party connects to, and the relay
 * rules the API's InspectorRoom Durable Object applies. Kept free of Workers and React Native APIs
 * so the editor, the app, the cli and the API share one implementation and it can be unit tested.
 *
 *   app    → editors          (hello, events, samples, time)
 *   editor → app              (overrides, replay, record, playback, time)
 *   editor → cli              (apply)
 *   cli    → editors          (hello, applied)
 *   room   → everyone         (presence, on every join and leave)
 */

import type { InspectorPresenceMessage, InspectorRole } from '../../protocol/inspector'

/** No 0/O, 1/I: codes are read off one screen and typed into another. */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const ROOM_CODE_LENGTH = 6
/** Messages above this are dropped by the room. */
export const MAX_MESSAGE_BYTES = 256 * 1024
export const INSPECTOR_ROLES: readonly InspectorRole[] = ['app', 'editor', 'cli']

export function isRoomCode(code: string): boolean {
  if (code.length !== ROOM_CODE_LENGTH) return false
  for (const ch of code) if (!ROOM_CODE_ALPHABET.includes(ch)) return false
  return true
}

export function isInspectorRole(role: unknown): role is InspectorRole {
  return typeof role === 'string' && (INSPECTOR_ROLES as readonly string[]).includes(role)
}

export function randomRoomCode(random: () => number = Math.random): string {
  let code = ''
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += ROOM_CODE_ALPHABET[Math.floor(random() * ROOM_CODE_ALPHABET.length)]
  return code
}

/** `http(s)://api` → `ws(s)://api/inspector/rooms/<code>/ws?role=<role>`. */
export function inspectorRoomUrl(apiUrl: string, code: string, role: InspectorRole): string {
  const base = apiUrl.replace(/\/+$/, '').replace(/^http(s?):\/\//, (_m, s: string) => `ws${s}://`)
  return `${base}/inspector/rooms/${encodeURIComponent(code)}/ws?role=${role}`
}

/** Which message types each role may send, and to whom they go. */
const ROUTES: Record<InspectorRole, Record<string, InspectorRole[]>> = {
  // `time` both ways: an editor sets the app's animation speed, and the app answers with the speed it runs at.
  app: { hello: ['editor'], events: ['editor'], samples: ['editor'], scenarios: ['editor'], scenarioDone: ['editor'], frame: ['editor'], recording: ['editor'], time: ['editor'] },
  editor: {
    overrides: ['app'],
    replay: ['app'],
    record: ['app'],
    playback: ['app'],
    capture: ['app'],
    scenario: ['app'],
    scrub: ['app'],
    time: ['app'],
    apply: ['cli'],
    source: ['cli'],
    hello: [],
  },
  cli: { hello: ['editor'], applied: ['editor'], sources: ['editor'] },
}

/**
 * Where a message from `from` goes, or null to drop it: too large, not JSON, no `type`, or a type
 * that role does not send. The payload is forwarded byte for byte, never re-serialised.
 */
export function routeMessage(from: InspectorRole, raw: string): InspectorRole[] | null {
  if (byteLength(raw) > MAX_MESSAGE_BYTES) return null
  let type: unknown
  try {
    type = (JSON.parse(raw) as { type?: unknown })?.type
  } catch {
    return null
  }
  if (typeof type !== 'string') return null
  return ROUTES[from][type] ?? null
}

export function presenceMessage(roles: InspectorRole[]): InspectorPresenceMessage {
  return {
    type: 'presence',
    app: roles.includes('app'),
    editors: roles.filter((r) => r === 'editor').length,
    cli: roles.includes('cli'),
  }
}

/** Close code an editor gets when the room belongs to another account: the code is in use. */
export const ROOM_TAKEN = 4003
/** A claimed room frees itself after this long without its owner, so codes are not held forever. */
export const ROOM_CLAIM_TTL_MS = 24 * 60 * 60 * 1000

export type RoomClaim = { userId: string; lastSeen: number }

/**
 * Who may join a room as an editor. The first signed-in editor claims it, and from then on only that
 * account can: the editor is the side that pushes overrides into the app and edits through the cli
 * onto disk, so a guessed or leaked code must not let another account do either. The owner may open
 * any number of tabs. A claim lapses once its owner has been gone for ROOM_CLAIM_TTL_MS.
 */
export function claimRoom(
  claim: RoomClaim | undefined,
  userId: string,
  now: number,
  ownerConnected: boolean,
): { ok: boolean; claim: RoomClaim } {
  if (!claim || claim.userId === userId) return { ok: true, claim: { userId, lastSeen: now } }
  if (!ownerConnected && now - claim.lastSeen > ROOM_CLAIM_TTL_MS) return { ok: true, claim: { userId, lastSeen: now } }
  return { ok: false, claim }
}

/** Roles that keep a single connection: a new app or cli replaces the one already in the room. */
export function replacesExisting(role: InspectorRole): boolean {
  return role === 'app' || role === 'cli'
}

/**
 * What the room keeps for an editor that joins after the app said hello (an agent's MCP server, a
 * second tab): the app's last hello, and its last `time` answer, which goes right after it. A new
 * hello clears the `time` answer (a reloaded app is back at 1x); the app leaving clears both. The
 * desktop relay and the Metro channel keep the same two.
 */
export type LateEditorCache = { hello?: string; time?: string }

/** The cache after a message from `from`, or null when the message does not change it (most do not). */
export function cacheForLateEditors(cache: LateEditorCache, from: InspectorRole, raw: string): LateEditorCache | null {
  // Samples and events are most of the traffic: only a message that can be a hello or a time is parsed.
  if (from !== 'app' || !/"type"\s*:\s*"(?:hello|time)"/.test(raw)) return null
  let msg: { type?: unknown; role?: unknown }
  try {
    msg = JSON.parse(raw) as { type?: unknown; role?: unknown }
  } catch {
    return null
  }
  if (msg.type === 'hello' && msg.role === 'app') return { hello: raw }
  if (msg.type === 'time' && cache.hello) return { ...cache, time: raw }
  return null
}

/** What a joining editor is sent, in order. */
export function lateEditorMessages(cache: LateEditorCache): string[] {
  return cache.hello ? [cache.hello, ...(cache.time ? [cache.time] : [])] : []
}

function byteLength(s: string): number {
  // UTF-8 length without TextEncoder allocation for the common ASCII case.
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4
      i++
    } else n += 3
  }
  return n
}

/**
 * Keep-alive. A room can drop a socket without the other end ever hearing about it (the API restarts,
 * a laptop sleeps, a network changes), and that end then sits "connected" to nothing. Every client
 * sends PING on an interval; the room answers PONG on its own (auto-response, no wake-up). Any message
 * counts as a sign of life, and a client that hears nothing for HEARTBEAT_TIMEOUT_MS reconnects.
 */
export const PING = 'ping'
export const PONG = 'pong'
export const HEARTBEAT_INTERVAL_MS = 10_000
export const HEARTBEAT_TIMEOUT_MS = 25_000
