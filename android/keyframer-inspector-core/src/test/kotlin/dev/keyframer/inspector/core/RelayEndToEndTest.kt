package dev.keyframer.inspector.core

import dev.keyframer.relay.EditorClient
import dev.keyframer.relay.FakeRelay
import dev.keyframer.relay.asList
import dev.keyframer.relay.asMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The session over a real WebSocket through the fake relay, with a panel stand-in on /editor: the
 * path an Android app takes to the desktop app, minus Android. One thread plays the main thread.
 */
class RelayEndToEndTest {
    private lateinit var relay: FakeRelay
    private lateinit var main: ScheduledExecutorService
    private val editors = ArrayList<EditorClient>()

    private val clock = object : Clock {
        override fun nowMs() = System.nanoTime() / 1e6
        override fun wallMs() = System.currentTimeMillis()
    }
    private val scheduler = Scheduler { delay, block ->
        val f = main.schedule(block, delay, TimeUnit.MILLISECONDS)
        Cancellable { f.cancel(false) }
    }
    /** A 60 Hz loop on the "main thread". */
    private val frames = FrameLoop { onFrame, afterFrame ->
        val f = main.scheduleAtFixedRate({
            val v = clock.nowMs()
            onFrame(v)
            afterFrame(v)
        }, 16, 16, TimeUnit.MILLISECONDS)
        Cancellable { f.cancel(false) }
    }

    @BeforeTest
    fun setUp() {
        relay = FakeRelay().start(0)
        main = Executors.newSingleThreadScheduledExecutor()
    }

    @AfterTest
    fun tearDown() {
        editors.forEach { it.close() }
        relay.stop()
        main.shutdownNow()
    }

    private fun editor() = EditorClient("ws://127.0.0.1:${relay.port}/editor").also {
        editors.add(it)
        it.awaitOpen()
    }

    private fun onMain(block: () -> Unit) = main.submit(block).get(5, TimeUnit.SECONDS)

    @Test
    fun `hello, catalog, record, playback and capture through the relay`() {
        val x = object : Signal {
            override val site = SignalSite("dev/keyframer/example/MainActivity.kt:80:0", "dev/keyframer/example/MainActivity.kt", 80, "MainActivity", "cardX")
            var value = 0.0
            val writes = ArrayList<Double>()
            override fun read() = value
            override fun write(v: Double) {
                writes.add(v)
                value = v
            }
        }
        val host = object : Host {
            override val appName = "E2E App"
            override val platform = "android"
            override val screen = Screen(411.0, 914.0, 2.625)
            override val canCapture = true
            override val frames = this@RelayEndToEndTest.frames
            override fun watchMarkers(onMarker: (Marker) -> Unit): Cancellable {
                onMarker(Marker.Navigation(clock.nowMs().toLong(), "MainActivity"))
                return Cancellable {}
            }
            override fun capture(format: String, quality: Double, width: Int?, done: (String?, String?) -> Unit) = done("aGVsbG8=", null)
        }
        val ed = editor()
        lateinit var session: InspectorSession
        onMain {
            session = InspectorSession(InspectorSession.relayUrl("127.0.0.1", relay.port, "E2E App"), OkHttpSockets(), scheduler, clock, host)
            session.addSignal(x)
            session.start()
        }

        val hello = ed.await(5000, "app hello") { it["type"] == "hello" && it["role"] == "app" }
        assertEquals("E2E App", hello["app"])
        assertEquals("android", hello["platform"])
        assertEquals("name=E2E%20App&platform=android", relay.appQuery)
        ed.await(5000, "catalog") { m -> m["type"] == "events" && m["events"].asList().any { it.asMap()["kind"] == "signal" } }

        // A second panel joins later: the relay's presence makes the app send the catalog again.
        val late = editor()
        late.await(5000, "catalog for the late editor") { m -> m["type"] == "events" && m["events"].asList().any { it.asMap()["site"].asMap()["name"] == "cardX" } }

        ed.send(mapOf("type" to "record", "signalIds" to listOf("*"), "on" to true))
        Thread.sleep(150)
        onMain { x.value = 10.0 }
        Thread.sleep(150)
        onMain {
            x.value = 20.0
            session.reportAnim(CallSite("a.kt:1:0", "a.kt", 1, 0, "ValueAnimator", null, "pulse", null, emptyList()), listOf(mapOf("duration" to 300)), Throwable().stackTrace)
        }
        Thread.sleep(400)
        ed.send(mapOf("type" to "record", "signalIds" to listOf("*"), "on" to false))
        Thread.sleep(250)

        val batches = ed.ofType("samples")
        val samples = batches.flatMap { it["samples"].asList() }.map { it.asMap() }
        assertTrue(samples.size > 20, "about 60 samples a second, got ${samples.size}")
        assertEquals(setOf(0.0, 10.0, 20.0), samples.map { it["v"] }.toSet())
        assertTrue(batches.flatMap { it["frames"].asList() }.isNotEmpty(), "frame stats ride along")
        assertEquals("navigation", batches.flatMap { it["markers"].asList() }.first().asMap()["kind"])
        val anim = ed.ofType("events").flatMap { it["events"].asList() }.map { it.asMap() }.single { it["kind"] == "anim" }
        assertTrue((anim["t"] as Double) > 200, "placed on the recording's clock")
        // Frames of the call that started it (here the executor running the "main thread"), libraries collapsed.
        assertTrue(anim["frames"].asList().map { it.asMap() }.any { it["collapse"] == true && it["methodName"].toString().startsWith("java.util.concurrent.") })

        ed.send(mapOf("type" to "playback", "samples" to listOf(mapOf("id" to x.site.id, "t" to 0, "v" to 1), mapOf("id" to x.site.id, "t" to 50, "v" to 2))))
        Thread.sleep(300)
        onMain { assertEquals(listOf(1.0, 2.0), x.writes) }

        ed.send(mapOf("type" to "capture", "id" to "c1", "samples" to listOf(mapOf("id" to x.site.id, "t" to 0, "v" to 7))))
        val frame = ed.await(5000, "frame") { it["type"] == "frame" }
        assertEquals("aGVsbG8=", frame["data"])
        assertEquals("jpg", frame["format"])

        onMain { session.dispose() }
    }

    @Test
    fun `reconnects when the relay comes back`() {
        val port = relay.port
        val host = object : Host {
            override val appName = "R"
            override val platform = "android"
            override val screen: Screen? = null
            override val canCapture = false
            override val frames = this@RelayEndToEndTest.frames
            override fun watchMarkers(onMarker: (Marker) -> Unit) = Cancellable {}
        }
        lateinit var session: InspectorSession
        onMain {
            session = InspectorSession(InspectorSession.relayUrl("127.0.0.1", port, "R"), OkHttpSockets(), scheduler, clock, host)
            session.start()
        }
        editor().await(5000, "first hello") { it["type"] == "hello" }
        relay.stop()
        Thread.sleep(300)
        relay = FakeRelay().start(port)
        val again = editor()
        // Backoff is 500 ms, then 1 s: well inside the wait.
        again.await(8000, "hello after the relay restarted") { it["type"] == "hello" && it["app"] == "R" }
        onMain { session.dispose() }
    }
}
