package dev.keyframer.inspector

import android.app.Activity
import dev.keyframer.inspector.core.InspectorSession
import dev.keyframer.inspector.core.OwnTime
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

    /** The inspector's own work on the main thread: an add-on's entry points time themselves with it. */
    val ownTime: OwnTime get() = Keyframer.ownTimeOf

    /**
     * `taken`'s stack read off the main thread, made into what `read` makes of it there, then `then`
     * with that on the main thread. For a call site nothing needs within the frame (see Stacks).
     */
    fun <T> readStack(taken: Throwable, read: (Array<StackTraceElement>) -> T, then: (T) -> Unit) = Stacks.read(taken, read, then)

    /** Which UI framework the hello names (call it from an add-on's install, before the session connects). */
    fun setFramework(name: String) = Keyframer.setFramework(name)

    /**
     * A screen declared while it is composed (KfScreen), in `owner` (its activity; null: the one on top),
     * on top of the ones declared before it. The same `token` again renames it in place.
     */
    fun declareScreen(token: Any, name: String, owner: Activity?) = Keyframer.declareScreen(token, name, owner)

    /** The screen `token` declared left the composition: the one under it names the screen again. */
    fun undeclareScreen(token: Any) = Keyframer.undeclareScreen(token)
}
