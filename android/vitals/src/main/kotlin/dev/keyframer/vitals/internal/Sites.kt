package dev.keyframer.vitals.internal

/** Where a tracked animation is in the app: `VitalsSiteRef` of protocol/vitals.ts, the two kinds Android sends. */
internal sealed class SiteRef {
    /** A name the developer gave (`kfTrack("card")`, a Compose label), plus the class it was written in when the build keeps it. */
    data class Name(val name: String, val type: String?) : SiteRef()

    /** The call site's stack frame. In minified builds these are R8 names; the uploaded mapping names them. */
    data class Jvm(val className: String, val method: String, val line: Int?, val file: String?) : SiteRef()

    fun toWire(): Map<String, Any?> = when (this) {
        is Name -> linkedMapOf<String, Any?>("kind" to "name", "name" to name).apply { if (type != null) put("type", type) }
        is Jvm -> linkedMapOf<String, Any?>("kind" to "jvm", "className" to className, "method" to method).apply {
            if (line != null) put("line", line)
            if (file != null) put("file", file)
        }
    }
}

/** One tracked call site: what it is, the animation API, the property when known. Equal sites share counters. */
internal data class SiteInfo(val ref: SiteRef, val fn: String, val component: String?, val prop: String?) {
    /** Stable across versions: the developer's name. Omitted for jvm refs (the server derives it). */
    val key: String? get() = (ref as? SiteRef.Name)?.name
}

internal object StackSites {
    /** Frames from these packages are never the app's call site. */
    val libraryPrefixes = listOf(
        "dev.keyframer.",
        "android.",
        "androidx.",
        "kotlin.",
        "kotlinx.",
        "java.",
        "javax.",
        "jdk.",
        "sun.",
        "dalvik.",
        "libcore.",
        "com.android.",
    )

    fun isLibrary(className: String): Boolean = libraryPrefixes.any { className.startsWith(it) }

    /** The first frame of app code: the line that called kfTrack or the Compose helper. */
    fun firstAppFrame(stack: Array<StackTraceElement>): StackTraceElement? = stack.firstOrNull { !isLibrary(it.className) }

    /** What R8 leaves as a file name when it drops it: no file at all, as far as a report goes. */
    private val NO_FILE = setOf("SourceFile", "Unknown Source", "")

    fun jvmRef(frame: StackTraceElement): SiteRef.Jvm =
        SiteRef.Jvm(frame.className.take(160), frame.methodName.take(128), frame.lineNumber.takeIf { it > 0 }, frame.fileName?.takeUnless { it in NO_FILE }?.take(160))

    /** `CardKt` for `com.example.CardKt$Card$1`: the class a name is written in, for `type`. */
    fun outerSimpleName(className: String): String = className.substringBefore('$').substringAfterLast('.')

    /**
     * The site for a tracked call: a name ref when the developer named it, else the call's stack frame.
     * `keepType`: the build keeps class names (not minified), so a named site can say which class it is in.
     */
    fun site(stack: Array<StackTraceElement>, name: String?, fn: String, prop: String?, keepType: Boolean): SiteInfo? {
        val frame = firstAppFrame(stack)
        // R8 renames classes to one or two letters: such a name says nothing, so it is left out.
        val component = frame?.let { outerSimpleName(it.className) }?.takeIf { keepType && it.length > 2 }
        val ref: SiteRef = when {
            !name.isNullOrBlank() -> SiteRef.Name(name.trim().take(128), component)
            frame != null -> jvmRef(frame)
            else -> return null
        }
        return SiteInfo(ref, fn, component, prop)
    }
}
