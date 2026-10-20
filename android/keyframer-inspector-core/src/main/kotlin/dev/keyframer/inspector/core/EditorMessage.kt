package dev.keyframer.inspector.core

/** What the app reads: InspectorEditorMessage and InspectorPresenceMessage. Anything else is Ignored. */
sealed class EditorMessage {
    data class Hello(val role: String) : EditorMessage()
    data class Overrides(val overrides: Map<String, Map<String, Double>>) : EditorMessage()
    object Replay : EditorMessage()
    /** `recorder`: who is recording (null: the anonymous recorder older editors share). */
    data class Record(val signalIds: List<String>, val on: Boolean, val recorder: String? = null) : EditorMessage()
    data class Scenario(val name: String) : EditorMessage()
    data class Playback(val samples: List<Sample>, val routes: List<Route>) : EditorMessage()
    data class Capture(
        val id: String,
        val samples: List<Sample>,
        val format: String,
        val quality: Double,
        val width: Int?,
        val route: Route?,
    ) : EditorMessage()
    data class Presence(val app: Boolean, val editors: Int, val cli: Boolean) : EditorMessage()
    /**
     * Animation speed: 1 normal, 0.25 a quarter, 0 paused, after [TimeRules] (null: nothing usable, the
     * app only answers). `step`, with a scale of 0: advance this many frames.
     */
    data class Time(val scale: Double?, val step: Int?) : EditorMessage()
    data class Ignored(val type: String?) : EditorMessage()

    companion object {
        /** Null for text that is not a JSON object (the relay's "pong", say). */
        fun parse(text: String): EditorMessage? {
            val m = runCatching { Json.parse(text) }.getOrNull().obj() ?: return null
            return when (val type = m.str("type")) {
                "hello" -> Hello(m.str("role") ?: "")
                "overrides" -> Overrides(
                    m["overrides"].obj().orEmpty().mapValues { (_, params) ->
                        params.obj().orEmpty().mapNotNull { (k, v) -> (v as? Number)?.let { k to it.toDouble() } }.toMap()
                    },
                )
                "replay" -> Replay
                "record" -> Record(m["signalIds"].list().filterIsInstance<String>(), m.bool("on") == true, m.str("recorder"))
                "scenario" -> Scenario(m.str("name") ?: "")
                "playback" -> Playback(samples(m["samples"]), m["routes"].list().mapNotNull { route(it) })
                "capture" -> Capture(
                    id = m.str("id") ?: "",
                    samples = samples(m["samples"]),
                    format = if (m.str("format") == "png") "png" else "jpg",
                    quality = m.num("quality") ?: 0.85,
                    width = m.num("width")?.toInt(),
                    route = route(m["route"]),
                )
                "presence" -> Presence(m.bool("app") == true, m.num("editors")?.toInt() ?: 0, m.bool("cli") == true)
                "time" -> TimeRules.scale(m["scale"]).let { scale -> Time(scale, TimeRules.step(m["step"], scale)) }
                else -> Ignored(type)
            }
        }

        private fun samples(v: Any?): List<Sample> = v.list().mapNotNull { s ->
            val o = s.obj() ?: return@mapNotNull null
            val id = o.str("id") ?: return@mapNotNull null
            val t = o.num("t") ?: return@mapNotNull null
            val value = o.num("v") ?: return@mapNotNull null
            Sample(id, Math.round(t), value)
        }

        private fun route(v: Any?): Route? {
            val o = v.obj() ?: return null
            val name = o.str("route") ?: return null
            return Route(Math.round(o.num("t") ?: 0.0), name, o["params"].obj())
        }
    }
}
