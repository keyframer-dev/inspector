// Screen names and Hero tags can carry data (`/users/42`, `Profile ada@example.com`). Before one leaves
// the device it goes through the same rules as the inspector's redaction (react-native/src/redact.ts
// maskText), in the same order, and is cut to 64 characters.

import 'protocol.dart';

final List<(RegExp, String Function(Match))> _masks = [
  // Secrets passed in URLs: ?token=…, &password=…
  (
    RegExp(
      r'''([?&#](?:access_?token|refresh_?token|id_?token|token|key|api_?key|secret|password|passwd|pwd|code|auth|session|sig|signature)=)[^&\s#"']+''',
      caseSensitive: false,
    ),
    (m) => '${m[1]}[redacted]',
  ),
  (RegExp(r'\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b', caseSensitive: false), (_) => '[id]'),
  (RegExp(r'[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}', caseSensitive: false), (_) => '[email]'),
  // JWTs
  (RegExp(r'\beyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]*'), (_) => '[token]'),
  (RegExp(r'\b(Bearer|Basic|Token)\s+[\w\-.~+/]{8,}=*', caseSensitive: false), (m) => '${m[1]} [token]'),
  // Prefixed keys: kf_…, sk-…, pk_live_…, ghp_…, xoxb-…
  (RegExp(r'\b(?:kf|sk|pk|rk|ghp|gho|ghs|github_pat|xox[abpr]?|AKIA)[-_][\w-]{8,}'), (_) => '[token]'),
  // Any long run of letters AND digits (api keys, hashes, session ids)
  (RegExp(r'\b(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[\w-]{24,}\b'), (_) => '[token]'),
  // Phone and card numbers written in groups
  (RegExp(r'\+?\(?\d{1,4}\)?(?:[ .-]\(?\d{2,4}\)?){2,}'), (_) => '[number]'),
  // Any other 4+ digit run: ids, amounts, codes
  (RegExp(r'\d{4,}'), (_) => '[number]'),
];

/// Replaces emails, long numbers, ids and tokens in `text` (redact.ts `maskText`).
String maskText(String text) {
  var out = text;
  for (final (re, by) in _masks) {
    out = out.replaceAllMapped(re, by);
  }
  return out;
}

/// `text` cut to `max` UTF-16 units, never in the middle of a surrogate pair.
String cut(String text, [int max = vitalsScreenNameMax]) {
  if (text.length <= max) return text;
  var end = max;
  final last = text.codeUnitAt(end - 1);
  if (last >= 0xD800 && last <= 0xDBFF) end -= 1;
  return text.substring(0, end);
}

/// A screen name as it may leave the device: masked, trimmed, at most 64 characters, never empty.
String screenName(String name) {
  final masked = cut(maskText(name).trim());
  return masked.isEmpty ? '(unnamed)' : masked;
}

/// A Hero tag as a site name: masked like a screen name, and every remaining number made `#`, so
/// `avatar-42` and `avatar-43` are one site, not one per item.
String heroName(Object tag) => cut('Hero(${maskText('$tag').replaceAll(RegExp(r'\d+'), '#')})', 160);
