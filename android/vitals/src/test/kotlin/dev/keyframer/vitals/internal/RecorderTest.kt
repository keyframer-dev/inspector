package dev.keyframer.vitals.internal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RecorderTest {
    private val ms = 1_000_000L
    private val budget = 1000.0 / 60
    private fun site(name: String) = SiteInfo(SiteRef.Name(name, null), "ObjectAnimator", null, "alpha")

    @Suppress("UNCHECKED_CAST")
    private fun Map<String, Any?>.threads(t: String) = (this["threads"] as Map<String, Any?>)[t] as Map<String, Any?>

    @Test
    fun framesDuringARunCountForItsSiteAndOthersAreTheBaseline() {
        val r = Recorder()
        r.foreground(true, 0)
        r.navigate("Feed", 0)
        // 600 ms after navigating, so no frame here is a screen mount.
        var t = 600 * ms
        repeat(10) {
            r.frame(t, 5.0, 10.0, budget)
            t += 17 * ms
        }
        r.frame(t, 5.0, 40.0, budget) // idle, missed 2
        t += 40 * ms
        val run = r.animationStart(site("card"), t, 300.0, reduceMotion = false)
        repeat(5) {
            r.frame(t, 5.0, 10.0, budget)
            t += 17 * ms
        }
        r.frame(t, 30.0, 50.0, budget) // missed 2, during the run
        t += 50 * ms
        r.animationEnd(run, t)
        t += 600 * ms
        r.frame(t, 5.0, 10.0, budget) // idle again
        val snap = r.snapshot(t + 10 * ms, reset = false)

        val ui = snap.screens[0].threads("ui")
        assertEquals(18, ui["frames"])
        assertEquals(12, ui["idleFrames"])
        assertEquals(2, ui["idleMissed"])
        val s = snap.sites.single()
        assertEquals(6, s["frames"])
        assertEquals(2, s["missed"])
        assertEquals(1, s["runs"])
        assertEquals(135L, s["activeMs"])
        assertEquals(50.0, s["worstMs"])
        assertEquals(round1(50 - budget), s["hitchMs"])
        // Both worst frames: the one during the run lists the site.
        assertEquals(2, snap.worst.size)
        assertEquals(50.0, snap.worst[0]["ms"])
        assertEquals(listOf(0), snap.worst[0]["sites"])
        assertEquals("js", snap.worst[0]["thread"]) // the main thread alone took 30 ms
        assertEquals("ui", snap.worst[1]["thread"])
        assertEquals(emptyList<Int>(), snap.worst[1]["sites"])
        assertEquals(60, snap.targetHz)
    }

    @Test
    fun framesThatArriveAfterTheRunEndedStillMatchIt() {
        val r = Recorder()
        r.navigate("Feed", 0)
        val start = 1000 * ms
        val run = r.animationStart(site("late"), start, 100.0, false)
        r.animationEnd(run, start + 100 * ms)
        // JankStats hands frames over a little after they were drawn.
        r.frame(start + 50 * ms, 5.0, 30.0, budget)
        assertEquals(1, r.snapshot(start + 200 * ms, false).sites.single()["frames"])
    }

    @Test
    fun aRunWithoutAnEndIsOverAtItsEstimate() {
        val r = Recorder()
        r.navigate("Feed", 0)
        r.animationStart(site("spring"), 1000 * ms, 200.0, false)
        r.frame(1100 * ms, 5.0, 10.0, budget) // inside
        r.frame(1300 * ms, 5.0, 10.0, budget) // after the estimate: idle
        val snap = r.snapshot(1400 * ms, false)
        assertEquals(1, snap.sites.single()["frames"])
        assertEquals(1, snap.screens[0].threads("ui")["idleFrames"])
    }

    @Test
    fun causes() {
        val r = Recorder()
        r.foreground(true, 0)
        r.navigate("Feed", 0)
        // Within 500 ms of the navigation: a screen mount, and how long after.
        r.frame(200 * ms, 5.0, 100.0, budget)
        // A burst: six animations starting within 50 ms of a slow frame.
        var t = 2000 * ms
        for (i in 0 until 6) r.animationStart(site("b$i"), t + i * ms, 100.0, false)
        r.frame(t + 10 * ms, 5.0, 90.0, budget)
        // A touch: the gesture window lasts 1.5 s after the finger lifts.
        t = 5000 * ms
        r.touch(true, t)
        r.touch(false, t + 100 * ms)
        r.frame(t + 1400 * ms, 5.0, 80.0, budget)
        // A scroll, with no finger down.
        t = 9000 * ms
        r.scroll(t)
        r.frame(t + 100 * ms, 5.0, 70.0, budget)
        // Nothing open.
        r.frame(12000 * ms, 5.0, 60.0, budget)
        val worst = r.snapshot(13000 * ms, false).worst
        assertEquals(listOf("screen-mount", "burst", "gesture", "scroll", "unknown"), worst.map { it["cause"] })
        assertEquals(300.0, worst[0]["afterNavMs"]) // the frame ended 300 ms after the navigation
        assertFalse(worst[1].containsKey("afterNavMs"))
        assertEquals((0..5).toList(), worst[1]["sites"])
    }

    @Test
    fun keepsTheFiveWorstLongestFirst() {
        val r = Recorder()
        r.navigate("Feed", 0)
        val lengths = listOf(30.0, 90.0, 20.0, 800.0, 45.0, 60.0, 35.0, 120.0)
        lengths.forEachIndexed { i, l -> r.frame((10_000L + i * 1000) * ms, 5.0, l, budget) }
        val snap = r.snapshot(20_000 * ms, false)
        assertEquals(listOf(800.0, 120.0, 90.0, 60.0, 45.0), snap.worst.map { it["ms"] })
        assertEquals(1, snap.screens[0].threads("ui")["frozen"])
    }

    @Test
    fun aSiteBelongsToTheScreenItRanLongestOn() {
        val r = Recorder()
        r.foreground(true, 0)
        r.navigate("A", 0)
        val s = site("x")
        r.animationEnd(r.animationStart(s, 100 * ms, null, false), 200 * ms)
        r.navigate("B", 300 * ms)
        r.animationEnd(r.animationStart(s, 400 * ms, null, false), 900 * ms)
        val snap = r.snapshot(1000 * ms, false)
        assertEquals(listOf("A", "B"), snap.screens.map { it["name"] })
        assertEquals(1, snap.sites.single()["screen"])
        assertEquals(2, snap.sites.single()["runs"])
        assertEquals(600L, snap.sites.single()["activeMs"])
        assertEquals(listOf(300L, 700L), snap.screens.map { it["ms"] })
    }

    @Test
    fun aNewWindowStartsEmptyAndRunningAnimationsCarryOn() {
        val r = Recorder()
        r.foreground(true, 0)
        r.navigate("Feed", 0)
        val spinner = r.animationStart(site("spinner"), 100 * ms, null, false)
        r.frame(200 * ms, 5.0, 40.0, budget)
        val first = r.snapshot(1000 * ms, reset = true)
        assertEquals(900L, first.sites.single()["activeMs"])
        r.frame(1100 * ms, 5.0, 10.0, budget)
        r.animationEnd(spinner, 1500 * ms)
        val second = r.snapshot(2000 * ms, reset = true)
        assertEquals(listOf("Feed"), second.screens.map { it["name"] })
        assertEquals(1000L, second.screens[0]["ms"])
        assertEquals(500L, second.sites.single()["activeMs"])
        assertEquals(1, second.sites.single()["frames"])
        assertTrue(second.worst.isEmpty())
    }

    @Test
    fun atMostFortyScreens() {
        val r = Recorder()
        for (i in 0 until 60) r.navigate("S$i", i * ms)
        val snap = r.snapshot(100 * ms, false)
        assertEquals(40, snap.screens.size)
        assertEquals("(other)", snap.screens.last()["name"])
    }

    @Test
    fun histogramsAddUp() {
        val r = Recorder()
        r.navigate("Feed", 0)
        val lengths = listOf(5.0, 17.0, 35.0, 52.0, 70.0, 120.0, 300.0, 700.0, 1500.0)
        lengths.forEachIndexed { i, l -> r.frame((1000L + i * 2000) * ms, l / 2, l, budget) }
        val ui = r.snapshot(30_000 * ms, false).screens[0].threads("ui")
        @Suppress("UNCHECKED_CAST")
        assertEquals(ui["frames"], (ui["hist"] as List<Int>).sum())
        assertEquals(2, ui["frozen"])
    }
}
