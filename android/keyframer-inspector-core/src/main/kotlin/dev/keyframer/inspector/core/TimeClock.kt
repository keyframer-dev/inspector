package dev.keyframer.inspector.core

/**
 * Animation time under the editor's `time` control: the real frame clock run at [scale] times its speed,
 * held while paused (scale 0), and moved on one frame per [step] while held. A change of speed re-anchors
 * at the moment it happens, so animation time never jumps: a quarter speed from here on, not "as if it
 * had always been a quarter".
 *
 * Until the first change it is the real clock, untouched. Afterwards it may lag the real clock by
 * however long it was slowed or paused; animations only look at differences between frames, so that is
 * fine. Several consumers can ask about one frame (the views driver, Compose's frame clock): [frame] is
 * idempotent for a given frame time, so a step is taken once per frame, by whoever asks first.
 *
 * Times are ms on one monotonic clock (Choreographer's frame times on Android). Single threaded.
 */
class TimeClock {
    /** 1 is normal, 0.25 a quarter of the speed, 0 paused. */
    var scale = 1.0
        private set

    /** One frame at the display's rate: what a step moves on. */
    var frameMs = 1000.0 / 60

    private var anchored = false
    private var realAt = 0.0
    private var virtualAt = 0.0
    private var steps = 0
    private var lastReal = Double.NaN
    private var lastVirtual = 0.0

    /** Frames still to step while paused. */
    val pendingSteps: Int get() = steps

    /** Whether time runs at anything but the real clock's pace. */
    val controlled: Boolean get() = scale != 1.0 || steps > 0

    /** Never changed: animation time is the real clock, exactly (consumers can pass real times through). */
    val untouched: Boolean get() = !anchored

    /** Animation time at real time `now`, without taking a step. */
    fun at(now: Double): Double {
        if (now == lastReal) return lastVirtual
        return if (anchored) virtualAt + (now - realAt) * scale else now
    }

    /** From real time `now` on, run at `scale`. Steps still pending are dropped unless it stays paused. */
    fun setScale(scale: Double, now: Double) {
        val s = if (scale.isFinite()) scale.coerceAtLeast(0.0) else 1.0
        val v = at(now)
        anchored = true
        realAt = now
        virtualAt = v
        if (now == lastReal) lastVirtual = v
        this.scale = s
        if (s != 0.0) steps = 0
    }

    /** While paused: move on `frames` frames, one per real frame. Ignored while running. */
    fun step(frames: Int) {
        if (scale == 0.0 && frames > 0) steps += frames
    }

    /**
     * The animation time of the frame drawn at real time `now`. While stepping, each new frame moves one
     * frame on; asking again about the same frame gives the same answer.
     */
    fun frame(now: Double): Double {
        if (now == lastReal) return lastVirtual
        var v = at(now)
        if (steps > 0 && scale == 0.0) {
            steps--
            v += frameMs
            realAt = now
            virtualAt = v
        }
        lastReal = now
        lastVirtual = v
        return v
    }
}

/**
 * What a `time` message may ask for, the same in every SDK: a scale that is missing, not a number,
 * NaN, infinite or negative is ignored (but still answered with the speed in effect); 0 pauses; above
 * 0 it runs from 0.01 to 4. A step counts only while paused (a scale of 0): whole frames, floored,
 * from 1 to 120.
 */
object TimeRules {
    const val MIN_SCALE = 0.01
    const val MAX_SCALE = 1.0
    const val MAX_STEP = 120

    /** The speed to run at, or null when the message asks for nothing usable. */
    fun scale(raw: Any?): Double? {
        val v = (raw as? Number)?.toDouble() ?: return null
        if (!v.isFinite() || v < 0) return null
        return if (v == 0.0) 0.0 else v.coerceIn(MIN_SCALE, MAX_SCALE)
    }

    /** Frames to step, or null: only when the message's own scale is 0. */
    fun step(raw: Any?, scale: Double?): Int? {
        if (scale != 0.0) return null
        val v = (raw as? Number)?.toDouble()?.takeIf { it.isFinite() } ?: return null
        val frames = kotlin.math.floor(v)
        if (frames < 1) return null
        return frames.coerceAtMost(MAX_STEP.toDouble()).toInt()
    }
}
