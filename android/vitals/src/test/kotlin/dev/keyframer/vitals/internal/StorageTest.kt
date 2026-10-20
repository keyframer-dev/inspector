package dev.keyframer.vitals.internal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

class SessionsTest {
    /** A random source that answers `values` in turn. */
    private class Seq(vararg val values: Double) : Random() {
        var i = 0
        override fun nextBits(bitCount: Int) = 0
        override fun nextDouble() = values[i++ % values.size]
    }

    @Test
    fun samplingIsDecidedOncePerSession() {
        val s = Sessions(MemoryKeyValue(), Seq(0.05, 0.5))
        assertTrue(s.foreground(0, "d1", 0.1))
        assertTrue(s.sampled)
        val nonce = s.session!!.nonce
        // Back within 30 s: the same session, the same decision, the same nonce.
        s.background(10_000)
        assertFalse(s.foreground(39_000, "d1", 0.1))
        assertTrue(s.sampled)
        assertEquals(nonce, s.session!!.nonce)
        // 30 s or more in the background: a new session, sampled again (0.5 >= 0.1: not this time).
        s.background(50_000)
        assertTrue(s.foreground(80_000, "d1", 0.1))
        assertFalse(s.sampled)
        assertNotEquals(nonce, s.session!!.nonce)
        assertTrue(Regex("^[0-9a-f]{32}$").matches(s.session!!.nonce))
    }

    @Test
    fun atMostThreeReportedSessionsADay() {
        val prefs = MemoryKeyValue()
        val s = Sessions(prefs, Seq(0.0))
        var t = 0L
        val sampled = (1..5).map {
            s.foreground(t, "d1", 1.0)
            val on = s.sampled
            s.background(t + 1000)
            t += 60_000
            on
        }
        assertEquals(listOf(true, true, true, false, false), sampled)
        // A new day starts the count again.
        s.foreground(t, "d2", 1.0)
        assertTrue(s.sampled)
        assertEquals(1L, prefs.getLong(Sessions.KEY_COUNT, 0))
    }

    @Test
    fun windowsAreTenMinutesOfForegroundTime() {
        val s = Sessions(MemoryKeyValue(), Seq(0.0))
        s.foreground(0, "d", 1.0)
        assertFalse(s.windowFull(9 * 60_000))
        // Background time does not count.
        s.background(9 * 60_000)
        s.foreground(9 * 60_000 + 20_000, "d", 1.0)
        assertEquals(60_000, s.windowLeftMs(9 * 60_000 + 20_000))
        assertTrue(s.windowFull(10 * 60_000 + 20_000))
        assertEquals(0, s.session!!.seq)
        s.windowClosed()
        assertEquals(1, s.session!!.seq)
        assertEquals(0, s.windowForegroundMs(10 * 60_000 + 20_000))
    }
}

class RetryStoreTest {
    @Test
    fun keepsAtMostFiveReports() {
        val store = RetryStore(tempDir())
        for (i in 0 until 7) store.add(Gzip.compress("{\"n\":$i}"), 1_000L + i)
        val left = store.list(2_000)
        assertEquals(5, left.size)
        assertEquals(listOf(2, 3, 4, 5, 6), left.map { (Json.parse(Gzip.decompress(it.read()!!)) as Map<*, *>)["n"].let { n -> (n as Double).toInt() } })
    }

    @Test
    fun keepsAtMost100KB() {
        val store = RetryStore(tempDir())
        val big = ByteArray(40 * 1024) { it.toByte() }
        for (i in 0 until 4) store.add(big, 1_000L + i)
        assertEquals(2, store.list(2_000).size)
        // One report over the whole budget is never kept.
        assertNull(store.add(ByteArray(101 * 1024), 3_000))
    }

    @Test
    fun dropsReportsOlderThanSevenDays() {
        val store = RetryStore(tempDir())
        store.add(Gzip.compress("{}"), 1_000)
        store.add(Gzip.compress("{}"), 1_000 + RetryStore.MAX_AGE_MS)
        assertEquals(1, store.list(1_000 + RetryStore.MAX_AGE_MS + 1).size)
    }

    @Test
    fun theCheckpointIsAdoptedOnTheNextLaunch() {
        val dir = tempDir()
        val store = RetryStore(dir)
        store.writeCheckpoint(Gzip.compress("{\"ended\":\"unknown\"}"))
        assertTrue(store.list(1).isEmpty())
        val next = RetryStore(dir)
        assertNotNull(next.adoptCheckpoint(10))
        assertEquals(1, next.list(10).size)
        assertNull(next.adoptCheckpoint(11))
        next.clear()
        assertTrue(next.list(12).isEmpty())
    }
}

class ConfigTest {
    @Test
    fun readsTheFixtureConfig() {
        val f = fixture("config.json") ?: return
        val c = Config.from(Json.parse(f.readText()))!!
        assertTrue(c.enabled)
        assertEquals(0.3, c.sampleRate, 0.0)
        assertNotNull(c.minSdkAndroid)
        // The fixture's minSdk lets this SDK's first version report.
        val store = ConfigStore(MemoryKeyValue(), "0.1.0")
        store.save(Json.parse(f.readText()), 0)
        assertTrue(store.allowed(0))
        assertFalse(c.collectReduceMotion)
        assertTrue(c.collectDeviceModel)
        assertFalse(c.collectDevelopment)
        assertEquals(86_400, c.ttlSec)
    }

    @Test
    fun minSdkStopsOlderVersions() {
        assertTrue(Config.compareVersions("1.0.0", "1.0.0") == 0)
        assertTrue(Config.compareVersions("0.9.9", "1.0.0") < 0)
        assertTrue(Config.compareVersions("1.0.10", "1.0.9") > 0)
        assertTrue(Config.compareVersions("1.0.0-beta.1", "1.0.0") < 0)
        val prefs = MemoryKeyValue()
        val old = ConfigStore(prefs, "0.9.0")
        old.save(Json.parse("""{"enabled":true,"sampleRate":0.5,"minSdk":{"android":"1.0.0","ios":"9.9.9"},"collect":{"reduceMotion":false,"deviceModel":true,"development":false},"ttlSec":86400}"""), 0)
        assertFalse(old.allowed(0))
        assertTrue(ConfigStore(prefs, "1.0.0").allowed(0))
    }

    @Test
    fun stopTurnsTheDeviceOffForSevenDays() {
        val f = fixture("ingest-response-stop.json")
        val body = f?.readText() ?: """{"ok":false,"config":{"enabled":false,"sampleRate":0,"collect":{"reduceMotion":false,"deviceModel":true,"development":false},"ttlSec":86400,"stop":true}}"""
        val store = ConfigStore(MemoryKeyValue(), "1.0.0")
        store.save((Json.parse(body) as Map<*, *>)["config"], 1_000)
        assertTrue(store.killed(1_000))
        assertFalse(store.allowed(1_000 + ConfigStore.SEVEN_DAYS_MS - 1))
        assertFalse(store.killed(1_000 + ConfigStore.SEVEN_DAYS_MS))
    }

    @Test
    fun fetchedAtMostDaily() {
        val store = ConfigStore(MemoryKeyValue(), "1.0.0")
        assertTrue(store.stale(0))
        store.save(Json.parse("""{"enabled":true,"sampleRate":0.1,"collect":{"reduceMotion":false,"deviceModel":true,"development":false},"ttlSec":300}"""), 1_000)
        assertFalse(store.stale(1_000 + 3_600_000))
        assertTrue(store.stale(1_000 + ConfigStore.DAY_MS))
    }
}

class UploaderTest {
    private val configs = ConfigStore(MemoryKeyValue(), "1.0.0")
    private val transport = FakeTransport()
    private val uploader = Uploader("https://vitals.example/", "kfp_live_x", transport, configs, "1.0.0")

    @Test
    fun postsGzippedJsonWithTheKeyAndKeepsTheConfig() {
        val f = fixture("ingest-response.json")
        if (f != null) transport.answer = { Transport.Response(200, f.readText()) }
        assertEquals(Uploader.Outcome.DONE, uploader.sendReport(Gzip.compress("{\"a\":1}"), 0))
        val r = transport.requests.single()
        assertEquals("POST", r.method)
        assertEquals("https://vitals.example/v1/reports", r.url)
        assertEquals("Bearer kfp_live_x", r.headers["Authorization"])
        assertEquals("gzip", r.headers["Content-Encoding"])
        assertEquals("application/json", r.headers["Content-Type"])
        assertEquals(mapOf("a" to 1.0), r.json)
        assertEquals(0.3, configs.current()!!.sampleRate, 0.0)
    }

    @Test
    fun outcomes() {
        for ((status, outcome) in listOf(400 to Uploader.Outcome.DONE, 413 to Uploader.Outcome.DONE, 429 to Uploader.Outcome.RETRY, 503 to Uploader.Outcome.RETRY)) {
            transport.answer = { Transport.Response(status, "") }
            assertEquals("status $status", outcome, uploader.sendReport(ByteArray(1), 0))
        }
        transport.answer = { null }
        assertEquals(Uploader.Outcome.RETRY, uploader.sendReport(ByteArray(1), 0))
        assertFalse(configs.killed(0))
        for (status in listOf(401, 410)) {
            val c = ConfigStore(MemoryKeyValue(), "1.0.0")
            val u = Uploader("https://vitals.example", "kfp_live_x", FakeTransport().apply { answer = { Transport.Response(status, "") } }, c, "1.0.0")
            assertEquals(Uploader.Outcome.KILLED, u.sendReport(ByteArray(1), 0))
            assertTrue(c.killed(ConfigStore.SEVEN_DAYS_MS - 1))
        }
    }

    @Test
    fun fetchesTheConfig() {
        val f = fixture("config.json")
        transport.answer = { Transport.Response(200, f?.readText() ?: """{"enabled":true,"sampleRate":0.3,"collect":{"reduceMotion":false,"deviceModel":true,"development":false},"ttlSec":86400}""") }
        assertTrue(uploader.fetchConfig(0))
        assertEquals("GET", transport.requests.single().method)
        assertEquals("https://vitals.example/v1/config/kfp_live_x", transport.requests.single().url)
        assertEquals(0.3, configs.current()!!.sampleRate, 0.0)
    }
}
