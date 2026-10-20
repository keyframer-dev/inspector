package dev.keyframer.vitals.internal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * The encoder against the shared golden report (inspector/packages/protocol/fixtures/vitals/
 * report-android.json): a report this SDK builds from a scripted session has the fixture's shape, key
 * for key, and the shared validator (protocol/src/vitals-validate.ts, run with bun when it is on the
 * PATH) accepts it.
 */
class GoldenReportTest {
    private fun scriptedReport(): Map<*, *> {
        val h = Harness()
        h.probe.adaptive = false
        h.reporter.framework = "Compose"
        h.reporter.launch()
        h.reporter.onForeground()
        val badge = SiteInfo(SiteRef.Name("cart-badge", null), "animateFloatAsState", null, "scale")
        val minified = StackSites.site(arrayOf(StackTraceElement("a.b.c", "a", "SourceFile", 3)), null, "ObjectAnimator", "translationY", keepType = false)!!
        val card = StackSites.site(arrayOf(StackTraceElement("com.acme.shop.feed.FeedCardKt", "FeedCard", "FeedCard.kt", 88)), null, "animateContentSize", null, keepType = true)!!

        h.reporter.navigate("MainActivity/feed")
        h.clock.ms += 1_000
        repeat(30) { h.frame(8.0) }
        val c = h.reporter.animationStart(card, 400.0)
        val b = h.reporter.animationStart(badge, 300.0)
        repeat(10) { h.frame(9.0) }
        h.frame(121.9, mainMs = 6.0)
        h.reporter.animationEnd(b)
        h.reporter.touch(true)
        h.frame(54.1, mainMs = 20.0)
        h.reporter.touch(false)
        h.reporter.animationEnd(c)
        h.clock.ms += 3_000
        h.reporter.navigate("MainActivity/product/[id]")
        h.clock.ms += 20
        val m = h.reporter.animationStart(minified, 500.0)
        h.frame(233.6, mainMs = 200.0)
        repeat(20) { h.frame(9.0) }
        h.reporter.animationEnd(m)
        h.clock.ms += 2_000
        h.frame(44.2, mainMs = 5.0)
        h.clock.ms += 1_000
        h.reporter.onBackground()
        return h.transport.reports.single()
    }

    /** Same keys, and the same JSON kind for each value, all the way down (arrays: each item against the fixture's first). */
    private fun sameShape(path: String, ours: Any?, golden: Any?, errors: MutableList<String>) {
        when (golden) {
            is Map<*, *> -> {
                if (ours !is Map<*, *>) return run { errors.add("$path: expected an object") }
                if (ours.keys != golden.keys) errors.add("$path: keys ${ours.keys} != fixture ${golden.keys}")
                for (k in golden.keys) if (ours.containsKey(k)) sameShape("$path.$k", ours[k], golden[k], errors)
            }
            is List<*> -> {
                if (ours !is List<*>) return run { errors.add("$path: expected an array") }
                if (golden.isNotEmpty()) ours.forEachIndexed { i, v -> sameShape("$path[$i]", v, golden.first(), errors) }
            }
            null -> if (ours != null && ours !is String) errors.add("$path: expected null or a string")
            else -> if (ours == null || ours::class != golden::class) errors.add("$path: expected ${golden::class.simpleName}, got ${ours?.let { it::class.simpleName }}")
        }
    }

    @Test
    fun matchesTheFixtureShape() {
        val f = fixture("report-android.json")
        assumeTrue("report-android.json not found", f != null)
        val golden = Json.parse(f!!.readText()) as Map<*, *>
        val ours = scriptedReport()
        val errors = ArrayList<String>()
        for (k in listOf("format", "version", "app", "sdk", "device", "display", "state", "session")) sameShape(k, ours[k], golden[k], errors)
        // Screens, sites and worst frames: each of ours against the fixture's entry of the same kind.
        for ((i, s) in (ours["screens"] as List<*>).withIndex()) sameShape("screens[$i]", s, (golden["screens"] as List<*>)[0], errors)
        val goldenSites = golden["sites"] as List<*>
        for ((i, s) in (ours["sites"] as List<*>).withIndex()) {
            val ref = (s as Map<*, *>)["ref"] as Map<*, *>
            val like = goldenSites.first { g ->
                val gr = (g as Map<*, *>)["ref"] as Map<*, *>
                gr["kind"] == ref["kind"] && gr.containsKey("file") == ref.containsKey("file")
            }
            sameShape("sites[$i]", s, like, errors)
        }
        val goldenWorst = golden["worst"] as List<*>
        for ((i, w) in (ours["worst"] as List<*>).withIndex()) {
            val like = goldenWorst.first { (it as Map<*, *>).containsKey("afterNavMs") == (w as Map<*, *>).containsKey("afterNavMs") }
            sameShape("worst[$i]", w, like, errors)
        }
        assertTrue(errors.joinToString("\n"), errors.isEmpty())

        // What the scripted session should say.
        assertEquals(listOf("MainActivity/feed", "MainActivity/product/[id]"), (ours["screens"] as List<*>).map { (it as Map<*, *>)["name"] })
        val worst = (ours["worst"] as List<*>).map { it as Map<*, *> }
        assertEquals(listOf(233.6, 121.9, 54.1, 44.2), worst.map { it["ms"] })
        assertEquals(listOf("screen-mount", "unknown", "gesture", "unknown"), worst.map { it["cause"] })
        assertEquals(listOf("js", "ui", "js", "ui"), worst.map { it["thread"] })
        assertEquals(3, (ours["sites"] as List<*>).size)
    }

    @Test
    fun theSharedValidatorAcceptsIt() {
        val dir = System.getProperty("keyframer.vitals.fixtures")?.let { File(it) }
        val validator = dir?.let { File(it, "../../src/vitals-validate.ts").canonicalFile }
        assumeTrue("vitals-validate.ts not found", validator?.exists() == true)
        val bun = listOf(System.getenv("BUN_INSTALL")?.let { "$it/bin/bun" }, System.getProperty("user.home")?.let { "$it/.bun/bin/bun" }, "/opt/homebrew/bin/bun", "/usr/local/bin/bun")
            .filterNotNull().firstOrNull { File(it).canExecute() }
        assumeTrue("bun not installed", bun != null)
        val out = File.createTempFile("report-android", ".json").apply { deleteOnExit() }
        out.writeText(Json.write(scriptedReport()))
        val script = "import { validateVitalsReport } from '${validator!!.path}'; " +
            "const r = validateVitalsReport(JSON.parse(await Bun.file('${out.path}').text())); " +
            "if (!r.ok) { console.log(r.errors.join('\\n')); process.exit(1) }"
        val p = ProcessBuilder(bun, "-e", script).redirectErrorStream(true).start()
        assertTrue("bun timed out", p.waitFor(60, TimeUnit.SECONDS))
        val text = p.inputStream.bufferedReader().readText()
        assertEquals("validator: $text", 0, p.exitValue())
    }
}
