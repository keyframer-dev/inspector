package dev.keyframer.vitals.internal

import java.io.File
import java.nio.file.Files
import java.util.concurrent.Executor

/** Time that moves only when a test says so; elapsed, nanos and wall time move together. */
internal class FakeClock(var ms: Long = 1_000_000L, var wallBase: Long = 1_790_000_000_000L, var today: String = "2026-291") : Clock {
    override fun elapsedMs() = ms
    override fun nanos() = ms * 1_000_000L
    override fun wallMs() = wallBase + ms
    override fun day() = today
}

/** Delayed tasks run when the clock is advanced past them, in order. */
internal class FakeScheduler(private val clock: FakeClock) : Scheduler {
    private class Task(val at: Long, val seq: Int, val run: () -> Unit) {
        var cancelled = false
    }

    private val tasks = ArrayList<Task>()
    private var seq = 0

    override fun post(delayMs: Long, task: () -> Unit): () -> Unit {
        val t = Task(clock.ms + delayMs, seq++, task)
        tasks.add(t)
        return { t.cancelled = true }
    }

    /** Moves time forward by `ms`, running every task that falls due on the way. */
    fun advance(ms: Long) {
        val end = clock.ms + ms
        while (true) {
            val next = tasks.filter { !it.cancelled && it.at <= end }.minWithOrNull(compareBy({ it.at }, { it.seq })) ?: break
            tasks.remove(next)
            if (next.at > clock.ms) clock.ms = next.at
            next.run()
        }
        clock.ms = end
    }

    fun pending(): Int = tasks.count { !it.cancelled }
}

internal class FakeProbe : DeviceProbe {
    var hz = 90
    var adaptive: Boolean? = false
    var lowPower = false
    var thermalLevel = -1
    var animationsOffNow = false
    var saver = false

    override fun device(collectModel: Boolean) = DeviceInfo(15, if (collectModel) "Google Pixel 7a" else null, "mid", 8)
    override fun display() = hz to adaptive
    override fun powerSave() = lowPower
    override fun thermal() = thermalLevel
    override fun animationsOff() = animationsOffNow
    override fun dataSaver() = saver
}

/** Records requests and answers from a script (default: 200 with the fixture's config). */
internal class FakeTransport : Transport {
    class Request(val method: String, val url: String, val headers: Map<String, String>, val body: ByteArray?) {
        val json: Any? get() = body?.let { Json.parse(Gzip.decompress(it)) }
    }

    val requests = ArrayList<Request>()
    var answer: (Request) -> Transport.Response? = { Transport.Response(200, """{"ok":true,"config":{"enabled":true,"sampleRate":0.3,"collect":{"reduceMotion":false,"deviceModel":true,"development":false},"ttlSec":86400}}""") }

    override fun send(method: String, url: String, headers: Map<String, String>, body: ByteArray?): Transport.Response? {
        val r = Request(method, url, headers, body)
        requests.add(r)
        return answer(r)
    }

    val reports: List<Map<*, *>> get() = requests.filter { it.url.endsWith("/v1/reports") }.map { it.json as Map<*, *> }
}

internal val direct = Executor { it.run() }

internal fun tempDir(): File = Files.createTempDirectory("vitals-test").toFile().also { it.deleteOnExit() }

/** The shared fixtures (inspector/packages/protocol/fixtures/vitals), or null outside this repository. */
internal fun fixture(name: String): File? {
    val dir = System.getProperty("keyframer.vitals.fixtures") ?: return null
    return File(dir, name).takeIf { it.exists() }
}

/** A Reporter wired to fakes, as KeyframerVitals.start wires the real ones. */
internal class Harness(
    val sampleRate: Double = 1.0,
    val environment: String? = "production",
    val debugId: String? = "3c8e5f1a07b94d62a9e4c2f6b1d8e037",
    val prefs: MemoryKeyValue = MemoryKeyValue(),
    val dir: File = tempDir(),
    val clock: FakeClock = FakeClock(),
) {
    val scheduler = FakeScheduler(clock)
    val transport = FakeTransport()
    val probe = FakeProbe()
    val store = RetryStore(dir)
    val reporter = Reporter(
        options = ReporterOptions(
            key = "kfp_live_abcdefghijklmnopqrstuvwx",
            endpoint = "https://vitals.example",
            sdkVersion = "0.1.0",
            sampleRate = sampleRate,
            environment = environment,
            app = AppInfo("com.acme.shop", "3.4.0", "412", "Views", environment ?: "development", debugId),
        ),
        clock = clock,
        prefs = prefs,
        store = store,
        transport = transport,
        io = direct,
        scheduler = scheduler,
        probe = probe,
    )

    /** A frame drawn now, `ms` long, against the display's interval (or `deadline`). */
    fun frame(ms: Double, mainMs: Double = ms / 2, deadline: Double? = null) {
        reporter.frame(clock.nanos(), mainMs, ms, deadline)
        clock.ms += maxOf(1, ms.toLong())
    }

    /** A new launch of the same app: same files and preferences, a new process. */
    fun relaunch(): Harness = Harness(sampleRate, environment, debugId, prefs, dir, clock)
}
