package dev.keyframer.vitals.internal

/** `VitalsConfig` of protocol/vitals.ts, as this SDK uses it. */
internal data class Config(
    val enabled: Boolean,
    val sampleRate: Double,
    val minSdkAndroid: String?,
    val collectReduceMotion: Boolean,
    val collectDeviceModel: Boolean,
    val collectDevelopment: Boolean,
    val stop: Boolean,
    val ttlSec: Long,
) {
    companion object {
        /** Before the first config arrives: reporting on, the app's sample rate, models on, Reduce Motion off. */
        fun defaults(sampleRate: Double) = Config(
            enabled = true,
            sampleRate = sampleRate,
            minSdkAndroid = null,
            collectReduceMotion = false,
            collectDeviceModel = true,
            collectDevelopment = true,
            stop = false,
            ttlSec = 86_400,
        )

        /** A config object (already parsed JSON), or null when it is not one. */
        fun from(v: Any?): Config? {
            val m = v as? Map<*, *> ?: return null
            val enabled = m["enabled"] as? Boolean ?: return null
            val rate = (m["sampleRate"] as? Number)?.toDouble() ?: return null
            val collect = m["collect"] as? Map<*, *>
            val minSdk = (m["minSdk"] as? Map<*, *>)?.get(VitalsProtocol.PLATFORM) as? String
            return Config(
                enabled = enabled,
                sampleRate = rate.coerceIn(0.0, 1.0),
                minSdkAndroid = minSdk,
                collectReduceMotion = collect?.get("reduceMotion") as? Boolean ?: false,
                collectDeviceModel = collect?.get("deviceModel") as? Boolean ?: true,
                collectDevelopment = collect?.get("development") as? Boolean ?: false,
                stop = m["stop"] as? Boolean ?: false,
                ttlSec = (m["ttlSec"] as? Number)?.toLong() ?: 86_400,
            )
        }

        /** -1, 0 or 1, comparing dotted versions numerically (`0.1.10` > `0.1.9`); a pre-release sorts first. */
        fun compareVersions(a: String, b: String): Int {
            fun parts(v: String) = v.substringBefore('-').split('.').map { it.toIntOrNull() ?: 0 }
            val pa = parts(a)
            val pb = parts(b)
            for (i in 0 until maxOf(pa.size, pb.size)) {
                val c = (pa.getOrElse(i) { 0 }).compareTo(pb.getOrElse(i) { 0 })
                if (c != 0) return c
            }
            val preA = a.contains('-')
            val preB = b.contains('-')
            return if (preA == preB) 0 else if (preA) -1 else 1
        }
    }
}

/**
 * The project's config on this device, the kill switch, and when to fetch again. A config arrives with
 * every upload response and from GET /v1/config/<key>, fetched at most once a day. `stop: true`, a 401 or
 * a 410 turn the reporter off on this device for 7 days.
 */
internal class ConfigStore(private val store: KeyValue, private val sdkVersion: String) {
    @Volatile private var cached: Config? = null

    /** The last config received, or null before the first one. */
    fun current(): Config? {
        cached?.let { return it }
        val raw = store.getString(KEY_CONFIG) ?: return null
        return runCatching { Config.from(Json.parse(raw)) }.getOrNull().also { cached = it }
    }

    /** Saves a config (a parsed `config` object). `stop: true` turns this device off for 7 days. */
    fun save(config: Any?, nowWallMs: Long) {
        val c = Config.from(config) ?: return
        cached = c
        store.put(KEY_CONFIG, Json.write(config))
        store.put(KEY_FETCHED, nowWallMs)
        if (c.stop) killFor7Days(nowWallMs)
    }

    fun killFor7Days(nowWallMs: Long) {
        store.put(KEY_OFF_UNTIL, nowWallMs + SEVEN_DAYS_MS)
    }

    /** Off on this device: killed within the last 7 days. */
    fun killed(nowWallMs: Long): Boolean = nowWallMs < store.getLong(KEY_OFF_UNTIL, 0)

    /** Reporting is allowed: not killed, the project on, this SDK version not below `minSdk.android`. */
    fun allowed(nowWallMs: Long): Boolean {
        if (killed(nowWallMs)) return false
        val c = current() ?: return true
        if (!c.enabled || c.stop) return false
        val min = c.minSdkAndroid
        return min == null || Config.compareVersions(sdkVersion, min) >= 0
    }

    /** Time to fetch the config again: none yet, or the last is a day old (or past its ttl, if longer). */
    fun stale(nowWallMs: Long): Boolean {
        val at = store.getLong(KEY_FETCHED, 0)
        if (at == 0L || current() == null) return true
        val ttl = maxOf(DAY_MS, (current()?.ttlSec ?: 0) * 1000)
        return nowWallMs - at >= ttl || nowWallMs < at
    }

    companion object {
        const val KEY_CONFIG = "config.json"
        const val KEY_FETCHED = "config.fetchedAt"
        const val KEY_OFF_UNTIL = "off.until"
        const val DAY_MS = 24L * 3600 * 1000
        const val SEVEN_DAYS_MS = 7 * DAY_MS
    }
}
