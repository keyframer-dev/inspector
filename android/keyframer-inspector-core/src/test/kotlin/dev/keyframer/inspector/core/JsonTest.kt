package dev.keyframer.inspector.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class JsonTest {
    @Test
    fun `numbers print the way JSON stringify prints them`() {
        assertEquals("1", Json.encode(1.0))
        assertEquals("-3", Json.encode(-3))
        assertEquals("0.5", Json.encode(0.5))
        assertEquals("1.5e-7", Json.encode(1.5e-7))
        assertEquals("1e+21", Json.encode(1e21))
        assertEquals("null", Json.encode(Double.NaN))
        assertEquals("null", Json.encode(Double.POSITIVE_INFINITY))
        // A Float off an animator keeps its short form, not 0.30000001192092896.
        assertEquals("0.3", Json.encode(0.3f))
        assertEquals("12", Json.encode(12f))
    }

    @Test
    fun `maps keep their order, skip nulls and keep explicit nulls`() {
        assertEquals("""{"b":1,"a":null,"c":[true,"x"]}""", Json.encode(linkedMapOf("b" to 1, "skip" to null, "a" to JsonNull, "c" to listOf(true, "x"))))
    }

    @Test
    fun `strings are escaped`() {
        assertEquals("\"a\\\"b\\\\c\\n\\u0001\"", Json.encode("a\"b\\c\n\u0001"))
    }

    @Test
    fun `parses what it writes and what JavaScript writes`() {
        val text = """{"type":"record","signalIds":["*"],"on":true,"n":-1.5e3,"u":"é\n","o":{},"a":[]}"""
        val m = Json.parse(text) as Map<*, *>
        assertEquals("record", m["type"])
        assertEquals(listOf("*"), m["signalIds"])
        assertEquals(true, m["on"])
        assertEquals(-1500.0, m["n"])
        assertEquals("é\n", m["u"])
        assertEquals(emptyMap<String, Any?>(), m["o"])
        assertEquals(emptyList<Any?>(), m["a"])
    }

    @Test
    fun `rejects broken JSON`() {
        assertFailsWith<IllegalArgumentException> { Json.parse("{\"a\":") }
        assertFailsWith<IllegalArgumentException> { Json.parse("pong") }
        assertFailsWith<IllegalArgumentException> { Json.parse("[1,2] x") }
    }
}
