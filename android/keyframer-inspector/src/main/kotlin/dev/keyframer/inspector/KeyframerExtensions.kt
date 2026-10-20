package dev.keyframer.inspector

import dev.keyframer.inspector.core.InspectorSession
import dev.keyframer.inspector.core.TimeClock

/**
 * Marks what Keyframer's own add-on modules (keyframer-inspector-compose) use to reach the running
 * inspector. Not part of the API apps call: it changes with the SDK, and the no-op has none of it.
 */
@RequiresOptIn(
    level = RequiresOptIn.Level.ERROR,
    message = "For Keyframer's own modules (keyframer-inspector-compose). Apps use Keyframer, which the no-op mirrors.",
)
@Retention(AnnotationRetention.BINARY)
@Target(AnnotationTarget.CLASS, AnnotationTarget.FUNCTION, AnnotationTarget.PROPERTY)
annotation class KeyframerExtensionApi

/**
 * The running inspector, for animation systems the SDK cannot see on its own (Compose): they register
 * their signals and report their starts through the session, read live overrides from it, and run on
 * [timeClock] so the editor's slow motion, pause and step reach them. Main thread.
 */
@KeyframerExtensionApi
object KeyframerExtensions {
    /** The session while the inspector runs, else null. */
    val session: InspectorSession? get() = Keyframer.sessionOrNull

    /** Animation time under the editor's `time` control, shared with Android's animators. */
    val timeClock: TimeClock? get() = Keyframer.timeClock

    /** The app's own animation helpers, skipped when looking for a call site (KeyframerConfig.libraryPrefixes). */
    val libraryPrefixes: List<String> get() = Keyframer.libraryPrefixes

    /** Which UI framework the hello names (call it from an add-on's install, before the session connects). */
    fun setFramework(name: String) = Keyframer.setFramework(name)
}
