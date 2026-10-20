package dev.keyframer.vitals.gradle

import com.sun.net.httpserver.HttpServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.net.InetSocketAddress
import java.util.zip.GZIPInputStream

private fun symbols(): File? = System.getProperty("keyframer.vitals.symbols")?.let { File(it) }?.takeIf { it.resolve("inputs/mapping.txt").exists() }

/** The plugin's r8 chunks against the symbols CLI's golden output, byte for byte. */
class R8SymbolsTest {
    private fun buildFixture(budget: Int): R8Symbols.SymbolSet {
        val dir = symbols()!!
        return R8Symbols.build(
            mapping = dir.resolve("inputs/mapping.txt").readText(),
            debugId = "1.4.0+212",
            appId = null,
            appVersion = "1.4.0",
            appBuild = "212",
            createdAt = "1970-01-01T00:00:00.000Z",
            cliName = "keyframer-vitals",
            cliVersion = "0.0.0-fixture",
            budget = budget,
        )
    }

    private fun compare(case: String, budget: Int) {
        assumeTrue("symbol fixtures not found", symbols() != null)
        val expected = symbols()!!.resolve("expected/$case/r8/1.4.0+212")
        val set = buildFixture(budget)
        val files = expected.listFiles()!!.map { it.name }.filter { it != "manifest.json" }.sorted()
        assertEquals(files, set.chunks.map { it.first })
        for ((file, json) in set.chunks) assertEquals("$case/$file", expected.resolve(file).readText().trim(), json)
        assertEquals("$case/manifest.json", expected.resolve("manifest.json").readText().trim(), set.manifestJson)
    }

    @Test
    fun matchesTheCliGolden() = compare("r8", R8Symbols.CHUNK_BUDGET)

    @Test
    fun cutsChunksLikeTheCli() = compare("r8-sharded", 600)

    @Test
    fun parsesEveryRowKind() {
        val classes = R8Symbols.parse(
            "a.B -> x:\n# {\"id\":\"sourceFile\",\"fileName\":\"B.kt\"}\n    int f -> a\n    1:3:void m(int):10:12 -> a\n    4:4:void com.o.C.n():7 -> a\n    5:6:void k() -> b\n    void z() -> c\n    void y():9 -> d\r\n",
        )
        val (obf, c) = classes.single()
        assertEquals("x", obf)
        assertEquals("a.B", c.name)
        assertEquals("B.kt", c.file)
        assertEquals(
            listOf(
                listOf("a", "m", 1L, 3L, 10L, 12L),
                listOf("a", "com.o.C.n", 4L, 4L, 7L, 7L),
                listOf("b", "k", 5L, 6L, 5L, 6L),
                listOf("c", "z", 0L, 0L, 0L, 0L),
                listOf("d", "y", 0L, 0L, 9L, 9L),
            ),
            c.methods.map { listOf(it.obfuscated, it.original, it.obfStart, it.obfEnd, it.origStart, it.origEnd) },
        )
    }

    @Test
    fun aClassLineWithoutAnArrowIsAnError() {
        try {
            R8Symbols.parse("not a mapping\n")
            fail("expected an error")
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message!!.contains("line 1"))
        }
    }

    @Test
    fun manifestCarriesTheBuildIdAndApp() {
        val set = R8Symbols.build("a.B -> x:\n    void z() -> c\n", "3C8E5F1A07B94D62A9E4C2F6B1D8E037", "com.acme.shop", "3.4.0", "412", "2026-10-18T00:00:00.000Z", "dev.keyframer.vitals", "1.0.0")
        assertEquals("3c8e5f1a07b94d62a9e4c2f6b1d8e037", set.debugId)
        assertEquals(
            "{\"format\":\"keyframer-vitals-symbols\",\"version\":1,\"kind\":\"r8\",\"debugId\":\"3c8e5f1a07b94d62a9e4c2f6b1d8e037\",\"app\":{\"id\":\"com.acme.shop\",\"version\":\"3.4.0\",\"build\":\"412\"},\"chunks\":[{\"file\":\"0000.json\",\"first\":\"x\"}],\"createdAt\":\"2026-10-18T00:00:00.000Z\",\"cli\":{\"name\":\"dev.keyframer.vitals\",\"version\":\"1.0.0\"}}",
            set.manifestJson,
        )
    }
}

class SymbolUploadTest {
    private class Seen(val method: String, val path: String, val auth: String?, val encoding: String?, val body: String)

    private fun server(statuses: MutableList<Int>, seen: MutableList<Seen>): HttpServer {
        val s = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        s.createContext("/") { ex ->
            val raw = ex.requestBody.readBytes()
            val enc = ex.requestHeaders.getFirst("Content-Encoding")
            val body = if (enc == "gzip") GZIPInputStream(raw.inputStream()).readBytes().toString(Charsets.UTF_8) else raw.toString(Charsets.UTF_8)
            seen.add(Seen(ex.requestMethod, ex.requestURI.rawPath, ex.requestHeaders.getFirst("Authorization"), enc, body))
            val status = if (statuses.isEmpty()) 200 else statuses.removeAt(0)
            ex.sendResponseHeaders(status, -1)
            ex.close()
        }
        s.start()
        return s
    }

    private val set = R8Symbols.build("a.B -> x:\n    void z() -> c\nb.C -> y:\n    void w() -> a\n", "1.4.0+212", null, "1.4.0", "212", "1970-01-01T00:00:00.000Z", "t", "0", budget = 60)

    @Test
    fun chunksFirstThenTheManifest() {
        val seen = ArrayList<Seen>()
        val s = server(mutableListOf(), seen)
        try {
            SymbolUpload("http://127.0.0.1:${s.address.port}/", "kft_secret").upload(set)
        } finally {
            s.stop(0)
        }
        assertEquals(listOf("PUT", "PUT", "POST"), seen.map { it.method })
        assertEquals(
            listOf("/v1/symbols/r8/1.4.0%2B212/0000.json", "/v1/symbols/r8/1.4.0%2B212/0001.json", "/v1/symbols/r8/1.4.0%2B212/manifest"),
            seen.map { it.path },
        )
        assertTrue(seen.all { it.auth == "Bearer kft_secret" })
        assertEquals(listOf("gzip", "gzip", null), seen.map { it.encoding })
        assertEquals(set.chunks.map { it.second }, seen.take(2).map { it.body })
        assertEquals(set.manifestJson, seen[2].body)
    }

    @Test
    fun retriesServerErrorsAndStopsOnARefusedKey() {
        val seen = ArrayList<Seen>()
        val s = server(mutableListOf(503, 429), seen)
        try {
            SymbolUpload("http://127.0.0.1:${s.address.port}", "kft_secret", backoffMs = 1).upload(set)
            assertEquals(5, seen.size)
            seen.clear()
            val refused = server(mutableListOf(401), seen)
            try {
                SymbolUpload("http://127.0.0.1:${refused.address.port}", "kft_bad", backoffMs = 1).upload(set)
                fail("expected a failure")
            } catch (e: SymbolUpload.Failure) {
                assertTrue(e.message!!.contains("kft_"))
                assertEquals(1, seen.size)
            } finally {
                refused.stop(0)
            }
        } finally {
            s.stop(0)
        }
    }
}
