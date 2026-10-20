package dev.keyframer.vitals.gradle

/**
 * An R8 / ProGuard `mapping.txt` as the r8 symbol set of protocol/vitals.ts (`VitalsSymbolManifest` and
 * `VitalsR8Chunk`), byte for byte what `keyframer-vitals symbols upload --mapping` writes (inspector/
 * symbols/src/r8.rs; golden files in protocol/fixtures/vitals/symbols/expected/r8).
 *
 * Each method row is `[obfuscated, original, obfStart, obfEnd, origStart, origEnd]`:
 * - `a:b:type name(args):c:d -> x`: obfuscated lines a..b map to c..d, line by line;
 * - `a:b:type name(args):c -> x`: every line a..b maps to c (inlined frames, outlines);
 * - `a:b:type name(args) -> x`: the original lines are a..b;
 * - `type name(args) -> x`: no line information, all four 0.
 * Rows sharing an obfuscated name and range are an inline stack, innermost first, as in the file. A
 * method inlined from another class keeps that class in front of its name (`com.acme.SpringsKt.cardScale`).
 */
object R8Symbols {
    /** 512 KiB of compact JSON per chunk: about 256 KB gzipped, the most the Worker takes. */
    const val CHUNK_BUDGET = 512 * 1024

    class Method(val obfuscated: String, val original: String, val obfStart: Long, val obfEnd: Long, val origStart: Long, val origEnd: Long)
    class Class(val name: String, var file: String?, val methods: MutableList<Method> = ArrayList())

    class SymbolSet(val debugId: String, val manifestJson: String, val chunks: List<Pair<String, String>>)

    /** Classes by obfuscated name, in code point order. */
    fun parse(text: String): List<Pair<String, Class>> {
        val classes = HashMap<String, Class>()
        var current: String? = null
        for ((n, raw) in text.split('\n').withIndex()) {
            val line = raw.removeSuffix("\r").trimEnd()
            val trimmed = line.trimStart()
            if (trimmed.isEmpty()) continue
            if (trimmed.startsWith("#")) {
                val file = sourceFile(trimmed)
                if (current != null && file != null) classes[current]?.file = file
                continue
            }
            val indented = line.startsWith(" ") || line.startsWith("\t")
            if (!indented) {
                if (!trimmed.endsWith(":")) throw IllegalArgumentException("mapping.txt line ${n + 1}: expected `original -> obfuscated:`")
                val body = trimmed.removeSuffix(":")
                val at = body.indexOf(" -> ")
                if (at < 0) throw IllegalArgumentException("mapping.txt line ${n + 1}: expected `original -> obfuscated:`")
                val obf = body.substring(at + 4).trim()
                classes[obf] = Class(body.substring(0, at).trim(), null)
                current = obf
                continue
            }
            val cls = current?.let { classes[it] } ?: continue
            val arrow = trimmed.lastIndexOf(" -> ")
            if (arrow < 0) continue
            val left = trimmed.substring(0, arrow)
            val obfName = trimmed.substring(arrow + 4).trim()
            // Fields have no parameter list.
            val open = left.indexOf('(')
            val close = left.lastIndexOf(')')
            if (open < 0 || close < 0) continue
            var head = left.substring(0, open)
            var range: Pair<Long, Long>? = null
            val parts = head.split(':', limit = 3)
            if (parts.size == 3) {
                val a = u32(parts[0])
                val b = u32(parts[1])
                if (a != null && b != null) {
                    range = a to b
                    head = parts[2]
                }
            }
            val name = head.substringAfterLast(' ')
            val tail = if (close + 1 <= left.length) left.substring(close + 1).split(':').filter { it.isNotEmpty() }.mapNotNull { u32(it) } else emptyList()
            val (os, oe, cs, ce) = when {
                range != null && tail.size >= 2 -> listOf(range.first, range.second, tail[0], tail[1])
                range != null && tail.size == 1 -> listOf(range.first, range.second, tail[0], tail[0])
                range != null -> listOf(range.first, range.second, range.first, range.second)
                tail.size >= 2 -> listOf(0L, 0L, tail[0], tail[1])
                tail.size == 1 -> listOf(0L, 0L, tail[0], tail[0])
                else -> listOf(0L, 0L, 0L, 0L)
            }
            cls.methods.add(Method(obfName, name, os, oe, cs, ce))
        }
        return classes.entries.sortedWith { a, b -> compareCodePoints(a.key, b.key) }.map { it.key to it.value }
    }

    /** Rust's `u32` parse: digits only, at most 4294967295. */
    private fun u32(s: String): Long? {
        if (s.isEmpty() || s.length > 10 || !s.all { it in '0'..'9' }) return null
        return s.toLong().takeIf { it <= 0xFFFFFFFFL }
    }

    /** `# {"id":"sourceFile","fileName":"Foo.kt"}`: the class's source file. */
    private fun sourceFile(comment: String): String? {
        val body = comment.trimStart('#').trim()
        if (!Regex("\"id\"\\s*:\\s*\"sourceFile\"").containsMatchIn(body)) return null
        val m = Regex("\"fileName\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"").find(body) ?: return null
        return unescape(m.groupValues[1])
    }

    private fun unescape(s: String): String {
        if (!s.contains('\\')) return s
        val out = StringBuilder()
        var i = 0
        while (i < s.length) {
            val c = s[i++]
            if (c != '\\' || i >= s.length) {
                out.append(c)
                continue
            }
            when (val e = s[i++]) {
                'n' -> out.append('\n')
                't' -> out.append('\t')
                'r' -> out.append('\r')
                'b' -> out.append('\b')
                'f' -> out.append('\u000C')
                'u' -> {
                    out.append(s.substring(i, i + 4).toInt(16).toChar())
                    i += 4
                }
                else -> out.append(e)
            }
        }
        return out.toString()
    }

    private fun compareCodePoints(a: String, b: String): Int {
        var i = 0
        var j = 0
        while (i < a.length && j < b.length) {
            val ca = a.codePointAt(i)
            val cb = b.codePointAt(j)
            if (ca != cb) return ca.compareTo(cb)
            i += Character.charCount(ca)
            j += Character.charCount(cb)
        }
        return (a.length - i).compareTo(b.length - j)
    }

    fun classJson(c: Class): String {
        val out = StringBuilder("{\"name\":").append(JsonText.string(c.name))
        c.file?.let { out.append(",\"file\":").append(JsonText.string(it)) }
        out.append(",\"methods\":[")
        c.methods.forEachIndexed { i, m ->
            if (i > 0) out.append(',')
            out.append('[').append(JsonText.string(m.obfuscated)).append(',').append(JsonText.string(m.original))
                .append(',').append(m.obfStart).append(',').append(m.obfEnd).append(',').append(m.origStart).append(',').append(m.origEnd).append(']')
        }
        return out.append("]}").toString()
    }

    /**
     * Keyed chunks: entries in order, a new chunk before an entry that would make the chunk's compact
     * JSON (`{"classes":{` + entries + `}}`) longer than `budget` bytes. One entry over the budget gets
     * a chunk of its own. Returns (first key, JSON) per chunk.
     */
    fun keyed(field: String, entries: List<Pair<String, String>>, budget: Int): List<Pair<String, String>> {
        val out = ArrayList<Pair<String, String>>()
        val open = "{" + JsonText.string(field) + ":{"
        val openLen = utf8(open)
        val cur = StringBuilder()
        var curLen = 0
        var first = ""
        for ((k, v) in entries) {
            val item = JsonText.string(k) + ":" + v
            val itemLen = utf8(item)
            if (cur.isNotEmpty() && openLen + curLen + itemLen + 3 > budget) {
                out.add(first to "$open$cur}}")
                cur.setLength(0)
                curLen = 0
            }
            if (cur.isEmpty()) {
                first = k
            } else {
                cur.append(',')
                curLen++
            }
            cur.append(item)
            curLen += itemLen
        }
        if (cur.isNotEmpty() || out.isEmpty()) out.add(first to "$open$cur}}")
        return out
    }

    private fun utf8(s: String) = s.toByteArray(Charsets.UTF_8).size

    fun chunkFile(i: Int) = "%04d.json".format(i)

    /**
     * The symbol set of a mapping: chunks `0000.json`… and the manifest, written last on upload.
     * `debugId`: the Gradle plugin's build id (lowercased), `app`: what the manifest says of the build.
     */
    fun build(
        mapping: String,
        debugId: String,
        appId: String?,
        appVersion: String?,
        appBuild: String?,
        createdAt: String,
        cliName: String,
        cliVersion: String,
        budget: Int = CHUNK_BUDGET,
    ): SymbolSet {
        val classes = parse(mapping)
        if (classes.isEmpty()) throw IllegalArgumentException("no classes in the mapping file")
        val chunks = keyed("classes", classes.map { (obf, c) -> obf to classJson(c) }, budget)
        val id = debugId.lowercase()
        val m = StringBuilder()
        m.append("{\"format\":\"keyframer-vitals-symbols\",\"version\":1,\"kind\":\"r8\",\"debugId\":").append(JsonText.string(id))
        val app = listOfNotNull(appId?.let { "\"id\":" + JsonText.string(it) }, appVersion?.let { "\"version\":" + JsonText.string(it) }, appBuild?.let { "\"build\":" + JsonText.string(it) })
        if (app.isNotEmpty()) m.append(",\"app\":{").append(app.joinToString(",")).append('}')
        m.append(",\"chunks\":[")
        chunks.forEachIndexed { i, (firstKey, _) ->
            if (i > 0) m.append(',')
            m.append("{\"file\":").append(JsonText.string(chunkFile(i))).append(",\"first\":").append(JsonText.string(firstKey)).append('}')
        }
        m.append("],\"createdAt\":").append(JsonText.string(createdAt))
        m.append(",\"cli\":{\"name\":").append(JsonText.string(cliName)).append(",\"version\":").append(JsonText.string(cliVersion)).append("}}")
        return SymbolSet(id, m.toString(), chunks.mapIndexed { i, c -> chunkFile(i) to c.second })
    }
}

/** JSON string literals with the escapes JSON.stringify and serde_json both write. */
internal object JsonText {
    fun string(s: String): String {
        val out = StringBuilder(s.length + 2).append('"')
        for (c in s) {
            when (c) {
                '"' -> out.append("\\\"")
                '\\' -> out.append("\\\\")
                '\n' -> out.append("\\n")
                '\r' -> out.append("\\r")
                '\t' -> out.append("\\t")
                '\b' -> out.append("\\b")
                '\u000C' -> out.append("\\f")
                else -> if (c.code < 0x20) out.append("\\u%04x".format(c.code)) else out.append(c)
            }
        }
        return out.append('"').toString()
    }
}
