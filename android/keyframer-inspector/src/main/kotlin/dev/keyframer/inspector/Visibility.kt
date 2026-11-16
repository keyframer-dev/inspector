package dev.keyframer.inspector

import android.graphics.Rect
import android.view.View
import dev.keyframer.inspector.core.Marker
import dev.keyframer.inspector.core.VisibilityTracker
import java.lang.ref.WeakReference

/**
 * A tracked view and the signals its values are recorded under. `active`: something animates it now
 * (an animator running); idle views are only checked again while they are reported as not visible, so
 * coming back is seen. `animatesAlpha`: its own alpha is what animates, so alpha 0 is part of the
 * animation (a fade in starts there), not the view being hidden.
 */
internal class ViewTarget(
    override val ids: List<String>,
    view: View,
    override val active: Boolean,
    val animatesAlpha: Boolean = false,
) : VisibilityTracker.Target {
    val view = WeakReference(view)

    override fun reason(): String? {
        // A view that was collected is certainly not in a window any more.
        val v = view.get() ?: return VisibilityTracker.Reasons.DETACHED
        return reasonFor(v, animatesAlpha)
    }
}

/**
 * Checks tracked views a few times a second while recording and reports when one stops being visible
 * (detached, covered by another screen, hidden, alpha 0, outside the window or clipped away) and when it
 * is visible again: values that keep moving meanwhile spend frames nobody sees. Each check walks a
 * view's parents once (getGlobalVisibleRect), so it costs little next to a frame; only views whose
 * animation runs are checked, and only for the values `sampled` says the recording has samples of
 * (recorded, and numbers). Main thread.
 */
internal class VisibilityWatcher(
    private val targets: () -> List<ViewTarget>,
    private val foreground: () -> Boolean,
    private val sampled: (String) -> Boolean,
    private val onMarker: (Marker) -> Unit,
) {
    companion object {
        const val INTERVAL_MS = 100L
    }

    private val tracker = VisibilityTracker()
    private var running = false

    private val tick = object : Runnable {
        override fun run() {
            if (!running) return
            try {
                ownTime.time { check() }
            } catch (_: Throwable) {
                // A view in a state that cannot be measured: checked again next time.
            }
            mainHandler.postDelayed(this, INTERVAL_MS)
        }
    }

    fun start() {
        if (running) return
        running = true
        tracker.reset()
        mainHandler.postDelayed(tick, INTERVAL_MS)
    }

    fun stop() {
        running = false
        mainHandler.removeCallbacks(tick)
    }

    private fun check() {
        // The app in the background is an appState marker, not every view going away.
        if (!foreground()) return
        tracker.check(AndroidClock.nowMs().toLong(), targets(), sampled).forEach(onMarker)
    }
}

/** Reused by every check: they all run on the main thread. */
private val rect = Rect()

private fun reasonFor(view: View, animatesAlpha: Boolean): String? {
    val attached = view.isAttachedToWindow
    val windowVisible = attached && view.windowVisibility == View.VISIBLE
    return VisibilityTracker.Reasons.of(
        attached = attached,
        windowVisible = windowVisible,
        shown = view.isShown,
        transparent = transparent(view, animatesAlpha),
        onScreen = windowVisible && view.width > 0 && view.height > 0 && view.getGlobalVisibleRect(rect),
    )
}

/** The view, or a parent, drawn at alpha 0. */
private fun transparent(view: View, animatesAlpha: Boolean): Boolean {
    if (!animatesAlpha && view.alpha <= 0f) return true
    var p = view.parent
    var depth = 0
    while (p is View && depth++ < 64) {
        if (p.alpha <= 0f) return true
        p = p.parent
    }
    return false
}
