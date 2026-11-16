package dev.keyframer.inspector.core

/**
 * Whether tracked views can be seen, turned into `visibility` markers: one when a view stops being
 * visible (with why) and one when it is visible again. Every view counts as visible until a check says
 * otherwise, so a recording only carries the changes. One tracker lives for one recording. Single
 * threaded.
 */
class VisibilityTracker {
    /** Signal id → why it is not visible, for the ones last reported as not visible. */
    private val hidden = HashMap<String, String>()

    /** Ids last reported as not visible: worth checking again even when nothing animates them. */
    val notVisible: Set<String> get() = hidden.keys

    /** A tracked view, as a round of checks sees it. */
    interface Target {
        /** The signals its values are recorded under. */
        val ids: List<String>

        /** Something animates it now. Idle ones are checked only while reported not visible, to see them come back. */
        val active: Boolean

        /** Why it cannot be seen now ([Reasons]), or null when it can. */
        fun reason(): String?
    }

    /**
     * One round of checks at `t`, returning the markers to send. Only ids the recording gets samples of
     * count (`sampled`: recorded, and reading as numbers): a marker about any other value points at
     * nothing. An id that stops counting, or whose view is not tracked any more, is forgotten, so it
     * starts out visible again if it comes back.
     */
    fun check(t: Long, targets: List<Target>, sampled: (String) -> Boolean): List<Marker.Visibility> {
        val out = ArrayList<Marker.Visibility>()
        val counted = HashSet<String>()
        for (target in targets) {
            if (!target.active && target.ids.none { it in hidden }) continue
            val ids = target.ids.filter(sampled)
            counted.addAll(ids)
            if (ids.isEmpty() || !target.active && ids.none { it in hidden }) continue
            // A view in a state that cannot be measured: checked again next round.
            val reason = try {
                target.reason()
            } catch (_: Throwable) {
                continue
            }
            for (id in ids) update(id, reason, t)?.let(out::add)
        }
        hidden.keys.retainAll(counted)
        return out
    }

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
