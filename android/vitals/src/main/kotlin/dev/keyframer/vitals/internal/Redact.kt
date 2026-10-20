package dev.keyframer.vitals.internal

/**
 * Screen names before they leave the device: the inspector's `maskText` rules
 * (react-native/src/redact.ts, same patterns in the same order), then cut to 64 characters.
 */
internal object Redact {
    private val MASKS: List<Pair<Regex, String>> = listOf(
        Regex("([?&#](?:access_?token|refresh_?token|id_?token|token|key|api_?key|secret|password|passwd|pwd|code|auth|session|sig|signature)=)[^&\\s#\"']+", RegexOption.IGNORE_CASE) to "$1[redacted]",
        Regex("\\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\b", RegexOption.IGNORE_CASE) to "[id]",
        Regex("[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}", RegexOption.IGNORE_CASE) to "[email]",
        Regex("\\beyJ[\\w-]{4,}\\.[\\w-]{4,}\\.[\\w-]*") to "[token]",
        Regex("\\b(Bearer|Basic|Token)\\s+[\\w\\-.~+/]{8,}=*", RegexOption.IGNORE_CASE) to "$1 [token]",
        Regex("\\b(?:kf|sk|pk|rk|ghp|gho|ghs|github_pat|xox[abpr]?|AKIA)[-_][\\w-]{8,}") to "[token]",
        Regex("\\b(?=[\\w-]*\\d)(?=[\\w-]*[A-Za-z])[\\w-]{24,}\\b") to "[token]",
        Regex("\\+?\\(?\\d{1,4}\\)?(?:[ .-]\\(?\\d{2,4}\\)?){2,}") to "[number]",
        Regex("\\d{4,}") to "[number]",
    )

    fun maskText(text: String): String {
        var out = text
        for ((re, by) in MASKS) out = re.replace(out, by)
        return out
    }

    /** A screen name as reports carry it: masked, trimmed, at most 64 characters, never empty. */
    fun screenName(raw: String): String {
        val masked = maskText(raw).trim()
        var end = minOf(masked.length, VitalsProtocol.SCREEN_NAME)
        // Never half of a surrogate pair (an emoji at the cut).
        if (end < masked.length && end > 0 && Character.isHighSurrogate(masked[end - 1])) end--
        val cut = masked.substring(0, end).trim()
        return cut.ifEmpty { "(unnamed)" }
    }
}
