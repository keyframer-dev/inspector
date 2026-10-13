package dev.keyframer.inspector.core

import kotlin.math.max
import kotlin.math.roundToInt
import kotlin.math.roundToLong

/**
 * Counts one thread's frames while a recording runs: its frame rate per window and every long frame.
 * A port of react-native/src/frameMeter.ts. The refresh interval is what most frames of the last
 * window took, snapped to 60/90/120 Hz, so a jittery loop does not read as a faster display.
 */
class FrameMeter(val thread: String, private val windowMs: Double = 250.0) {
    private var interval = 1000.0 / 60
    private var last = -1.0
    private var windowStart = -1.0
    private var frames = 0
    private var dropped = 0
    private var fast = 0
    private var mid = 0

    val stats = ArrayList<FrameStat>()
    val drops = ArrayList<FrameDrop>()

    /** A display that says its own rate (Display.getRefreshRate) starts from it instead of 60 Hz. */
    fun hintRefreshRate(hz: Float) {
        if (hz in 30f..240f) interval = 1000.0 / hz
    }

    /** A frame was drawn at `t` ms (the recording's clock). */
    fun tick(t: Double) {
        val prev = last
        last = t
        if (prev < 0) {
            windowStart = t
            return
        }
        val dt = t - prev
        if (dt <= 0) return
        if (dt < 10.5) fast++ else if (dt < 13) mid++
        val lost = max(0, (dt / interval).roundToInt() - 1)
        if (lost > 0) {
            dropped += lost
            drops.add(FrameDrop(t.roundToLong(), thread, (dt * 10).roundToLong() / 10.0, lost))
        }
        frames++
        val span = t - windowStart
        if (span >= windowMs) {
            stats.add(FrameStat(t.roundToLong(), thread, (frames * 1000 / span).roundToInt(), dropped))
            val n = frames
            interval = if (fast * 2 > n) 1000.0 / 120 else if ((fast + mid) * 2 > n) 1000.0 / 90 else 1000.0 / 60
            frames = 0
            dropped = 0
            fast = 0
            mid = 0
            windowStart = t
        }
    }
}
