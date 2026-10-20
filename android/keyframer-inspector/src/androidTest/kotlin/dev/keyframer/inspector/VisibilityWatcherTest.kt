package dev.keyframer.inspector

import android.view.View
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.keyframer.inspector.core.Marker
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CopyOnWriteArrayList

@RunWith(AndroidJUnit4::class)
class VisibilityWatcherTest {
    @Test
    fun reportsWhyATrackedViewCannotBeSeenAndWhenItIsBack() {
        ActivityScenario.launch(TestActivity::class.java).use { scenario ->
            val markers = CopyOnWriteArrayList<Marker.Visibility>()
            lateinit var view: View
            lateinit var watcher: VisibilityWatcher
            scenario.onActivity { a ->
                view = View(a)
                a.root.addView(view, 100, 100)
                watcher = VisibilityWatcher({ listOf(ViewTarget(listOf("box"), view, active = true)) }, { true }) { m -> markers.add(m as Marker.Visibility) }
                watcher.start()
            }
            fun step(change: (View) -> Unit) {
                scenario.onActivity { change(view) }
                Thread.sleep(3 * VisibilityWatcher.INTERVAL_MS)
            }
            step { }
            step { it.translationX = 100_000f }
            step { it.translationX = 0f }
            step { it.alpha = 0f }
            step { it.alpha = 1f }
            step { it.visibility = View.INVISIBLE }
            step { it.visibility = View.VISIBLE }
            step { (it.parent as android.view.ViewGroup).removeView(it) }
            scenario.onActivity { watcher.stop() }
            assertEquals(
                listOf(false to "offscreen", true to null, false to "hidden", true to null, false to "hidden", true to null, false to "detached"),
                markers.map { it.visible to it.reason },
            )
            assertEquals(setOf("box"), markers.map { it.id }.toSet())
        }
    }
}
