package dev.keyframer.inspector.core

import org.junit.Assume
import java.io.File
import java.util.concurrent.TimeUnit
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Every message this SDK sends, written into src/test/goldens/messages.ts, which `tsc` checks against
 * protocol/inspector.ts: a field the protocol does not have, a missing one or a wrong
 * literal fails there (ProtocolTest pins the exact bytes; this pins the shape). After changing a
 * message: `./gradlew :keyframer-inspector-core:test -PupdateGoldens=true`, and review the diff.
 */
class GoldensTest {
    private val file = File("src/test/goldens/messages.ts")
    private val update = System.getProperty("keyframer.updateGoldens") == "true"

    private val site = CallSite(
        id = "dev/keyframer/example/MainActivity.kt:42:0",
        file = "dev/keyframer/example/MainActivity.kt",
        line = 42,
        column = 0,
        fn = "ObjectAnimator",
        component = "MainActivity",
        target = "title",
        prop = null,
        params = listOf(Param("duration", 650.0), Param("startDelay", 120.0), Param("repeatCount", 0.0)),
    )

    private fun goldens(): LinkedHashMap<String, JsonValue> = linkedMapOf(
        "hello" to AppMessage.Hello(
            "Keyframer Example", "android", true, Screen(411.4, 914.3, 2.625), listOf("drag card", "open detail"),
            framework = "android-views",
            osVersion = "15",
            build = "debug",
            threads = linkedMapOf("js" to ThreadInfo("Main", animates = true)),
            capabilities = listOf("capture", "playback", "overrides", "replay", "scenarios", "time"),
            root = "/Users/me/app/src/main/kotlin",
            display = DisplayInfo(120.0, adaptive = true),
            accessibility = AccessibilityInfo(reduceMotion = false),
            device = DeviceInfo(name = "Pixel 4 API 35", model = "sdk_gphone64_arm64", id = "Pixel_4_API_35", simulator = true),
        ),
        "helloCompose" to AppMessage.Hello(
            "Compose App", "android", false, null, emptyList(),
            framework = "compose",
            display = DisplayInfo(60.0),
            accessibility = AccessibilityInfo(reduceMotion = true),
            // A physical device: its model only.
            device = DeviceInfo(model = "Google Pixel 8", simulator = false),
        ),
        "catalog" to AppMessage.Events(
            listOf(
                Event.Signal(SignalSite("dev/keyframer/example/MainActivity.kt:80:0:cardX", "dev/keyframer/example/MainActivity.kt", 80, "MainActivity", "cardX")),
                Event.Signal(SignalSite("${site.id}:alpha", site.file, 42, "MainActivity", "title.alpha", writable = false, prop = "alpha")),
                Event.Signal(SignalSite("${site.id}:time", site.file, 42, "MainActivity", "title time", kind = "time")),
                Event.RenderHint("${site.id}:alpha", "layer-alpha", "alpha animates on TextView, which has overlapping rendering and no hardware layer"),
                Event.RenderHint("dev/keyframer/example/MainActivity.kt:96:0", "elevation", "translationZ animates on TextView, so its shadow is drawn again every frame"),
                Event.RenderHint("dev/keyframer/example/DetailActivity.kt:50:0", "mask"),
                Event.Unsignal("dev/keyframer/example/DetailActivity.kt:31:0"),
            ),
        ),
        // While recording, values that mount and go away say when.
        "mounts" to AppMessage.Events(
            listOf(
                Event.Signal(SignalSite("dev/keyframer/example/DetailActivity.kt:50:0:sheet:alpha", "dev/keyframer/example/DetailActivity.kt", 50, "DetailActivity", "sheet.alpha", writable = false, prop = "alpha"), t = 412),
                Event.Unsignal("dev/keyframer/example/DetailActivity.kt:50:0:sheet:alpha", t = 1630),
            ),
        ),
        "anim" to AppMessage.Events(
            listOf(
                Event.Anim(
                    1, site, 1_760_000_000_000,
                    listOf(linkedMapOf("duration" to 650, "delay" to 120, "iterationCount" to 1, "direction" to "normal", "interpolator" to "DecelerateInterpolator", "values" to linkedMapOf("alpha" to listOf(0.0, 1.0)))),
                    t = 120,
                    frames = listOf(StackFrame("dev.keyframer.example.MainActivity.onCreate", "dev/keyframer/example/MainActivity.kt", 42, 0), StackFrame("android.app.Activity.performCreate", "android/app/Activity.java", 8595, 0, collapse = true)),
                    durationMs = 770,
                ),
                Event.Anim(
                    2, CallSite("dev/keyframer/example/ComposeActivity.kt:60:0", "dev/keyframer/example/ComposeActivity.kt", 60, 0, "animateFloatAsState", "ExpandingCard", "corner", null, listOf(Param("dampingRatio", 0.5), Param("stiffness", 400.0))),
                    1_760_000_000_500,
                    listOf(linkedMapOf("type" to "spring", "dampingRatio" to 0.5, "stiffness" to 400.0, "values" to linkedMapOf("corner" to listOf(8.0, 32.0)))),
                    durationMs = 612,
                ),
            ),
        ),
        "samples" to AppMessage.Samples(
            samples = listOf(Sample("dev/keyframer/example/MainActivity.kt:80:0:cardX", 16, 12.5), Sample("${site.id}:time", 16, 250.0)),
            frames = listOf(FrameStat(250, "js", 118, 2)),
            drops = listOf(FrameDrop(400, "js", 25.1, 2)),
            markers = listOf(
                Marker.Navigation(0, "MainActivity"),
                Marker.Navigation(10, "detail", linkedMapOf("id" to 7)),
                Marker.Touch(20, "start", 0, 200.0, 412.5),
                Marker.Touch(30, "cancel", 0, 200.0, 412.5, lost = true),
                Marker.AppState(40, "background"),
                Marker.Keyboard(50, true, 300),
                Marker.Log(60, "error", "boom", "at x"),
                Marker.Note(70, "slow here"),
                Marker.Accessibility(80, true),
                Marker.Display(90, 60.0),
                Marker.Visibility(100, "dev/keyframer/example/MainActivity.kt:120:0", false, VisibilityTracker.Reasons.COVERED),
                Marker.Visibility(110, "dev/keyframer/example/MainActivity.kt:120:0", true),
                Marker.Time(120, 0.25),
                Marker.Time(130, 0.0),
                Marker.Time(140, 0.0, step = 3),
            ),
        ),
        "time" to AppMessage.Time(0.25),
        "timePaused" to AppMessage.Time(0.0),
        "frame" to AppMessage.Frame("c1", "aGVsbG8=", "jpg"),
        "frameError" to AppMessage.Frame("c2", error = "No activity on screen."),
        "scenarios" to AppMessage.Scenarios(listOf("drag card", "open detail")),
        "scenarioDone" to AppMessage.ScenarioDone("drag card", 1200),
        "scenarioDoneError" to AppMessage.ScenarioDone("nope", 0, "No scenario named \"nope\". Registered: drag card."),
    )

    /** The import line is kept from the file on disk: the public repository lays the protocol out elsewhere. */
    private fun typescript(importLine: String?): String = buildString {
        appendLine("// Generated by GoldensTest from the messages this SDK sends: do not edit.")
        appendLine("// `tsc -p src/test/goldens/tsconfig.json` checks every message against the protocol types.")
        appendLine(importLine ?: "import type { InspectorAppMessage } from '../../../../../../../../../protocol/inspector'")
        appendLine()
        appendLine("export const goldens = {")
        for ((name, msg) in goldens()) appendLine("  $name: ${Json.encode(msg)},")
        appendLine("} satisfies Record<string, InspectorAppMessage>")
    }

    @Test
    fun `messages ts is in sync with the messages`() {
        val existing = if (file.exists()) file.readLines().firstOrNull { it.startsWith("import type ") } else null
        val actual = typescript(existing)
        if (update || !file.exists()) file.writeText(actual)
        assertEquals(actual, file.readText(), "messages.ts is stale: run ./gradlew :keyframer-inspector-core:test -PupdateGoldens=true")
    }

    @Test
    fun `the goldens type-check against the protocol`() {
        // The workspace's TypeScript, wherever the inspector is developed: its own node_modules, or
        // Keyframer's when it is a subtree there, or the public repository's.
        val tsc = listOf("../../../node_modules/.bin/tsc", "../../../../node_modules/.bin/tsc", "../../node_modules/.bin/tsc")
            .map(::File).firstOrNull { it.exists() }
        Assume.assumeTrue("no TypeScript in node_modules", tsc != null)
        if (!file.exists()) file.writeText(typescript(null))
        val p = ProcessBuilder(tsc!!.path, "-p", "src/test/goldens/tsconfig.json").redirectErrorStream(true).start()
        val out = p.inputStream.bufferedReader().readText()
        check(p.waitFor(120, TimeUnit.SECONDS)) { "tsc did not finish" }
        assertEquals(0, p.exitValue(), out)
    }
}
