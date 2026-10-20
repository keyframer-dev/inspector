package dev.keyframer.inspector

import android.animation.Animator
import android.app.Activity
import android.app.Application
import android.view.View
import dev.keyframer.inspector.core.Scenario
import dev.keyframer.inspector.core.Signal

/** Same as keyframer-inspector's, so a release build compiles unchanged. */
data class KeyframerConfig(
    val host: String? = null,
    val port: Int = 8790,
    val appName: String? = null,
    val enableInRelease: Boolean = false,
    val libraryPrefixes: List<String> = emptyList(),
    val sourceRoot: String? = null,
)

/** keyframer-inspector's API, doing nothing: what release builds link against instead. */
object Keyframer {
    val isRunning: Boolean get() = false

    @JvmStatic
    @JvmOverloads
    fun start(application: Application, config: KeyframerConfig = KeyframerConfig()) {}

    @JvmStatic
    fun stop() {}

    @JvmStatic
    @JvmOverloads
    fun <T : Animator> track(animator: T, name: String? = null): T = animator

    @JvmStatic
    fun <T : Animator> track(animator: T, name: String?, view: View?): T = animator

    @JvmStatic
    fun untrack(animator: Animator) {}

    @JvmStatic
    fun removeSignal(signal: Signal) {}

    @JvmStatic
    @JvmOverloads
    fun signal(name: String, read: () -> Float, write: ((Float) -> Unit)? = null): Signal? = null

    @JvmStatic
    @JvmOverloads
    fun signal(name: String, view: View?, read: () -> Float, write: ((Float) -> Unit)? = null): Signal? = null

    @JvmStatic
    @JvmOverloads
    fun setRoute(route: String, params: Map<String, Any?>? = null) {}

    @JvmStatic
    fun setNavigator(navigate: ((route: String, params: Map<String, Any?>?) -> Boolean)?) {}

    @JvmStatic
    fun registerReplay(replay: (() -> Unit)?) {}

    @JvmStatic
    fun registerScenario(name: String, scenario: Scenario): () -> Unit = {}

    val topActivity: Activity? get() = null
}

fun <T : Animator> T.kfTrack(name: String? = null): T = this

fun <T : Animator> T.kfTrack(name: String?, view: View): T = this
