package dev.keyframer.inspector.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class CallSitesTest {
    private fun f(cls: String, method: String, file: String?, line: Int) = StackTraceElement(cls, method, file, line)

    // What Throwable().stackTrace looks like inside Keyframer.track(...) called from an Activity's onCreate.
    private val stack = arrayOf(
        f("dev.keyframer.inspector.Keyframer", "track", "Keyframer.kt", 120),
        f("dev.keyframer.inspector.Keyframer", "track\$default", "Keyframer.kt", 110),
        f("dev.keyframer.example.MainActivity", "onCreate", "MainActivity.kt", 42),
        f("android.app.Activity", "performCreate", "Activity.java", 8595),
        f("android.app.ActivityThread", "main", "ActivityThread.java", 8177),
        f("java.lang.reflect.Method", "invoke", null, -2),
    )

    @Test
    fun `first app frame skips the SDK and the platform`() {
        val site = CallSites.site(CallSites.firstAppFrame(stack)!!)
        assertEquals("dev/keyframer/example/MainActivity.kt:42:0", site.id)
        assertEquals("dev/keyframer/example/MainActivity.kt", site.file)
        assertEquals(42, site.line)
        assertEquals("MainActivity", site.component)
        assertEquals("onCreate", site.method)
    }

    @Test
    fun `lambdas and inner classes belong to their outer class`() {
        val frame = f("dev.keyframer.example.MainActivity\$onCreate\$1\$2", "invoke", "MainActivity.kt", 77)
        assertEquals("MainActivity", CallSites.component(frame))
        assertEquals("dev/keyframer/example/MainActivity.kt", CallSites.filePath(frame))
        val synthetic = f("dev.keyframer.example.MainActivity", "onCreate\$lambda\$3", "MainActivity.kt", 90)
        assertEquals("onCreate", CallSites.site(synthetic).method)
    }

    @Test
    fun `top-level functions are named after the function, like a composable`() {
        val frame = f("dev.keyframer.example.ui.CardKt", "PulsingCard", "Card.kt", 12)
        assertEquals("PulsingCard", CallSites.component(frame))
        assertEquals("dev/keyframer/example/ui/Card.kt:12:0", CallSites.site(frame).id)
    }

    @Test
    fun `no file name falls back to the class, a stack with no app frame gives null`() {
        assertEquals("com/acme/Thing.kt", CallSites.filePath(f("com.acme.Thing\$1", "run", null, 3)))
        assertNull(CallSites.firstAppFrame(arrayOf(f("android.os.Looper", "loop", "Looper.java", 1), f("dev.keyframer.inspector.X", "y", "X.kt", 2))))
        // Lines <= 0 (native or unknown) are not a call site.
        assertNull(CallSites.firstAppFrame(arrayOf(f("com.acme.A", "b", "A.kt", -1))))
    }

    @Test
    fun `extra library prefixes, for an app's own animation helpers`() {
        val s = arrayOf(f("com.acme.motion.Fade", "run", "Fade.kt", 9), f("com.acme.Home", "show", "Home.kt", 30))
        assertEquals("Home", CallSites.component(CallSites.firstAppFrame(s, listOf("com.acme.motion."))!!))
    }

    @Test
    fun `frames for the trace collapse library frames`() {
        val frames = CallSites.frames(stack)
        assertEquals("dev.keyframer.example.MainActivity.onCreate", frames.first().methodName)
        assertEquals(false, frames.first().collapse)
        assertEquals(true, frames[1].collapse)
        assertEquals(4, frames.size)
    }
}
