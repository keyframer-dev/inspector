package dev.keyframer.vitals.internal

/**
 * The little JSON the reporter needs: writing reports (maps keep their insertion order, so reports read
 * like the protocol's type) and reading configs. Plain Kotlin, so it runs in unit tests without Android.
 */
internal object Json {
    fun write(value: Any?): String = StringBuilder().also { write(it, value) }.toString()

    private fun write(out: StringBuilder, v: Any?) {
        when (v) {
            null -> out.append("null")
            is Boolean -> out.append(v)
            is Int, is Long, is Short, is Byte -> out.append(v)
            is Float -> number(out, v.toDouble())
            is Double -> number(out, v)
            is Number -> number(out, v.toDouble())
            is String -> string(out, v)
            is Map<*, *> -> {
                out.append('{')
                var first = true
                for ((k, value) in v) {
                    if (!first) out.append(',')
                    first = false
                    string(out, k.toString())
                    out.append(':')
                    write(out, value)
                }
                out.append('}')
            }
            is Iterable<*> -> {
                out.append('[')
                var first = true
                for (item in v) {
                    if (!first) out.append(',')
                    first = false
                    write(out, item)
                }
                out.append(']')
            }
            is IntArray -> write(out, v.toList())
            is LongArray -> write(out, v.toList())
            else -> string(out, v.toString())
        }
    }

    /** Whole numbers without a fraction (as JavaScript writes them), others as they are. */
    private fun number(out: StringBuilder, d: Double) {
        if (!d.isFinite()) {
            out.append("null")
            return
        }
        val l = d.toLong()
        if (l.toDouble() == d && kotlin.math.abs(d) < 1e15) out.append(l) else out.append(d)
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
                else -> if (c < ' ' || c == ' ' || c == ' ') out.append(String.format("\\u%04x", c.code)) else out.append(c)
            }
        }
        out.append('"')
    }

    /** Objects as LinkedHashMap, arrays as List, numbers as Double. Throws on malformed input. */
    fun parse(text: String): Any? {
        val p = Parser(text)
        val v = p.value()
        p.skipWs()
        if (p.i != text.length) throw IllegalArgumentException("trailing characters at ${p.i}")
        return v
    }

    private class Parser(val s: String) {
        var i = 0

        fun skipWs() {
            while (i < s.length && s[i].isWhitespace()) i++
        }

        fun value(): Any? {
            skipWs()
            if (i >= s.length) throw IllegalArgumentException("unexpected end")
            return when (val c = s[i]) {
                '{' -> obj()
                '[' -> arr()
                '"' -> str()
                't' -> literal("true", true)
                'f' -> literal("false", false)
                'n' -> literal("null", null)
                else -> if (c == '-' || c.isDigit()) num() else throw IllegalArgumentException("unexpected '$c' at $i")
            }
        }

        private fun literal(word: String, v: Any?): Any? {
            if (!s.startsWith(word, i)) throw IllegalArgumentException("bad literal at $i")
            i += word.length
            return v
        }

        private fun num(): Double {
            val start = i
            while (i < s.length && (s[i].isDigit() || s[i] in "+-.eE")) i++
            return s.substring(start, i).toDouble()
        }

        private fun str(): String {
            i++
            val out = StringBuilder()
            while (true) {
                if (i >= s.length) throw IllegalArgumentException("unterminated string")
                val c = s[i++]
                when (c) {
                    '"' -> return out.toString()
                    '\\' -> {
                        when (val e = s[i++]) {
                            'n' -> out.append('\n')
                            'r' -> out.append('\r')
                            't' -> out.append('\t')
                            'b' -> out.append('\b')
                            'f' -> out.append('\u000C')
                            'u' -> {
                                out.append(s.substring(i, i + 4).toInt(16).toChar())
                                i += 4
                            }
                            else -> out.append(e)
                        }
                    }
                    else -> out.append(c)
                }
            }
        }

        private fun obj(): Map<String, Any?> {
            i++
            val out = LinkedHashMap<String, Any?>()
            skipWs()
            if (s[i] == '}') {
                i++
                return out
            }
            while (true) {
                skipWs()
                val k = str()
                skipWs()
                if (s[i++] != ':') throw IllegalArgumentException("expected ':' at ${i - 1}")
                out[k] = value()
                skipWs()
                when (s[i++]) {
                    ',' -> continue
                    '}' -> return out
                    else -> throw IllegalArgumentException("expected ',' or '}' at ${i - 1}")
                }
            }
        }

        private fun arr(): List<Any?> {
            i++
            val out = ArrayList<Any?>()
            skipWs()
            if (s[i] == ']') {
                i++
                return out
            }
            while (true) {
                out.add(value())
                skipWs()
                when (s[i++]) {
                    ',' -> continue
                    ']' -> return out
                    else -> throw IllegalArgumentException("expected ',' or ']' at ${i - 1}")
                }
            }
        }
    }
}
