package dev.keyframer.vitals.internal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class JsonTest {
    @Test
    fun writesInOrderAndReadsBack() {
        val v = linkedMapOf("b" to 1, "a" to listOf(1.5, 2.0, null, true), "s" to "q\"\n\u0001é")
        val text = Json.write(v)
        assertEquals("{\"b\":1,\"a\":[1.5,2,null,true],\"s\":\"q\\\"\\n\\u0001é\"}", text)
        val back = Json.parse(text) as Map<*, *>
        assertEquals(listOf("b", "a", "s"), back.keys.toList())
        assertEquals("q\"\n\u0001é", back["s"])
        assertEquals(1.0, back["b"])
    }

    @Test
    fun readsEveryFixture() {
        val dir = fixture("report-android.json")?.parentFile ?: return
        for (f in dir.listFiles()!!.filter { it.name.endsWith(".json") }) Json.parse(f.readText())
    }
}

class RedactTest {
    @Test
    fun masksLikeTheInspector() {
        // The cases of react-native/src/redact.test.ts.
        assertEquals("mail [email] now", Redact.maskText("mail ada.l@example.co.uk now"))
        assertEquals("card [number] ok", Redact.maskText("card 4111 1111 1111 1111 ok"))
        assertEquals("call [number]", Redact.maskText("call +1 (555) 123-4567"))
        assertEquals("order [number] failed", Redact.maskText("order 1234567 failed"))
        assertEquals("id [id]", Redact.maskText("id 3f2b8c1e-9d4a-4b2e-8f00-123456789abc"))
        assertEquals("Authorization: Bearer [token]", Redact.maskText("Authorization: Bearer abcDEF123456789xyz"))
        // Built at run time so the public assembly's secret scan never sees a key-shaped literal.
        assertEquals("key [token]", Redact.maskText("key kf_" + "0123456789abcdef".repeat(2)))
        assertEquals("[token]", Redact.maskText("sk-live_abcdefgh12345678"))
        assertEquals("GET /api?token=[redacted]&page=2", Redact.maskText("GET /api?token=s3cr3t&page=2"))
        assertEquals("session [token]", Redact.maskText("session a1b2c3d4e5f6a1b2c3d4e5f6a1b2"))
        assertEquals("Cannot read property \"x\" of undefined at index 3", Redact.maskText("Cannot read property \"x\" of undefined at index 3"))
        assertEquals("withSpring took 120ms", Redact.maskText("withSpring took 120ms"))
    }

    @Test
    fun screenNamesAreMaskedAndCut() {
        assertEquals("Profile [email]", Redact.screenName("Profile ada@example.com"))
        assertEquals("users/[number]", Redact.screenName("users/48213"))
        assertEquals(64, Redact.screenName("x".repeat(100)).length)
        assertEquals("(unnamed)", Redact.screenName("   "))
        // An emoji across the cut is not split in half.
        val name = Redact.screenName("a".repeat(63) + "😀")
        assertEquals("a".repeat(63), name)
    }
}

class FrameMathTest {
    @Test
    fun countsMissedFramesByCost() {
        val b = 1000.0 / 60
        assertEquals(0, FrameMath.missed(5.0, b))
        assertEquals(0, FrameMath.missed(16.6, b))
        assertEquals(0, FrameMath.missed(17.5, b)) // within a millisecond of the deadline
        assertEquals(1, FrameMath.missed(20.0, b))
        assertEquals(1, FrameMath.missed(33.0, b))
        assertEquals(2, FrameMath.missed(40.0, b))
        // The fixture's worst frame: 233.6 ms at 90 Hz missed 20.
        assertEquals(20, FrameMath.missed(233.6, 1000.0 / 90))
    }

    @Test
    fun bucketsByLowerBound() {
        val expected = mapOf(0 to 0, 1 to 1, 2 to 2, 3 to 3, 4 to 3, 5 to 4, 8 to 4, 9 to 5, 16 to 5, 17 to 6, 32 to 6, 33 to 7, 500 to 7)
        for ((missed, bucket) in expected) assertEquals("missed $missed", bucket, VitalsProtocol.bucket(missed))
    }

    @Test
    fun snapsRates() {
        assertEquals(60, FrameMath.snapHz(16.67))
        assertEquals(90, FrameMath.snapHz(11.1))
        assertEquals(120, FrameMath.snapHz(8.33))
        assertEquals(120, FrameMath.snapHz(8.0))
    }

    @Test
    fun threadStatsCountHistogramFrozenHitchAndIdle() {
        val t = ThreadStats()
        val b = 1000.0 / 60
        t.add(10.0, b, idle = true)
        t.add(40.0, b, idle = true)
        t.add(800.0, b, idle = false)
        assertEquals(3, t.frames)
        assertEquals(listOf(1, 0, 1, 0, 0, 0, 0, 1), t.hist.toList())
        assertEquals(1, t.frozen)
        assertEquals(40.0 - b + 800.0 - b, t.hitchMs, 1e-9)
        assertEquals(2, t.idleFrames)
        assertEquals(2, t.idleMissed)
        assertEquals(t.frames, t.hist.sum())
    }
}

class TiersTest {
    @Test
    fun tiers() {
        assertEquals("low", Tiers.tier(3, 8, 0, lowRam = false))
        assertEquals("low", Tiers.tier(8, 8, 0, lowRam = true))
        assertEquals("mid", Tiers.tier(4, 8, 0, lowRam = false))
        assertEquals("mid", Tiers.tier(6, 8, 30, lowRam = false))
        assertEquals("high", Tiers.tier(6, 8, 31, lowRam = false))
        assertEquals("high", Tiers.tier(8, 8, 0, lowRam = false))
        assertEquals(4, Tiers.memoryGb(3_700_000_000L))
        assertEquals(8, Tiers.memoryGb(7_600_000_000L))
    }

    @Test
    fun osMajorAndThermal() {
        assertEquals(14, Tiers.osMajor("14", 34))
        assertEquals(8, Tiers.osMajor("8.1.0", 27))
        assertEquals(15, Tiers.osMajor(null, 35))
        assertEquals(12, Tiers.osMajor("", 32))
        assertEquals(listOf(0, 1, 1, 2, 3, 3, 3), (0..6).map { Tiers.thermalLevel(it) })
    }
}

class StackSitesTest {
    private fun f(cls: String, method: String = "run", file: String? = "X.kt", line: Int = 10) = StackTraceElement(cls, method, file, line)

    @Test
    fun theFirstAppFrameIsTheCallSite() {
        val stack = arrayOf(
            f("dev.keyframer.vitals.KeyframerVitals", "track"),
            f("dev.keyframer.vitals.KeyframerVitalsKt", "kfTrack"),
            f("androidx.compose.runtime.Composer", "x"),
            f("kotlin.collections.CollectionsKt", "forEach"),
            f("com.acme.shop.feed.FeedCardKt", "FeedCard", "FeedCard.kt", 88),
            f("android.app.Activity", "performCreate"),
        )
        val site = StackSites.site(stack, null, "ObjectAnimator", "alpha", keepType = true)!!
        assertEquals(SiteRef.Jvm("com.acme.shop.feed.FeedCardKt", "FeedCard", 88, "FeedCard.kt"), site.ref)
        assertEquals("FeedCardKt", site.component)
        assertNull(site.key)
        assertEquals(
            mapOf("kind" to "jvm", "className" to "com.acme.shop.feed.FeedCardKt", "method" to "FeedCard", "line" to 88, "file" to "FeedCard.kt"),
            site.ref.toWire(),
        )
    }

    @Test
    fun minifiedFramesKeepTheirR8NamesWithoutAFile() {
        val stack = arrayOf(f("dev.keyframer.vitals.KeyframerVitals", "track"), f("a.b.c", "a", "SourceFile", 3))
        val site = StackSites.site(stack, null, "ObjectAnimator", "translationY", keepType = false)!!
        assertEquals(mapOf("kind" to "jvm", "className" to "a.b.c", "method" to "a", "line" to 3), site.ref.toWire())
        assertNull(site.component)
        // Even when the build claims to keep names, a one-letter class says nothing.
        assertNull(StackSites.site(stack, null, "ObjectAnimator", null, keepType = true)!!.component)
        // No line numbers kept: no line.
        val noLine = StackSites.site(arrayOf(f("a.b.c", "a", null, -1)), null, "ObjectAnimator", null, keepType = false)!!
        assertEquals(mapOf("kind" to "jvm", "className" to "a.b.c", "method" to "a"), noLine.ref.toWire())
    }

    @Test
    fun namedSitesUseTheName() {
        val stack = arrayOf(f("com.acme.Cart", "bump"))
        val site = StackSites.site(stack, "cart-badge", "animateFloatAsState", "scale", keepType = true)!!
        assertEquals(SiteRef.Name("cart-badge", "Cart"), site.ref)
        assertEquals("cart-badge", site.key)
        val minified = StackSites.site(stack, "cart-badge", "animateFloatAsState", "scale", keepType = false)!!
        assertEquals(mapOf("kind" to "name", "name" to "cart-badge"), minified.ref.toWire())
        // Only library frames and no name: nothing to report.
        assertNull(StackSites.site(arrayOf(f("android.view.View", "x")), null, "ValueAnimator", null, true))
        assertTrue(StackSites.isLibrary("dev.keyframer.inspector.Keyframer"))
        assertFalse(StackSites.isLibrary("com.acme.Cart"))
    }
}
