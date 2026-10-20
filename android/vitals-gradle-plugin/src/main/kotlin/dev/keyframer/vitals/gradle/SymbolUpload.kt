package dev.keyframer.vitals.gradle

import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.zip.Deflater
import java.util.zip.GZIPOutputStream

/**
 * Uploads a symbol set the way `keyframer-vitals symbols upload` (@keyframerdev/vitals-cli) does:
 * PUT /v1/symbols/r8/<debugId>/<chunk> for each chunk (gzipped JSON), then POST the manifest, so the set
 * is visible only when complete. Retries with backoff on network errors, 429 and 5xx; 401, 403 and 413
 * stop at once.
 */
class SymbolUpload(
    private val endpoint: String,
    private val key: String,
    private val retries: Int = 4,
    private val backoffMs: Long = 500,
    private val log: (String) -> Unit = {},
) {
    class Failure(message: String) : Exception(message)

    fun upload(set: R8Symbols.SymbolSet) {
        val base = endpoint.trimEnd('/') + "/v1/symbols/r8/" + enc(set.debugId)
        val bodies = set.chunks.map { (file, json) -> file to gzip(json) }
        for ((file, body) in bodies) {
            if (body.size > MAX_CHUNK_GZIP) throw Failure("chunk $file is ${body.size} bytes gzipped, over the $MAX_CHUNK_GZIP byte limit")
        }
        for ((file, body) in bodies) {
            send("$base/${enc(file)}", "PUT", mapOf("Content-Type" to "application/json", "Content-Encoding" to "gzip"), body, "chunk $file of r8 ${set.debugId}")
        }
        send("$base/manifest", "POST", mapOf("Content-Type" to "application/json"), set.manifestJson.toByteArray(Charsets.UTF_8), "the manifest of r8 ${set.debugId}")
    }

    private fun send(url: String, method: String, headers: Map<String, String>, body: ByteArray, what: String) {
        var wait = backoffMs
        var attempt = 0
        while (true) {
            var status = 0
            var text = ""
            var retryAfter = 0L
            try {
                val c = URL(url).openConnection() as HttpURLConnection
                try {
                    c.requestMethod = method
                    c.connectTimeout = 30_000
                    c.readTimeout = 60_000
                    c.doOutput = true
                    c.setRequestProperty("Authorization", "Bearer $key")
                    for ((k, v) in headers) c.setRequestProperty(k, v)
                    c.setFixedLengthStreamingMode(body.size)
                    c.outputStream.use { it.write(body) }
                    status = c.responseCode
                    if (status in 200..299) return
                    text = (c.errorStream ?: c.inputStream)?.use { String(it.readBytes(), Charsets.UTF_8) }.orEmpty()
                    retryAfter = c.getHeaderField("Retry-After")?.toLongOrNull() ?: 0
                } finally {
                    c.disconnect()
                }
            } catch (e: java.io.IOException) {
                text = e.message ?: e.javaClass.simpleName
            }
            val retryable = status == 0 || status == 429 || status >= 500
            if (!retryable || attempt >= retries) throw Failure(explain(status, what, text, url))
            log("  retrying $what (${if (status == 0) "network error" else status.toString()})")
            Thread.sleep(maxOf(wait, retryAfter * 1000))
            wait *= 2
            attempt++
        }
    }

    private fun explain(status: Int, what: String, body: String, url: String): String {
        val detail = body.trim().takeIf { it.isNotEmpty() }?.let { ": " + it.take(300) }.orEmpty()
        return when (status) {
            0 -> "$what could not reach ${URL(url).let { "${it.protocol}://${it.authority}" }}$detail"
            401, 403 -> "the upload key was refused ($status) for $what. Use the project's CI upload key (kft_…) from the Motion Vitals dashboard, in KEYFRAMER_VITALS_UPLOAD_KEY or the keyframerVitalsUploadKey Gradle property$detail"
            413 -> "$what is too large for the server (413)$detail"
            else -> "$what failed with $status$detail"
        }
    }

    companion object {
        /** The Worker's limit for one chunk, gzipped. */
        const val MAX_CHUNK_GZIP = 256 * 1024

        private fun enc(s: String) = URLEncoder.encode(s, "UTF-8").replace("+", "%20")

        fun gzip(text: String): ByteArray {
            val out = ByteArrayOutputStream()
            object : GZIPOutputStream(out) {
                init {
                    def.setLevel(Deflater.BEST_COMPRESSION)
                }
            }.use { it.write(text.toByteArray(Charsets.UTF_8)) }
            return out.toByteArray()
        }
    }
}
