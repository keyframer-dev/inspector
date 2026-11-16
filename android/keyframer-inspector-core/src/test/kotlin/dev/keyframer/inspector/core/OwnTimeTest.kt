package dev.keyframer.inspector.core

import kotlin.test.Test
import kotlin.test.assertEquals

class OwnTimeTest {
    /** A clock that moves only when the test moves it, in ms. */
    private class Clock : NanoClock {
        var ms = 0.0
        override fun nanos() = (ms * 1e6).toLong()
    }

    private val clock = Clock()
    private val own = OwnTime(clock).apply { meter(true) }

    @Test
    fun `a section adds the time it took to the total`() {
        own.time { clock.ms += 2.5 }
        clock.ms += 10.0
        own.time { clock.ms += 1.0 }
        assertEquals(3.5, own.totalMs)
    }

    @Test
    fun `nested sections count once`() {
        own.time {
            clock.ms += 1.0
            // A report that takes a stack, inside an animator's listener.
            own.time { clock.ms += 2.0 }
            clock.ms += 1.0
        }
        assertEquals(4.0, own.totalMs)
    }

    @Test
    fun `a section that throws still counts`() {
        runCatching { own.time { clock.ms += 1.0; error("boom") } }
        own.time { clock.ms += 1.0 }
        assertEquals(2.0, own.totalMs)
    }

    @Test
    fun `app code run from a section is not the inspector's, its sections inside are`() {
        own.time {
            clock.ms += 1.0
            own.app {
                // A scenario taps: the app's work, then a tracked animator's listener.
                clock.ms += 20.0
                own.time { clock.ms += 0.5 }
                clock.ms += 5.0
            }
            clock.ms += 1.0
        }
        assertEquals(2.5, own.totalMs)
    }

    @Test
    fun `nothing is timed without a meter`() {
        val idle = OwnTime(clock)
        idle.time { clock.ms += 3.0 }
        assertEquals(0.0, idle.totalMs)
        // A meter that starts inside a section times the sections after it.
        idle.time {
            idle.meter(true)
            clock.ms += 3.0
        }
        idle.time { clock.ms += 1.0 }
        assertEquals(1.0, idle.totalMs)
        idle.meter(false)
        idle.time { clock.ms += 1.0 }
        assertEquals(1.0, idle.totalMs)
    }
}
