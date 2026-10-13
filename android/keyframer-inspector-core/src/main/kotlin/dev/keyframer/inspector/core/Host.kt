package dev.keyframer.inspector.core

/*
 * What the session needs from the platform, injected so the whole session runs under JVM tests with
 * a virtual clock. The session is single threaded: every callback below must arrive on the thread the
 * Scheduler runs (the main thread on Android).
 */

fun interface Cancellable {
    fun cancel()
}

/** Runs blocks on the session's thread. */
fun interface Scheduler {
    fun post(delayMs: Long, block: () -> Unit): Cancellable
}

interface Clock {
    /** Monotonic ms. On Android: the Choreographer and MotionEvent timebase (CLOCK_MONOTONIC). */
    fun nowMs(): Double

    /** Wall clock ms, for `at` on animation events (Date.now on React Native). */
    fun wallMs(): Long
}

/** Per-frame callbacks on the session's thread (Choreographer on Android). */
fun interface FrameLoop {
    /**
     * Calls `onFrame(vsyncMs)` at the start of every frame (before animators update, so values written
     * there show in that frame) and `afterFrame(vsyncMs)` once the frame's animations ran (values read
     * there belong to that frame). `vsyncMs` is on the Clock's monotonic timebase.
     */
    fun start(onFrame: (Double) -> Unit, afterFrame: (Double) -> Unit): Cancellable
}

/** Something the app wants recorded and played back: an animator's value, a dragged offset. */
interface Signal {
    val site: SignalSite

    /** The current value, or null when there is none (an animator that never started). */
    fun read(): Double?

    /** Playback and capture write recorded values back. Read-only signals ignore it. */
    fun write(v: Double) {}

    /** Before playback or capture writes into it (an animator pauses). */
    fun hold() {}

    /** After playback or capture is done with it (an animator goes back to how it was). */
    fun release() {}
}

interface Host {
    val appName: String
    val platform: String
    val screen: Screen?
    val canCapture: Boolean
    val frames: FrameLoop

    /** The UI framework, for how the problems engine words its fixes. */
    val framework: String get() = "android-views"

    val osVersion: String? get() = null

    /** "debug" or "release" (a debuggable build runs slower). Null: not sent. */
    val build: String? get() = null

    /**
     * The app's source folder on the developer's machine, sent in the hello: call-site paths
     * (`com/example/app/MainActivity.kt`) resolve against it to open in an editor, and "Apply to code"
     * writes only under it. Null: not sent.
     */
    val root: String? get() = null

    /**
     * The threads this app reports, by role: `js` is the app thread (the main thread, which also runs
     * animators), `ui` the frame thread (RenderThread), left out until it is measured.
     */
    val threads: Map<String, ThreadInfo> get() = linkedMapOf("js" to ThreadInfo("Main", animates = true))

    /** What the panel may ask for. No `scrub` (samples and play-time tracks cover it) and no device `recordings` yet. */
    val capabilities: List<String>
        get() = listOfNotNull(if (canCapture) "capture" else null, "playback", "overrides", "replay", "scenarios")

    /** The display's refresh rate, a starting point for the frame meter. */
    fun refreshRate(): Float = 60f

    /**
     * Touches, screens, app state and the like until the returned handle is cancelled, timed on the
     * Clock's monotonic ms (the session moves them onto the recording's clock). The screen the app is on
     * comes first, as a navigation marker.
     */
    fun watchMarkers(onMarker: (Marker) -> Unit): Cancellable

    /** Takes the app to `route` when it is on another screen. True when the screen changes. */
    fun navigateTo(route: String, params: Map<String, Any?>?): Boolean = false

    /** Snapshots the screen as base64, then calls back with the data or an error. */
    fun capture(format: String, quality: Double, width: Int?, done: (data: String?, error: String?) -> Unit) {
        done(null, "This app does not capture its screen.")
    }

    /** What `replay` runs (re-create the screen, re-fire its entrance). False when there is nothing to run. */
    fun replay(): Boolean = false
}

/** The transport: one JSON InspectorMessage per text frame. */
interface SocketFactory {
    fun open(url: String, listener: SocketListener): InspectorSocket
}

/** Called on any thread; the session hops onto its own. */
interface SocketListener {
    fun onOpen()
    fun onMessage(text: String)
    fun onClosed(reason: String?)
}

interface InspectorSocket {
    fun send(text: String): Boolean
    fun close()
}

/** A scenario an editor (or an agent through the MCP server) can run to reproduce a problem. */
fun interface Scenario {
    /** Call `done` once it finished, with the error when it failed. */
    fun run(done: (Throwable?) -> Unit)
}
