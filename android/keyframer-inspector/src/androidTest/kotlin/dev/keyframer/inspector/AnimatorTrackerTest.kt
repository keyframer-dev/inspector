package dev.keyframer.inspector

import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.view.View
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.keyframer.inspector.core.Cancellable
import dev.keyframer.inspector.core.FrameLoop
import dev.keyframer.inspector.core.Host
import dev.keyframer.inspector.core.InspectorSession
import dev.keyframer.inspector.core.InspectorSocket
import dev.keyframer.inspector.core.Marker
import dev.keyframer.inspector.core.Screen
import dev.keyframer.inspector.core.SocketFactory
import dev.keyframer.inspector.core.SocketListener
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Which animators kfTrack keeps apart (N22: fifty from one line in a loop are fifty, not two). */
@RunWith(AndroidJUnit4::class)
class AnimatorTrackerTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    private val host = object : Host {
        override val appName = "test"
        override val platform = "android"
        override val screen: Screen? = null
        override val canCapture = false
        override val frames = FrameLoop { _, _ -> Cancellable {} }
        override fun watchMarkers(onMarker: (Marker) -> Unit) = Cancellable {}
    }
    private val noSockets = object : SocketFactory {
        override fun open(url: String, listener: SocketListener) = object : InspectorSocket {
            override fun send(text: String) = false
            override fun close() {}
        }
    }
    private val session = InspectorSession("ws://127.0.0.1:1/app", noSockets, MainScheduler, AndroidClock, host)
    private val tracker = AnimatorTracker { session }

    /** One line of app code, as a loop body would have it. */
    private val stack = arrayOf(StackTraceElement("com.example.Rows", "bind", "Rows.kt", 42))

    private fun main(block: () -> Unit) = InstrumentationRegistry.getInstrumentation().runOnMainSync(block)

    private fun row() = View(context)

    @Test
    fun fiftyNamedRowsFromOneLineAreFiftyAnimators() = main {
        val animators = (1..50).map { i ->
            ObjectAnimator.ofFloat(row(), View.TRANSLATION_X, 0f, 100f).also { tracker.track(it, "row$i", null, stack, emptyList()) }
        }
        animators.forEach { it.start() }
        assertEquals(50, tracker.ids.size)
        assertTrue("row7" in tracker.ids.joinToString())
        // Each a value and a play-time track, under its name.
        assertEquals(100, session.signalIds.size)
        assertTrue("com/example/Rows.kt:42:0:row7" in session.signalIds)
        assertTrue("com/example/Rows.kt:42:0:row7:time" in session.signalIds)
        animators.forEach { it.cancel() }
    }

    @Test
    fun rowsWithOneNameMadeFirstAndStartedLaterKeepTheirOwnIds() = main {
        val animators = (1..50).map {
            ObjectAnimator.ofFloat(row(), View.ALPHA, 0f, 1f).also { a -> tracker.track(a, "row", null, stack, emptyList()) }
        }
        assertEquals(50, tracker.ids.size)
        assertTrue("com/example/Rows.kt:42:0:row#50" in tracker.ids)
        // The value signals say what they animate.
        assertEquals("alpha", session.signal("com/example/Rows.kt:42:0:row")?.site?.prop)
        animators.forEach { it.start() }
        assertEquals(50, tracker.ids.size)
        animators.forEach { it.cancel() }
    }

    @Test
    fun unnamedValueAnimatorsInALoopAreKeptApartToo() = main {
        val animators = (1..10).map { ValueAnimator.ofFloat(0f, 1f).also { a -> tracker.track(a, null, null, stack, emptyList()) } }
        assertEquals(10, tracker.ids.size)
        assertEquals(null, session.signal("com/example/Rows.kt:42:0")?.site?.prop)
        animators.forEach { it.cancel() }
    }

    @Test
    fun aOneShotMadeAgainForTheSameViewReplacesTheOneThatRan() = main {
        val card = row()
        val first = ObjectAnimator.ofFloat(card, View.TRANSLATION_Y, 0f).setDuration(10_000)
        tracker.track(first, "snap", null, stack, emptyList())
        first.start()
        // The next tap cancels it and makes a new one, as the example's drag does.
        first.cancel()
        val second = ObjectAnimator.ofFloat(card, View.TRANSLATION_Y, 0f).setDuration(10_000)
        tracker.track(second, "snap", null, stack, emptyList())
        assertEquals(setOf("com/example/Rows.kt:42:0:snap"), tracker.ids)
        assertEquals(2, session.signalIds.size)
        // Another view's snap from the same line is another animator.
        val other = ObjectAnimator.ofFloat(row(), View.TRANSLATION_Y, 0f).setDuration(10_000)
        tracker.track(other, "snap", null, stack, emptyList())
        assertEquals(2, tracker.ids.size)
        second.cancel()
    }
}
