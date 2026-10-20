package dev.keyframer.vitals.internal

import android.app.Activity
import android.app.Application
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.display.DisplayManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.view.MotionEvent
import android.view.ViewTreeObserver
import android.view.Window
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import androidx.metrics.performance.FrameData
import androidx.metrics.performance.FrameDataApi24
import androidx.metrics.performance.FrameDataApi31
import androidx.metrics.performance.JankStats
import java.util.Calendar
import java.util.WeakHashMap

internal object AndroidClock : Clock {
    override fun elapsedMs() = SystemClock.elapsedRealtime()
    override fun nanos() = System.nanoTime()
    override fun wallMs() = System.currentTimeMillis()
    override fun day(): String {
        val c = Calendar.getInstance()
        return "${c.get(Calendar.YEAR)}-${c.get(Calendar.DAY_OF_YEAR)}"
    }
}

internal class MainScheduler : Scheduler {
    private val handler = Handler(Looper.getMainLooper())
    override fun post(delayMs: Long, task: () -> Unit): () -> Unit {
        val r = Runnable { runCatching(task) }
        handler.postDelayed(r, delayMs)
        return { handler.removeCallbacks(r) }
    }
}

internal class SharedPrefsKeyValue(context: Context) : KeyValue {
    private val prefs = context.getSharedPreferences("dev.keyframer.vitals", Context.MODE_PRIVATE)
    override fun getString(key: String): String? = prefs.getString(key, null)
    override fun getLong(key: String, default: Long): Long = prefs.getLong(key, default)
    override fun put(key: String, value: String?) = prefs.edit().putString(key, value).apply()
    override fun put(key: String, value: Long) = prefs.edit().putLong(key, value).apply()
}

internal class AndroidProbe(private val device: AndroidDevice) : DeviceProbe {
    override fun device(collectModel: Boolean) = device.device(collectModel)
    override fun display() = device.display()
    override fun powerSave() = device.powerSave()
    override fun thermal() = device.thermal()
    override fun animationsOff() = device.animationsOff()
    override fun dataSaver() = device.dataSaver()
}

/**
 * Android's side: the process going to the background and back (ProcessLifecycleOwner), activities as
 * screens, JankStats on each activity's window (only while a sampled session measures), touches through
 * the window callback, scrolls through the view tree, thermal and power saver changes. Nothing here runs
 * per frame except JankStats' own FrameMetrics listener.
 */
internal class AndroidHooks(private val app: Application, private val reporter: Reporter) {
    private class Hooked(val jank: JankStats?, val scroll: ViewTreeObserver.OnScrollChangedListener)

    private val hooked = WeakHashMap<Activity, Hooked>()
    /** Screen names set with setScreen, per activity: an activity coming back keeps its last one. */
    private val named = WeakHashMap<Activity, String>()
    private var resumed: java.lang.ref.WeakReference<Activity>? = null

    private val frames = JankStats.OnFrameListener { f -> onFrame(f) }

    private val activities = object : Application.ActivityLifecycleCallbacks {
        override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
        override fun onActivityStarted(activity: Activity) = hook(activity)
        override fun onActivityResumed(activity: Activity) {
            resumed = java.lang.ref.WeakReference(activity)
            reporter.navigate(named[activity] ?: Redact.screenName(activity.javaClass.simpleName))
        }
        override fun onActivityPaused(activity: Activity) {}
        override fun onActivityStopped(activity: Activity) {}
        override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
        override fun onActivityDestroyed(activity: Activity) = unhook(activity)
    }

    private val process = object : DefaultLifecycleObserver {
        override fun onStart(owner: LifecycleOwner) = reporter.onForeground()
        override fun onStop(owner: LifecycleOwner) = reporter.onBackground()
    }

    private val powerReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            reporter.powerSaveChanged((context.getSystemService(Context.POWER_SERVICE) as PowerManager).isPowerSaveMode)
        }
    }

    private val thermalListener: Any? = if (Build.VERSION.SDK_INT >= 29) PowerManager.OnThermalStatusChangedListener { s -> reporter.thermalChanged(Tiers.thermalLevel(s)) } else null

    private val displayListener = object : DisplayManager.DisplayListener {
        override fun onDisplayAdded(displayId: Int) {}
        override fun onDisplayRemoved(displayId: Int) {}
        override fun onDisplayChanged(displayId: Int) = reporter.displayChanged()
    }

    fun install() {
        app.registerActivityLifecycleCallbacks(activities)
        reporter.onMeasuring = { on -> onMain { measuringChanged(on) } }
        // Replays onStart when the app is already in the foreground (start called after the first screen).
        ProcessLifecycleOwner.get().lifecycle.addObserver(process)
    }

    /** `MainActivity/feed`: the activity, then the route the app names (masked, the whole cut to 64). */
    fun setScreen(name: String) {
        val activity = resumed?.get()
        val full = Redact.screenName(activity?.let { "${it.javaClass.simpleName}/${Redact.maskText(name.trim())}" } ?: name)
        activity?.let { named[it] = full }
        reporter.navigate(full)
    }

    /** A screen already on show when start is called: hooked now rather than on its next start. */
    fun adopt(activity: Activity) {
        hook(activity)
        resumed = java.lang.ref.WeakReference(activity)
        reporter.navigate(named[activity] ?: Redact.screenName(activity.javaClass.simpleName))
    }

    private var listening = false

    private fun measuringChanged(on: Boolean) {
        for (h in hooked.values) h.jank?.isTrackingEnabled = on
        if (on == listening) return
        listening = on
        val pm = app.getSystemService(Context.POWER_SERVICE) as? PowerManager
        val dm = app.getSystemService(Context.DISPLAY_SERVICE) as? DisplayManager
        runCatching {
            if (on) {
                val filter = IntentFilter(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED)
                if (Build.VERSION.SDK_INT >= 33) app.registerReceiver(powerReceiver, filter, Context.RECEIVER_NOT_EXPORTED) else app.registerReceiver(powerReceiver, filter)
                if (Build.VERSION.SDK_INT >= 29) pm?.addThermalStatusListener(app.mainExecutor, thermalListener as PowerManager.OnThermalStatusChangedListener)
                dm?.registerDisplayListener(displayListener, Handler(Looper.getMainLooper()))
            } else {
                app.unregisterReceiver(powerReceiver)
                if (Build.VERSION.SDK_INT >= 29) pm?.removeThermalStatusListener(thermalListener as PowerManager.OnThermalStatusChangedListener)
                dm?.unregisterDisplayListener(displayListener)
            }
        }
    }

    private fun hook(activity: Activity) {
        if (hooked.containsKey(activity)) {
            hooked[activity]?.jank?.isTrackingEnabled = reporter.measuring
            return
        }
        val window = activity.window ?: return
        val jank = runCatching { JankStats.createAndTrack(window, frames).also { it.isTrackingEnabled = reporter.measuring } }.getOrNull()
        if (window.callback !is TouchWatcher) window.callback?.let { window.callback = TouchWatcher(it, reporter) }
        val scroll = ViewTreeObserver.OnScrollChangedListener { reporter.scroll() }
        runCatching { window.decorView.viewTreeObserver.addOnScrollChangedListener(scroll) }
        hooked[activity] = Hooked(jank, scroll)
    }

    private fun unhook(activity: Activity) {
        val h = hooked.remove(activity) ?: return
        h.jank?.isTrackingEnabled = false
        runCatching { activity.window?.decorView?.viewTreeObserver?.takeIf { it.isAlive }?.removeOnScrollChangedListener(h.scroll) }
        named.remove(activity)
    }

    /** JankStats' thread. The whole frame against its deadline on Android 12+, else the CPU frame against the display's interval. */
    private fun onFrame(f: FrameData) {
        val mainMs = f.frameDurationUiNanos / 1e6
        when (f) {
            is FrameDataApi31 -> {
                val total = f.frameDurationTotalNanos / 1e6
                val deadline = (f.frameDurationTotalNanos - f.frameOverrunNanos) / 1e6
                reporter.frame(f.frameStartNanos, mainMs, total, deadline)
            }
            is FrameDataApi24 -> reporter.frame(f.frameStartNanos, mainMs, f.frameDurationCpuNanos / 1e6, null)
            else -> reporter.frame(f.frameStartNanos, mainMs, mainMs, null)
        }
    }

    private fun onMain(block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) block() else Handler(Looper.getMainLooper()).post(block)
    }
}

/** Sees touches on an activity's window before the activity does, then hands them on unchanged. */
internal class TouchWatcher(val base: Window.Callback, private val reporter: Reporter) : Window.Callback by base {
    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        try {
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> reporter.touch(true)
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> reporter.touch(false)
            }
        } catch (_: Throwable) {
            // Never break input.
        }
        return base.dispatchTouchEvent(event)
    }
}
