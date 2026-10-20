package dev.keyframer.relay

import java.io.File
import java.util.Base64
import kotlin.system.exitProcess

/**
 * ./gradlew :fake-relay:run                          relay on 127.0.0.1:8790, logs what passes
 * ./gradlew :fake-relay:run --args="--port 8791"
 * ./gradlew :fake-relay:run --args="--script --record 3000 --out /tmp/kf"
 *     relay plus a scripted editor: waits for an app, records everything for 3 s, prints a summary,
 *     plays the recording back, captures one frame (saved to --out) and exits 0 when all of it worked.
 *     --scenario "drag card,open detail"   runs these scenarios while recording, in order
 *     --capture-at 300,900                 captures the recording at these times (default: the middle)
 * ./gradlew :fake-relay:run --args="--script --time pulse"
 *     relay plus a scripted editor that checks the `time` capability: runs the given scenarios first,
 *     then records while it sets the speed to 1, 0.25, 0 (with a step), and 1 again, and measures how
 *     fast the signals named `pulse` move in each phase. Exits 0 when slow motion, pause and step all
 *     show in the samples. It also prints the hello's display and motion settings, the markers
 *     (time, display, accessibility, visibility) and render hints it saw.
 */
fun main(args: Array<String>) {
    fun arg(name: String) = args.indexOf(name).takeIf { it >= 0 }?.let { args.getOrNull(it + 1) }
    val port = arg("--port")?.toInt() ?: 8790
    val quiet = "--quiet" in args
    val relay = FakeRelay(log = { if (!quiet) println("[relay] $it") }).start(port)
    if ("--script" !in args) {
        println("Ctrl+C to stop. Emulator apps reach this at ws://10.0.2.2:$port, devices through `adb reverse tcp:$port tcp:$port`.")
        Thread.currentThread().join()
    }
    val ok = try {
        Script(
            url = "ws://127.0.0.1:${relay.port}/editor",
            recordMs = arg("--record")?.toLong() ?: 3000,
            appWaitMs = arg("--wait")?.toLong() ?: 120_000,
            out = arg("--out")?.let(::File),
            scenarios = arg("--scenario")?.split(',')?.map { it.trim() }.orEmpty(),
            captureAt = arg("--capture-at")?.split(',')?.map { it.trim().toDouble() }.orEmpty(),
            timeSignal = arg("--time"),
        ).run()
    } catch (e: Throwable) {
        println("[script] FAILED: ${e.message}")
        false
    } finally {
        relay.stop()
    }
    exitProcess(if (ok) 0 else 1)
}

/** What a panel does in one session, checked step by step. */
class Script(
    private val url: String,
    private val recordMs: Long,
    private val appWaitMs: Long,
    private val out: File?,
    private val scenarios: List<String> = emptyList(),
    private val captureAt: List<Double> = emptyList(),
    /** Check the `time` capability on the signals with this name instead of recording and playing back. */
    private val timeSignal: String? = null,
) {
    private fun say(s: String) = println("[script] $s")

    fun run(): Boolean {
        val editor = EditorClient(url)
        editor.awaitOpen()
        editor.send(mapOf("type" to "hello", "role" to "editor"))
        say("waiting for an app...")
        val hello = editor.await(appWaitMs, "the app's hello") { it["type"] == "hello" && it["role"] == "app" }
        say("hello: app=${hello["app"]} platform=${hello["platform"]} capture=${hello["capture"]} screen=${hello["screen"]} scenarios=${hello["scenarios"]} device=${hello["device"]}")
        editor.await(5000, "the catalog") { m -> m["type"] == "events" && m["events"].asList().any { it.asMap()["kind"] == "signal" } }
        Thread.sleep(500)
        val signals = editor.ofType("events").flatMap { it["events"].asList() }.map { it.asMap() }.filter { it["kind"] == "signal" }
            .map { it["site"].asMap() }.associateBy { it["id"] as String }
        say("signals (${signals.size}): " + signals.values.joinToString { "${it["name"]} @ ${it["file"]}:${(it["line"] as Double).toInt()}" })
        if (timeSignal != null) return timeCheck(editor, hello, timeSignal).also { editor.close() }

        editor.clear()
        editor.send(mapOf("type" to "record", "signalIds" to listOf("*"), "on" to true))
        val t0 = System.currentTimeMillis()
        for (name in scenarios) {
            editor.send(mapOf("type" to "scenario", "name" to name))
            val done = editor.await(recordMs + 10_000, "scenarioDone $name") { it["type"] == "scenarioDone" && it["name"] == name }
            say("scenario: $done")
        }
        Thread.sleep((recordMs - (System.currentTimeMillis() - t0)).coerceAtLeast(300))
        editor.send(mapOf("type" to "record", "signalIds" to listOf("*"), "on" to false))
        Thread.sleep(400)

        val batches = editor.ofType("samples")
        val samples = batches.flatMap { it["samples"].asList() }.map { it.asMap() }
        val frames = batches.flatMap { it["frames"].asList() }.map { it.asMap() }
        val drops = batches.flatMap { it["drops"].asList() }.map { it.asMap() }
        val markers = batches.flatMap { it["markers"].asList() }.map { it.asMap() }
        val anims = editor.ofType("events").flatMap { it["events"].asList() }.map { it.asMap() }.filter { it["kind"] == "anim" }
        say("recorded ${samples.size} samples in ${batches.size} batches")
        for ((id, list) in samples.groupBy { it["id"] as String }) {
            val vs = list.map { it["v"] as Double }
            say("  $id: ${list.size} samples, t ${(list.first()["t"] as Double).toLong()}..${(list.last()["t"] as Double).toLong()} ms, v ${vs.min()}..${vs.max()}")
        }
        say("frames: ${frames.size} windows, fps ${frames.map { (it["fps"] as Double).toInt() }.take(12)}..., ${drops.size} long frames")
        say("markers: " + markers.groupBy { it["kind"] }.map { (k, v) -> "$k x${v.size}" } + " routes ${markers.filter { it["kind"] == "navigation" }.map { it["route"] }}")
        for (a in anims.take(6)) {
            val site = a["site"].asMap()
            say("  anim #${(a["eid"] as Double).toInt()} ${site["fn"]} ${site["target"]} @ ${site["file"]}:${(site["line"] as Double).toInt()} in ${site["component"]} t=${a["t"]} args=${a["args"]}")
        }
        var ok = samples.isNotEmpty() && frames.isNotEmpty()

        val routes = markers.filter { it["kind"] == "navigation" }.map { mapOf("t" to it["t"], "route" to it["route"]) }
        if (samples.isNotEmpty()) {
            say("playing the recording back...")
            editor.send(mapOf("type" to "playback", "samples" to samples, "routes" to routes))
            Thread.sleep(recordMs + 800)
        }

        val times = captureAt.ifEmpty { if (samples.isEmpty()) emptyList() else listOf(samples.maxOf { it["t"] as Double } / 2) }
        for ((n, mid) in times.withIndex()) {
            if (hello["capture"] != true) break
            val at = samples.groupBy { it["id"] }.mapNotNull { (_, l) -> l.minByOrNull { kotlin.math.abs((it["t"] as Double) - mid) } }
            // The screen it was on at that time, as the panel sends it.
            val route = routes.lastOrNull { (it["t"] as Double) <= mid }
            val id = "c${n + 1}"
            editor.clear()
            editor.send(mapOf("type" to "capture", "id" to id, "samples" to at, "format" to "jpg", "quality" to 0.8, "width" to 360, "route" to route))
            val frame = editor.await(10_000, "frame $id") { it["type"] == "frame" && it["id"] == id }
            val data = frame["data"] as? String
            if (data == null) {
                say("capture failed: ${frame["error"]}")
                ok = false
            } else {
                val bytes = Base64.getDecoder().decode(data)
                say("captured frame at ${mid.toLong()} ms (${route?.get("route")}): ${bytes.size} bytes ${frame["format"]}")
                out?.let { dir ->
                    dir.mkdirs()
                    val file = File(dir, "capture-${mid.toLong()}.${frame["format"]}")
                    file.writeBytes(bytes)
                    say("saved ${file.absolutePath}")
                }
            }
        }
        editor.close()
        say(if (ok) "OK" else "FAILED")
        return ok
    }

    /**
     * Slow motion, pause and step, measured: the mean speed (|change| per ms) of the named signals in
     * each phase, against the first phase at normal speed.
     */
    private fun timeCheck(editor: EditorClient, hello: Map<String, Any?>, name: String): Boolean {
        say("hello: framework=${hello["framework"]} display=${hello["display"]} accessibility=${hello["accessibility"]} capabilities=${hello["capabilities"]}")
        if ("time" !in hello["capabilities"].asList()) {
            say("the app does not list the time capability")
            return false
        }
        for (s in scenarios) {
            editor.send(mapOf("type" to "scenario", "name" to s))
            say("scenario: ${editor.await(10_000, "scenarioDone $s") { it["type"] == "scenarioDone" && it["name"] == s }}")
        }
        Thread.sleep(600)
        val ids = editor.ofType("events").flatMap { it["events"].asList() }.map { it.asMap() }
            .filter { it["kind"] == "signal" }.map { it["site"].asMap() }
            .filter { (it["name"] as? String)?.let { n -> n == name || n.endsWith(".$name") } == true }
            .map { it["id"] as String }.toSet()
        if (ids.isEmpty()) {
            say("no signal named $name")
            return false
        }
        say("measuring ${ids.joinToString()}")
        fun hintsSoFar() = editor.ofType("events").flatMap { it["events"].asList() }.map { it.asMap() }.filter { it["kind"] == "renderHint" }
        val earlierHints = hintsSoFar()
        editor.clear()
        editor.send(mapOf("type" to "record", "signalIds" to listOf("*"), "on" to true))
        fun phase(@Suppress("UNUSED_PARAMETER") label: String, ms: Long, vararg msg: Map<String, Any?>) {
            for (m in msg) editor.send(m)
            Thread.sleep(120 + ms)
        }
        phase("normal", 1200)
        phase("0.25", 1600, mapOf("type" to "time", "scale" to 0.25))
        phase("paused", 800, mapOf("type" to "time", "scale" to 0))
        phase("step 6", 600, mapOf("type" to "time", "scale" to 0, "step" to 6))
        phase("normal again", 1200, mapOf("type" to "time", "scale" to 1))
        editor.send(mapOf("type" to "record", "signalIds" to listOf("*"), "on" to false))
        Thread.sleep(400)

        val answers = editor.ofType("time").map { it["scale"] }
        say("time answers: $answers")
        if (System.getenv("KF_DEBUG") != null) {
            say("messages: " + editor.messages().joinToString(" ") { m ->
                when (m["type"]) {
                    "samples" -> "samples(${m["samples"].asList().size},${m["markers"].asList().size}m)"
                    "time" -> "time(${m["scale"]})"
                    else -> m["type"].toString()
                }
            })
        }
        val batches = editor.ofType("samples")
        val samples = batches.flatMap { it["samples"].asList() }.map { it.asMap() }.filter { it["id"] in ids }
        val markers = batches.flatMap { it["markers"].asList() }.map { it.asMap() }
        val times = markers.filter { it["kind"] == "time" }
        fun moved(from: Double, to: Double): Pair<Double, Double> {
            var moved = 0.0
            var span = 0.0
            for (list in samples.groupBy { it["id"] }.values) {
                val w = list.filter { (it["t"] as Double) in from..to }.sortedBy { it["t"] as Double }
                for (i in 1 until w.size) moved += kotlin.math.abs((w[i]["v"] as Double) - (w[i - 1]["v"] as Double))
                if (w.size > 1) span += (w.last()["t"] as Double) - (w.first()["t"] as Double)
            }
            return moved to span
        }
        fun speed(from: Double, to: Double) = moved(from, to).let { (m, s) -> if (s > 0) m / s else 0.0 }
        say("markers: " + markers.filter { it["kind"] in setOf("time", "display", "accessibility", "visibility") })
        val hints = earlierHints + hintsSoFar()
        say("render hints: " + hints.map { "${it["hint"]} on ${it["id"]}: ${it["detail"]}" })
        if (times.map { it["scale"] } != listOf(0.25, 0.0, 1.0)) {
            say("time markers: ${times.map { it["scale"] }}, expected [0.25, 0.0, 1.0]")
            say("FAILED")
            return false
        }
        // Phases on the recording's clock, from the markers the app put there; the step went out 920 ms
        // after the pause (as sent), so it lands about that long after the pause marker.
        val (slow, pause, normal) = times.map { it["t"] as Double }
        val end = samples.maxOf { it["t"] as Double }
        val base = speed(100.0, slow - 50)
        val step = pause + 920
        val r = linkedMapOf(
            "0.25" to speed(slow + 150, pause - 50) / base,
            "paused" to speed(pause + 150, step - 70) / base,
            "held after the steps" to speed(step + 330, normal - 50) / base,
            "normal again" to speed(normal + 150, end) / base,
        )
        for ((label, v) in r) say("  $label: ${"%.3f".format(v)} of normal speed")
        // Six frames of 16.7 ms moved on, give or take where on the curve it was paused.
        val stepped = moved(step - 60, step + 330).first / (base * 100)
        say("  step 6: moved ${"%.2f".format(stepped)} times what 100 ms at normal speed moves")
        val ok = base > 0 &&
            answers == listOf(0.25, 0.0, 0.0, 1.0) &&
            r.getValue("0.25") in 0.12..0.45 &&
            r.getValue("paused") < 0.01 &&
            stepped in 0.05..4.0 &&
            r.getValue("held after the steps") < 0.01 &&
            r.getValue("normal again") in 0.6..1.4
        say(if (ok) "OK" else "FAILED")
        return ok
    }
}
