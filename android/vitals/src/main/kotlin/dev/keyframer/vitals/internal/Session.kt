package dev.keyframer.vitals.internal

import java.security.SecureRandom
import kotlin.random.Random

/** The few values the reporter keeps between launches (SharedPreferences on a device, a map in tests). */
internal interface KeyValue {
    fun getString(key: String): String?
    fun getLong(key: String, default: Long): Long
    fun put(key: String, value: String?)
    fun put(key: String, value: Long)
}

internal class MemoryKeyValue : KeyValue {
    val map = HashMap<String, Any?>()
    override fun getString(key: String) = map[key] as? String
    override fun getLong(key: String, default: Long) = map[key] as? Long ?: default
    override fun put(key: String, value: String?) {
        if (value == null) map.remove(key) else map[key] = value
    }
    override fun put(key: String, value: Long) {
        map[key] = value
    }
}

/**
 * Sessions and their windows (production.md 2.1). A session is one foreground period: it ends after
 * 30 s in the background. A window is at most 10 minutes of foreground time; a long session sends
 * several, linked by a random nonce kept in memory only. Sampling is decided once per session, and at
 * most 3 sessions a day report from one device (counted here, never sent).
 *
 * `nowMs` is a monotonic clock that keeps counting while the device sleeps (elapsedRealtime); `day` is
 * the local date, for the daily count only.
 */
internal class Sessions(
    private val store: KeyValue,
    private val random: Random = Random.Default,
) {
    class Session(val nonce: String, val sampleRate: Double, val sampled: Boolean) {
        var seq = 0
            internal set
    }

    var session: Session? = null
        private set
    private var backgroundAtMs = -1L
    private var windowForegroundMs = 0L
    private var sessionForegroundMs = 0L
    private var foregroundSinceMs = -1L

    /** True while the current session reports. */
    val sampled: Boolean get() = session?.sampled == true

    /**
     * The app came to the foreground. Returns true when this starts a new session (none yet, or the
     * last one has been in the background for 30 s or more).
     */
    fun foreground(nowMs: Long, day: String, sampleRate: Double): Boolean {
        val fresh = session == null || backgroundAtMs >= 0 && nowMs - backgroundAtMs >= VitalsProtocol.SESSION_GAP_MS
        if (fresh) {
            session = newSession(day, sampleRate)
            windowForegroundMs = 0
            sessionForegroundMs = 0
        }
        backgroundAtMs = -1
        foregroundSinceMs = nowMs
        return fresh
    }

    /** The app went to the background: foreground time stops. */
    fun background(nowMs: Long) {
        accumulate(nowMs)
        foregroundSinceMs = -1
        backgroundAtMs = nowMs
    }

    private fun accumulate(nowMs: Long) {
        if (foregroundSinceMs >= 0 && nowMs > foregroundSinceMs) {
            windowForegroundMs += nowMs - foregroundSinceMs
            sessionForegroundMs += nowMs - foregroundSinceMs
            foregroundSinceMs = nowMs
        }
    }

    /** Foreground time of the open window. */
    fun windowForegroundMs(nowMs: Long): Long {
        accumulate(nowMs)
        return windowForegroundMs
    }

    /** The open window is full (10 minutes of foreground time). */
    fun windowFull(nowMs: Long): Boolean = windowForegroundMs(nowMs) >= VitalsProtocol.WINDOW_MS

    /** Time left before the open window is full. */
    fun windowLeftMs(nowMs: Long): Long = (VitalsProtocol.WINDOW_MS - windowForegroundMs(nowMs)).coerceAtLeast(0)

    /** The open window was sent: the next one of this session has the next seq. */
    fun windowClosed() {
        session?.let { it.seq++ }
        windowForegroundMs = 0
    }

    /** Ends the session now (setEnabled(false)): the next foreground starts a new one. */
    fun end() {
        session = null
        backgroundAtMs = -1
        foregroundSinceMs = -1
        windowForegroundMs = 0
    }

    private fun newSession(day: String, sampleRate: Double): Session {
        val rate = sampleRate.coerceIn(0.0, 1.0)
        var sampled = random.nextDouble() < rate
        if (sampled) {
            val count = if (store.getString(KEY_DAY) == day) store.getLong(KEY_COUNT, 0) else 0
            if (count >= VitalsProtocol.MAX_SESSIONS_PER_DAY) {
                sampled = false
            } else {
                store.put(KEY_DAY, day)
                store.put(KEY_COUNT, count + 1)
            }
        }
        return Session(newNonce(), rate, sampled)
    }

    companion object {
        const val KEY_DAY = "sessions.day"
        const val KEY_COUNT = "sessions.count"
        private val secure = SecureRandom()

        /** 16 random bytes as 32 hex characters: links one session's windows, nothing else. */
        fun newNonce(): String {
            val b = ByteArray(16)
            secure.nextBytes(b)
            return b.joinToString("") { "%02x".format(it) }
        }
    }
}
