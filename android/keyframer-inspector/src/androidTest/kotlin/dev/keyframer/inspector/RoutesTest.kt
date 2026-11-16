package dev.keyframer.inspector

import android.app.Activity
import android.app.Application
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.keyframer.inspector.core.Cancellable
import dev.keyframer.inspector.core.Marker
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CopyOnWriteArrayList

/** Navigation markers: the route the app set survives a resume, declared screens name the route, a swap is one marker. */
@RunWith(AndroidJUnit4::class)
class RoutesTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app = instrumentation.targetContext.applicationContext as Application
    private val routes = CopyOnWriteArrayList<String>()
    private lateinit var host: AndroidHost
    private var unwatch: Cancellable? = null

    private fun <T> main(block: () -> T): T {
        var out: T? = null
        instrumentation.runOnMainSync { out = block() }
        @Suppress("UNCHECKED_CAST")
        return out as T
    }

    @Before
    fun setUp() = main {
        host = AndroidHost(app, "test", null) {}
        app.registerActivityLifecycleCallbacks(host)
        unwatch = host.watchMarkers { m -> if (m is Marker.Navigation) routes.add(m.route) }
    }

    @After
    fun tearDown() = main {
        unwatch?.cancel()
        app.unregisterActivityLifecycleCallbacks(host)
        host.dispose()
    }

    @Test
    fun aResumeKeepsTheRouteTheAppSet() {
        ActivityScenario.launch(TestActivity::class.java).use { scenario ->
            main { host.setRoute("feed", null) }
            assertEquals("feed", main { host.route })
            // Paused under another activity (as under a permission dialog), then back.
            scenario.moveToState(Lifecycle.State.STARTED)
            scenario.moveToState(Lifecycle.State.RESUMED)
            assertEquals("feed", main { host.route })
            val after = routes.dropWhile { it != "feed" }
            assertEquals("feed", after.last())
            assertFalse("TestActivity" in after)
        }
    }

    @Test
    fun declaredScreensNameTheRouteAndASwapIsOneMarker() {
        ActivityScenario.launch(TestActivity::class.java).use { scenario ->
            lateinit var activity: Activity
            scenario.onActivity { activity = it }
            val home = Any()
            val settings = Any()
            main { host.declareScreen(home, "Home", activity) }
            instrumentation.waitForIdleSync()
            assertEquals("Home", main { host.route })
            // One screen leaving as the next enters: Settings, never TestActivity in between.
            main {
                host.undeclareScreen(home)
                host.declareScreen(settings, "Settings", activity)
            }
            instrumentation.waitForIdleSync()
            main { host.undeclareScreen(settings) }
            instrumentation.waitForIdleSync()
            assertEquals(listOf("Home", "Settings", "TestActivity"), routes.dropWhile { it != "Home" })
        }
    }
}
