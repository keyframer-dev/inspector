package dev.keyframer.inspector.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class VisibilityTrackerTest {
    private val r = VisibilityTracker.Reasons

    @Test
    fun `only changes are markers, every view starts visible`() {
        val v = VisibilityTracker()
        assertNull(v.update("card", null, 10))
        assertEquals(Marker.Visibility(20, "card", false, "offscreen"), v.update("card", r.OFFSCREEN, 20))
        // Still not visible, for another reason: nothing new to say.
        assertNull(v.update("card", r.DETACHED, 30))
        assertEquals(setOf("card"), v.notVisible)
        assertEquals(Marker.Visibility(40, "card", true), v.update("card", null, 40))
        assertEquals(emptySet(), v.notVisible)
    }

    @Test
    fun `a new recording starts over, a removed signal is forgotten`() {
        val v = VisibilityTracker()
        v.update("a", r.HIDDEN, 1)
        v.update("b", r.COVERED, 1)
        v.forget("a")
        assertEquals(setOf("b"), v.notVisible)
        v.reset()
        assertEquals(emptySet(), v.notVisible)
        assertEquals(Marker.Visibility(5, "b", false, "covered"), v.update("b", r.COVERED, 5))
    }

    @Test
    fun `reasons are checked in order`() {
        assertEquals("detached", r.of(attached = false, windowVisible = false, shown = false, transparent = true, onScreen = false))
        assertEquals("covered", r.of(attached = true, windowVisible = false, shown = true, transparent = false, onScreen = false))
        assertEquals("hidden", r.of(attached = true, windowVisible = true, shown = false, transparent = false, onScreen = true))
        assertEquals("hidden", r.of(attached = true, windowVisible = true, shown = true, transparent = true, onScreen = true))
        assertEquals("offscreen", r.of(attached = true, windowVisible = true, shown = true, transparent = false, onScreen = false))
        assertNull(r.of(attached = true, windowVisible = true, shown = true, transparent = false, onScreen = true))
    }
}
