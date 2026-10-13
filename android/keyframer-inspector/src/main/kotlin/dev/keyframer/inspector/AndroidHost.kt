package dev.keyframer.inspector

import android.app.Activity
import android.app.Application
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Build
import android.os.Bundle
import android.util.Base64
import android.view.MotionEvent
import android.view.PixelCopy
import android.view.Window
import android.view.WindowManager
import dev.keyframer.inspector.core.Cancellable
import dev.keyframer.inspector.core.FrameLoop
import dev.keyframer.inspector.core.Host
import dev.keyframer.inspector.core.Marker
import dev.keyframer.inspector.core.Screen
import java.io.ByteArrayOutputStream
import java.lang.ref.WeakReference
import java.util.concurrent.Executors
import kotlin.math.roundToInt

/**
 * The platform side of the session: which activity is on top, touches on its window, screens as
 * navigation markers, the app going to the background, screenshots, and navigating back to a screen.
 */
internal class AndroidHost(
    private val app: Application,
    override val appName: String,
    override val root: String?,
    private val onActivityDestroyed: (Activity) -> Unit,
) : Host, Application.ActivityLifecycleCallbacks {
    override val platform = "android"
    override val osVersion: String = Build.VERSION.RELEASE
    override val build: String =
        if (app.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0) "debug" else "release"
    override val canCapture = true
    override val frames: FrameLoop = ChoreographerFrames

    private val density = app.resources.displayMetrics.density

    override val screen: Screen
        get() {
            val (w, h) = realSize()
            return Screen(round1(w / density), round1(h / density), density.toDouble())
        }

    // ── activities and routes ────────────────────────────────────────────────────────────────────

    private val alive = ArrayList<WeakReference<Activity>>()
    private var top: WeakReference<Activity>? = null
    private var started = 0
    /** The screen as markers name it: the resumed activity, or what the app set with Keyframer.setRoute. */
    var route: String? = null
        private set
    private var routeParams: Map<String, Any?>? = null

    val topActivity: Activity? get() = top?.get()?.takeUnless { it.isFinishing || it.isDestroyed }

    /** The newest activity, even before it resumes: what a tracked animator created in onCreate belongs to. */
    val currentActivity: Activity? get() = alive.lastOrNull { it.get()?.isDestroyed == false }?.get()

    fun setRoute(name: String, params: Map<String, Any?>?) {
        if (name == route && params == routeParams) return
        route = name
        routeParams = params
        markerSink?.invoke(Marker.Navigation(AndroidClock.nowMs().toLong(), name, params))
    }

    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {
        alive.add(WeakReference(activity))
        wrapWindow(activity)
    }

    override fun onActivityStarted(activity: Activity) {
        if (started++ == 0 && markerSink != null) markerSink?.invoke(Marker.AppState(AndroidClock.nowMs().toLong(), "active"))
    }

    override fun onActivityResumed(activity: Activity) {
        top = WeakReference(activity)
        wrapWindow(activity)
        setRoute(activity.javaClass.simpleName, null)
    }

    override fun onActivityPaused(activity: Activity) = Unit

    override fun onActivityStopped(activity: Activity) {
        if (--started == 0) markerSink?.invoke(Marker.AppState(AndroidClock.nowMs().toLong(), "background"))
    }

    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit

    override fun onActivityDestroyed(activity: Activity) {
        alive.removeAll { it.get() == null || it.get() === activity }
        if (top?.get() === activity) top = null
        onActivityDestroyed.invoke(activity)
    }

    // ── markers ──────────────────────────────────────────────────────────────────────────────────

    private var markerSink: ((Marker) -> Unit)? = null
    private val lastMove = HashMap<Int, Long>()

    override fun watchMarkers(onMarker: (Marker) -> Unit): Cancellable {
        markerSink = onMarker
        lastMove.clear()
        route?.let { onMarker(Marker.Navigation(AndroidClock.nowMs().toLong(), it, routeParams)) }
        return Cancellable { if (markerSink === onMarker) markerSink = null }
    }

    private fun wrapWindow(activity: Activity) {
        val window = activity.window ?: return
        val current = window.callback ?: return
        if (current is TouchCallback) return
        window.callback = TouchCallback(current) { ev -> onTouch(ev) }
    }

    /** Touches in screen points (dp), timed by the event (uptime ms: the session's monotonic clock). */
    private fun onTouch(ev: MotionEvent) {
        val sink = markerSink ?: return
        val t = ev.eventTime
        val dx = ev.rawX - ev.getX(0)
        val dy = ev.rawY - ev.getY(0)
        fun mark(phase: String, i: Int) {
            val x = if (Build.VERSION.SDK_INT >= 29) ev.getRawX(i) else ev.getX(i) + dx
            val y = if (Build.VERSION.SDK_INT >= 29) ev.getRawY(i) else ev.getY(i) + dy
            sink(Marker.Touch(t, phase, ev.getPointerId(i), round1(x / density), round1(y / density)))
        }
        when (ev.actionMasked) {
            MotionEvent.ACTION_DOWN, MotionEvent.ACTION_POINTER_DOWN -> mark("start", ev.actionIndex)
            MotionEvent.ACTION_UP, MotionEvent.ACTION_POINTER_UP -> mark("end", ev.actionIndex)
            MotionEvent.ACTION_CANCEL -> for (i in 0 until ev.pointerCount) mark("cancel", i)
            MotionEvent.ACTION_MOVE -> for (i in 0 until ev.pointerCount) {
                // At most one move per finger per 120 Hz frame, as on React Native.
                val id = ev.getPointerId(i)
                if (t - (lastMove[id] ?: Long.MIN_VALUE / 2) < 8) continue
                lastMove[id] = t
                mark("move", i)
            }
        }
    }

    // ── navigation, replay ───────────────────────────────────────────────────────────────────────

    var navigator: ((String, Map<String, Any?>?) -> Boolean)? = null
    var replayer: (() -> Unit)? = null

    override fun navigateTo(route: String, params: Map<String, Any?>?): Boolean {
        if (route == this.route) return false
        if (navigator?.invoke(route, params) == true) return true
        val cls = activityClass(route) ?: return false
        val from: Context = topActivity ?: app
        val intent = Intent(from, cls)
        params?.forEach { (k, v) ->
            when (v) {
                is String -> intent.putExtra(k, v)
                is Boolean -> intent.putExtra(k, v)
                is Number -> if (v.toDouble() == Math.rint(v.toDouble())) intent.putExtra(k, v.toLong()) else intent.putExtra(k, v.toDouble())
            }
        }
        // Back to it when it is still in the stack (the activities above it finish), a new one otherwise.
        if (alive.any { it.get()?.javaClass == cls }) intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        if (from !is Activity) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        from.startActivity(intent)
        return true
    }

    private fun activityClass(simpleName: String): Class<*>? {
        alive.firstNotNullOfOrNull { it.get()?.javaClass?.takeIf { c -> c.simpleName == simpleName } }?.let { return it }
        val declared = runCatching {
            @Suppress("DEPRECATION")
            app.packageManager.getPackageInfo(app.packageName, PackageManager.GET_ACTIVITIES).activities
        }.getOrNull().orEmpty()
        val name = declared.map { it.name }.firstOrNull { it.substringAfterLast('.') == simpleName } ?: return null
        return runCatching { Class.forName(name) }.getOrNull()
    }

    override fun replay(): Boolean {
        replayer?.let {
            it()
            return true
        }
        // Re-creating the screen re-runs its onCreate: entrances fire again.
        val a = topActivity ?: return false
        a.recreate()
        return true
    }

    // ── capture ──────────────────────────────────────────────────────────────────────────────────

    private val encoder = Executors.newSingleThreadExecutor { r -> Thread(r, "keyframer-capture").apply { isDaemon = true } }

    override fun capture(format: String, quality: Double, width: Int?, done: (String?, String?) -> Unit) {
        val activity = topActivity ?: return done(null, "No activity on screen.")
        val window = activity.window
        val view = window.decorView
        if (view.width <= 0 || view.height <= 0) return done(null, "The window has no size yet.")
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        val encode = {
            encoder.execute {
                try {
                    done(encode(bitmap, format, quality, width), null)
                } catch (e: Throwable) {
                    done(null, e.message ?: e.toString())
                }
            }
        }
        if (Build.VERSION.SDK_INT >= 26) {
            pixelCopy(window, bitmap, encode, done)
        } else {
            view.draw(Canvas(bitmap))
            encode()
        }
    }

    private fun pixelCopy(window: Window, bitmap: Bitmap, then: () -> Unit, done: (String?, String?) -> Unit) {
        if (Build.VERSION.SDK_INT < 26) return
        PixelCopy.request(window, bitmap, { result ->
            if (result == PixelCopy.SUCCESS) then() else done(null, "PixelCopy failed ($result)")
        }, mainHandler)
    }

    private fun encode(full: Bitmap, format: String, quality: Double, width: Int?): String {
        val scaled = if (width != null && width in 1 until full.width) {
            Bitmap.createScaledBitmap(full, width, (full.height * width.toDouble() / full.width).roundToInt().coerceAtLeast(1), true)
        } else full
        val out = ByteArrayOutputStream()
        val png = format == "png"
        scaled.compress(if (png) Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG, (quality * 100).roundToInt().coerceIn(1, 100), out)
        if (scaled !== full) scaled.recycle()
        full.recycle()
        return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    }

    // ── display ──────────────────────────────────────────────────────────────────────────────────

    override fun refreshRate(): Float {
        val wm = app.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        @Suppress("DEPRECATION")
        return wm.defaultDisplay?.refreshRate ?: 60f
    }

    private fun realSize(): Pair<Int, Int> {
        val wm = app.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        if (Build.VERSION.SDK_INT >= 30) {
            val b = wm.currentWindowMetrics.bounds
            return b.width() to b.height()
        }
        val m = android.util.DisplayMetrics()
        @Suppress("DEPRECATION")
        wm.defaultDisplay.getRealMetrics(m)
        return m.widthPixels to m.heightPixels
    }

    private fun round1(v: Float): Double = (v * 10).roundToInt() / 10.0
}
