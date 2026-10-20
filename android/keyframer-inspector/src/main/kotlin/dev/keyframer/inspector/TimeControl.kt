package dev.keyframer.inspector

import android.animation.Animator
import android.animation.AnimatorSet
import android.animation.ValueAnimator
import android.os.Build
import android.util.Log
import android.view.Choreographer
import dev.keyframer.inspector.core.TimeClock
import dev.keyframer.inspector.core.TimeRules
import java.lang.reflect.Field
import java.lang.reflect.Method

/**
 * The `time` capability for Android animators: slow motion, pause and step.
 *
 * Slow motion is the animator duration scale (what "Animator duration scale" in the developer options
 * sets), changed through ValueAnimator's hidden `setDurationScale`: every ValueAnimator, ObjectAnimator,
 * AnimatorSet, ViewPropertyAnimator and Transition in the process runs slower. A running animator reads
 * the scale on every frame, so changing it moves the animator to another point of its curve; the ones the
 * SDK knows (tracked with kfTrack, and every running one when AnimationHandler can be read) are put back
 * at the play time they had, so the change does not jump.
 *
 * Pausing cannot use the scale (0 means "animations off": everything jumps to its end). Instead the
 * known running animators are held: every frame their play time is set back to where it was, which
 * re-anchors their start time, so letting go continues from there, with no resume() bookkeeping. A step
 * moves that play time on by one frame at the display's rate, once per frame. When the scale cannot be
 * changed (the reflection is refused), slow motion drives the known animators the same way, at a rate.
 *
 * Compose (keyframer-inspector-compose) reads [clock], the same animation time, through its frame clock.
 *
 * Changes land on the next frame, from a frame callback: there Android's animation clock is locked to
 * the frame's vsync, so the play times read and set are exact (read between frames, they are off by up
 * to a frame), and the clock is anchored on the same times Compose's frames use.
 *
 * Main thread only. Every reflective call is guarded: without them, time control covers fewer animators,
 * it never breaks the app.
 */
internal class TimeControl(
    /** The running animators the SDK tracks, as the ones to hold (an AnimatorSet, not its children). */
    private val tracked: () -> List<Animator>,
    private val refreshRate: () -> Float,
    /** The duration scale the person chose in the settings (1 when it cannot be read). */
    private val systemScale: () -> Float,
) {
    val clock = TimeClock()

    /** The speed in effect: 1 normal, 0 paused. */
    val scale: Double get() = clock.scale

    /** The duration scale before the first change, put back at speed 1. Null while untouched. */
    private var original: Float? = null
    /** Turned off when setting the scale fails. The reflection itself waits for the first change. */
    private var scaleWorks = true
    private val canScale: Boolean get() = scaleWorks && DurationScale.canSet

    private class Hold(val playTime: Double, val at: Double)

    private val held = LinkedHashMap<Animator, Hold>()
    private var loop: Choreographer.FrameCallback? = null
    private val pending = ArrayList<Pair<Double, Int?>>()
    private var applying: Choreographer.FrameCallback? = null

    /** Applies an editor's `time` on the next frame. Returns the speed that will be in effect. */
    fun set(scale: Double, step: Int?): Double {
        val s = if (scale.isFinite()) scale.coerceIn(0.0, TimeRules.MAX_SCALE) else 1.0
        clock.frameMs = 1000.0 / refreshRate().toDouble().coerceIn(1.0, 1000.0)
        pending.add(s to step)
        if (applying == null) {
            val cb = Choreographer.FrameCallback { frameTimeNanos ->
                applying = null
                val now = frameTimeNanos / 1e6
                val todo = pending.toList()
                pending.clear()
                try {
                    for ((next, steps) in todo) {
                        if (next != clock.scale) change(next, now)
                        if (next == 0.0 && steps != null && steps > 0) clock.step(steps.coerceAtMost(TimeRules.MAX_STEP))
                    }
                } catch (e: Throwable) {
                    Log.w("Keyframer", "time control: $e")
                }
                updateLoop()
            }
            applying = cb
            Choreographer.getInstance().postFrameCallback(cb)
        }
        return s
    }

    /** The person changed the animator duration scale in the settings while the speed is not 1. */
    fun systemScaleChanged() {
        if (original == null) return
        original = systemScale()
        // The system sets its own scale in this process too; ours goes on top once it has, with the
        // known animators put back where they are (in a frame, for exact play times).
        mainHandler.postDelayed({
            Choreographer.getInstance().postFrameCallback {
                if (original == null || clock.scale <= 0 || !canScale) return@postFrameCallback
                val at = known().mapNotNull { a -> playTime(a)?.let { a to it } }
                if (applyDurationScale(clock.scale)) for ((a, p) in at) seek(a, p)
            }
        }, 250)
    }

    private fun change(s: Double, now: Double) {
        val running = known()
        if (s > 0 && canScale) {
            // Where each animator is before the scale moves it, to put it back after.
            val at = LinkedHashMap<Animator, Double>()
            for (a in running) {
                val h = held[a]
                val p = if (h != null) h.playTime + (clock.at(now) - h.at) else playTime(a)
                if (p != null) at[a] = p
            }
            held.clear()
            clock.setScale(s, now)
            if (!applyDurationScale(s)) {
                // Refused after all: hold them at the new rate instead.
                scaleWorks = false
                for ((a, p) in at) held[a] = Hold(p, clock.at(now))
                return
            }
            for ((a, p) in at) seek(a, p)
            if (s == 1.0) original = null
            return
        }
        // Paused, or slowed without the duration scale: hold everything known from here on.
        val v0 = clock.at(now)
        for (a in running) {
            if (held.containsKey(a)) continue
            val p = playTime(a) ?: continue
            held[a] = Hold(p, v0)
        }
        clock.setScale(s, now)
        if (s == 1.0) {
            letGo(now)
            if (original != null) {
                DurationScale.set(original!!)
                original = null
            }
        }
    }

    private fun applyDurationScale(s: Double): Boolean {
        val base = original ?: (DurationScale.get() ?: systemScale()).also { original = it }
        val target = if (s == 1.0) base else (base / s).toFloat()
        return DurationScale.set(target)
    }

    /** Back to the animators' own clock: each continues from where it was held. */
    private fun letGo(now: Double) {
        for ((a, h) in held) seek(a, h.playTime + (clock.at(now) - h.at))
        held.clear()
    }

    private val holding: Boolean get() = clock.scale == 0.0 || (clock.scale != 1.0 && !canScale)

    private fun updateLoop() {
        if (holding || clock.pendingSteps > 0) {
            if (loop != null) return
            val choreographer = Choreographer.getInstance()
            val cb = object : Choreographer.FrameCallback {
                override fun doFrame(frameTimeNanos: Long) {
                    if (loop !== this) return
                    try {
                        frame(frameTimeNanos / 1e6)
                    } catch (e: Throwable) {
                        Log.w("Keyframer", "time control stopped: $e")
                        held.clear()
                        loop = null
                        return
                    }
                    if (holding || clock.pendingSteps > 0) choreographer.postFrameCallback(this) else loop = null
                }
            }
            loop = cb
            choreographer.postFrameCallback(cb)
        } else {
            loop?.let { Choreographer.getInstance().removeFrameCallback(it) }
            loop = null
        }
    }

    /** One frame while holding: animators that started since join, every held one shows its play time. */
    private fun frame(now: Double) {
        val v = clock.frame(now)
        if (!holding) return
        for (a in known()) {
            if (held.containsKey(a)) continue
            val p = playTime(a) ?: continue
            held[a] = Hold(p, v)
        }
        val it = held.entries.iterator()
        while (it.hasNext()) {
            val (a, h) = it.next()
            // Ended, cancelled, or paused by the app (seeking a paused animator would upset its resume).
            if (!a.isStarted || a.isPaused) {
                it.remove()
                continue
            }
            seek(a, h.playTime + (v - h.at))
        }
    }

    /** The running animators to hold: the tracked ones, and every other one AnimationHandler runs. */
    private fun known(): List<Animator> {
        val out = LinkedHashSet<Animator>()
        for (a in tracked()) if (isHoldable(a)) out.add(a)
        for (a in RunningAnimators.all()) if (isHoldable(a)) out.add(a)
        return out.toList()
    }

    /** Past its start delay and not paused. An AnimatorSet only on API 26+, where the set drives its children. */
    private fun isHoldable(a: Animator): Boolean {
        if (a is AnimatorSet && Build.VERSION.SDK_INT < 26) return false
        return a.isRunning && !a.isPaused && (a is ValueAnimator || a is AnimatorSet)
    }

    private fun playTime(a: Animator): Double? = runCatching {
        when (a) {
            is ValueAnimator -> a.currentPlayTime.toDouble()
            is AnimatorSet -> if (Build.VERSION.SDK_INT >= 26) a.currentPlayTime.toDouble() else null
            else -> null
        }
    }.getOrNull()

    private fun seek(a: Animator, p: Double) {
        val t = p.toLong().coerceAtLeast(0)
        try {
            when (a) {
                is ValueAnimator -> a.currentPlayTime = t
                is AnimatorSet -> if (Build.VERSION.SDK_INT >= 26) {
                    // A set refuses a play time past its end.
                    val total = a.totalDuration
                    a.currentPlayTime = if (total == Animator.DURATION_INFINITE) t else t.coerceAtMost((total - a.startDelay).coerceAtLeast(0))
                }
            }
        } catch (_: Throwable) {
            // An animator in a state that cannot seek: it runs on its own clock.
        }
    }
}

/**
 * ValueAnimator's process-wide duration scale. The getter is public from API 33; below that, and for the
 * setter, the hidden members ActivityThread uses (`setDurationScale`, `sDurationScale`), by reflection.
 */
internal object DurationScale {
    private val setter: Method? = runCatching {
        ValueAnimator::class.java.getDeclaredMethod("setDurationScale", Float::class.javaPrimitiveType).apply { isAccessible = true }
    }.getOrNull()
    private val scaleField: Field? = runCatching {
        ValueAnimator::class.java.getDeclaredField("sDurationScale").apply { isAccessible = true }
    }.getOrNull()

    val canSet: Boolean get() = setter != null || scaleField != null

    fun get(): Float? = runCatching {
        if (Build.VERSION.SDK_INT >= 33) ValueAnimator.getDurationScale() else scaleField?.getFloat(null)
    }.getOrNull()

    /** True when the scale is now `v`. */
    fun set(v: Float): Boolean {
        val ok = runCatching {
            when {
                setter != null -> setter.invoke(null, v)
                scaleField != null -> scaleField.setFloat(null, v)
                else -> return false
            }
        }.isSuccess
        if (!ok) return false
        return get()?.let { it == v } ?: true
    }
}

/**
 * Every animator running on the main thread, from the hidden AnimationHandler, when the platform lets
 * an app read it; empty otherwise (then only tracked animators are held).
 */
internal object RunningAnimators {
    private val read: (() -> List<Any?>)? = runCatching {
        val cls = Class.forName("android.animation.AnimationHandler")
        val getInstance = cls.getDeclaredMethod("getInstance").apply { isAccessible = true }
        val callbacks = cls.getDeclaredField("mAnimationCallbacks").apply { isAccessible = true }
        val f: () -> List<Any?> = { (callbacks.get(getInstance.invoke(null)) as? List<*>)?.toList().orEmpty() }
        f
    }.getOrNull()

    val available: Boolean get() = read != null

    fun all(): List<Animator> {
        val r = read ?: return emptyList()
        return runCatching { r().filterIsInstance<Animator>() }.getOrDefault(emptyList())
    }
}
