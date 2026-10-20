package dev.keyframer.vitals.internal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ReporterTest {
    private val site = SiteInfo(SiteRef.Name("card", null), "ObjectAnimator", null, "alpha")

    @Suppress("UNCHECKED_CAST")
    private fun Map<*, *>.obj(k: String) = this[k] as Map<String, Any?>

    @Test
    fun aSampledSessionSendsItsWindowWhenTheAppGoesToTheBackground() {
        val h = Harness()
        h.reporter.launch()
        h.reporter.onForeground()
        assertTrue(h.reporter.measuring)
        h.reporter.navigate("MainActivity")
        h.clock.ms += 600
        val run = h.reporter.animationStart(site, 300.0)
        repeat(10) { h.frame(9.0) }
        h.frame(40.0, mainMs = 30.0)
        h.reporter.animationEnd(run)
        h.clock.ms += 1_000
        h.reporter.onBackground()

        val report = h.transport.reports.single()
        assertEquals("keyframer-vitals", report["format"])
        assertEquals("background", report.obj("session")["ended"])
        assertEquals(0.0, report.obj("session")["seq"])
        assertEquals(1.0, report.obj("session")["sampleRate"])
        assertEquals("3c8e5f1a07b94d62a9e4c2f6b1d8e037", report.obj("app")["debugId"])
        assertEquals(90.0, report.obj("display")["hz"])
        // Sent, so nothing waits.
        assertTrue(h.store.list(h.clock.wallMs()).isEmpty())
        // The answer's config is kept for the next session (sample rate 0.3).
        assertEquals(0.3, h.reporter.configs.current()!!.sampleRate, 0.0)
    }

    @Test
    fun nothingIsMeasuredOrSentByAnUnsampledSession() {
        val h = Harness(sampleRate = 0.0)
        h.reporter.launch()
        h.reporter.onForeground()
        assertFalse(h.reporter.measuring)
        h.frame(100.0)
        h.reporter.onBackground()
        h.scheduler.advance(60 * 60_000)
        assertTrue(h.transport.requests.none { it.url.endsWith("/v1/reports") })
    }

    @Test
    fun aDebuggableBuildWithoutAnEnvironmentReportsNothing() {
        val h = Harness(environment = null)
        h.reporter.launch()
        h.reporter.onForeground()
        assertFalse(h.reporter.measuring)
    }

    @Test
    fun setEnabledFalseStopsAndDropsWhatIsPending() {
        val h = Harness()
        h.transport.answer = { null } // offline: reports wait
        h.reporter.launch()
        h.reporter.onForeground()
        h.frame(50.0)
        h.reporter.onBackground()
        assertEquals(1, h.store.list(h.clock.wallMs()).size)
        h.reporter.onForeground()
        h.frame(50.0)
        h.reporter.setEnabled(false)
        assertFalse(h.reporter.measuring)
        assertTrue(h.store.list(h.clock.wallMs()).isEmpty())
        val tried = h.transport.reports.size
        h.reporter.onBackground()
        h.transport.answer = { Transport.Response(200, "{}") }
        h.scheduler.advance(60 * 60_000)
        assertEquals(tried, h.transport.reports.size)
        // Back on: a new session that measures again.
        h.reporter.setEnabled(true)
        h.reporter.onForeground()
        assertTrue(h.reporter.measuring)
    }

    @Test
    fun aCheckpointEveryMinuteIsSentOnTheNextLaunchAsUnknown() {
        val h = Harness()
        h.reporter.launch()
        h.reporter.onForeground()
        h.reporter.navigate("MainActivity")
        repeat(5) { h.frame(60.0) }
        h.scheduler.advance(61_000)
        // The process dies here (a freeze the person kills): no onBackground.
        val next = h.relaunch()
        next.reporter.launch()
        next.reporter.onForeground()
        next.scheduler.advance(10_000)
        val sent = next.transport.reports.single()
        assertEquals("unknown", sent.obj("session")["ended"])
        @Suppress("UNCHECKED_CAST")
        val ui = ((sent["screens"] as List<Map<String, Any?>>)[0]["threads"] as Map<String, Any?>)["ui"] as Map<String, Any?>
        assertEquals(5.0, ui["frames"])
    }

    @Test
    fun aFullWindowIsSentAndTheNextHasTheNextSeq() {
        val h = Harness()
        h.reporter.launch()
        h.reporter.onForeground()
        h.frame(30.0)
        h.scheduler.advance(10 * 60_000 + 1_000)
        h.frame(30.0)
        h.reporter.onBackground()
        val reports = h.transport.reports
        assertEquals(listOf("window", "background"), reports.map { it.obj("session")["ended"] })
        assertEquals(listOf(0.0, 1.0), reports.map { it.obj("session")["seq"] })
        assertEquals(1, reports.map { it.obj("session")["nonce"] }.toSet().size)
    }

    @Test
    fun unauthorizedTurnsTheReporterOffForSevenDays() {
        val h = Harness()
        h.transport.answer = { Transport.Response(401, """{"ok":false}""") }
        h.reporter.launch()
        h.reporter.onForeground()
        h.frame(40.0)
        h.reporter.onBackground()
        h.scheduler.advance(1)
        assertTrue(h.reporter.configs.killed(h.clock.wallMs()))
        h.reporter.onForeground()
        assertFalse(h.reporter.measuring)
        // Still off on the next launch, and its checkpoint is dropped, not sent.
        val next = h.relaunch()
        next.reporter.launch()
        next.reporter.onForeground()
        assertFalse(next.reporter.measuring)
        next.scheduler.advance(60 * 60_000)
        assertTrue(next.transport.requests.isEmpty())
    }

    @Test
    fun failedUploadsRetryInTheForegroundAfterOneFiveAndThirtyMinutes() {
        val h = Harness()
        h.transport.answer = { Transport.Response(503, "") }
        h.reporter.launch()
        h.reporter.onForeground()
        h.frame(40.0)
        h.reporter.onBackground() // sent at once: 503
        h.reporter.onForeground()
        val first = h.transport.reports.size
        assertEquals(1, first)
        h.scheduler.advance(61_000) // 1 minute
        assertEquals(2, h.transport.reports.size)
        h.scheduler.advance(5 * 60_000) // 5 minutes
        assertEquals(3, h.transport.reports.size)
        h.transport.answer = { Transport.Response(200, "{\"ok\":true}") }
        h.scheduler.advance(40 * 60_000) // the 30 minute retry (and the full window's own send) gets through
        assertTrue(h.transport.reports.size >= 4)
        assertTrue(h.store.list(h.clock.wallMs()).isEmpty())
    }

    @Test
    fun retriesWaitForTheForeground() {
        val h = Harness()
        h.transport.answer = { null }
        h.reporter.launch()
        h.reporter.onForeground()
        h.frame(40.0)
        h.reporter.onBackground()
        val tries = h.transport.reports.size
        h.scheduler.advance(2 * 60 * 60_000)
        assertEquals(tries, h.transport.reports.size)
        h.transport.answer = { Transport.Response(200, "{}") }
        h.reporter.onForeground()
        h.scheduler.advance(10_000)
        assertTrue(h.store.list(h.clock.wallMs()).isEmpty())
    }

    @Test
    fun dataSaverDefersUploads() {
        val h = Harness()
        h.probe.saver = true
        h.reporter.launch()
        h.reporter.onForeground()
        h.frame(40.0)
        h.reporter.onBackground()
        assertTrue(h.transport.reports.isEmpty())
        assertEquals(1, h.store.list(h.clock.wallMs()).size)
        // The next launch without Data Saver sends it.
        val next = h.relaunch()
        next.reporter.launch()
        next.reporter.onForeground()
        next.scheduler.advance(10_000)
        assertEquals(1, next.transport.reports.size)
    }

    @Test
    fun theConfigIsFetchedTenSecondsAfterLaunchAtMostDaily() {
        val h = Harness()
        h.reporter.launch()
        h.scheduler.advance(10_000)
        assertEquals(1, h.transport.requests.count { it.url.contains("/v1/config/kfp_live_") })
        val next = h.relaunch()
        next.reporter.launch()
        next.scheduler.advance(10_000)
        assertTrue(next.transport.requests.none { it.url.contains("/v1/config/") })
    }

    @Test
    fun reduceMotionOnlyWhenTheProjectCollectsIt() {
        val h = Harness()
        h.probe.animationsOffNow = true
        h.reporter.launch()
        h.reporter.onForeground()
        h.reporter.animationStart(site, 100.0)
        h.frame(30.0)
        h.reporter.onBackground()
        val first = h.transport.reports.single()
        assertFalse(first.obj("state").containsKey("reduceMotion"))
        // The project turns it on.
        h.reporter.configs.save(Json.parse("""{"enabled":true,"sampleRate":1,"collect":{"reduceMotion":true,"deviceModel":false,"development":false},"ttlSec":86400}"""), h.clock.wallMs())
        h.clock.ms += 60_000
        h.reporter.onForeground()
        h.reporter.animationStart(site, 100.0)
        h.frame(30.0)
        h.reporter.onBackground()
        val second = h.transport.reports.last()
        assertEquals(true, second.obj("state")["reduceMotion"])
        @Suppress("UNCHECKED_CAST")
        assertEquals(1.0, (second["sites"] as List<Map<String, Any?>>).single()["runsReduceMotion"])
        // Device models off: no model.
        assertFalse(second.obj("device").containsKey("model"))
    }
}
