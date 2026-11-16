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

    /** A view whose state a test sets. */
    private class View(override val ids: List<String>, override var active: Boolean = true, var why: String? = null) : VisibilityTracker.Target {
        var checks = 0
        override fun reason(): String? {
            checks++
            return why
        }
    }

    @Test
    fun `a round reports only values the recording has samples of`() {
        val v = VisibilityTracker()
        // A view with a number recorded and a value that never reads as one (an animator of objects).
        val card = View(listOf("card", "card:color"), why = r.OFFSCREEN)
        val other = View(listOf("other"), why = r.HIDDEN)
        val sampled = setOf("card")
        assertEquals(listOf(Marker.Visibility(10, "card", false, "offscreen")), v.check(10, listOf(card, other), { it in sampled }))
        // Nothing recorded on it: not even looked at.
        assertEquals(0, other.checks)
        card.why = null
        assertEquals(listOf(Marker.Visibility(20, "card", true)), v.check(20, listOf(card, other), { it in sampled }))
    }

    @Test
    fun `idle views are checked while reported not visible, and forgotten when they stop counting`() {
        val v = VisibilityTracker()
        val card = View(listOf("card"), why = r.COVERED)
        var sampled = setOf("card")
        v.check(10, listOf(card), { it in sampled })
        // Nothing animates it any more, but it was reported not visible: checked, to see it come back.
        card.active = false
        card.checks = 0
        assertEquals(emptyList(), v.check(20, listOf(card), { it in sampled }))
        assertEquals(1, card.checks)
        // No longer recorded: forgotten, so recording it again starts it out visible and says so.
        sampled = emptySet()
        assertEquals(emptyList(), v.check(30, listOf(card), { it in sampled }))
        assertEquals(emptySet(), v.notVisible)
        sampled = setOf("card")
        card.active = true
        assertEquals(listOf(Marker.Visibility(40, "card", false, "covered")), v.check(40, listOf(card), { it in sampled }))
        // Its view is not tracked any more: forgotten too.
        v.check(50, emptyList(), { it in sampled })
        assertEquals(emptySet(), v.notVisible)
    }

    @Test
    fun `a view that cannot be measured is checked again next round`() {
        val v = VisibilityTracker()
        val broken = object : VisibilityTracker.Target {
            override val ids = listOf("a")
            override val active = true
            override fun reason(): String? = throw IllegalStateException("not laid out")
        }
        val fine = View(listOf("b"), why = r.HIDDEN)
        assertEquals(listOf(Marker.Visibility(10, "b", false, "hidden")), v.check(10, listOf(broken, fine), { true }))
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
