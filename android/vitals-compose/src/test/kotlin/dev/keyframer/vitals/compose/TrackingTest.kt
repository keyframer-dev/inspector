@file:OptIn(VitalsExtensionApi::class)

package dev.keyframer.vitals.compose

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.VectorConverter
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import dev.keyframer.vitals.VitalsExtensionApi
import dev.keyframer.vitals.VitalsExtensions
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TrackingTest {
    private class Log {
        val events = ArrayList<String>()
        var n = 0
        val runs = Runs({ d -> "run${++n}".also { events.add("start $it ${d?.toInt()}") } }, { events.add("end $it") })
    }

    @Test
    fun aNewTargetStartsARunAndEndsTheOneBefore() {
        val log = Log()
        val changes = TargetChanges(0f, log.runs)
        changes.committed(0f) { 100.0 } // the first composition: nothing moves
        changes.committed(1f) { 300.0 }
        changes.committed(1f) { 300.0 } // a recomposition with the same target
        changes.committed(0f) { 250.0 } // interrupted by a new target
        changes.finished()
        changes.finished()
        assertEquals(listOf("start run1 300", "end run1", "start run2 250", "end run2"), log.events)
        assertEquals(2, log.runs.started)
    }

    @Test
    fun durationsFromTheSpec() {
        assertEquals(400.0, Durations.ms(tween<Float>(300, delayMillis = 100), Float.VectorConverter, 0f, 1f)!!, 0.5)
        val springMs = Durations.ms(spring<Float>(), Float.VectorConverter, 0f, 100f)!!
        assertTrue("a default spring settles in well under 2 s: $springMs", springMs in 50.0..2000.0)
        assertNull(Durations.ms(infiniteRepeatable(tween<Float>(500), RepeatMode.Reverse), Float.VectorConverter, 0f, 1f))
    }

    @Test
    fun theCallSiteIsTheComposableThatCalledTheHelper() {
        val stack = arrayOf(
            StackTraceElement("dev.keyframer.vitals.compose.TrackingKt", "rememberRuns", "Tracking.kt", 60),
            StackTraceElement("dev.keyframer.vitals.compose.AnimateAsStateKt", "kfAnimateFloatAsState", "AnimateAsState.kt", 50),
            StackTraceElement("androidx.compose.runtime.ComposerImpl", "cache", "Composer.kt", 1),
            StackTraceElement("com.acme.shop.feed.FeedCardKt", "FeedCard", "FeedCard.kt", 88),
        )
        val unnamed = VitalsExtensions.site(stack, null, "animateFloatAsState", "scale")
        assertNotNull(unnamed)
        val named = VitalsExtensions.site(stack, "cart-badge", "animateFloatAsState", "scale")
        assertNotNull(named)
        assertEquals(null, "FloatAnimation".unlessDefault("FloatAnimation"))
        assertEquals("cart-badge", "cart-badge".unlessDefault("FloatAnimation"))
        // Before start nothing is measured: helpers fall through to Compose's own calls.
        assertTrue(!VitalsExtensions.measuring && !VitalsExtensions.started)
        assertNull(VitalsExtensions.start(unnamed!!, 100.0))
    }
}
