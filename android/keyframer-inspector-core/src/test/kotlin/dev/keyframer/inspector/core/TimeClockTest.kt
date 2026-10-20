package dev.keyframer.inspector.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class TimeClockTest {
    @Test
    fun `untouched, it is the real clock`() {
        val c = TimeClock()
        assertTrue(c.untouched)
        assertFalse(c.controlled)
        assertEquals(1234.5, c.frame(1234.5))
        assertEquals(2000.0, c.at(2000.0))
    }

    @Test
    fun `slow motion runs from where it was, without a jump`() {
        val c = TimeClock()
        c.setScale(0.25, 1000.0)
        assertEquals(1000.0, c.at(1000.0))
        assertEquals(1025.0, c.frame(1100.0))
        // Back to normal: continues from 1050, lagging the real clock by 150.
        c.setScale(1.0, 1200.0)
        assertEquals(1050.0, c.at(1200.0))
        assertEquals(1150.0, c.frame(1300.0))
        assertFalse(c.untouched)
        assertFalse(c.controlled)
    }

    @Test
    fun `paused, it holds, and steps move one frame per real frame`() {
        val c = TimeClock()
        c.frameMs = 1000.0 / 120
        c.setScale(0.0, 500.0)
        assertEquals(500.0, c.frame(516.0))
        c.step(2)
        assertEquals(2, c.pendingSteps)
        val a = c.frame(532.0)
        assertEquals(500.0 + 1000.0 / 120, a, 1e-9)
        // Asking about the same frame again does not take another step.
        assertEquals(a, c.frame(532.0))
        assertEquals(a, c.at(532.0))
        assertEquals(500.0 + 2000.0 / 120, c.frame(548.0), 1e-9)
        assertEquals(0, c.pendingSteps)
        assertEquals(500.0 + 2000.0 / 120, c.frame(564.0), 1e-9)
    }

    @Test
    fun `steps only count while paused, and running again drops the rest`() {
        val c = TimeClock()
        c.step(3)
        assertEquals(0, c.pendingSteps)
        c.setScale(0.0, 0.0)
        c.step(3)
        c.setScale(0.5, 10.0)
        assertEquals(0, c.pendingSteps)
        assertEquals(5.0, c.frame(20.0))
    }

    @Test
    fun `a speed that is not a number is normal speed, below zero is paused`() {
        val c = TimeClock()
        c.setScale(Double.NaN, 0.0)
        assertEquals(1.0, c.scale)
        c.setScale(-2.0, 0.0)
        assertEquals(0.0, c.scale)
    }

    @Test
    fun `the shared time rules`() {
        // Ignored: missing, not a number, NaN, infinite, negative.
        for (raw in listOf(null, "1", Double.NaN, Double.POSITIVE_INFINITY, -0.5)) assertEquals(null, TimeRules.scale(raw), "$raw")
        assertEquals(0.0, TimeRules.scale(0))
        assertEquals(0.01, TimeRules.scale(0.0001))
        assertEquals(0.25, TimeRules.scale(0.25))
        assertEquals(1.0, TimeRules.scale(100))
        assertEquals(1.0, TimeRules.scale(2))
        assertEquals(1.0, TimeRules.scale(1))
        // Steps: only with a scale of 0, whole frames floored, 1 to 120.
        assertEquals(6, TimeRules.step(6.9, 0.0))
        assertEquals(null, TimeRules.step(6, 0.5))
        assertEquals(null, TimeRules.step(6, null))
        assertEquals(null, TimeRules.step(0.9, 0.0))
        assertEquals(120, TimeRules.step(1e9, 0.0))
        assertEquals(null, TimeRules.step("2", 0.0))
    }
}
