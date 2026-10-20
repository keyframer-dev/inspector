package dev.keyframer.inspector.core

import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Golden JSON for every message the SDK sends, written against protocol/inspector.ts:
 * the same keys, the same order, `string | null` fields present as null, optional fields left out.
 */
class ProtocolTest {
    private val site = CallSite(
        id = "dev/keyframer/example/MainActivity.kt:42:0",
        file = "dev/keyframer/example/MainActivity.kt",
        line = 42,
        column = 0,
        fn = "ObjectAnimator",
        component = "MainActivity",
        target = "logo",
        prop = null,
        params = listOf(Param("duration", 600.0), Param("startDelay", 0.0)),
    )

    @Test
    fun hello() {
        assertEquals(
            """{"type":"hello","role":"app","app":"Example","platform":"android","capture":true,"screen":{"width":411.42857142857144,"height":914.2857142857143,"scale":2.625},"scenarios":["drag card"],"protocol":1,"sdk":{"name":"keyframer-inspector","version":"0.2.0"},"framework":"android-views","osVersion":"14","build":"debug","threads":{"js":{"label":"Main","animates":true}},"capabilities":["capture","playback","overrides","replay","scenarios"]}""",
            Json.encode(
                AppMessage.Hello(
                    "Example", "android", true, Screen(1080 / 2.625, 2400 / 2.625, 2.625), listOf("drag card"),
                    framework = "android-views",
                    osVersion = "14",
                    build = "debug",
                    threads = linkedMapOf("js" to ThreadInfo("Main", animates = true)),
                    capabilities = listOf("capture", "playback", "overrides", "replay", "scenarios"),
                ),
            ),
        )
        // With RenderThread measured, it is the frame thread.
        assertEquals(
            """{"type":"hello","role":"app","app":"a","platform":"android","capture":false,"scenarios":[],"protocol":1,"sdk":{"name":"keyframer-inspector","version":"0.2.0"},"threads":{"js":{"label":"Main","animates":true},"ui":{"label":"RenderThread"}}}""",
            Json.encode(AppMessage.Hello("a", "android", false, null, emptyList(), threads = linkedMapOf("js" to ThreadInfo("Main", true), "ui" to ThreadInfo("RenderThread")))),
        )
    }

    @Test
    fun `hello carries the source root when the app sets one`() {
        assertEquals(
            """{"type":"hello","role":"app","app":"a","platform":"android","capture":false,"scenarios":[],"protocol":1,"sdk":{"name":"keyframer-inspector","version":"0.2.0"},"root":"/Users/me/app/src/main/kotlin"}""",
            Json.encode(AppMessage.Hello("a", "android", false, null, emptyList(), root = "/Users/me/app/src/main/kotlin")),
        )
    }

    @Test
    fun `hello from the session carries what the host says`() {
        val p = TestPlatform()
        val host = FakeHost(p)
        val sockets = FakeSockets()
        InspectorSession("ws://x", sockets, p, p, host).start()
        sockets.last.listener.onOpen()
        p.runDue()
        assertEquals(
            """{"type":"hello","role":"app","app":"Example","platform":"android","capture":true,"screen":{"width":400,"height":800,"scale":2.5},"scenarios":[],"protocol":1,"sdk":{"name":"keyframer-inspector","version":"0.2.0"},"framework":"android-views","threads":{"js":{"label":"Main","animates":true}},"capabilities":["capture","playback","overrides","replay","scenarios"]}""",
            sockets.last.sent.first(),
        )
    }

    @Test
    fun `anim event, live and while recording`() {
        val args = listOf(linkedMapOf("duration" to 600, "delay" to 0, "iterationCount" to 1, "interpolator" to "DecelerateInterpolator", "values" to linkedMapOf("alpha" to listOf(0f, 1f))))
        assertEquals(
            """{"type":"events","events":[{"kind":"anim","eid":1,"site":{"id":"dev/keyframer/example/MainActivity.kt:42:0","file":"dev/keyframer/example/MainActivity.kt","line":42,"column":0,"fn":"ObjectAnimator","component":"MainActivity","target":"logo","prop":null,"params":[{"path":"duration","value":600},{"path":"startDelay","value":0}]},"at":1760000000000,"args":[{"duration":600,"delay":0,"iterationCount":1,"interpolator":"DecelerateInterpolator","values":{"alpha":[0,1]}}],"thread":"js","durationMs":600}]}""",
            Json.encode(AppMessage.Events(listOf(Event.Anim(1, site, 1760000000000, args, durationMs = 600)))),
        )
        assertEquals(
            """{"kind":"anim","eid":2,"site":{"id":"a.kt:1:0","file":"a.kt","line":1,"column":0,"fn":"ValueAnimator","component":null,"target":null,"prop":null,"params":[]},"at":5,"args":[],"thread":"js","t":120,"frames":[{"methodName":"dev.Example.go","file":"dev/Example.kt","lineNumber":7,"column":0},{"methodName":"android.os.Handler.dispatchMessage","file":"android/os/Handler.java","lineNumber":99,"column":0,"collapse":true}]}""",
            Json.encode(
                Event.Anim(
                    2, CallSite("a.kt:1:0", "a.kt", 1, 0, "ValueAnimator", null, null, null, emptyList()), 5, emptyList(), t = 120,
                    frames = listOf(StackFrame("dev.Example.go", "dev/Example.kt", 7, 0), StackFrame("android.os.Handler.dispatchMessage", "android/os/Handler.java", 99, 0, collapse = true)),
                ),
            ),
        )
    }

    @Test
    fun `signal and unsignal events`() {
        assertEquals(
            """{"kind":"signal","site":{"id":"dev/keyframer/example/MainActivity.kt:80:0:cardX","file":"dev/keyframer/example/MainActivity.kt","line":80,"column":0,"component":"MainActivity","name":"cardX"}}""",
            Json.encode(Event.Signal(SignalSite("dev/keyframer/example/MainActivity.kt:80:0:cardX", "dev/keyframer/example/MainActivity.kt", 80, "MainActivity", "cardX"))),
        )
        // An animator's own value: read only, it replays through its :time track.
        assertEquals(
            """{"kind":"signal","site":{"id":"x","file":"f","line":1,"column":0,"component":null,"name":null,"writable":false}}""",
            Json.encode(Event.Signal(SignalSite("x", "f", 1, null, null, writable = false))),
        )
        // With the property it animates, before `writable` as in the protocol.
        assertEquals(
            """{"kind":"signal","site":{"id":"x","file":"f","line":1,"column":0,"component":null,"name":"title.alpha","prop":"alpha","writable":false}}""",
            Json.encode(Event.Signal(SignalSite("x", "f", 1, null, "title.alpha", writable = false, prop = "alpha"))),
        )
        assertEquals("""{"kind":"unsignal","id":"x"}""", Json.encode(Event.Unsignal("x")))
        // While recording: when it mounted and went away.
        assertEquals("""{"kind":"unsignal","id":"x","t":900}""", Json.encode(Event.Unsignal("x", t = 900)))
        assertEquals(
            """{"kind":"signal","site":{"id":"x:time","file":"f","line":1,"column":0,"component":null,"name":"pulse time","kind":"time"},"t":120}""",
            Json.encode(Event.Signal(SignalSite("x:time", "f", 1, null, "pulse time", kind = "time"), t = 120)),
        )
    }

    @Test
    fun `samples with frames, drops and markers`() {
        val msg = AppMessage.Samples(
            samples = listOf(Sample("cardX", 16, 12.5), Sample("pulse:time", 16, 1200.0)),
            frames = listOf(FrameStat(250, "js", 60, 0)),
            drops = listOf(FrameDrop(400, "js", 48.3, 2)),
            markers = listOf(
                Marker.Navigation(0, "MainActivity"),
                Marker.Touch(10, "start", 0, 200.0, 412.5),
                Marker.Touch(30, "cancel", 0, 200.0, 412.5, lost = true),
                Marker.AppState(50, "background"),
                Marker.Keyboard(60, true, 300),
            ),
        )
        assertEquals(
            """{"type":"samples","samples":[{"id":"cardX","t":16,"v":12.5},{"id":"pulse:time","t":16,"v":1200}],"frames":[{"t":250,"thread":"js","fps":60,"dropped":0}],"drops":[{"t":400,"thread":"js","ms":48.3,"dropped":2}],"markers":[{"kind":"navigation","t":0,"route":"MainActivity"},{"kind":"touch","t":10,"phase":"start","id":0,"x":200,"y":412.5},{"kind":"touch","t":30,"phase":"cancel","id":0,"x":200,"y":412.5,"lost":true},{"kind":"appState","t":50,"state":"background"},{"kind":"keyboard","t":60,"visible":true,"height":300}]}""",
            Json.encode(msg),
        )
        // Empty extras are left out; `samples` always goes.
        assertEquals("""{"type":"samples","samples":[]}""", Json.encode(AppMessage.Samples(emptyList())))
    }

    @Test
    fun `frame, scenarios and scenarioDone`() {
        assertEquals("""{"type":"frame","id":"c1","data":"AAAA","format":"jpg"}""", Json.encode(AppMessage.Frame("c1", "AAAA", "jpg")))
        assertEquals("""{"type":"frame","id":"c2","error":"no window"}""", Json.encode(AppMessage.Frame("c2", error = "no window")))
        assertEquals("""{"type":"scenarios","names":["a","b"]}""", Json.encode(AppMessage.Scenarios(listOf("a", "b"))))
        assertEquals("""{"type":"scenarioDone","name":"a","ms":120}""", Json.encode(AppMessage.ScenarioDone("a", 120)))
        assertEquals("""{"type":"scenarioDone","name":"a","ms":3,"error":"boom"}""", Json.encode(AppMessage.ScenarioDone("a", 3, "boom")))
    }

    @Test
    fun `hello with the display, the motion settings and the time capability`() {
        assertEquals(
            """{"type":"hello","role":"app","app":"a","platform":"android","capture":true,"scenarios":[],"protocol":1,"sdk":{"name":"keyframer-inspector","version":"0.2.0"},"framework":"compose","capabilities":["capture","playback","overrides","replay","scenarios","time"],"display":{"hz":120,"adaptive":true},"accessibility":{"reduceMotion":false}}""",
            Json.encode(
                AppMessage.Hello(
                    "a", "android", true, null, emptyList(),
                    framework = "compose",
                    capabilities = listOf("capture", "playback", "overrides", "replay", "scenarios", "time"),
                    display = DisplayInfo(120.0, adaptive = true),
                    accessibility = AccessibilityInfo(reduceMotion = false),
                ),
            ),
        )
        // A display with one rate leaves `adaptive` out.
        assertEquals("""{"hz":60}""", Json.encode(DisplayInfo(60.0)))
        assertEquals("""{"reduceMotion":true}""", Json.encode(AccessibilityInfo(true)))
    }

    @Test
    fun `hello with the device`() {
        assertEquals(
            """{"type":"hello","role":"app","app":"a","platform":"android","capture":false,"scenarios":[],"protocol":1,"sdk":{"name":"keyframer-inspector","version":"0.2.0"},"device":{"name":"Pixel 4 API 35","model":"sdk_gphone64_arm64","id":"Pixel_4_API_35","simulator":true}}""",
            Json.encode(AppMessage.Hello("a", "android", false, null, emptyList(), device = DeviceInfo("Pixel 4 API 35", "sdk_gphone64_arm64", "Pixel_4_API_35", true))),
        )
        // A physical device: its model, and nothing that names it.
        assertEquals("""{"model":"Google Pixel 8","simulator":false}""", Json.encode(DeviceInfo(model = "Google Pixel 8", simulator = false)))
    }

    @Test
    fun `time answer`() {
        assertEquals("""{"type":"time","scale":0.25}""", Json.encode(AppMessage.Time(0.25)))
        assertEquals("""{"type":"time","scale":0}""", Json.encode(AppMessage.Time(0.0)))
    }

    @Test
    fun `render hints`() {
        assertEquals(
            """{"type":"events","events":[{"kind":"renderHint","id":"dev/keyframer/example/DetailActivity.kt:31:0","hint":"layer-alpha","detail":"alpha animates on LinearLayout, which has overlapping rendering and no hardware layer"},{"kind":"renderHint","id":"x","hint":"elevation"}]}""",
            Json.encode(
                AppMessage.Events(
                    listOf(
                        Event.RenderHint("dev/keyframer/example/DetailActivity.kt:31:0", "layer-alpha", "alpha animates on LinearLayout, which has overlapping rendering and no hardware layer"),
                        Event.RenderHint("x", "elevation"),
                    ),
                ),
            ),
        )
    }

    @Test
    fun `accessibility, display, visibility and time markers`() {
        val markers = listOf(
            Marker.Accessibility(0, true),
            Marker.Display(120, 60.0),
            Marker.Visibility(300, "card", false, "offscreen"),
            Marker.Visibility(420, "card", true),
            Marker.Time(500, 0.25),
            Marker.Time(900, 0.0),
            Marker.Time(950, 0.0, step = 6),
        )
        assertEquals(
            """{"type":"samples","samples":[],"markers":[{"kind":"accessibility","t":0,"reduceMotion":true},{"kind":"display","t":120,"hz":60},{"kind":"visibility","t":300,"id":"card","visible":false,"reason":"offscreen"},{"kind":"visibility","t":420,"id":"card","visible":true},{"kind":"time","t":500,"scale":0.25},{"kind":"time","t":900,"scale":0},{"kind":"time","t":950,"scale":0,"step":6}]}""",
            Json.encode(AppMessage.Samples(emptyList(), markers = markers)),
        )
        // Moving them onto the recording's clock keeps everything else.
        assertEquals(listOf(10L, 130L, 310L, 430L, 510L, 910L, 960L), markers.map { it.shifted(10).t })
        assertEquals(Marker.Visibility(310, "card", false, "offscreen"), markers[2].shifted(10))
    }

    @Test
    fun `relay url`() {
        assertEquals("ws://10.0.2.2:8790/app?name=My%20App&platform=android", InspectorSession.relayUrl("10.0.2.2", 8790, "My App"))
        assertEquals("ws://[::1]:8790/app?name=a&platform=android", InspectorSession.relayUrl("::1", 8790, "a"))
    }
}
