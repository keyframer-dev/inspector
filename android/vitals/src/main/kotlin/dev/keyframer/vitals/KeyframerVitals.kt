package dev.keyframer.vitals

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.AnimatorSet
import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.app.Activity
import android.app.Application
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import dev.keyframer.vitals.internal.AndroidClock
import dev.keyframer.vitals.internal.AndroidDevice
import dev.keyframer.vitals.internal.AndroidHooks
import dev.keyframer.vitals.internal.AndroidProbe
import dev.keyframer.vitals.internal.AppInfo
import dev.keyframer.vitals.internal.HttpTransport
import dev.keyframer.vitals.internal.MainScheduler
import dev.keyframer.vitals.internal.Recorder
import dev.keyframer.vitals.internal.Redact
import dev.keyframer.vitals.internal.Reporter
import dev.keyframer.vitals.internal.ReporterOptions
import dev.keyframer.vitals.internal.RetryStore
import dev.keyframer.vitals.internal.SharedPrefsKeyValue
import dev.keyframer.vitals.internal.SiteInfo
import dev.keyframer.vitals.internal.StackSites
import dev.keyframer.vitals.internal.VitalsProtocol
import java.io.File
import java.util.concurrent.Executors

/**
 * Motion Vitals: slow frames and janky animations from production, as anonymous counters per screen,
 * per animation and per app version (https://keyframer.dev/docs/vitals).
 *
 * ```kotlin
 * // Application.onCreate (or after your consent flow: nothing is measured or sent before start)
 * KeyframerVitals.start(this, key = "kfp_live_…")
 *
 * // Name the animations you care about; the dashboard shows them by name.
 * ObjectAnimator.ofFloat(card, View.SCALE_X, 1f, 1.1f).kfTrack("card-expand").start()
 * ```
 *
 * Like Sentry: reporting starts at [start]; [setEnabled] (false) stops it and drops what is pending.
 * Reports never hold personal data: no ids, text, values, touches or absolute times.
 */
object KeyframerVitals {
    private const val TAG = "KeyframerVitals"

    @Volatile private var reporter: Reporter? = null
    private var hooks: AndroidHooks? = null
    @Volatile private var keepTypes = true

    /** start was called and reporting is not switched off with setEnabled(false). */
    @JvmStatic
    val isEnabled: Boolean get() = reporter?.enabled == true

    /**
     * Starts reporting. Call once, on the main thread, from Application.onCreate or once the app may
     * report (after its consent flow).
     *
     * @param key the project's field key, `kfp_live_…` (public: it can only write reports).
     * @param appVersion defaults to the package's versionName.
     * @param build defaults to the package's versionCode.
     * @param environment `"production"` or `"development"`. By default a release build reports as
     *   production and a debuggable build reports nothing; pass `"development"` to see a debug build's
     *   reports in the dashboard's development environment.
     * @param sampleRate the share of sessions that report (default 0.1) until the project's config says
     *   otherwise.
     * @param endpoint the ingest server, `https://vitals.keyframer.dev` by default.
     * @return false when the key is not a field key or start had already been called.
     */
    @JvmStatic
    @JvmOverloads
    fun start(
        context: Context,
        key: String,
        appVersion: String? = null,
        build: String? = null,
        environment: String? = null,
        sampleRate: Double? = null,
        endpoint: String? = null,
    ): Boolean {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            Handler(Looper.getMainLooper()).post { start(context, key, appVersion, build, environment, sampleRate, endpoint) }
            return true
        }
        if (reporter != null) return false
        if (!key.startsWith("kfp_")) {
            Log.w(TAG, "Not started: the key must be a project's field key (kfp_…).")
            return false
        }
        if (environment != null && environment != "production" && environment != "development") {
            Log.w(TAG, "Not started: environment is \"production\" or \"development\".")
            return false
        }
        val app = context.applicationContext as? Application ?: return false
        val device = AndroidDevice(app)
        val debugId = device.debugId()
        keepTypes = debugId == null
        val env = environment ?: if (device.debuggable) null else "production"
        if (env == null) Log.i(TAG, "A debuggable build reports nothing unless start is given environment = \"development\".")
        val sdkVersion = BuildConfig.SDK_VERSION
        val options = ReporterOptions(
            key = key,
            endpoint = endpoint ?: VitalsProtocol.ENDPOINT,
            sdkVersion = sdkVersion,
            sampleRate = (sampleRate ?: VitalsProtocol.DEFAULT_SAMPLE_RATE).coerceIn(0.0, 1.0),
            environment = env,
            app = AppInfo(
                id = device.packageName,
                version = appVersion ?: device.versionName() ?: "0",
                build = build ?: device.versionCode(),
                framework = "Views",
                environment = env ?: "development",
                debugId = debugId,
            ),
        )
        val io = Executors.newSingleThreadExecutor { r -> Thread(r, "keyframer-vitals").apply { isDaemon = true; priority = Thread.MIN_PRIORITY } }
        val r = Reporter(
            options = options,
            clock = AndroidClock,
            prefs = SharedPrefsKeyValue(app),
            store = RetryStore(File(app.filesDir, "keyframer-vitals")),
            transport = HttpTransport,
            io = io,
            scheduler = MainScheduler(),
            probe = AndroidProbe(device),
        )
        reporter = r
        val h = AndroidHooks(app, r)
        hooks = h
        h.install()
        (context as? Activity)?.let { h.adopt(it) }
        r.launch()
        return true
    }

    /**
     * Turns reporting off (false): nothing more is measured or sent, and what was pending (the open
     * window, unsent reports) is dropped. True turns it back on with a new session. Before [start] it
     * does nothing: start is what turns reporting on.
     */
    @JvmStatic
    fun setEnabled(enabled: Boolean) = onMain { reporter?.setEnabled(enabled) }

    /**
     * Names the screen on show, for navigation an activity does not tell (Compose destinations,
     * fragments). The name is masked like the inspector's redaction (ids, emails, numbers, tokens) and
     * cut to 64 characters; pass route patterns (`users/{id}`), not values.
     */
    @JvmStatic
    fun setScreen(name: String) = onMain { hooks?.setScreen(name) }

    /**
     * Tracks an animator: each run is a motion window, and the frames drawn during it count against
     * its call site (`name`, or where this was called). Same as `animator.kfTrack(name)`.
     */
    @JvmStatic
    @JvmOverloads
    fun <T : Animator> track(animator: T, name: String? = null): T {
        val stack = Throwable().stackTrace
        val site = StackSites.site(stack, name?.let { Redact.maskText(it) }, fnOf(animator), (animator as? ObjectAnimator)?.propertyName, keepTypes) ?: return animator
        if (animator.listeners?.any { it is VitalsListener } == true) return animator
        animator.addListener(VitalsListener(site))
        return animator
    }

    /** Stops tracking an animator. */
    @JvmStatic
    fun untrack(animator: Animator) {
        animator.listeners?.filterIsInstance<VitalsListener>()?.forEach {
            it.finish()
            animator.removeListener(it)
        }
    }

    private fun fnOf(a: Animator): String = when (a) {
        is ObjectAnimator -> "ObjectAnimator"
        is ValueAnimator -> "ValueAnimator"
        is AnimatorSet -> "AnimatorSet"
        else -> a.javaClass.simpleName.ifEmpty { "Animator" }
    }

    private class VitalsListener(val site: SiteInfo) : AnimatorListenerAdapter() {
        private var run: Recorder.Run? = null

        override fun onAnimationStart(animation: Animator) {
            finish()
            run = reporter?.animationStart(site, estimateMs(animation))
        }

        override fun onAnimationEnd(animation: Animator) = finish()

        fun finish() {
            val r = run ?: return
            run = null
            reporter?.animationEnd(r)
        }
    }

    /** How long a run lasts: delay, duration and repeats at the system's animator scale; null when it repeats forever. */
    internal fun estimateMs(a: Animator): Double? {
        val total = a.totalDuration
        if (total == Animator.DURATION_INFINITE || total < 0) return null
        val scale = if (Build.VERSION.SDK_INT >= 33) ValueAnimator.getDurationScale().toDouble() else 1.0
        return total * scale
    }

    // ---------- for dev.keyframer:vitals-compose ----------

    internal fun reporterOrNull(): Reporter? = reporter
    internal val keepClassNames: Boolean get() = keepTypes

    private fun onMain(block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) block() else Handler(Looper.getMainLooper()).post(block)
    }
}

/**
 * Tracks this animator for Motion Vitals and returns it: `ObjectAnimator.ofFloat(…).kfTrack("card").start()`.
 * The same call as the inspector's `kfTrack`, so a debug build can use both.
 */
fun <T : Animator> T.kfTrack(name: String? = null): T = KeyframerVitals.track(this, name)
