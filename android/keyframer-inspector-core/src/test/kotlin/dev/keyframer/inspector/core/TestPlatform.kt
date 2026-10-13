package dev.keyframer.inspector.core

/** A virtual clock, scheduler and frame loop: time only moves when a test moves it. */
class TestPlatform : Clock, Scheduler, FrameLoop {
    var now = 1_000.0
    private var seq = 0
    private data class Task(val at: Double, val seq: Int, val block: () -> Unit, var cancelled: Boolean = false)
    private val tasks = ArrayList<Task>()
    private val loops = ArrayList<Pair<(Double) -> Unit, (Double) -> Unit>>()

    override fun nowMs() = now
    override fun wallMs() = 1_760_000_000_000L + now.toLong()

    override fun post(delayMs: Long, block: () -> Unit): Cancellable {
        val t = Task(now + delayMs, seq++, block)
        tasks.add(t)
        return Cancellable { t.cancelled = true }
    }

    override fun start(onFrame: (Double) -> Unit, afterFrame: (Double) -> Unit): Cancellable {
        val l = onFrame to afterFrame
        loops.add(l)
        return Cancellable { loops.remove(l) }
    }

    val framesRunning: Boolean get() = loops.isNotEmpty()

    /** Runs everything due by now, including what those tasks post with no delay. */
    fun runDue() {
        while (true) {
            val next = tasks.filter { !it.cancelled && it.at <= now }.minWithOrNull(compareBy({ it.at }, { it.seq })) ?: break
            tasks.remove(next)
            next.block()
        }
        tasks.removeAll { it.cancelled }
    }

    /** Moves time forward in 16 ms frames (or plain time when nothing asks for frames). */
    fun advance(ms: Double, frameMs: Double = 1000.0 / 60) {
        val end = now + ms
        runDue()
        while (now + frameMs <= end + 1e-9) {
            now += frameMs
            runDue()
            for ((onFrame, _) in loops.toList()) onFrame(now)
            for ((_, after) in loops.toList()) after(now)
            runDue()
        }
        now = end
        runDue()
    }
}

/** A socket factory whose sockets a test opens, feeds and closes by hand. */
class FakeSockets : SocketFactory {
    inner class Socket(val url: String, val listener: SocketListener) : InspectorSocket {
        val sent = ArrayList<String>()
        var closed = false
        override fun send(text: String): Boolean {
            sent.add(text)
            return true
        }
        override fun close() {
            closed = true
        }
    }

    val opened = ArrayList<Socket>()
    val last: Socket get() = opened.last()

    override fun open(url: String, listener: SocketListener): InspectorSocket = Socket(url, listener).also { opened.add(it) }
}

/** A host that records what the session asked of it. */
class FakeHost(private val p: TestPlatform) : Host {
    override val appName = "Example"
    override val platform = "android"
    override val screen = Screen(400.0, 800.0, 2.5)
    override var canCapture = true
    override val frames: FrameLoop = p
    var markerSink: ((Marker) -> Unit)? = null
    val navigations = ArrayList<String>()
    var replays = 0
    var captureReply: Pair<String?, String?> = "BASE64" to null
    val captureRequests = ArrayList<Triple<String, Double, Int?>>()

    override fun watchMarkers(onMarker: (Marker) -> Unit): Cancellable {
        markerSink = onMarker
        onMarker(Marker.Navigation(p.now.toLong(), "MainActivity"))
        return Cancellable { markerSink = null }
    }

    override fun navigateTo(route: String, params: Map<String, Any?>?): Boolean {
        navigations.add(route)
        return true
    }

    override fun capture(format: String, quality: Double, width: Int?, done: (String?, String?) -> Unit) {
        captureRequests.add(Triple(format, quality, width))
        done(captureReply.first, captureReply.second)
    }

    override fun replay(): Boolean {
        replays++
        return true
    }
}

/** A plain value as a signal, with the calls made on it. */
class ValueSignal(id: String, var value: Double? = 0.0, name: String = id) : Signal {
    override val site = SignalSite(id, "dev/keyframer/example/MainActivity.kt", 10, "MainActivity", name)
    val writes = ArrayList<Double>()
    var holds = 0
    var releases = 0
    override fun read() = value
    override fun write(v: Double) {
        writes.add(v)
        value = v
    }
    override fun hold() {
        holds++
    }
    override fun release() {
        releases++
    }
}
