package dev.keyframer.vitals.internal

/** What a report says about the app (`VitalsReport.app`). */
internal data class AppInfo(
    val id: String?,
    val version: String,
    val build: String?,
    val framework: String?,
    val environment: String,
    val debugId: String?,
)

/** `VitalsReport.device`: model only when the project allows it. */
internal data class DeviceInfo(val osMajor: Int, val model: String?, val tier: String?, val memoryGb: Int?)

/** `VitalsReport.state`: each flag true if it was true at any time in the window. */
internal class WindowState {
    var reduceMotion = false
    var lowPower = false
    /** 0 nominal, 1 fair, 2 serious, 3 critical; -1 unknown (before API 29). */
    var thermal = -1

    fun reset() {
        reduceMotion = false
        lowPower = false
        thermal = -1
    }

    companion object {
        val THERMAL = listOf("nominal", "fair", "serious", "critical")
    }
}

/** Builds `VitalsReport` JSON (protocol/vitals.ts) from a window's snapshot. */
internal object Encoder {
    fun report(
        app: AppInfo,
        sdkVersion: String,
        device: DeviceInfo,
        displayHz: Int,
        adaptive: Boolean?,
        state: WindowState,
        collectReduceMotion: Boolean,
        nonce: String,
        seq: Int,
        sampleRate: Double,
        foregroundMs: Long,
        ended: String,
        snap: Recorder.Snapshot,
    ): Map<String, Any?> {
        val appMap = linkedMapOf<String, Any?>()
        app.id?.let { appMap["id"] = it }
        appMap["version"] = app.version
        app.build?.let { appMap["build"] = it }
        appMap["platform"] = VitalsProtocol.PLATFORM
        app.framework?.let { appMap["framework"] = it }
        appMap["environment"] = app.environment
        app.debugId?.let { appMap["debugId"] = it }

        val deviceMap = linkedMapOf<String, Any?>("os" to "android", "osMajor" to device.osMajor)
        device.model?.let { deviceMap["model"] = it }
        device.tier?.let { deviceMap["tier"] = it }
        device.memoryGb?.let { deviceMap["memoryGb"] = it }

        val displayMap = linkedMapOf<String, Any?>("hz" to displayHz)
        adaptive?.let { displayMap["adaptive"] = it }
        displayMap["targetHz"] = snap.targetHz ?: displayHz

        // Screen time and measured time come from other clocks than foreground time: never above it.
        val screens = snap.screens.map { sc ->
            val ms = (sc["ms"] as Number).toLong()
            if (ms > foregroundMs) LinkedHashMap(sc).apply { put("ms", foregroundMs) } else sc
        }
        val measured = minOf(Math.round(snap.measuredMs), foregroundMs)

        val stateMap = linkedMapOf<String, Any?>()
        if (collectReduceMotion) stateMap["reduceMotion"] = state.reduceMotion
        stateMap["lowPower"] = state.lowPower
        if (state.thermal >= 0) stateMap["thermal"] = WindowState.THERMAL[state.thermal.coerceIn(0, 3)]

        return linkedMapOf(
            "format" to VitalsProtocol.FORMAT,
            "version" to VitalsProtocol.VERSION,
            "app" to appMap,
            "sdk" to linkedMapOf("name" to VitalsProtocol.SDK_NAME, "version" to sdkVersion),
            "device" to deviceMap,
            "display" to displayMap,
            "state" to stateMap,
            "session" to linkedMapOf(
                "nonce" to nonce,
                "seq" to seq,
                "sampleRate" to sampleRate,
                "foregroundMs" to foregroundMs,
                "measuredMs" to measured,
                "ended" to ended,
            ),
            "screens" to screens,
            "sites" to snap.sites,
            "worst" to snap.worst,
        )
    }

    /**
     * The report as JSON within the 32 KB cap: when over, the sites that drew the fewest frames go
     * first (worst frames keep pointing at the right ones).
     */
    @Suppress("UNCHECKED_CAST")
    fun encode(report: Map<String, Any?>): String {
        var json = Json.write(report)
        if (json.utf8Length() <= VitalsProtocol.MAX_BYTES) return json
        val sites = report["sites"] as List<Map<String, Any?>>
        val ranked = sites.indices.sortedByDescending { (sites[it]["frames"] as Int) + (sites[it]["missed"] as Int) }
        var keep = sites.size
        while (keep > 0) {
            keep /= 2
            val kept = ranked.take(keep).sorted()
            val remap = kept.withIndex().associate { (newIdx, old) -> old to newIdx }
            val worst = (report["worst"] as List<Map<String, Any?>>).map { w ->
                LinkedHashMap(w).apply { put("sites", (w["sites"] as List<Int>).mapNotNull { remap[it] }) }
            }
            val next = LinkedHashMap(report).apply {
                put("sites", kept.map { sites[it] })
                put("worst", worst)
            }
            json = Json.write(next)
            if (json.utf8Length() <= VitalsProtocol.MAX_BYTES) return json
        }
        return json
    }

    private fun String.utf8Length(): Int = toByteArray(Charsets.UTF_8).size
}
