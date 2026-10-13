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
) {
    private fun say(s: String) = println("[script] $s")

    fun run(): Boolean {
        val editor = EditorClient(url)
        editor.awaitOpen()
        editor.send(mapOf("type" to "hello", "role" to "editor"))
        say("waiting for an app...")
        val hello = editor.await(appWaitMs, "the app's hello") { it["type"] == "hello" && it["role"] == "app" }
        say("hello: app=${hello["app"]} platform=${hello["platform"]} capture=${hello["capture"]} screen=${hello["screen"]} scenarios=${hello["scenarios"]}")
        editor.await(5000, "the catalog") { m -> m["type"] == "events" && m["events"].asList().any { it.asMap()["kind"] == "signal" } }
        Thread.sleep(500)
        val signals = editor.ofType("events").flatMap { it["events"].asList() }.map { it.asMap() }.filter { it["kind"] == "signal" }
            .map { it["site"].asMap() }.associateBy { it["id"] as String }
        say("signals (${signals.size}): " + signals.values.joinToString { "${it["name"]} @ ${it["file"]}:${(it["line"] as Double).toInt()}" })

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
}
