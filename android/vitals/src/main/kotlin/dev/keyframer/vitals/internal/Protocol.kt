package dev.keyframer.vitals.internal

/**
 * Mirrors inspector/protocol/vitals.ts (the wire format every Motion Vitals reporter
 * shares). Keep the two in step; the golden report test checks this SDK's output against the fixture.
 */
internal object VitalsProtocol {
    const val FORMAT = "keyframer-vitals"
    const val VERSION = 1
    const val ENDPOINT = "https://vitals.keyframer.dev"
    const val PLATFORM = "android"
    const val SDK_NAME = "dev.keyframer:vitals"

    /** Frames missed per frame, by lower bound: 0, 1, 2, 3-4, 5-8, 9-16, 17-32, 33+. */
    val BUCKETS = intArrayOf(0, 1, 2, 3, 5, 9, 17, 33)
    const val FROZEN_MS = 700.0
    const val WINDOW_MS = 10L * 60 * 1000
    const val SESSION_GAP_MS = 30L * 1000
    const val MAX_SCREENS = 40
    const val MAX_SITES = 200
    const val MAX_BYTES = 32 * 1024
    const val SCREEN_NAME = 64
    const val MAX_SESSIONS_PER_DAY = 3
    const val DEFAULT_SAMPLE_RATE = 0.1
    /** What this SDK sends of VITALS_LIMITS.worst (10). */
    const val WORST = 5

    /** The bucket a frame that missed `missed` vsyncs falls in. */
    fun bucket(missed: Int): Int {
        var b = 0
        for (i in BUCKETS.indices) if (missed >= BUCKETS[i]) b = i
        return b
    }
}

internal enum class Cause(val wire: String) {
    SCREEN_MOUNT("screen-mount"),
    BURST("burst"),
    SCROLL("scroll"),
    GESTURE("gesture"),
    UNKNOWN("unknown"),
}
