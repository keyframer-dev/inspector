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

    @Test
    fun `a known display rate is what frames are counted against, slow windows or not`() {
        val m = FrameMeter("js")
        m.setRefreshRate(120.0)
        var t = 0.0
        // A whole window of 16.7 ms frames: on a 120 Hz display every one skipped a frame. Guessing
        // from the frames would call it a 60 Hz display with no drops.
        repeat(40) {
            m.tick(t)
            t += 1000.0 / 60
        }
        assertEquals(39, m.drops.size)
        assertTrue(m.drops.all { it.dropped == 1 })
        assertEquals(1000.0 / 120, m.frameMs)
        // A display marker moves it.
        m.setRefreshRate(60.0)
        m.drops.clear()
        repeat(10) {
            m.tick(t)
            t += 1000.0 / 60
        }
        assertTrue(m.drops.isEmpty())
    }

    @Test
    fun `a long frame says how much of it was the inspector's own work`() {
        val m = FrameMeter("js")
        // The running total before the recording's first frame is not this recording's.
        m.tick(0.0, inspector = 40.0)
        m.tick(16.7, inspector = 40.2)
        // 3.26 ms of the inspector's work between these two frames: said, rounded to 0.1 ms.
        m.tick(66.7, inspector = 43.46)
        assertEquals(listOf(FrameDrop(67, "js", 50.0, 2, inspectorMs = 3.3)), m.drops)
    }

    @Test
    fun `less than half a millisecond of the inspector's work is not said`() {
        val m = FrameMeter("js")
        m.tick(0.0)
        m.tick(50.0, inspector = 0.49)
        assertEquals(listOf(FrameDrop(50, "js", 50.0, 2)), m.drops)
        assertEquals(null, m.drops.single().inspectorMs)
        // Exactly half a millisecond is.
        m.tick(100.0, inspector = 0.99)
        assertEquals(0.5, m.drops.last().inspectorMs)
    }

    @Test
    fun `the inspector's part of a frame is never more than the frame`() {
        val m = FrameMeter("js")
        m.tick(0.0)
        // Read from another clock, the total can grow by a little more than the frame took.
        m.tick(40.0, inspector = 41.0)
        assertEquals(40.0, m.drops.single().inspectorMs)
    }

    @Test
    fun `work in frames that did not drop is not carried into a later drop`() {
        val m = FrameMeter("js")
        var t = 0.0
        var total = 0.0
        repeat(10) {
            m.tick(t, total)
            t += 1000.0 / 60
            total += 2.0
        }
        assertTrue(m.drops.isEmpty())
        // The long frame has only its own share: what the total grew by since the frame before.
        m.tick(t + 33.3, total + 1.5)
        assertEquals(3.5, m.drops.single().inspectorMs)
    }
}
