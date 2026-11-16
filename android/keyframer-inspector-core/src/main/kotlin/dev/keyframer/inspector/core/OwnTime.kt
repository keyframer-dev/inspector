package dev.keyframer.inspector.core

/** Monotonic nanoseconds, returned as a primitive so reading it allocates nothing. */
fun interface NanoClock {
    fun nanos(): Long
}

/**
 * The inspector's own work on the main thread, timed so a frame drop it caused is told from the app's
 * (FrameDrop.inspectorMs). A port of react-native/src/ownTime.ts: animator listeners, sampling and
 * the frame loop, visibility checks, navigation and touch markers, handling the editor's messages,
 * encoding and sending, Compose's trackers, kfAnimateTo's bookkeeping and taking stacks.
 *
 * Each stretch of it is a section: [enter] before, [leave] after (in a finally), or [time] around it.
 * Sections nest and only the outermost is timed, so a report that takes a stack inside an animator's
 * listener counts once. App code the inspector runs on request (a scenario, the app's own replay) is
 * left out with [app]. The time adds up in a running total; the frame meter reads it at every frame,
 * and what it grew by since the frame before is the inspector's part of that one (FrameMeter.tick).
 *
 * Timed only while a frame meter runs ([meter]); otherwise a section is a check of one field. Main
 * thread only: plain fields, nothing allocated per section.
 */
class OwnTime(private val clock: NanoClock = NanoClock { System.nanoTime() }) {
    /** Frame meters reading the total: sections are timed while there is one. */
    private var meters = 0
    /** How many sections are open, and when the outermost began (-1: it is not timed). */
    private var depth = 0
    private var start = -1L
    private var totalNanos = 0L

    /** How long the inspector has worked on this thread while a meter ran, ms: a running total. */
    val totalMs: Double get() = totalNanos / 1e6

    /** The thread starts working for the inspector. Pair it with [leave] in a finally. */
    fun enter() {
        if (depth++ == 0) start = if (meters > 0) clock.nanos() else -1L
    }

    /** The thread is back to the app's code: the outermost section adds its time to the total. */
    fun leave() {
        if (depth == 0) return
        if (--depth == 0 && start >= 0) {
            totalNanos += clock.nanos() - start
            start = -1L
        }
    }

    /** `block`, timed as the inspector's work. */
    inline fun <R> time(block: () -> R): R {
        enter()
        try {
            return block()
        } finally {
            leave()
        }
    }

    /**
     * `block` is the app's work, run by the inspector from inside a section (a scenario, a replay):
     * not timed, though the inspector's own sections inside it are.
     */
    inline fun <R> app(block: () -> R): R {
        val open = pause()
        try {
            return block()
        } finally {
            resume(open)
        }
    }

    /** Closes the open sections for now; returns how many, for [resume]. */
    fun pause(): Int {
        val open = depth
        if (open > 0 && start >= 0) totalNanos += clock.nanos() - start
        depth = 0
        start = -1L
        return open
    }

    /** Opens again the sections [pause] closed. */
    fun resume(open: Int) {
        depth = open
        start = if (open > 0 && meters > 0) clock.nanos() else -1L
    }

    /** A frame meter starts (or stops) reading the total. */
    fun meter(on: Boolean) {
        meters = if (on) meters + 1 else maxOf(0, meters - 1)
    }
}
