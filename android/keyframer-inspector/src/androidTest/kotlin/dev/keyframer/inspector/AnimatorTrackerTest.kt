package dev.keyframer.inspector

import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.view.View
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.example.rows.Rows
import dev.keyframer.inspector.core.Cancellable
import dev.keyframer.inspector.core.FrameLoop
import dev.keyframer.inspector.core.Host
import dev.keyframer.inspector.core.InspectorSession
import dev.keyframer.inspector.core.InspectorSocket
import dev.keyframer.inspector.core.Json
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

    /** A session whose socket keeps what it is sent, open. */
    private class Sent {
        val texts = ArrayList<String>()
        var listener: SocketListener? = null
        val sockets = object : SocketFactory {
            override fun open(url: String, listener: SocketListener): InspectorSocket {
                this@Sent.listener = listener
                return object : InspectorSocket {
                    override fun send(text: String): Boolean = texts.add(text)
                    override fun close() {}
                }
            }
        }

        @Suppress("UNCHECKED_CAST")
        fun events(): List<Map<String, Any?>> = texts.map { Json.parse(it) as Map<String, Any?> }
            .filter { it["type"] == "events" }
            .flatMap { it["events"] as List<Map<String, Any?>> }
    }

    private fun openSession(sent: Sent): InspectorSession {
        val s = InspectorSession("ws://127.0.0.1:1/app", sent.sockets, MainScheduler, AndroidClock, host)
        main { s.start() }
        sent.listener!!.onOpen()
        InstrumentationRegistry.getInstrumentation().waitForIdleSync()
        return s
    }

    /** Waits for the stack worker's answer to reach the main thread. */
    private fun settled(until: () -> Boolean) {
        val end = System.currentTimeMillis() + 3000
        while (System.currentTimeMillis() < end) {
            InstrumentationRegistry.getInstrumentation().waitForIdleSync()
            var done = false
            main { done = until() }
            if (done) return
            Thread.sleep(5)
        }
        throw AssertionError("the stack was not read in time")
    }

    @Test
    fun aStartBeforeTheStackIsReadIsReportedOnceItIs() {
        val sent = Sent()
        val s = openSession(sent)
        val deferred = AnimatorTracker { s }
        lateinit var fade: ObjectAnimator
        val startedAt = System.currentTimeMillis()
        main {
            fade = ObjectAnimator.ofFloat(row(), View.ALPHA, 0f, 1f).setDuration(10_000)
            deferred.track(fade, "fade", null, Rows.taken(), emptyList())
            fade.start()
            // Nobody records, nothing is overridden: the stack is read off the main thread.
            assertTrue(deferred.ids.isEmpty())
        }
        settled { deferred.ids.isNotEmpty() }
        main {
            assertEquals(setOf("com/example/rows/Rows.kt:5:0:fade"), deferred.ids)
            // Started again once registered: reported by its own listener, the early one is gone.
            fade.cancel()
            fade.start()
            s.flush()
        }
        val anims = sent.events().filter { it["kind"] == "anim" }
        assertEquals(2, anims.size)
        assertEquals("com/example/rows/Rows.kt:5:0", (anims[0]["site"] as Map<*, *>)["id"])
        // The first one at the time it started, not when its stack came back.
        assertTrue((anims[0]["at"] as Double) - startedAt in 0.0..1000.0)
        assertTrue("com/example/rows/Rows.kt:5:0:fade:time" in s.signalIds)
        main {
            fade.cancel()
            s.dispose()
        }
    }

    @Test
    fun whileRecordingTheStackIsReadAtOnce() {
        val sent = Sent()
        val s = openSession(sent)
        val deferred = AnimatorTracker { s }
        main {
            s.setRecording(listOf("*"), true)
            val pulse = ValueAnimator.ofFloat(0f, 1f).setDuration(10_000)
            deferred.track(pulse, "pulse", null, Rows.taken(), emptyList())
            // Its values are sampled from the next frame on.
            assertEquals(setOf("com/example/rows/Rows.kt:5:0:pulse"), deferred.ids)
            pulse.start()
            pulse.cancel()
        }
        // The start's stack goes along, read off the main thread: the report follows.
        settled {
            s.flush()
            sent.events().any { it["kind"] == "anim" }
        }
        val anim = sent.events().single { it["kind"] == "anim" }
        assertTrue("t" in anim)
        assertTrue((anim["frames"] as List<*>).isNotEmpty())
        main { s.dispose() }
    }

    @Test
    fun untrackingAnAnimatorWhoseStackIsBeingReadUntracksIt() {
        val sent = Sent()
        val s = openSession(sent)
        val deferred = AnimatorTracker { s }
        main {
            val a = ObjectAnimator.ofFloat(row(), View.ALPHA, 0f, 1f)
            deferred.track(a, "gone", null, Rows.taken(), emptyList())
            deferred.untrack(a)
            assertTrue(deferred.ids.isEmpty())
            assertTrue(s.signalIds.isEmpty())
        }
        // The worker's answer finds nothing left to register.
        Thread.sleep(100)
        InstrumentationRegistry.getInstrumentation().waitForIdleSync()
        main {
            assertTrue(deferred.ids.isEmpty())
            s.dispose()
        }
    }
}
