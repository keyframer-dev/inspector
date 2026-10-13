package dev.keyframer.inspector.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class FrameMeterTest {
    @Test
    fun `steady 60 Hz has no drops and reports 60 fps per window`() {
        val m = FrameMeter("js")
        var t = 0.0
        repeat(40) {
            m.tick(t)
            t += 1000.0 / 60
        }
        assertTrue(m.drops.isEmpty())
        assertTrue(m.stats.isNotEmpty())
        assertEquals(60, m.stats.first().fps)
        assertEquals("js", m.stats.first().thread)
    }

    @Test
    fun `a long frame is a drop with how many frames it skipped`() {
        val m = FrameMeter("js")
        m.tick(0.0)
        m.tick(16.7)
        m.tick(16.7 + 50.0)
        assertEquals(listOf(FrameDrop(67, "js", 50.0, 2)), m.drops)
    }

    @Test
    fun `a 120 Hz display is detected after one window`() {
        val m = FrameMeter("js")
        var t = 0.0
        repeat(40) {
            m.tick(t)
            t += 1000.0 / 120
        }
        // A 16.7 ms frame on a 120 Hz display skipped one frame.
        m.tick(t + 1000.0 / 120)
        assertEquals(1, m.drops.single().dropped)
    }
}
