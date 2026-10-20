package dev.keyframer.inspector.core

/*
 * The wire protocol, mirrored from protocol/inspector.ts. Field names, order and nullability
 * follow the TypeScript types: a `string | null` field is always present (JsonNull), an optional `?:`
 * field is left out when absent. ProtocolTest pins the JSON of every message this SDK sends.
 */

private fun orNull(v: Any?): Any = v ?: JsonNull

/** InspectorParam: a number the panel can show and tweak live. Android paths are config names ("duration"). */
data class Param(val path: String, val value: Double) : JsonValue {
    override fun toJson() = linkedMapOf("path" to path, "value" to value)
}

/** InspectorCallSite. `column` is 0 on Android: JVM stack frames carry only a line. */
data class CallSite(
    val id: String,
    val file: String,
    val line: Int,
    val column: Int,
    val fn: String,
    val component: String?,
    val target: String?,
    val prop: String?,
    val params: List<Param>,
) : JsonValue {
    override fun toJson() = linkedMapOf<String, Any?>(
        "id" to id,
        "file" to file,
        "line" to line,
        "column" to column,
        "fn" to fn,
        "component" to orNull(component),
        "target" to orNull(target),
        "prop" to orNull(prop),
        "params" to params,
    )
}

/**
 * InspectorSignalSite: a value the panel can record and play back. `column` is 0 on the JVM (frames
 * carry only a line); `writable` is false for values playback cannot set (an animator's own value,
 * which replays through its `:time` track). `prop`: the property it animates, when the SDK knows it
 * (an ObjectAnimator's: alpha, translationY), so the problems engine can tell a fade from a move.
 */
data class SignalSite(
    val id: String,
    val file: String,
    val line: Int,
    val component: String?,
    val name: String?,
    val column: Int? = 0,
    val writable: Boolean? = null,
    val kind: String? = null,
    val prop: String? = null,
) : JsonValue {
    override fun toJson() = linkedMapOf<String, Any?>(
        "id" to id,
        "file" to file,
        "line" to line,
        "column" to column,
        "component" to orNull(component),
        "name" to orNull(name),
        "kind" to kind,
        "prop" to prop,
        "writable" to writable,
    )
}

/** InspectorThreadInfo: what a thread is called on this platform, and whether animations run on it. */
data class ThreadInfo(val label: String, val animates: Boolean? = null) : JsonValue {
    override fun toJson() = linkedMapOf<String, Any?>("label" to label, "animates" to animates)
}

/**
 * InspectorDisplay: the refresh rate frames are counted against. `adaptive` when the display has several
 * rates and switches between them (Android's variable refresh): `hz` is then the highest.
 */
data class DisplayInfo(val hz: Double, val adaptive: Boolean = false) : JsonValue {
    override fun toJson() = linkedMapOf<String, Any?>("hz" to hz, "adaptive" to (if (adaptive) true else null))
}

/** InspectorAccessibility. On Android, Reduce Motion is "Remove animations": an animator duration scale of 0. */
data class AccessibilityInfo(val reduceMotion: Boolean) : JsonValue {
    override fun toJson() = linkedMapOf<String, Any?>("reduceMotion" to reduceMotion)
}

/**
 * InspectorDevice: which device the app runs on, so a relay or a CI run can tell two apps apart. On an
 * emulator, `id` is the AVD name and `name` the same in readable form. A physical device sends only its
 * `model` and `simulator: false`, never the name its owner gave it: recordings get shared.
 */
data class DeviceInfo(val name: String? = null, val model: String? = null, val id: String? = null, val simulator: Boolean? = null) : JsonValue {
    override fun toJson() = linkedMapOf<String, Any?>("name" to name, "model" to model, "id" to id, "simulator" to simulator)
}

/** The SDK, as `hello` names it. */
object Sdk {
    const val NAME = "keyframer-inspector"
    const val VERSION = "0.1.0"
    /** The protocol version this SDK speaks. */
    const val PROTOCOL = 1
}

/** InspectorStackFrame. */
data class StackFrame(val methodName: String, val file: String, val lineNumber: Int, val column: Int, val collapse: Boolean = false) : JsonValue {
    override fun toJson() = linkedMapOf<String, Any?>(
        "methodName" to methodName,
        "file" to file,
        "lineNumber" to lineNumber,
        "column" to column,
        "collapse" to (if (collapse) true else null),
    )
}

/** InspectorEvent. */
sealed class Event : JsonValue {
    data class Anim(
        val eid: Int,
        val site: CallSite,
        val at: Long,
        val args: List<Any?>,
        /** "js", the app thread: on Android the main thread, where animators run. */
        val thread: String = "js",
        val t: Long? = null,
        val stack: String? = null,
        /** The stack already mapped to source, while recording. */
        val frames: List<StackFrame>? = null,
        /** Delay plus every repeat, when it ends at all (null for an infinite animator). */
        val durationMs: Long? = null,
    ) : Event() {
        override fun toJson() = linkedMapOf<String, Any?>(
            "kind" to "anim",
            "eid" to eid,
            "site" to site,
            "at" to at,
            "args" to args,
            "thread" to thread,
            "t" to t,
            "stack" to stack,
            "frames" to frames,
            "durationMs" to durationMs,
        )
    }

    /**
     * A value that went away (its screen closed): it leaves the panel's catalog. `t`, while recording:
     * when, on the recording's clock (its history ends there; a remount starts a new one).
     */
    data class Unsignal(val id: String, val t: Long? = null) : Event() {
        override fun toJson() = linkedMapOf("kind" to "unsignal", "id" to id, "t" to t)
    }

    /** A value registered. `t`, while recording: when (a screen made again registers its values again). */
    data class Signal(val site: SignalSite, val t: Long? = null) : Event() {
        override fun toJson() = linkedMapOf("kind" to "signal", "site" to site, "t" to t)
    }

    /**
     * InspectorRenderHint: something about how an animated view is drawn that costs the frame more than
     * it needs to. `id` is the signal it belongs to, `hint` a key the problems engine words a fix for.
     * Sent once per view and hint.
     */
    data class RenderHint(val id: String, val hint: String, val detail: String? = null) : Event() {
        override fun toJson() = linkedMapOf("kind" to "renderHint", "id" to id, "hint" to hint, "detail" to detail)
    }
}

/** InspectorSample. */
data class Sample(val id: String, val t: Long, val v: Double) : JsonValue {
    override fun toJson() = linkedMapOf("id" to id, "t" to t, "v" to v)
}

/** InspectorFrameStat. `thread` is "js" for the Android main thread, the app thread (see README, threads). */
data class FrameStat(val t: Long, val thread: String, val fps: Int, val dropped: Int) : JsonValue {
    override fun toJson() = linkedMapOf("t" to t, "thread" to thread, "fps" to fps, "dropped" to dropped)
}

/** InspectorFrameDrop. */
data class FrameDrop(val t: Long, val thread: String, val ms: Double, val dropped: Int) : JsonValue {
    override fun toJson() = linkedMapOf("t" to t, "thread" to thread, "ms" to ms, "dropped" to dropped)
}

/** InspectorRoute. */
data class Route(val t: Long, val route: String, val params: Map<String, Any?>? = null) : JsonValue {
    override fun toJson() = linkedMapOf("t" to t, "route" to route, "params" to params)
}

/** InspectorMarker. Coordinates are screen points (dp on Android). */
sealed class Marker : JsonValue {
    abstract val t: Long

    data class Touch(override val t: Long, val phase: String, val id: Int, val x: Double, val y: Double, val lost: Boolean = false) : Marker() {
        override fun toJson() = linkedMapOf<String, Any?>(
            "kind" to "touch",
            "t" to t,
            "phase" to phase,
            "id" to id,
            "x" to x,
            "y" to y,
            "lost" to (if (lost) true else null),
        )
    }

    data class Navigation(override val t: Long, val route: String, val params: Map<String, Any?>? = null) : Marker() {
        override fun toJson() = linkedMapOf("kind" to "navigation", "t" to t, "route" to route, "params" to params)
    }

    data class AppState(override val t: Long, val state: String) : Marker() {
        override fun toJson() = linkedMapOf("kind" to "appState", "t" to t, "state" to state)
    }

    data class Keyboard(override val t: Long, val visible: Boolean, val height: Int) : Marker() {
        override fun toJson() = linkedMapOf("kind" to "keyboard", "t" to t, "visible" to visible, "height" to height)
    }

    data class Log(override val t: Long, val level: String, val message: String, val stack: String? = null) : Marker() {
        override fun toJson() = linkedMapOf("kind" to "log", "t" to t, "level" to level, "message" to message, "stack" to stack)
    }

    data class Note(override val t: Long, val text: String) : Marker() {
        override fun toJson() = linkedMapOf("kind" to "note", "t" to t, "text" to text)
    }

    /** Remove animations was turned on or off while recording. */
    data class Accessibility(override val t: Long, val reduceMotion: Boolean) : Marker() {
        override fun toJson() = linkedMapOf("kind" to "accessibility", "t" to t, "reduceMotion" to reduceMotion)
    }

    /** The display's refresh rate changed while recording: frames from here on are counted against `hz`. */
    data class Display(override val t: Long, val hz: Double) : Marker() {
        override fun toJson() = linkedMapOf("kind" to "display", "t" to t, "hz" to hz)
    }

    /**
     * A tracked view left the screen or came back. `id` is the signal its value is recorded under;
     * `reason` (when it is not visible): offscreen, hidden, detached or covered.
     */
    data class Visibility(override val t: Long, val id: String, val visible: Boolean, val reason: String? = null) : Marker() {
        override fun toJson() = linkedMapOf("kind" to "visibility", "t" to t, "id" to id, "visible" to visible, "reason" to reason)
    }

    /**
     * The editor changed the animation speed while recording: 1 normal, 0.25 a quarter, 0 paused.
     * `step`, while paused: the app advanced this many frames at `t` (one marker per step).
     */
    data class Time(override val t: Long, val scale: Double, val step: Int? = null) : Marker() {
        override fun toJson() = linkedMapOf("kind" to "time", "t" to t, "scale" to scale, "step" to step)
    }

    fun shifted(by: Long): Marker = when (this) {
        is Touch -> copy(t = t + by)
        is Navigation -> copy(t = t + by)
        is AppState -> copy(t = t + by)
        is Keyboard -> copy(t = t + by)
        is Log -> copy(t = t + by)
        is Note -> copy(t = t + by)
        is Accessibility -> copy(t = t + by)
        is Display -> copy(t = t + by)
        is Visibility -> copy(t = t + by)
        is Time -> copy(t = t + by)
    }
}

data class Screen(val width: Double, val height: Double, val scale: Double) : JsonValue {
    override fun toJson() = linkedMapOf("width" to width, "height" to height, "scale" to scale)
}

/** InspectorAppMessage: app → editors. */
sealed class AppMessage : JsonValue {
    data class Hello(
        val app: String,
        val platform: String,
        val capture: Boolean,
        val screen: Screen?,
        val scenarios: List<String>,
        val framework: String? = null,
        val osVersion: String? = null,
        /** "debug" or "release": frame times in a debuggable build are inflated. */
        val build: String? = null,
        val threads: Map<String, ThreadInfo>? = null,
        val capabilities: List<String>? = null,
        val protocol: Int = Sdk.PROTOCOL,
        val root: String? = null,
        val sdk: Map<String, String> = linkedMapOf("name" to Sdk.NAME, "version" to Sdk.VERSION),
        val display: DisplayInfo? = null,
        val accessibility: AccessibilityInfo? = null,
        val device: DeviceInfo? = null,
    ) : AppMessage() {
        override fun toJson() = linkedMapOf<String, Any?>(
            "type" to "hello",
            "role" to "app",
            "app" to app,
            "platform" to platform,
            "capture" to capture,
            "screen" to screen,
            "scenarios" to scenarios,
            "protocol" to protocol,
            "sdk" to sdk,
            "framework" to framework,
            "osVersion" to osVersion,
            "build" to build,
            "threads" to threads,
            "capabilities" to capabilities,
            "root" to root,
            "display" to display,
            "accessibility" to accessibility,
            "device" to device,
        )
    }

    data class Scenarios(val names: List<String>) : AppMessage() {
        override fun toJson() = linkedMapOf("type" to "scenarios", "names" to names)
    }

    data class ScenarioDone(val name: String, val ms: Long, val error: String? = null) : AppMessage() {
        override fun toJson() = linkedMapOf("type" to "scenarioDone", "name" to name, "ms" to ms, "error" to error)
    }

    data class Events(val events: List<Event>) : AppMessage() {
        override fun toJson() = linkedMapOf("type" to "events", "events" to events)
    }

    /** Empty lists are left out, as the React Native client does (`samples` is always there). */
    data class Samples(
        val samples: List<Sample>,
        val frames: List<FrameStat> = emptyList(),
        val drops: List<FrameDrop> = emptyList(),
        val markers: List<Marker> = emptyList(),
    ) : AppMessage() {
        override fun toJson() = linkedMapOf<String, Any?>(
            "type" to "samples",
            "samples" to samples,
            "frames" to frames.ifEmpty { null },
            "drops" to drops.ifEmpty { null },
            "markers" to markers.ifEmpty { null },
        )
    }

    data class Frame(val id: String, val data: String? = null, val format: String? = null, val error: String? = null) : AppMessage() {
        override fun toJson() = linkedMapOf("type" to "frame", "id" to id, "data" to data, "format" to format, "error" to error)
    }

    /** The animation speed now in effect, after a `time` message (or after hello, when it is not 1). */
    data class Time(val scale: Double) : AppMessage() {
        override fun toJson() = linkedMapOf("type" to "time", "scale" to scale)
    }
}
