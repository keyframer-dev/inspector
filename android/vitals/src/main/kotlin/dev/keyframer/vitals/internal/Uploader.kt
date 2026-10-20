package dev.keyframer.vitals.internal

import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.zip.GZIPInputStream
import java.util.zip.GZIPOutputStream

/** One HTTP exchange: status and body, or null when the network failed. */
internal fun interface Transport {
    fun send(method: String, url: String, headers: Map<String, String>, body: ByteArray?): Response?

    class Response(val status: Int, val body: String)
}

/** HttpURLConnection, no extra dependency. 15 s to connect and to read; never follows redirects to elsewhere. */
internal object HttpTransport : Transport {
    override fun send(method: String, url: String, headers: Map<String, String>, body: ByteArray?): Transport.Response? = try {
        val c = URL(url).openConnection() as HttpURLConnection
        try {
            c.requestMethod = method
            c.connectTimeout = 15_000
            c.readTimeout = 15_000
            c.instanceFollowRedirects = false
            c.useCaches = false
            for ((k, v) in headers) c.setRequestProperty(k, v)
            if (body != null) {
                c.doOutput = true
                c.setFixedLengthStreamingMode(body.size)
                c.outputStream.use { it.write(body) }
            }
            val status = c.responseCode
            val stream = if (status >= 400) c.errorStream else c.inputStream
            val text = stream?.use { s ->
                val raw = s.readBytes()
                if (c.contentEncoding.equals("gzip", ignoreCase = true)) Gzip.decompress(raw) else String(raw, Charsets.UTF_8)
            }.orEmpty()
            Transport.Response(status, text)
        } finally {
            c.disconnect()
        }
    } catch (_: Exception) {
        null
    }
}

internal object Gzip {
    fun compress(text: String): ByteArray {
        val out = ByteArrayOutputStream()
        GZIPOutputStream(out).use { it.write(text.toByteArray(Charsets.UTF_8)) }
        return out.toByteArray()
    }

    fun decompress(gz: ByteArray): String = GZIPInputStream(gz.inputStream()).use { String(it.readBytes(), Charsets.UTF_8) }
}

/**
 * Sends reports and fetches the config (protocol/vitals.ts): POST /v1/reports with the gzipped report,
 * GET /v1/config/<key>. Every answer's config is kept; 401 and 410 switch the reporter off for 7 days.
 */
internal class Uploader(
    private val endpoint: String,
    private val key: String,
    private val transport: Transport,
    private val configs: ConfigStore,
    private val sdkVersion: String,
) {
    enum class Outcome {
        /** Accepted (200), or refused for good (400, 413): either way it is done with. */
        DONE,
        /** Try again later: network, 429, 5xx. */
        RETRY,
        /** 401 or 410, or `stop`: off for 7 days, pending reports dropped. */
        KILLED,
    }

    private val base = endpoint.trimEnd('/')

    fun sendReport(gz: ByteArray, nowWallMs: Long): Outcome {
        val r = transport.send(
            "POST",
            "$base/v1/reports",
            mapOf(
                "Authorization" to "Bearer $key",
                "Content-Type" to "application/json",
                "Content-Encoding" to "gzip",
                "User-Agent" to "${VitalsProtocol.SDK_NAME}/$sdkVersion",
            ),
            gz,
        ) ?: return Outcome.RETRY
        readConfig(r.body, nowWallMs)
        return when {
            r.status == 401 || r.status == 410 -> {
                configs.killFor7Days(nowWallMs)
                Outcome.KILLED
            }
            configs.killed(nowWallMs) -> Outcome.KILLED
            r.status in 200..299 || r.status == 400 || r.status == 413 -> Outcome.DONE
            else -> Outcome.RETRY
        }
    }

    /** Fetches the config; true when one arrived. */
    fun fetchConfig(nowWallMs: Long): Boolean {
        val r = transport.send("GET", "$base/v1/config/$key", mapOf("Accept" to "application/json", "User-Agent" to "${VitalsProtocol.SDK_NAME}/$sdkVersion"), null) ?: return false
        if (r.status == 401 || r.status == 410) {
            configs.killFor7Days(nowWallMs)
            return false
        }
        if (r.status !in 200..299) return false
        val parsed = runCatching { Json.parse(r.body) }.getOrNull() ?: return false
        // The config itself, or an ingest-style answer carrying one.
        val config = (parsed as? Map<*, *>)?.let { if (it.containsKey("config")) it["config"] else it }
        if (Config.from(config) == null) return false
        configs.save(config, nowWallMs)
        return true
    }

    private fun readConfig(body: String, nowWallMs: Long) {
        if (body.isEmpty()) return
        val parsed = runCatching { Json.parse(body) }.getOrNull() as? Map<*, *> ?: return
        parsed["config"]?.let { configs.save(it, nowWallMs) }
    }
}
