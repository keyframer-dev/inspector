package dev.keyframer.inspector.core

/**
 * Where app code called into the inspector, from a JVM stack: the first frame that is not the SDK,
 * the platform or a library. What the Babel plugin bakes in on React Native, found at run time here.
 */
object CallSites {
    /** Frames from these packages are never "the app". */
    val libraryPrefixes = listOf(
        "dev.keyframer.inspector.",
        "java.",
        "javax.",
        "jdk.",
        "sun.",
        "kotlin.",
        "kotlinx.",
        "android.",
        "androidx.",
        "com.android.",
        "com.google.android.",
        "dalvik.",
        "libcore.",
        "org.junit.",
        "junit.",
        "org.gradle.",
        "okhttp3.",
    )

    fun isLibrary(className: String, extra: List<String> = emptyList()): Boolean =
        libraryPrefixes.any { className.startsWith(it) } || extra.any { className.startsWith(it) }

    /** The first app frame, or null when the whole stack is library code. */
    fun firstAppFrame(stack: Array<StackTraceElement>, extraLibraryPrefixes: List<String> = emptyList()): StackTraceElement? =
        stack.firstOrNull { !isLibrary(it.className, extraLibraryPrefixes) && it.lineNumber > 0 }

    /**
     * `com/example/app/MainActivity.kt` from `com.example.app.MainActivity$onCreate$1` and `MainActivity.kt`:
     * the package as folders, the way sources are laid out under src/main/java or src/main/kotlin.
     */
    fun filePath(frame: StackTraceElement): String {
        val name = frame.fileName ?: (outerClass(frame.className).substringAfterLast('.') + ".kt")
        val pkg = frame.className.substringBeforeLast('.', "")
        return if (pkg.isEmpty()) name else pkg.replace('.', '/') + "/" + name
    }

    /**
     * The component the call sits in: the outer class (`MainActivity` for `MainActivity$onCreate$1`), or
     * for a top-level function (a `CardKt` file class) the function itself, the way a composable is named.
     * A lambda in a top-level function (`CardKt$PulsingCard$1.invoke`) is named after that function;
     * one Compose hoisted out of every function (`ComposableSingletons$CardKt$lambda-1$1`) after its file.
     */
    fun component(frame: StackTraceElement): String? {
        var outer = outerClass(frame.className).substringAfterLast('.')
        var inner = frame.className.substringAfter('$', "").split('$')
        if (outer == "ComposableSingletons" && inner.isNotEmpty() && inner[0].isNotEmpty()) {
            outer = inner[0]
            inner = inner.drop(1)
        }
        if (!outer.endsWith("Kt")) return outer.ifEmpty { null }
        val method = cleanMethod(frame.methodName)
        if (method.isNotEmpty() && method !in LAMBDA_METHODS) return method
        inner.firstOrNull { it.isNotEmpty() && !it[0].isDigit() && !it.startsWith("lambda") }?.let { return it }
        return outer.removeSuffix("Kt").ifEmpty { null }
    }

    /** What a lambda's body is called on the JVM: no help naming the function it is written in. */
    private val LAMBDA_METHODS = setOf("invoke", "invokeSuspend")

    fun site(frame: StackTraceElement): Located {
        val file = filePath(frame)
        return Located(id = "$file:${frame.lineNumber}:0", file = file, line = frame.lineNumber, component = component(frame), method = cleanMethod(frame.methodName))
    }

    /** Frames for the trace, app frames first-class and library frames collapsed, like a symbolicated JS stack. */
    fun frames(stack: Array<StackTraceElement>, limit: Int = 40, extraLibraryPrefixes: List<String> = emptyList()): List<StackFrame> =
        stack.asSequence()
            .dropWhile { it.className.startsWith("dev.keyframer.inspector.") }
            .take(limit)
            .map { StackFrame(it.className + "." + it.methodName, filePath(it), it.lineNumber.coerceAtLeast(0), 0, collapse = isLibrary(it.className, extraLibraryPrefixes)) }
            .toList()

    data class Located(val id: String, val file: String, val line: Int, val component: String?, val method: String)

    private fun outerClass(className: String): String = className.substringBefore('$')

    /** Kotlin's synthetic method names: `onCreate$lambda$0` → `onCreate`, `access$foo` → `foo`. */
    private fun cleanMethod(m: String): String = m.removePrefix("access$").substringBefore('$')
}
