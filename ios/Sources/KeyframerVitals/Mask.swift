import Foundation

/// Screen names before they leave the device: the rules of the inspector's `maskText`
/// (react-native/src/redact.ts), in the same order, then cut to 64 characters. A view controller
/// type rarely carries data, but a name the app passes (`setScreen("Profile ada@example.com")`) can.
enum Mask {
    /// Applied in order: the specific shapes first, so a token is not half eaten by the number rule.
    private static let rules: [(NSRegularExpression, String)] = {
        let raw: [(String, NSRegularExpression.Options, String)] = [
            (#"([?&#](?:access_?token|refresh_?token|id_?token|token|key|api_?key|secret|password|passwd|pwd|code|auth|session|sig|signature)=)[^&\s#"']+"#, [.caseInsensitive], "$1[redacted]"),
            (#"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b"#, [.caseInsensitive], "[id]"),
            (#"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}"#, [.caseInsensitive], "[email]"),
            (#"\beyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]*"#, [], "[token]"),
            (#"\b(Bearer|Basic|Token)\s+[\w\-.~+/]{8,}=*"#, [.caseInsensitive], "$1 [token]"),
            (#"\b(?:kf|sk|pk|rk|ghp|gho|ghs|github_pat|xox[abpr]?|AKIA)[-_][\w-]{8,}"#, [], "[token]"),
            (#"\b(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[\w-]{24,}\b"#, [], "[token]"),
            (#"\+?\(?\d{1,4}\)?(?:[ .-]\(?\d{2,4}\)?){2,}"#, [], "[number]"),
            (#"\d{4,}"#, [], "[number]"),
        ]
        return raw.map { (try! NSRegularExpression(pattern: $0.0, options: $0.1), $0.2) }
    }()

    /// Replaces emails, long numbers, ids and tokens in `text`.
    static func maskText(_ text: String) -> String {
        var out = text
        for (re, template) in rules {
            out = re.stringByReplacingMatches(in: out, range: NSRange(out.startIndex..., in: out), withTemplate: template)
        }
        return out
    }

    /// A screen name as reported: masked, trimmed, at most 64 characters, never empty.
    static func screenName(_ raw: String) -> String {
        let masked = maskText(raw).trimmingCharacters(in: .whitespacesAndNewlines)
        let cut = String(masked.prefix(Vitals.screenNameLength))
        return cut.isEmpty ? "Unknown" : cut
    }
}
