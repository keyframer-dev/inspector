/**
 * Screen names before they leave the device. A route name can carry data (`/users/42`,
 * `Profile ada@example.com`): the same masks as the inspector's share links (`maskText` in
 * `react-native/src/redact.ts`, copied here; `mask.parity.test.ts` keeps them identical), then
 * cut to VITALS_LIMITS.screenName characters.
 */

import { VITALS_LIMITS } from '../../protocol/vitals'

/** Applied in order: the specific shapes first, so a token is not half eaten by the number rule. */
const MASKS: Array<[RegExp, string]> = [
  // Secrets passed in URLs: ?token=…, &password=…
  [/([?&#](?:access_?token|refresh_?token|id_?token|token|key|api_?key|secret|password|passwd|pwd|code|auth|session|sig|signature)=)[^&\s#"']+/gi, '$1[redacted]'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[id]'],
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]'],
  // JWTs
  [/\beyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]*/g, '[token]'],
  [/\b(Bearer|Basic|Token)\s+[\w\-.~+/]{8,}=*/gi, '$1 [token]'],
  // Prefixed keys: kf_…, sk-…, pk_live_…, ghp_…, xoxb-…
  [/\b(?:kf|sk|pk|rk|ghp|gho|ghs|github_pat|xox[abpr]?|AKIA)[-_][\w-]{8,}/g, '[token]'],
  // Any long run of letters AND digits (api keys, hashes, session ids)
  [/\b(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[\w-]{24,}\b/g, '[token]'],
  // Phone and card numbers written in groups (4111 1111 1111 1111, +1 (555) 123-4567)
  [/\+?\(?\d{1,4}\)?(?:[ .-]\(?\d{2,4}\)?){2,}/g, '[number]'],
  // Any other 4+ digit run: ids, amounts, codes
  [/\d{4,}/g, '[number]'],
]

/** Replaces emails, long numbers, ids and tokens in `text`. */
export function maskText(text: string): string {
  let out = text
  for (const [re, by] of MASKS) out = out.replace(re, by)
  return out
}

/** A screen name as it is sent: masked, trimmed, at most 64 characters, never empty. */
export function screenName(raw: unknown): string {
  const s = typeof raw === 'string' ? maskText(raw).trim() : ''
  if (!s) return 'unknown'
  return s.length > VITALS_LIMITS.screenName ? s.slice(0, VITALS_LIMITS.screenName) : s
}
