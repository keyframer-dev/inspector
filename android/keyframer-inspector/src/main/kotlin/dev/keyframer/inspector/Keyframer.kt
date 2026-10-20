package dev.keyframer.inspector

import android.animation.Animator
import android.app.Activity
import android.app.Application
import android.content.pm.ApplicationInfo
import android.util.Log
import android.view.View
import dev.keyframer.inspector.core.CallSites
import dev.keyframer.inspector.core.InspectorSession
import dev.keyframer.inspector.core.OkHttpSockets
import dev.keyframer.inspector.core.Scenario
import dev.keyframer.inspector.core.Signal
import dev.keyframer.inspector.core.SignalSite
import java.lang.ref.WeakReference

/** Where the relay is and how the app shows up in the panel. */
data class KeyframerConfig(
    /** Relay host. Null: 10.0.2.2 on the emulator, 127.0.0.1 on a device (with `adb reverse tcp:8790 tcp:8790`). */
    val host: String? = null,
    val port: Int = 8790,
    /** The name the panel shows. Null: the app's label. */
    val appName: String? = null,
    /** Connect in a non-debuggable build too. Off by default: the inspector is a development tool. */
    val enableInRelease: Boolean = false,
    /** Packages of the app's own animation helpers, skipped when looking for the call site. */
    val libraryPrefixes: List<String> = emptyList(),
    /**
     * The source set's folder on your machine, where call-site paths (`com/example/app/MainActivity.kt`)
     * live: the panel opens them in an editor and "Apply to code" writes tuned values back, under this
     * folder only. From Gradle, for instance:
     * `buildConfigField("String", "KF_SOURCE_ROOT", "\"${projectDir}/src/main/kotlin\"")`, then
     * `KeyframerConfig(sourceRoot = BuildConfig.KF_SOURCE_ROOT)`.
     */
    val sourceRoot: String? = null,
)

/**
 * The Keyframer runtime inspector for Android Views. Start it in Application.onCreate:
 *
 *     Keyframer.start(this)
 *
 * then track what should show up in the panel:
 *
 *     ObjectAnimator.ofFloat(title, View.ALPHA, 0f, 1f).kfTrack("title").start()
 *     val cardX = Keyframer.signal("cardX", read = { card.translationX }, write = { card.translationX = it })
 *
 * Every call is cheap and does nothing when the inspector is not running (a release build).
 * Call it on the main thread; calls from other threads hop onto it.
 *
 * Jetpack Compose: add keyframer-inspector-compose (and its no-op for release builds); it is found and
 * installed by [start].
 */
object Keyframer {
    private const val TAG = "Keyframer"

    /** keyframer-inspector-compose's entry point, looked up by name so this module does not depend on Compose. */
    private const val COMPOSE = "dev.keyframer.inspector.compose.KeyframerCompose"

    private var session: InspectorSession? = null
    private var host: AndroidHost? = null
    private var time: TimeControl? = null
    private var app: Application? = null
    private var config = KeyframerConfig()
    private val animators = AnimatorTracker { session }
    private val signals = ArrayList<OwnedSignal>()
    private val scenarios = LinkedHashMap<String, Scenario>()
    private val unregister = HashMap<String, () -> Unit>()
    private var pendingRoute: Pair<String, Map<String, Any?>?>? = null
    private var navigator: ((String, Map<String, Any?>?) -> Boolean)? = null
    private var replayer: (() -> Unit)? = null

    val isRunning: Boolean get() = session != null

    /** Connects to the relay and starts listening. Does nothing in a release build unless enabled. */
    @JvmStatic
    @JvmOverloads
    fun start(application: Application, config: KeyframerConfig = KeyframerConfig()) = onMain {
        if (session != null) return@onMain
        val debuggable = application.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0
        if (!debuggable && !config.enableInRelease) return@onMain
        this.config = config
        app = application
        val name = config.appName ?: application.applicationInfo.loadLabel(application.packageManager).toString()
        val h = AndroidHost(application, name, config.sourceRoot?.ifEmpty { null }) { activity -> ownerDestroyed(activity) }
        h.navigator = navigator
        h.replayer = replayer
        application.registerActivityLifecycleCallbacks(h)
        host = h
        val t = TimeControl({ animators.runningRoots() }, { h.refreshRate() }, { h.animatorScaleSetting() })
        time = t
        h.time = t
        h.visibilityTargets = { animators.visibilityTargets() + signals.mapNotNull { it.viewTarget() } }
        animators.topWindow = { h.topActivity?.window }
        h.startWatching()
        val url = InspectorSession.relayUrl(config.host ?: defaultHost(), config.port, name)
        val s = InspectorSession(url, OkHttpSockets(), MainScheduler, AndroidClock, h)
        s.onOverrides = { animators.applyOverrides(it) }
        session = s
        for ((n, sc) in scenarios) unregister[n] = s.registerScenario(n, sc)
        pendingRoute?.let { (r, p) -> h.setRoute(r, p) }
        installCompose()
        s.start()
        Log.i(TAG, "inspector connecting to $url")
    }

    /** keyframer-inspector-compose, when the app has it: its hello says "compose" and its clock joins `time`. */
    private fun installCompose() {
        val cls = try {
            Class.forName(COMPOSE)
        } catch (_: Throwable) {
            return
        }
        try {
            cls.getMethod("install").invoke(null)
        } catch (e: Throwable) {
            Log.w(TAG, "keyframer-inspector-compose did not install: ${e.cause ?: e}")
        }
    }

    /** Disconnects and forgets everything tracked. */
    @JvmStatic
    fun stop() = onMain {
        session?.dispose()
        session = null
        host?.let {
            app?.unregisterActivityLifecycleCallbacks(it)
            it.dispose()
        }
        host = null
        time = null
        animators.clear()
        signals.clear()
        unregister.clear()
    }

    /**
     * Reports this animator every time it starts (duration, delay, repeats, interpolator, keyframes and
     * where it was written) and records its value and play time while the panel records. An AnimatorSet
     * tracks each of its children. Returns the animator, for chaining.
     */
    @JvmStatic
    @JvmOverloads
    fun <T : Animator> track(animator: T, name: String? = null): T {
        if (session == null) return animator
        val stack = Throwable().stackTrace
        onMain { animators.track(animator, name, host?.currentActivity, stack, config.libraryPrefixes) }
        return animator
    }

    /**
     * [track], for an animator that moves `view` through its own update listener (a ValueAnimator):
     * the view is watched for visibility while recording and checked for render hints, as an
     * ObjectAnimator's target is.
     */
    @JvmStatic
    fun <T : Animator> track(animator: T, name: String?, view: View?): T {
        if (session == null) return animator
        val stack = Throwable().stackTrace
        onMain { animators.track(animator, name, host?.currentActivity, stack, config.libraryPrefixes, view) }
        return animator
    }

    /** Stops reporting an animator passed to [track]; its signals leave the panel (`unsignal`). */
    @JvmStatic
    fun untrack(animator: Animator) {
        if (session == null) return
        onMain { animators.untrack(animator) }
    }

    /** Removes a value made with [signal] before its activity goes away. */
    @JvmStatic
    fun removeSignal(signal: Signal) = onMain {
        if (signals.removeAll { it === signal }) session?.removeSignal(signal.site.id)
    }

    /**
     * A value the panel records and plays back: a dragged offset, a scroll position, a progress. `write`
     * makes it replayable (playback and capture set it); leave it out for read-only values. It belongs to
     * the activity it was created in and goes away with it.
     */
    @JvmStatic
    @JvmOverloads
    fun signal(name: String, read: () -> Float, write: ((Float) -> Unit)? = null): Signal? {
        if (session == null) return null
        return addSignal(name, null, read, write, Throwable().stackTrace)
    }

    /**
     * [signal] for a value that moves `view`: while recording, the panel also hears when the view stops
     * being visible (scrolled away, covered, hidden, detached) and when it comes back.
     */
    @JvmStatic
    @JvmOverloads
    fun signal(name: String, view: View?, read: () -> Float, write: ((Float) -> Unit)? = null): Signal? {
        if (session == null) return null
        return addSignal(name, view, read, write, Throwable().stackTrace)
    }

    private fun addSignal(name: String, view: View?, read: () -> Float, write: ((Float) -> Unit)?, stack: Array<StackTraceElement>): Signal? {
        val at = CallSites.firstAppFrame(stack, config.libraryPrefixes)?.let { CallSites.site(it) } ?: return null
        val site = SignalSite("${at.id}:$name", at.file, at.line, at.component, name, column = 0, writable = if (write == null) false else null)
        val sig = OwnedSignal(site, read, write, WeakReference(host?.currentActivity), view?.let { WeakReference(it) })
        onMain {
            signals.removeAll { it.site.id == sig.site.id }
            signals.add(sig)
            session?.addSignal(sig)
        }
        return sig
    }

    /** Names the screen for markers and playback, for apps that change screens without activities (fragments, Navigation). */
    @JvmStatic
    @JvmOverloads
    fun setRoute(route: String, params: Map<String, Any?>? = null) = onMain {
        val h = host
        if (h == null) pendingRoute = route to params else h.setRoute(route, params)
    }

    /** How playback and export go back to a recorded screen when it is not an activity. Return true when it navigated. */
    @JvmStatic
    fun setNavigator(navigate: ((route: String, params: Map<String, Any?>?) -> Boolean)?) = onMain {
        navigator = navigate
        host?.navigator = navigate
    }

    /** What the panel's replay runs. By default the screen on top is re-created, which re-fires its entrance. */
    @JvmStatic
    fun registerReplay(replay: (() -> Unit)?) = onMain {
        replayer = replay
        host?.replayer = replay
    }

    /** An interaction an editor or an agent can run to reproduce something. Returns the unregister. */
    @JvmStatic
    fun registerScenario(name: String, scenario: Scenario): () -> Unit {
        onMain {
            scenarios[name] = scenario
            session?.let { unregister[name] = it.registerScenario(name, scenario) }
        }
        return {
            onMain {
                if (scenarios[name] === scenario) {
                    scenarios.remove(name)
                    unregister.remove(name)?.invoke()
                }
            }
        }
    }

    /** The activity on top, for scenarios that drive the UI. */
    val topActivity: Activity? get() = host?.topActivity

    private fun ownerDestroyed(activity: Activity) {
        animators.ownerDestroyed(activity)
        val gone = signals.filter { it.owner.get() === activity || it.owner.get() == null }
        signals.removeAll(gone)
        gone.forEach { session?.removeSignal(it.site.id) }
    }

    private fun defaultHost(): String = if (isEmulator()) "10.0.2.2" else "127.0.0.1"

    private fun isEmulator(): Boolean = DeviceProbe.buildLooksLikeEmulator()

    private class OwnedSignal(
        override val site: SignalSite,
        private val reader: () -> Float,
        private val writer: ((Float) -> Unit)?,
        val owner: WeakReference<Activity?>,
        private val view: WeakReference<View>?,
    ) : Signal {
        override fun read(): Double? = runCatching { reader().toString().toDouble() }.getOrNull()
        override fun write(v: Double) {
            writer?.invoke(v.toFloat())
        }

        /** Signals are few and moved by hand: their views are checked whenever the recording checks. */
        fun viewTarget(): ViewTarget? = view?.get()?.let { ViewTarget(listOf(site.id), it, active = true) }
    }

    // ── for keyframer-inspector-compose (see KeyframerExtensions) ────────────────────────────────────

    internal val sessionOrNull: InspectorSession? get() = session
    internal val timeClock get() = time?.clock
    internal val libraryPrefixes: List<String> get() = config.libraryPrefixes
    internal fun setFramework(name: String) {
        host?.framework = name
    }
}

/** `ObjectAnimator.ofFloat(...).kfTrack("title").start()`: see [Keyframer.track]. */
fun <T : Animator> T.kfTrack(name: String? = null): T = Keyframer.track(this, name)

/**
 * `ValueAnimator.ofFloat(1f, 1.3f).apply { addUpdateListener { ... } }.kfTrack("pulse", pulse).start()`:
 * see [Keyframer.track], with the view the animator moves.
 */
fun <T : Animator> T.kfTrack(name: String?, view: View): T = Keyframer.track(this, name, view)
