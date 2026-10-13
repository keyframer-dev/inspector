package dev.keyframer.inspector.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/** The editor messages, as the panel and the MCP server send them (JSON.stringify output). */
class EditorMessageTest {
    @Test
    fun record() {
        assertEquals(EditorMessage.Record(listOf("*"), true), EditorMessage.parse("""{"type":"record","signalIds":["*"],"on":true}"""))
        assertEquals(EditorMessage.Record(listOf("a", "b"), false), EditorMessage.parse("""{"type":"record","signalIds":["a","b"],"on":false}"""))
    }

    @Test
    fun playback() {
        val msg = EditorMessage.parse(
            """{"type":"playback","samples":[{"id":"x","t":16.4,"v":3},{"id":"y","t":0,"v":-1.25},{"bad":1}],"routes":[{"t":0,"route":"MainActivity"},{"t":900,"route":"DetailActivity","params":{"id":7}}]}""",
        )
        assertEquals(
            EditorMessage.Playback(
                listOf(Sample("x", 16, 3.0), Sample("y", 0, -1.25)),
                listOf(Route(0, "MainActivity"), Route(900, "DetailActivity", mapOf("id" to 7.0))),
            ),
            msg,
        )
    }

    @Test
    fun capture() {
        assertEquals(
            EditorMessage.Capture("f3", listOf(Sample("x", 100, 1.0)), "png", 0.7, 390, Route(80, "DetailActivity")),
            EditorMessage.parse("""{"type":"capture","id":"f3","samples":[{"id":"x","t":100,"v":1}],"format":"png","quality":0.7,"width":390,"route":{"t":80,"route":"DetailActivity"}}"""),
        )
        // Defaults as on React Native: jpg at 0.85, no width, no route.
        assertEquals(EditorMessage.Capture("f4", emptyList(), "jpg", 0.85, null, null), EditorMessage.parse("""{"type":"capture","id":"f4","samples":[]}"""))
    }

    @Test
    fun `overrides, replay, scenario, presence, hello`() {
        assertEquals(
            EditorMessage.Overrides(mapOf("a.kt:1:0" to mapOf("duration" to 900.0))),
            EditorMessage.parse("""{"type":"overrides","overrides":{"a.kt:1:0":{"duration":900,"bad":"x"}}}"""),
        )
        assertEquals(EditorMessage.Replay, EditorMessage.parse("""{"type":"replay"}"""))
        assertEquals(EditorMessage.Scenario("drag card"), EditorMessage.parse("""{"type":"scenario","name":"drag card"}"""))
        assertEquals(EditorMessage.Presence(true, 2, false), EditorMessage.parse("""{"type":"presence","app":true,"editors":2,"cli":false}"""))
        assertEquals(EditorMessage.Hello("editor"), EditorMessage.parse("""{"type":"hello","role":"editor"}"""))
    }

    @Test
    fun `what the app does not handle`() {
        assertEquals(EditorMessage.Ignored("apply"), EditorMessage.parse("""{"type":"apply","edits":[]}"""))
        assertNull(EditorMessage.parse("pong"))
        assertNull(EditorMessage.parse("[1]"))
    }
}
