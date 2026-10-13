package dev.keyframer.inspector

import android.view.MotionEvent
import android.view.Window

/**
 * Sees every touch on an activity's window before the activity does, then hands it on unchanged.
 * Installed over whatever callback is there (the activity, or AppCompat's wrapper of it).
 */
internal class TouchCallback(
    val base: Window.Callback,
    private val onTouch: (MotionEvent) -> Unit,
) : Window.Callback by base {
    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        try {
            onTouch(event)
        } catch (_: Throwable) {
            // The inspector must never break input.
        }
        return base.dispatchTouchEvent(event)
    }
}
