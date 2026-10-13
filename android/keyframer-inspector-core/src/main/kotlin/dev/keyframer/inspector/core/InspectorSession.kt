package dev.keyframer.inspector.core

import java.net.URLEncoder
import kotlin.math.max
import kotlin.math.roundToLong

/**
 * The app's side of the live inspector, a port of react-native/src/client.ts (connectInspector)
 * onto an injected platform. Same behaviour and message order:
 *
 *   - on open: `hello`, then everything queued (the catalog of signals first);
 *   - events (animations, signals) batched every [batchMs];
 *   - `record` samples the listed signals every frame, with the frame meter and markers riding along
 *     in `samples` batches; `['*']` includes signals that register while recording;
 *   - `playback` writes recorded samples back in time order, navigating along the recorded routes;
 *   - `capture` shows one set of samples, waits for the screen, snapshots it and answers with `frame`;
 *   - `scenario`, `replay` and `overrides` as on React Native;
 *   - a new editor (a `presence` with more editors, or an editor `hello` the relay forwards) gets the
 *     app's hello and the catalog again;
 *   - reconnects with a backoff from 500 ms to 10 s.
 *
 * Single threaded: construct it and call it on the Scheduler's thread.
 */
class InspectorSession(
    private val url: String,
    private val sockets: SocketFactory,
    private val scheduler: Scheduler,
    private val clock: Clock,
    private val host: Host,
    private val batchMs: Long = 100,
) {
    companion object {
        const val MAX_QUEUED_EVENTS = 2000
        const val MAX_QUEUED_SAMPLES = 20_000
        const val MAX_BACKOFF_MS = 10_000L
        /** After a screen change during capture, how long the transition gets before the snapshot. */
        const val ROUTE_SETTLE_MS = 700L
        /** Held signals go back to how they were this long after the last capture of an export. */
        const val CAPTURE_RELEASE_MS = 600L

        /** `ws://host:port/app?name=<app>&platform=<platform>`: the desktop relay's app endpoint. */
        fun relayUrl(host: String, port: Int, app: String, platform: String = "android"): String {
            val enc = { s: String -> URLEncoder.encode(s, "UTF-8").replace("+", "%20") }
            val h = if (host.contains(':') && !host.startsWith("[")) "[$host]" else host
            return "ws://$h:$port/app?name=${enc(app)}&platform=${enc(platform)}"
        }
    }

    private val signals = LinkedHashMap<String, Signal>()
    private val catalog = LinkedHashMap<String, Event>()
    private val scenarios = LinkedHashMap<String, Scenario>()

    private var queue = ArrayList<Event>()
    private var samples = ArrayList<Sample>()
    private var frameStats = ArrayList<FrameStat>()
    private var drops = ArrayList<FrameDrop>()
    private var markers = ArrayList<Marker>()

    private var nextEid = 1
    var overrides: Map<String, Map<String, Double>> = emptyMap()
        private set
    /** Called when an editor changes the live overrides (the Android layer applies them to animators). */
    var onOverrides: ((Map<String, Map<String, Double>>) -> Unit)? = null

    private var socket: InspectorSocket? = null
    private var open = false
    private var disposed = false
    private var backoff = 500L
    private var editors = 0
    private var reconnect: Cancellable? = null
    private var flushTimer: Cancellable? = null

    /** Whether a relay connection is open. */
    val connected: Boolean get() = open

    // ── frames: one platform loop shared by sampling, the meter, playback and capture ─────────────
    private val frameConsumers = LinkedHashSet<FrameConsumer>()
    private var frameLoop: Cancellable? = null

    private interface FrameConsumer {
        fun onFrame(vsync: Double) {}
        fun afterFrame(vsync: Double) {}
    }

    private fun addFrames(c: FrameConsumer) {
        frameConsumers.add(c)
        if (frameLoop == null) {
            frameLoop = host.frames.start(
                { v -> for (f in frameConsumers.toList()) f.onFrame(v) },
                { v -> for (f in frameConsumers.toList()) f.afterFrame(v) },
            )
        }
    }

    private fun removeFrames(c: FrameConsumer) {
        frameConsumers.remove(c)
        if (frameConsumers.isEmpty()) {
            frameLoop?.cancel()
            frameLoop = null
        }
    }

    // ── public API (the Android layer calls these) ────────────────────────────────────────────────

    fun start() {
        flushTimer = repeat(batchMs) { flush() }
        connect()
    }

    /** Adds a signal, or replaces the one with the same id (a screen re-created: same call site, new value). */
    fun addSignal(signal: Signal) {
        signals[signal.site.id] = signal
        enqueue(Event.Signal(signal.site))
    }

    /** A signal went away (its screen closed, or it was untracked): editors drop it from their catalog. */
    fun removeSignal(id: String) {
        if (signals.remove(id) == null) return
        catalog.remove("signal:$id")
        recording.remove(id)
        enqueue(Event.Unsignal(id))
    }

    fun signal(id: String): Signal? = signals[id]

    /**
     * An animation started. `stack` is the stack of the call that started it: while recording it rides
     * along as frames (`t` places it on the recording's clock).
     */
    fun reportAnim(site: CallSite, args: List<Any?>, stack: Array<StackTraceElement>? = null, durationMs: Long? = null): Int {
        val eid = nextEid++
        val recordingNow = isRecording
        enqueue(
            Event.Anim(
                eid = eid,
                site = site,
                at = clock.wallMs(),
                args = args,
                thread = "js",
                t = if (recordingNow) elapsed() else null,
                frames = if (recordingNow && stack != null) CallSites.frames(stack) else null,
                durationMs = durationMs,
            ),
        )
        return eid
    }

    fun registerScenario(name: String, scenario: Scenario): () -> Unit {
        scenarios[name] = scenario
        sendRaw(AppMessage.Scenarios(scenarios.keys.toList()))
        return {
            if (scenarios[name] === scenario) {
                scenarios.remove(name)
                sendRaw(AppMessage.Scenarios(scenarios.keys.toList()))
            }
        }
    }

    fun dispose() {
        disposed = true
        flushTimer?.cancel()
        reconnect?.cancel()
        stopPlayback()
        releaseCapture()
        if (isRecording) setRecording(listOf("*"), false)
        frameLoop?.cancel()
        frameLoop = null
        frameConsumers.clear()
        socket?.close()
        socket = null
        open = false
    }

    // ── queue and flush ──────────────────────────────────────────────────────────────────────────

    private fun enqueue(e: Event) {
        if (e is Event.Signal) {
            catalog["signal:${e.site.id}"] = e
            // A signal registered while recording is new or replaces one; recording everything, it joins.
            if (recordAll) recording.add(e.site.id)
        }
        queue.add(e)
        if (queue.size > MAX_QUEUED_EVENTS) queue = ArrayList(queue.subList(queue.size - MAX_QUEUED_EVENTS, queue.size))
    }

    private fun sendRaw(msg: JsonValue): Boolean {
        val s = socket ?: return false
        if (!open) return false
        return s.send(Json.encode(msg))
    }

    fun flush() {
        if (!open) return
        if (queue.isNotEmpty()) {
            sendRaw(AppMessage.Events(queue))
            queue = ArrayList()
        }
        if (samples.isNotEmpty() || frameStats.isNotEmpty() || drops.isNotEmpty() || markers.isNotEmpty()) {
            sendRaw(AppMessage.Samples(samples, frameStats, drops, markers))
            samples = ArrayList()
            frameStats = ArrayList()
            drops = ArrayList()
            markers = ArrayList()
        }
    }

    private fun hello() = AppMessage.Hello(
        app = host.appName,
        platform = host.platform,
        capture = host.canCapture,
        screen = host.screen,
        scenarios = scenarios.keys.toList(),
        framework = host.framework,
        osVersion = host.osVersion,
        build = host.build,
        threads = host.threads,
        capabilities = host.capabilities,
        root = host.root,
    )

    // ── connection ───────────────────────────────────────────────────────────────────────────────

    private fun connect() {
        if (disposed) return
        var mine: InspectorSocket? = null
        val listener = object : SocketListener {
            override fun onOpen() = onSession { if (socket === mine) opened() }
            override fun onMessage(text: String) = onSession { if (socket === mine) handle(text) }
            override fun onClosed(reason: String?) = onSession { if (socket === mine) closed() }
        }
        mine = sockets.open(url, listener)
        socket = mine
    }

    private fun onSession(block: () -> Unit) {
        scheduler.post(0) { if (!disposed) block() }
    }

    private fun opened() {
        open = true
        backoff = 500
        sendRaw(hello())
        flush()
    }

    private fun closed() {
        open = false
        socket = null
        editors = 0
        if (disposed) return
        reconnect = scheduler.post(backoff) { connect() }
        backoff = minOf(backoff * 2, MAX_BACKOFF_MS)
    }

    private fun handle(text: String) {
        when (val msg = EditorMessage.parse(text) ?: return) {
            is EditorMessage.Overrides -> {
                overrides = msg.overrides
                onOverrides?.invoke(overrides)
            }
            EditorMessage.Replay -> host.replay()
            is EditorMessage.Record -> setRecording(msg.signalIds, msg.on)
            is EditorMessage.Playback -> playback(msg.samples, msg.routes)
            is EditorMessage.Capture -> capture(msg)
            is EditorMessage.Scenario -> runScenario(msg.name)
            is EditorMessage.Presence -> {
                // A new editor missed the one-off signal reports: send it the catalog.
                if (msg.editors > editors && catalog.isNotEmpty()) sendRaw(AppMessage.Events(catalog.values.toList()))
                editors = msg.editors
            }
            is EditorMessage.Hello -> if (msg.role == "editor") {
                // A relay that forwards an editor's hello instead of sending presence: same answer.
                sendRaw(hello())
                if (catalog.isNotEmpty()) sendRaw(AppMessage.Events(catalog.values.toList()))
            }
            is EditorMessage.Ignored -> Unit
        }
    }

    // ── record ───────────────────────────────────────────────────────────────────────────────────

    private val recording = LinkedHashSet<String>()
    private var recordAll = false
    private var recordStart = 0.0
    private var meter: FrameMeter? = null
    private var unwatchMarkers: Cancellable? = null

    /** Ms since recording started, on the recording's clock. */
    private fun elapsed(): Long = max(0L, (clock.nowMs() - recordStart).roundToLong())

    /** Recording `['*']` counts with no signal yet: frames, markers and animations are recorded all the same. */
    val isRecording: Boolean get() = recording.isNotEmpty() || recordAll

    private val recorder = object : FrameConsumer {
        override fun onFrame(vsync: Double) {
            val m = meter ?: return
            m.tick(vsync - recordStart)
            if (m.stats.isNotEmpty()) frameStats.addAll(m.stats).also { m.stats.clear() }
            if (m.drops.isNotEmpty()) drops.addAll(m.drops).also { m.drops.clear() }
        }

        override fun afterFrame(vsync: Double) {
            if (samples.size >= MAX_QUEUED_SAMPLES) return
            val t = max(0L, (vsync - recordStart).roundToLong())
            for (id in recording) {
                val v = signals[id]?.read() ?: continue
                if (v.isFinite()) samples.add(Sample(id, t, v))
            }
        }
    }

    fun setRecording(ids: List<String>, on: Boolean) {
        val was = isRecording
        val all = "*" in ids
        if (on) {
            if (!was) recordStart = clock.nowMs()
            if (all) recordAll = true
            recording.addAll(if (all) signals.keys else ids)
        } else if (all) {
            recordAll = false
            recording.clear()
        } else {
            recording.removeAll(ids.toSet())
        }
        val now = isRecording
        if (was == now) return
        if (now) {
            meter = FrameMeter("js").also { it.hintRefreshRate(host.refreshRate()) }
            addFrames(recorder)
            val shift = -recordStart.roundToLong()
            unwatchMarkers = host.watchMarkers { m ->
                if (markers.size < MAX_QUEUED_EVENTS) markers.add(m.shifted(shift).let { if (it.t < 0) it.shifted(-it.t) else it })
            }
        } else {
            meter = null
            removeFrames(recorder)
            unwatchMarkers?.cancel()
            unwatchMarkers = null
        }
    }

    // ── playback ─────────────────────────────────────────────────────────────────────────────────

    private var playing: FrameConsumer? = null
    private val held = LinkedHashSet<Signal>()

    private fun hold(s: Signal) {
        if (held.add(s)) s.hold()
    }

    private fun releaseHeld() {
        for (s in held) s.release()
        held.clear()
    }

    private fun stopPlayback() {
        playing?.let { removeFrames(it) }
        playing = null
    }

    fun playback(recorded: List<Sample>, routes: List<Route> = emptyList()) {
        stopPlayback()
        releaseHeld()
        val ordered = recorded.sortedBy { it.t }
        val screens = routes.sortedBy { it.t }
        if (ordered.isEmpty()) {
            screens.firstOrNull()?.let { host.navigateTo(it.route, it.params) }
            return
        }
        val t0 = minOf(ordered.first().t, screens.firstOrNull()?.t ?: Long.MAX_VALUE)
        val start = clock.nowMs()
        var i = 0
        var r = 0
        val consumer = object : FrameConsumer {
            override fun onFrame(vsync: Double) {
                val at = clock.nowMs() - start
                while (r < screens.size && screens[r].t - t0 <= at) {
                    val s = screens[r++]
                    host.navigateTo(s.route, s.params)
                }
                while (i < ordered.size && ordered[i].t - t0 <= at) {
                    val s = ordered[i++]
                    val sig = signals[s.id] ?: continue
                    hold(sig)
                    sig.write(s.v)
                }
                if (i >= ordered.size && r >= screens.size) {
                    stopPlayback()
                    releaseHeld()
                }
            }
        }
        playing = consumer
        addFrames(consumer)
        // The first due samples go in at once, as on React Native (step() before the timer).
        consumer.onFrame(start)
    }

    // ── capture ──────────────────────────────────────────────────────────────────────────────────

    private val captures = ArrayDeque<EditorMessage.Capture>()
    private var capturing = false
    private var captureRelease: Cancellable? = null

    private fun releaseCapture() {
        captureRelease?.cancel()
        captureRelease = null
        releaseHeld()
    }

    private fun capture(msg: EditorMessage.Capture) {
        captures.addLast(msg)
        if (!capturing) nextCapture()
    }

    private fun nextCapture() {
        val msg = captures.removeFirstOrNull()
        if (msg == null) {
            capturing = false
            return
        }
        capturing = true
        if (!host.canCapture) {
            sendRaw(AppMessage.Frame(msg.id, error = "This app does not capture its screen."))
            return nextCapture()
        }
        stopPlayback()
        captureRelease?.cancel()
        captureRelease = null
        val show = {
            for (s in msg.samples) {
                val sig = signals[s.id] ?: continue
                hold(sig)
                sig.write(s.v)
            }
            // A write shows on the next frame's draw: wait for three, as React Native does.
            afterFrames(3) {
                host.capture(msg.format, msg.quality, msg.width) { data, error ->
                    onSession {
                        sendRaw(if (data != null) AppMessage.Frame(msg.id, data, msg.format) else AppMessage.Frame(msg.id, error = error ?: "capture failed"))
                        captureRelease = scheduler.post(CAPTURE_RELEASE_MS) { releaseHeld() }
                        nextCapture()
                    }
                }
            }
        }
        val route = msg.route
        if (route != null && host.navigateTo(route.route, route.params)) scheduler.post(ROUTE_SETTLE_MS) { show() } else show()
    }

    private fun afterFrames(n: Int, then: () -> Unit) {
        var left = n
        val c = object : FrameConsumer {
            override fun afterFrame(vsync: Double) {
                if (--left > 0) return
                removeFrames(this)
                then()
            }
        }
        addFrames(c)
    }

    // ── scenarios ────────────────────────────────────────────────────────────────────────────────

    private fun runScenario(name: String) {
        val s = scenarios[name]
        val t0 = clock.nowMs()
        if (s == null) {
            val names = scenarios.keys.joinToString(", ").ifEmpty { "none" }
            sendRaw(AppMessage.ScenarioDone(name, 0, "No scenario named \"$name\". Registered: $names."))
            return
        }
        var finished = false
        val done = { e: Throwable? ->
            onSession {
                if (!finished) {
                    finished = true
                    sendRaw(AppMessage.ScenarioDone(name, (clock.nowMs() - t0).roundToLong(), e?.let { it.message ?: it.toString() }))
                }
            }
        }
        try {
            s.run(done)
        } catch (e: Throwable) {
            done(e)
        }
    }

    // ── timers ───────────────────────────────────────────────────────────────────────────────────

    private fun repeat(everyMs: Long, block: () -> Unit): Cancellable {
        var current: Cancellable? = null
        var stopped = false
        fun schedule() {
            current = scheduler.post(everyMs) {
                if (stopped) return@post
                block()
                schedule()
            }
        }
        schedule()
        return Cancellable {
            stopped = true
            current?.cancel()
        }
    }
}
