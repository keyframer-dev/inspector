package dev.keyframer.inspector.core

/**
 * Whether tracked views can be seen, turned into `visibility` markers: one when a view stops being
 * visible (with why) and one when it is visible again. Every view counts as visible until a check says
 * otherwise, so a recording only carries the changes. Single threaded.
 */
class VisibilityTracker {
    /** Signal id → why it is not visible, for the ones last reported as not visible. */
    private val hidden = HashMap<String, String>()

    /** Ids last reported as not visible: worth checking again even when nothing animates them. */
    val notVisible: Set<String> get() = hidden.keys

    /**
     * The view behind `id` was checked at `t`: `reason` is null when it is visible, else why it is not
     * ([Reasons]). Returns the marker to send when that is a change.
     */
    fun update(id: String, reason: String?, t: Long): Marker.Visibility? {
        val was = hidden[id]
        return when {
            reason == null && was != null -> {
                hidden.remove(id)
                Marker.Visibility(t, id, true)
            }
            reason != null && was == null -> {
                hidden[id] = reason
                Marker.Visibility(t, id, false, reason)
            }
            else -> null
        }
    }

    /** The signal went away: nothing more to say about it. */
    fun forget(id: String) {
        hidden.remove(id)
    }

    /** A new recording: every view starts out visible. */
    fun reset() = hidden.clear()

    /**
     * Why a view is not visible, in the order they are checked. The app going to the background is an
     * `appState` marker instead, so it is not one of them.
     */
    object Reasons {
        /** Not in a window any more (its screen was torn down, a list recycled it). */
        const val DETACHED = "detached"
        /** In a window that is not shown: another screen covers it. */
        const val COVERED = "covered"
        /** Itself or a parent not VISIBLE, or at alpha 0. */
        const val HIDDEN = "hidden"
        /** Outside the window, or clipped away by its parents (scrolled out). */
        const val OFFSCREEN = "offscreen"

        /** The reason for a view in this state, or null when it can be seen. */
        fun of(attached: Boolean, windowVisible: Boolean, shown: Boolean, transparent: Boolean, onScreen: Boolean): String? = when {
            !attached -> DETACHED
            !windowVisible -> COVERED
            !shown || transparent -> HIDDEN
            !onScreen -> OFFSCREEN
            else -> null
        }
    }
}
