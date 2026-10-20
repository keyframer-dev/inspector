package dev.keyframer.inspector.core

import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

@Suppress("UNCHECKED_CAST")
class InspectorSessionTest {
    private lateinit var p: TestPlatform
    private lateinit var sockets: FakeSockets
    private lateinit var host: FakeHost
    private lateinit var session: InspectorSession

    private val site = CallSite("a.kt:3:0", "a.kt", 3, 0, "ValueAnimator", "MainActivity", "pulse", null, listOf(Param("duration", 300.0)))

    @BeforeTest
    fun setUp() {
        p = TestPlatform()
        sockets = FakeSockets()
        host = FakeHost(p)
        session = InspectorSession("ws://relay/app?name=Example&platform=android", sockets, p, p, host)
        session.start()
    }

    private fun open() {
        sockets.last.listener.onOpen()
        p.runDue()
    }

    private fun receive(json: String) {
        sockets.last.listener.onMessage(json)
        p.runDue()
    }

    private fun sent(): List<Map<String, Any?>> = sockets.opened.flatMap { it.sent }.map { Json.parse(it) as Map<String, Any?> }
    private fun sentOf(type: String) = sent().filter { it["type"] == type }
    private fun recordedSamples() = sentOf("samples").flatMap { it["samples"] as List<Map<String, Any?>> }

    @Test
    fun `hello first, then the catalog that was queued before the socket opened`() {
        session.addSignal(ValueSignal("cardX"))
        session.reportAnim(site, listOf(mapOf("duration" to 300)))
        open()
        val out = sent()
        assertEquals("hello", out[0]["type"])
        assertEquals("app", out[0]["role"])
        assertEquals("android", out[0]["platform"])
        assertEquals(true, out[0]["capture"])
        assertEquals(mapOf("width" to 400.0, "height" to 800.0, "scale" to 2.5), out[0]["screen"])
        assertEquals("events", out[1]["type"])
        val events = out[1]["events"] as List<Map<String, Any?>>
        assertEquals(listOf("signal", "anim"), events.map { it["kind"] })
        // Not recording: no `t`, no frames.
        assertFalse("t" in events[1])
        assertEquals("js", events[1]["thread"])
        assertEquals("android-views", out[0]["framework"])
        assertEquals(mapOf("js" to mapOf("label" to "Main", "animates" to true)), out[0]["threads"])
    }

    @Test
    fun `events are batched every 100 ms`() {
        open()
        session.reportAnim(site, emptyList())
        session.reportAnim(site, emptyList())
        assertEquals(1, sent().size)
        p.advance(100.0)
        val batch = sentOf("events").single()["events"] as List<Map<String, Any?>>
        assertEquals(listOf(1.0, 2.0), batch.map { it["eid"] })
    }

    @Test
    fun `a new editor gets the catalog again, on presence or on its hello`() {
        session.addSignal(ValueSignal("cardX"))
        open()
        p.advance(100.0)
        val before = sentOf("events").size
        receive("""{"type":"presence","app":true,"editors":1,"cli":false}""")
        assertEquals(before + 1, sentOf("events").size)
        // Same count again: nobody new.
        receive("""{"type":"presence","app":true,"editors":1,"cli":false}""")
        assertEquals(before + 1, sentOf("events").size)
        receive("""{"type":"hello","role":"editor"}""")
        assertEquals(2, sentOf("hello").size)
        assertEquals(before + 2, sentOf("events").size)
    }

    @Test
    fun `record star samples every signal per frame, with frames and markers, and stops cleanly`() {
        val x = ValueSignal("cardX")
        session.addSignal(x)
        open()
        receive("""{"type":"record","signalIds":["*"],"on":true}""")
        assertTrue(p.framesRunning)
        // A signal that registers while recording everything joins.
        val y = ValueSignal("cardY", 5.0)
        session.addSignal(y)
        x.value = 1.0
        p.advance(50.0)
        host.markerSink!!(Marker.Touch(p.now.toLong(), "start", 0, 10.0, 20.0))
        x.value = 2.0
        p.advance(300.0)
        receive("""{"type":"record","signalIds":["*"],"on":false}""")
        p.advance(100.0)
        assertFalse(p.framesRunning)

        val samples = recordedSamples()
        assertTrue(samples.any { it["id"] == "cardX" && it["v"] == 1.0 })
        assertTrue(samples.any { it["id"] == "cardX" && it["v"] == 2.0 })
        assertTrue(samples.any { it["id"] == "cardY" })
        // On the recording's clock: the first frame is one frame in.
        assertEquals(17.0, samples.first()["t"])
        val batches = sentOf("samples")
        val frames = batches.flatMap { (it["frames"] as? List<Map<String, Any?>>).orEmpty() }
        assertTrue(frames.isNotEmpty())
        assertTrue(frames.all { it["thread"] == "js" && it["fps"] == 60.0 })
        val markers = batches.flatMap { (it["markers"] as? List<Map<String, Any?>>).orEmpty() }
        assertEquals(listOf("navigation", "touch"), markers.map { it["kind"] })
        assertEquals(0.0, markers[0]["t"])
        assertEquals(50.0, markers[1]["t"])
        val sampled = recordedSamples().size
        p.advance(200.0)
        assertEquals(sampled, recordedSamples().size)
    }

    @Test
    fun `a removed signal is unsignalled, leaves the catalog and stops recording`() {
        session.addSignal(ValueSignal("a"))
        session.addSignal(ValueSignal("b"))
        open()
        receive("""{"type":"record","signalIds":["*"],"on":true}""")
        p.advance(50.0)
        session.removeSignal("a")
        session.removeSignal("a")
        p.advance(100.0)
        val events = sentOf("events").flatMap { it["events"] as List<Map<String, Any?>> }
        assertEquals(listOf(mapOf("kind" to "unsignal", "id" to "a", "t" to 50.0)), events.filter { it["kind"] == "unsignal" })
        val before = recordedSamples().count { it["id"] == "a" }
        p.advance(100.0)
        assertEquals(before, recordedSamples().count { it["id"] == "a" })
        // A late editor gets only what is still there.
        receive("""{"type":"presence","app":true,"editors":1,"cli":false}""")
        val catalog = sentOf("events").last()["events"] as List<Map<String, Any?>>
        assertEquals(listOf("b"), catalog.map { (it["site"] as Map<String, Any?>)["id"] })
    }

    @Test
    fun `durationMs rides along when the app knows it`() {
        open()
        session.reportAnim(site, emptyList(), durationMs = 820)
        session.reportAnim(site, emptyList())
        p.advance(100.0)
        val anims = sentOf("events").flatMap { it["events"] as List<Map<String, Any?>> }
        assertEquals(listOf(820.0, null), anims.map { it["durationMs"] })
    }

    @Test
    fun `record only the listed ids`() {
        session.addSignal(ValueSignal("a"))
        session.addSignal(ValueSignal("b"))
        open()
        receive("""{"type":"record","signalIds":["b"],"on":true}""")
        p.advance(200.0)
        assertEquals(setOf("b"), recordedSamples().map { it["id"] }.toSet())
    }

    @Test
    fun `animations while recording carry t and app frames`() {
        open()
        receive("""{"type":"record","signalIds":["*"],"on":true}""")
        p.advance(120.0)
        val stack = arrayOf(StackTraceElement("dev.keyframer.example.MainActivity", "onCreate", "MainActivity.kt", 42))
        session.reportAnim(site, emptyList(), stack)
        p.advance(100.0)
        val anim = sentOf("events").flatMap { it["events"] as List<Map<String, Any?>> }.single { it["kind"] == "anim" }
        assertEquals(120.0, anim["t"])
        assertEquals("dev.keyframer.example.MainActivity.onCreate", (anim["frames"] as List<Map<String, Any?>>).single()["methodName"])
    }

    @Test
    fun `playback writes samples in time order, navigates, holds then releases`() {
        val x = ValueSignal("cardX")
        session.addSignal(x)
        open()
        receive(
            """{"type":"playback","samples":[{"id":"cardX","t":1090,"v":3},{"id":"cardX","t":1000,"v":1},{"id":"cardX","t":1040,"v":2},{"id":"gone","t":1000,"v":9}],
               "routes":[{"t":1000,"route":"MainActivity"},{"t":1070,"route":"DetailActivity"}]}""",
        )
        // The first due sample goes in at once, before any frame.
        assertEquals(listOf(1.0), x.writes)
        assertEquals(1, x.holds)
        assertEquals(listOf("MainActivity"), host.navigations)
        p.advance(60.0)
        assertEquals(listOf(1.0, 2.0), x.writes)
        p.advance(60.0)
        assertEquals(listOf(1.0, 2.0, 3.0), x.writes)
        assertEquals(listOf("MainActivity", "DetailActivity"), host.navigations)
        assertEquals(1, x.holds)
        assertEquals(1, x.releases)
        assertFalse(p.framesRunning)
    }

    @Test
    fun `capture shows the samples, waits three frames, answers with the frame, releases later`() {
        val x = ValueSignal("cardX")
        session.addSignal(x)
        open()
        receive("""{"type":"capture","id":"c1","samples":[{"id":"cardX","t":500,"v":42}],"format":"png","quality":0.5,"width":200}""")
        assertEquals(listOf(42.0), x.writes)
        assertTrue(host.captureRequests.isEmpty())
        p.advance(17.0 * 3)
        assertEquals(listOf(Triple<String, Double, Int?>("png", 0.5, 200)), host.captureRequests.toList())
        val frame = sentOf("frame").single()
        assertEquals(mapOf("type" to "frame", "id" to "c1", "data" to "BASE64", "format" to "png"), frame)
        assertEquals(0, x.releases)
        p.advance(InspectorSession.CAPTURE_RELEASE_MS.toDouble())
        assertEquals(1, x.releases)
    }

    @Test
    fun `capture with a route waits for the transition, and errors come back as frame errors`() {
        open()
        host.captureReply = null to "no window"
        receive("""{"type":"capture","id":"c2","samples":[],"route":{"t":0,"route":"DetailActivity"}}""")
        assertEquals(listOf("DetailActivity"), host.navigations)
        p.advance(200.0)
        assertTrue(host.captureRequests.isEmpty())
        p.advance(InspectorSession.ROUTE_SETTLE_MS.toDouble())
        assertEquals(mapOf("type" to "frame", "id" to "c2", "error" to "no window"), sentOf("frame").single())

        host.canCapture = false
        receive("""{"type":"capture","id":"c3","samples":[]}""")
        assertEquals("This app does not capture its screen.", sentOf("frame").last()["error"])
    }

    @Test
    fun `scenarios run and answer, unknown ones say what exists`() {
        open()
        var finish: ((Throwable?) -> Unit)? = null
        session.registerScenario("drag card") { done -> finish = done }
        assertEquals(mapOf("type" to "scenarios", "names" to listOf("drag card")), sentOf("scenarios").single())
        receive("""{"type":"scenario","name":"drag card"}""")
        p.advance(250.0)
        finish!!(null)
        p.runDue()
        assertEquals(mapOf("type" to "scenarioDone", "name" to "drag card", "ms" to 250.0), sentOf("scenarioDone").single())
        receive("""{"type":"scenario","name":"nope"}""")
        assertEquals("No scenario named \"nope\". Registered: drag card.", sentOf("scenarioDone").last()["error"])
        session.registerScenario("boom") { throw IllegalStateException("broke") }
        receive("""{"type":"scenario","name":"boom"}""")
        assertEquals("broke", sentOf("scenarioDone").last()["error"])
    }

    @Test
    fun `replay and overrides reach the app`() {
        open()
        var got: Map<String, Map<String, Double>>? = null
        session.onOverrides = { got = it }
        receive("""{"type":"overrides","overrides":{"a.kt:3:0":{"duration":900}}}""")
        assertEquals(mapOf("a.kt:3:0" to mapOf("duration" to 900.0)), got)
        receive("""{"type":"replay"}""")
        assertEquals(1, host.replays)
    }

    @Test
    fun `reconnects with a growing backoff and says hello again`() {
        open()
        sockets.last.listener.onClosed("gone")
        p.runDue()
        assertEquals(1, sockets.opened.size)
        p.advance(499.0)
        assertEquals(1, sockets.opened.size)
        p.advance(1.0)
        assertEquals(2, sockets.opened.size)
        sockets.last.listener.onClosed("refused")
        p.runDue()
        p.advance(999.0)
        assertEquals(2, sockets.opened.size)
        p.advance(1.0)
        assertEquals(3, sockets.opened.size)
        open()
        assertEquals("hello", Json.parse(sockets.last.sent.first()).let { (it as Map<String, Any?>)["type"] })
        // A stale socket's late callbacks are ignored.
        sockets.opened[0].listener.onMessage("""{"type":"replay"}""")
        p.runDue()
        assertEquals(0, host.replays)
    }

    @Test
    fun `dispose closes the socket and stops reconnecting`() {
        open()
        session.dispose()
        assertTrue(sockets.last.closed)
        sockets.last.listener.onClosed(null)
        p.advance(20_000.0)
        assertEquals(1, sockets.opened.size)
    }

    // ── time, display, accessibility, render hints ─────────────────────────────────────────────

    @Test
    fun `time is answered with the speed in effect, and is 1 when the app cannot change it`() {
        open()
        receive("""{"type":"time","scale":0.25}""")
        assertTrue(host.timeCalls.isEmpty())
        assertEquals(mapOf("type" to "time", "scale" to 1.0), sentOf("time").single())
        host.canControlTime = true
        receive("""{"type":"time","scale":0.25}""")
        receive("""{"type":"time","scale":0,"step":2}""")
        assertEquals(listOf(0.25 to null, 0.0 to 2), host.timeCalls)
        assertEquals(listOf(1.0, 0.25, 0.0), sentOf("time").map { it["scale"] })
        // Nothing usable: no change, still answered with the speed in effect.
        receive("""{"type":"time","scale":-3}""")
        receive("""{"type":"time"}""")
        assertEquals(listOf(0.25 to null, 0.0 to 2), host.timeCalls)
        assertEquals(listOf(1.0, 0.25, 0.0, 0.0, 0.0), sentOf("time").map { it["scale"] })
        assertEquals(0.0, session.timeScale)
        // The capability is in the hello.
        receive("""{"type":"hello","role":"editor"}""")
        assertEquals("time", (sentOf("hello").last()["capabilities"] as List<*>).last())
    }

    @Test
    fun `a new editor hears the speed after the hello, and the last one leaving restores it`() {
        host.canControlTime = true
        open()
        receive("""{"type":"presence","app":true,"editors":1,"cli":false}""")
        receive("""{"type":"time","scale":0.5}""")
        val before = sentOf("time").size
        receive("""{"type":"presence","app":true,"editors":2,"cli":false}""")
        assertEquals(before + 1, sentOf("time").size)
        receive("""{"type":"hello","role":"editor"}""")
        val out = sent()
        val hello = out.indexOfLast { it["type"] == "hello" }
        assertEquals(mapOf("type" to "time", "scale" to 0.5), out[hello + 1])
        // One of two leaves: still controlled.
        receive("""{"type":"presence","app":true,"editors":1,"cli":false}""")
        assertEquals(0.5, session.timeScale)
        val answers = sentOf("time").size
        receive("""{"type":"presence","app":true,"editors":0,"cli":false}""")
        assertEquals(1.0 to null, host.timeCalls.last())
        assertEquals(1.0, session.timeScale)
        // The reset is said, so a relay that remembers the speed forgets it.
        assertEquals(listOf(mapOf("type" to "time", "scale" to 1.0)), sentOf("time").drop(answers))
    }

    @Test
    fun `the connection dropping, or dispose, puts the speed back`() {
        host.canControlTime = true
        open()
        receive("""{"type":"time","scale":0}""")
        sockets.last.listener.onClosed("gone")
        p.runDue()
        assertEquals(1.0 to null, host.timeCalls.last())
        p.advance(500.0)
        open()
        receive("""{"type":"time","scale":0.1}""")
        session.dispose()
        assertEquals(1.0 to null, host.timeCalls.last())
        // Said before the socket closes; the reset when the connection dropped had nobody to tell.
        assertEquals(mapOf("type" to "time", "scale" to 1.0), Json.parse(sockets.last.sent.last()))
        assertEquals(listOf(0.0, 0.1, 1.0), sentOf("time").map { it["scale"] })
    }

    @Test
    fun `speed changes while recording are time markers, and a recording started slowed says so`() {
        host.canControlTime = true
        open()
        receive("""{"type":"time","scale":0.5}""")
        receive("""{"type":"record","signalIds":["*"],"on":true}""")
        p.advance(100.0)
        receive("""{"type":"time","scale":0}""")
        receive("""{"type":"time","scale":0,"step":1}""")
        p.advance(50.0)
        receive("""{"type":"time","scale":1}""")
        p.advance(100.0)
        val markers = sentOf("samples").flatMap { (it["markers"] as? List<Map<String, Any?>>).orEmpty() }.filter { it["kind"] == "time" }
        // Each step is a marker of its own, with the frames it moved on.
        assertEquals(
            listOf(Triple(0.0, 0.5, null), Triple(100.0, 0.0, null), Triple(100.0, 0.0, 1.0), Triple(150.0, 1.0, null)),
            markers.map { Triple(it["t"], it["scale"], it["step"]) },
        )
    }

    @Test
    fun `the hello carries the display and motion settings, and a recording gets what changed since`() {
        host.display = DisplayInfo(120.0, adaptive = true)
        host.accessibility = AccessibilityInfo(false)
        open()
        val hello = sentOf("hello").single()
        assertEquals(mapOf("hz" to 120.0, "adaptive" to true), hello["display"])
        assertFalse("device" in hello)
        assertEquals(mapOf("reduceMotion" to false), hello["accessibility"])
        // The display idles at 60 Hz and Remove animations went on after the hello.
        host.rate = 60.000004f
        host.accessibility = AccessibilityInfo(true)
        receive("""{"type":"record","signalIds":["*"],"on":true}""")
        p.advance(100.0)
        val markers = sentOf("samples").flatMap { (it["markers"] as? List<Map<String, Any?>>).orEmpty() }
        assertEquals(
            listOf(mapOf("kind" to "display", "t" to 0.0, "hz" to 60.0), mapOf("kind" to "accessibility", "t" to 0.0, "reduceMotion" to true)),
            markers.filter { it["kind"] == "display" || it["kind"] == "accessibility" },
        )
    }

    @Test
    fun `with a known display, frames are counted against its rate, and display markers move it`() {
        host.display = DisplayInfo(120.0)
        host.rate = 120f
        open()
        receive("""{"type":"record","signalIds":["*"],"on":true}""")
        // 60 Hz frames on a 120 Hz display: each one skipped a frame.
        p.advance(300.0, frameMs = 1000.0 / 60)
        session.flush()
        val drops = sentOf("samples").flatMap { (it["drops"] as? List<Map<String, Any?>>).orEmpty() }
        assertTrue(drops.size > 10, "got ${drops.size}")
        val before = drops.size
        host.markerSink!!(Marker.Display(p.now.toLong(), 60.0))
        p.advance(300.0, frameMs = 1000.0 / 60)
        session.flush()
        assertEquals(before, sentOf("samples").flatMap { (it["drops"] as? List<Map<String, Any?>>).orEmpty() }.size)
        val display = sentOf("samples").flatMap { (it["markers"] as? List<Map<String, Any?>>).orEmpty() }.single { it["kind"] == "display" }
        assertEquals(60.0, display["hz"])
    }

    @Test
    fun `render hints ride with the catalog, and leave with their signal`() {
        session.addSignal(ValueSignal("card"))
        session.reportRenderHint("card", "layer-alpha", "alpha animates on LinearLayout")
        session.reportRenderHint("card", "layer-alpha", "alpha animates on LinearLayout")
        open()
        val first = sentOf("events").single()["events"] as List<Map<String, Any?>>
        // The same hint again is not news.
        assertEquals(listOf("signal", "renderHint"), first.map { it["kind"] })
        receive("""{"type":"presence","app":true,"editors":1,"cli":false}""")
        // The catalog keeps one per signal and hint.
        val catalog = sentOf("events").last()["events"] as List<Map<String, Any?>>
        assertEquals(listOf("signal", "renderHint"), catalog.map { it["kind"] })
        assertEquals(mapOf("kind" to "renderHint", "id" to "card", "hint" to "layer-alpha", "detail" to "alpha animates on LinearLayout"), catalog[1])
        session.removeSignal("card")
        p.advance(100.0)
        receive("""{"type":"presence","app":true,"editors":2,"cli":false}""")
        assertTrue((sentOf("events").last()["events"] as List<Map<String, Any?>>).none { it["kind"] == "renderHint" })
    }

    @Test
    fun `the hello names the device the host reports`() {
        host.device = DeviceInfo(name = "Pixel 4 API 35", model = "sdk_gphone64_arm64", id = "Pixel_4_API_35", simulator = true)
        open()
        assertEquals(
            mapOf("name" to "Pixel 4 API 35", "model" to "sdk_gphone64_arm64", "id" to "Pixel_4_API_35", "simulator" to true),
            sentOf("hello").single()["device"],
        )
    }

    // ── recorders ──────────────────────────────────────────────────────────────────────────────

    @Test
    fun `of two recorders, one stopping leaves the other recording, and the clock starts once`() {
        session.addSignal(ValueSignal("a"))
        session.addSignal(ValueSignal("b"))
        open()
        receive("""{"type":"presence","app":true,"editors":2,"cli":false}""")
        receive("""{"type":"record","signalIds":["*"],"on":true,"recorder":"panel"}""")
        p.advance(100.0)
        receive("""{"type":"record","signalIds":["b"],"on":true,"recorder":"ci"}""")
        p.advance(100.0)
        // The second recorder did not restart the recording's clock.
        assertTrue(recordedSamples().map { it["t"] as Double }.zipWithNext().all { (x, y) -> y >= x })
        receive("""{"type":"record","signalIds":["*"],"on":false,"recorder":"panel"}""")
        assertTrue(session.isRecording)
        session.flush()
        val before = recordedSamples()
        p.advance(200.0)
        session.flush()
        val after = recordedSamples().drop(before.size)
        // Only the ci recorder's id from here on.
        assertEquals(setOf("b"), after.map { it["id"] }.toSet())
        assertTrue((after.first()["t"] as Double) > 200)
        receive("""{"type":"record","signalIds":["b"],"on":false,"recorder":"ci"}""")
        assertFalse(session.isRecording)
        assertFalse(p.framesRunning)
    }

    @Test
    fun `off without a recorder stops only the anonymous one`() {
        session.addSignal(ValueSignal("a"))
        open()
        receive("""{"type":"record","signalIds":["*"],"on":true}""")
        receive("""{"type":"record","signalIds":["a"],"on":true,"recorder":"mcp"}""")
        receive("""{"type":"record","signalIds":["*"],"on":false}""")
        assertTrue(session.isRecording)
        // An off for an id it does not record leaves a recorder as it is.
        receive("""{"type":"record","signalIds":["zzz"],"on":false,"recorder":"mcp"}""")
        assertTrue(session.isRecording)
        receive("""{"type":"record","signalIds":["a"],"on":false,"recorder":"mcp"}""")
        assertFalse(session.isRecording)
    }

    @Test
    fun `the last editor leaving drops every recorder`() {
        session.addSignal(ValueSignal("a"))
        open()
        receive("""{"type":"presence","app":true,"editors":2,"cli":false}""")
        receive("""{"type":"record","signalIds":["*"],"on":true,"recorder":"panel"}""")
        receive("""{"type":"record","signalIds":["a"],"on":true,"recorder":"ci"}""")
        receive("""{"type":"presence","app":true,"editors":1,"cli":false}""")
        assertTrue(session.isRecording)
        receive("""{"type":"presence","app":true,"editors":0,"cli":false}""")
        assertFalse(session.isRecording)
        assertFalse(p.framesRunning)
    }

    @Test
    fun `the connection dropping drops every recorder`() {
        session.addSignal(ValueSignal("a"))
        open()
        receive("""{"type":"record","signalIds":["*"],"on":true,"recorder":"panel"}""")
        receive("""{"type":"record","signalIds":["a"],"on":true}""")
        assertTrue(session.isRecording)
        sockets.last.listener.onClosed("gone")
        p.runDue()
        assertFalse(session.isRecording)
        assertFalse(p.framesRunning)
        // Back again, nothing records until an editor asks.
        p.advance(500.0)
        open()
        assertFalse(session.isRecording)
    }

    @Test
    fun `values mounting and going away while recording say when, the catalog does not`() {
        session.addSignal(ValueSignal("before"))
        open()
        receive("""{"type":"record","signalIds":["*"],"on":true}""")
        p.advance(100.0)
        session.addSignal(ValueSignal("sheet"))
        p.advance(200.0)
        session.removeSignal("sheet")
        p.advance(100.0)
        session.flush()
        val events = sentOf("events").flatMap { it["events"] as List<Map<String, Any?>> }
        val mounted = events.single { it["kind"] == "signal" && (it["site"] as Map<String, Any?>)["id"] == "sheet" }
        assertEquals(100.0, mounted["t"])
        assertEquals(mapOf("kind" to "unsignal", "id" to "sheet", "t" to 300.0), events.single { it["kind"] == "unsignal" })
        // Registered before recording: no time.
        assertFalse("t" in events.single { it["kind"] == "signal" && (it["site"] as Map<String, Any?>)["id"] == "before" })
        // A panel that joins later gets the catalog as registered, with no recording time.
        session.addSignal(ValueSignal("again"))
        receive("""{"type":"presence","app":true,"editors":1,"cli":false}""")
        val catalog = sentOf("events").last()["events"] as List<Map<String, Any?>>
        assertTrue(catalog.none { "t" in it })
    }
}
