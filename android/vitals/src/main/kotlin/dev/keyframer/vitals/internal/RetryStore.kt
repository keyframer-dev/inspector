package dev.keyframer.vitals.internal

import java.io.File

/**
 * Reports waiting to be sent, as gzipped JSON files in the app's files dir (production.md 2.1): at most
 * 5 reports, 100 KB and 7 days; the oldest go first when a limit is hit. Also the window's checkpoint,
 * rewritten every 60 s while a window is open, so a session that ends in a freeze the person kills is
 * sent on the next launch with `ended: 'unknown'`.
 */
internal class RetryStore(private val dir: File) {
    class Pending(val file: File, val createdMs: Long) {
        fun read(): ByteArray? = runCatching { file.readBytes() }.getOrNull()
    }

    private var counter = 0

    /** Keeps one report (gzipped JSON). Returns its entry, or null when it could not be written. */
    @Synchronized
    fun add(gz: ByteArray, nowWallMs: Long): Pending? {
        if (gz.size > MAX_BYTES) return null
        if (!dir.exists() && !dir.mkdirs()) return null
        val f = File(dir, "%013d-%03d$SUFFIX".format(nowWallMs, counter++ % 1000))
        val ok = runCatching {
            val tmp = File(dir, f.name + ".tmp")
            tmp.writeBytes(gz)
            tmp.renameTo(f)
        }.getOrDefault(false)
        if (!ok) return null
        trim(nowWallMs)
        return list(nowWallMs).firstOrNull { it.file == f }
    }

    /** Pending reports, oldest first, after dropping what is past the limits. */
    @Synchronized
    fun list(nowWallMs: Long): List<Pending> {
        trim(nowWallMs)
        return entries()
    }

    @Synchronized
    fun remove(p: Pending) {
        p.file.delete()
    }

    @Synchronized
    fun clear() {
        entries().forEach { it.file.delete() }
        checkpointFile.delete()
        dir.listFiles()?.filter { it.name.endsWith(".tmp") }?.forEach { it.delete() }
    }

    private fun entries(): List<Pending> =
        (dir.listFiles() ?: emptyArray())
            .filter { it.isFile && it.name.endsWith(SUFFIX) }
            .mapNotNull { f -> f.name.substringBefore('-').toLongOrNull()?.let { Pending(f, it) } }
            .sortedWith(compareBy({ it.createdMs }, { it.file.name }))

    private fun trim(nowWallMs: Long) {
        val all = entries().toMutableList()
        // Past 7 days (or from a clock that has moved back a long way): dropped.
        all.removeAll { p -> (nowWallMs - p.createdMs > MAX_AGE_MS || p.createdMs - nowWallMs > MAX_AGE_MS).also { if (it) p.file.delete() } }
        while (all.size > MAX_REPORTS) all.removeAt(0).file.delete()
        while (all.isNotEmpty() && all.sumOf { it.file.length() } > MAX_BYTES) all.removeAt(0).file.delete()
    }

    // ---------- the checkpoint ----------

    private val checkpointFile get() = File(dir, "checkpoint.json.gz")

    @Synchronized
    fun writeCheckpoint(gz: ByteArray) {
        if (!dir.exists() && !dir.mkdirs()) return
        runCatching {
            val tmp = File(dir, "checkpoint.tmp")
            tmp.writeBytes(gz)
            tmp.renameTo(checkpointFile)
        }
    }

    @Synchronized
    fun clearCheckpoint() {
        checkpointFile.delete()
    }

    /** The last launch's checkpoint, moved into the pending reports to be sent. */
    @Synchronized
    fun adoptCheckpoint(nowWallMs: Long): Pending? {
        val f = checkpointFile
        if (!f.exists()) return null
        val bytes = runCatching { f.readBytes() }.getOrNull()
        f.delete()
        return bytes?.let { add(it, nowWallMs) }
    }

    companion object {
        const val SUFFIX = ".json.gz"
        const val MAX_REPORTS = 5
        const val MAX_BYTES = 100 * 1024L
        const val MAX_AGE_MS = 7L * 24 * 3600 * 1000
    }
}
