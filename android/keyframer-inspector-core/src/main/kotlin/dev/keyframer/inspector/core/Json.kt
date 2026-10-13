package dev.keyframer.inspector.core

/**
 * A small JSON writer and reader, so the SDK ships without a serialization library.
 *
 * Writing takes plain Kotlin values: Map (keys in insertion order, null values skipped like
 * `undefined` in JSON.stringify), List, String, Number, Boolean and null. Numbers print the way
 * JavaScript prints them, so the bytes match what the React Native client sends: `1` not `1.0`,
 * `1e-7` not `1.0E-7`, and NaN or infinity become `null`.
 *
 * Reading returns Map<String, Any?>, List<Any?>, String, Double, Boolean or null.
 */
object Json {
    fun encode(value: Any?): String = StringBuilder().also { write(it, value) }.toString()

    fun parse(text: String): Any? = Reader(text).run {
        val v = value()
        skipSpace()
        if (i != s.length) fail("trailing characters")
        v
    }

    fun number(d: Double): String {
        if (d.isNaN() || d.isInfinite()) return "null"
        if (d == Math.rint(d) && kotlin.math.abs(d) < 1e15) return d.toLong().toString()
        val s = d.toString()
        val e = s.indexOf('E')
        if (e < 0) return s
        // 1.5E-7 → 1.5e-7, 1.0E21 → 1e+21
        var mantissa = s.substring(0, e)
        if (mantissa.endsWith(".0")) mantissa = mantissa.dropLast(2)
        val exp = s.substring(e + 1)
        return mantissa + "e" + (if (exp.startsWith("-")) exp else "+$exp")
    }

    private fun write(out: StringBuilder, v: Any?) {
        when (v) {
            null -> out.append("null")
            is String -> string(out, v)
            is Boolean -> out.append(v)
            is Int, is Long, is Short, is Byte -> out.append((v as Number).toLong())
            // A Float read off an animator: its shortest decimal, not the binary expansion of the Double.
            is Float -> out.append(if (v.isNaN() || v.isInfinite()) "null" else number(v.toString().toDouble()))
            is Number -> out.append(number(v.toDouble()))
            is Map<*, *> -> {
                out.append('{')
                var first = true
                for ((k, x) in v) {
                    if (x == null) continue
                    if (!first) out.append(',')
                    first = false
                    string(out, k.toString())
                    out.append(':')
                    write(out, x)
                }
                out.append('}')
            }
            is Iterable<*> -> {
                out.append('[')
                var first = true
                for (x in v) {
                    if (!first) out.append(',')
                    first = false
                    write(out, x)
                }
                out.append(']')
            }
            is Array<*> -> write(out, v.asList())
            is JsonValue -> write(out, v.toJson())
            is JsonNull -> out.append("null")
            else -> string(out, v.toString())
        }
    }

    private fun string(out: StringBuilder, s: String) {
        out.append('"')
        for (c in s) {
            when (c) {
                '"' -> out.append("\\\"")
                '\\' -> out.append("\\\\")
                '\n' -> out.append("\\n")
                '\r' -> out.append("\\r")
                '\t' -> out.append("\\t")
                '\b' -> out.append("\\b")
                '\u000C' -> out.append("\\f")
                else -> if (c < ' ') out.append(String.format("\\u%04x", c.code)) else out.append(c)
            }
        }
        out.append('"')
    }

    private class Reader(val s: String) {
        var i = 0

        fun fail(why: String): Nothing = throw IllegalArgumentException("Bad JSON at $i: $why")

        fun skipSpace() {
            while (i < s.length && s[i].isWhitespace()) i++
        }

        fun value(): Any? {
            skipSpace()
            if (i >= s.length) fail("unexpected end")
            return when (val c = s[i]) {
                '{' -> obj()
                '[' -> arr()
                '"' -> str()
                't' -> literal("true", true)
                'f' -> literal("false", false)
                'n' -> literal("null", null)
                else -> if (c == '-' || c.isDigit()) num() else fail("unexpected '$c'")
            }
        }

        fun literal(word: String, v: Any?): Any? {
            if (!s.startsWith(word, i)) fail("expected $word")
            i += word.length
            return v
        }

        fun obj(): Map<String, Any?> {
            val out = LinkedHashMap<String, Any?>()
            i++
            skipSpace()
            if (s.getOrNull(i) == '}') return out.also { i++ }
            while (true) {
                skipSpace()
                if (s.getOrNull(i) != '"') fail("expected a key")
                val k = str()
                skipSpace()
                if (s.getOrNull(i) != ':') fail("expected ':'")
                i++
                out[k] = value()
                skipSpace()
                when (s.getOrNull(i)) {
                    ',' -> i++
                    '}' -> return out.also { i++ }
                    else -> fail("expected ',' or '}'")
                }
            }
        }

        fun arr(): List<Any?> {
            val out = ArrayList<Any?>()
            i++
            skipSpace()
            if (s.getOrNull(i) == ']') return out.also { i++ }
            while (true) {
                out.add(value())
                skipSpace()
                when (s.getOrNull(i)) {
                    ',' -> i++
                    ']' -> return out.also { i++ }
                    else -> fail("expected ',' or ']'")
                }
            }
        }

        fun str(): String {
            val out = StringBuilder()
            i++
            while (true) {
                if (i >= s.length) fail("unterminated string")
                val c = s[i++]
                when (c) {
                    '"' -> return out.toString()
                    '\\' -> {
                        when (val e = s.getOrNull(i++) ?: fail("bad escape")) {
                            '"', '\\', '/' -> out.append(e)
                            'n' -> out.append('\n')
                            'r' -> out.append('\r')
                            't' -> out.append('\t')
                            'b' -> out.append('\b')
                            'f' -> out.append('\u000C')
                            'u' -> {
                                if (i + 4 > s.length) fail("bad unicode escape")
                                out.append(s.substring(i, i + 4).toInt(16).toChar())
                                i += 4
                            }
                            else -> fail("bad escape '$e'")
                        }
                    }
                    else -> out.append(c)
                }
            }
        }

        fun num(): Double {
            val start = i
            if (s[i] == '-') i++
            while (i < s.length && (s[i].isDigit() || s[i] in ".eE+-")) i++
            return s.substring(start, i).toDoubleOrNull() ?: fail("bad number")
        }
    }
}

/** Something that knows its own JSON shape (a Map or a List of plain values). */
interface JsonValue {
    fun toJson(): Any
}

/** An explicit JSON `null` inside a map, where a plain null would drop the key. */
object JsonNull

// Readers for parsed JSON.
@Suppress("UNCHECKED_CAST")
internal fun Any?.obj(): Map<String, Any?>? = this as? Map<String, Any?>
internal fun Any?.list(): List<Any?> = (this as? List<Any?>) ?: emptyList()
internal fun Map<String, Any?>.str(key: String): String? = this[key] as? String
internal fun Map<String, Any?>.num(key: String): Double? = (this[key] as? Number)?.toDouble()
internal fun Map<String, Any?>.bool(key: String): Boolean? = this[key] as? Boolean
