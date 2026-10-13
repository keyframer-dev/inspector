package dev.keyframer.inspector

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.AnimatorSet
import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.app.Activity
import dev.keyframer.inspector.core.CallSite
import dev.keyframer.inspector.core.CallSites
import dev.keyframer.inspector.core.InspectorSession
import dev.keyframer.inspector.core.Param
import dev.keyframer.inspector.core.Signal
import dev.keyframer.inspector.core.SignalSite
import java.lang.ref.WeakReference

/**
 * Animators the app handed to [Keyframer.track]. Android has no global hook into ValueAnimator (its
 * AnimationHandler is hidden API), so animators are registered one by one; see the README for the
 * bytecode route that would make it automatic.
 *
 * Each tracked animator reports an `anim` event every time it starts, and registers signals:
 *   `<site>` (or `<site>:<property>` with several properties): its animated value, read-only;
 *   `<site>:time`: its play time in ms, the one playback and capture write. Writing a play time seeks a
 *   clone of the animator, which shares the app's update listeners (and an ObjectAnimator's target), so
 *   the views follow while the original stays paused and untouched. Release resumes the original, or
 *   puts the views back where it left them.
 */
internal class AnimatorTracker(private val session: () -> InspectorSession?) {
    private val tracked = LinkedHashMap<String, Tracked>()
    private var overrides: Map<String, Map<String, Double>> = emptyMap()

    fun track(animator: Animator, name: String?, owner: Activity?, stack: Array<StackTraceElement>, extraPrefixes: List<String>) {
        val frame = CallSites.firstAppFrame(stack, extraPrefixes) ?: return
        val located = CallSites.site(frame)
        when (animator) {
            is ValueAnimator -> register(animator, located, located.id, name, owner, stack)
            is AnimatorSet -> animator.childAnimations.forEachIndexed { i, child ->
                // A set's children share its call site; on API 26+ the set drives them, so seeking a child
                // shows that child only. Good enough to see each part; a set-level time track is a next step.
                if (child is ValueAnimator) register(child, located, "${located.id}/$i", name?.let { "$it[$i]" }, owner, stack)
            }
        }
    }

    private fun register(animator: ValueAnimator, at: CallSites.Located, baseId: String, name: String?, owner: Activity?, stack: Array<StackTraceElement>) {
        if (tracked.values.any { it.animator === animator }) return
        // Two live animators from one line (rows of a list) get #2, #3; a finished one is replaced (a
        // one-shot created on every tap, or a screen created again).
        var id = baseId
        var n = 1
        while (true) {
            val existing = tracked[id] ?: break
            if (!existing.animator.isRunning || existing.owner.get()?.isDestroyed != false) {
                existing.dispose()
                break
            }
            id = "$baseId#${++n}"
        }
        val t = Tracked(animator, at, id, name, WeakReference(owner), stack)
        tracked[id] = t
        overrides[at.id]?.let { t.apply(it) }
        t.attach()
    }

    /** Stops reporting this animator (an AnimatorSet: its children); its signals leave the panel. */
    fun untrack(animator: Animator) {
        val targets = if (animator is AnimatorSet) animator.childAnimations.toSet() else setOf(animator)
        val gone = tracked.values.filter { it.animator in targets }
        for (t in gone) {
            t.dispose()
            tracked.remove(t.id)
        }
    }

    fun applyOverrides(next: Map<String, Map<String, Double>>) {
        overrides = next
        for (t in tracked.values) next[t.at.id]?.let { t.apply(it) }
    }

    /** An activity went away: its animators and their signals go with it. */
    fun ownerDestroyed(activity: Activity) {
        val gone = tracked.values.filter { it.owner.get() === activity || it.owner.get() == null && it.ownedByActivity }
        for (t in gone) {
            t.dispose()
            tracked.remove(t.id)
        }
    }

    fun clear() {
        tracked.values.forEach { it.dispose() }
        tracked.clear()
    }

    private inner class Tracked(
        val animator: ValueAnimator,
        val at: CallSites.Located,
        val id: String,
        val name: String?,
        val owner: WeakReference<Activity>,
        val registeredFrom: Array<StackTraceElement>,
    ) {
        val ownedByActivity = owner.get() != null
        private var lastPlayTime = 0L
        private var pending: Map<String, Double>? = null
        private val signalIds = ArrayList<String>()

        private val fn = when (animator) {
            is ObjectAnimator -> "ObjectAnimator"
            else -> "ValueAnimator"
        }

        private val properties: List<String>
            get() = animator.values?.map { it.propertyName.orEmpty() } ?: listOf("")

        private val updates = ValueAnimator.AnimatorUpdateListener { a -> lastPlayTime = a.currentPlayTime }

        private val lifecycle = object : AnimatorListenerAdapter() {
            override fun onAnimationStart(animation: Animator) {
                // The start's own stack when it holds app code (a tap handler), else where it was tracked.
                val now = Throwable().stackTrace
                val stack = if (CallSites.firstAppFrame(now) != null) now else registeredFrom
                session()?.reportAnim(callSite(), listOf(args()), stack, durationMs())
            }

            override fun onAnimationEnd(animation: Animator) {
                lastPlayTime = endTime()
                pending?.let {
                    pending = null
                    apply(it)
                }
            }
        }

        fun attach() {
            animator.addUpdateListener(updates)
            animator.addListener(lifecycle)
            val s = session() ?: return
            val props = properties
            val label = name ?: (animator as? ObjectAnimator)?.propertyName ?: props.firstOrNull()?.ifEmpty { null }
            if (props.size <= 1) {
                add(s, ValueSignal(id, label, null))
            } else {
                for (p in props) add(s, ValueSignal("$id:$p", listOfNotNull(name, p).joinToString("."), p))
            }
            add(s, TimeSignal("$id:time", listOfNotNull(label, "time").joinToString(" ")))
        }

        private fun add(s: InspectorSession, signal: Signal) {
            signalIds.add(signal.site.id)
            s.addSignal(signal)
        }

        fun dispose() {
            animator.removeUpdateListener(updates)
            animator.removeListener(lifecycle)
            session()?.let { s -> signalIds.forEach { s.removeSignal(it) } }
            signalIds.clear()
        }

        /** Live edits from the panel: now when idle, at the end of the current run otherwise. */
        fun apply(params: Map<String, Double>) {
            if (animator.isRunning) {
                pending = params
                return
            }
            params["duration"]?.let { animator.duration = it.toLong().coerceAtLeast(0) }
            params["startDelay"]?.let { animator.startDelay = it.toLong().coerceAtLeast(0) }
            params["repeatCount"]?.let { animator.repeatCount = it.toInt() }
        }

        /** Delay plus every repeat; null when it repeats forever. */
        fun durationMs(): Long? =
            if (animator.repeatCount == ValueAnimator.INFINITE) null else animator.startDelay + animator.duration * (animator.repeatCount + 1)

        private fun endTime(): Long =
            if (animator.repeatCount == ValueAnimator.INFINITE) animator.currentPlayTime else animator.duration * (animator.repeatCount + 1)

        fun callSite() = CallSite(
            id = at.id,
            file = at.file,
            line = at.line,
            column = 0,
            fn = fn,
            component = at.component,
            target = name ?: (animator as? ObjectAnimator)?.target?.let { targetName(it) },
            prop = (animator as? ObjectAnimator)?.propertyName ?: properties.singleOrNull()?.ifEmpty { null },
            params = listOf(
                Param("duration", animator.duration.toDouble()),
                Param("startDelay", animator.startDelay.toDouble()),
                Param("repeatCount", animator.repeatCount.toDouble()),
            ),
        )

        /**
         * One config object, shaped like the React Native inspector's "CSS animation" args (duration,
         * delay, iterationCount) so the panel's timing estimates can read it, plus what Android adds.
         */
        fun args(): Map<String, Any?> = linkedMapOf(
            "duration" to animator.duration,
            "delay" to animator.startDelay,
            "iterationCount" to (if (animator.repeatCount == ValueAnimator.INFINITE) "infinite" else animator.repeatCount + 1),
            "direction" to (if (animator.repeatMode == ValueAnimator.REVERSE) "alternate" else "normal"),
            "interpolator" to (animator.interpolator?.javaClass?.simpleName ?: "AccelerateDecelerateInterpolator"),
            "values" to keyframes(),
        )

        /**
         * The keyframe values per property. PropertyValuesHolder has no getter for them; its toString
         * prints them ("alpha:  0.0  1.0  "), which is what this reads. Path-based holders give none.
         */
        private fun keyframes(): Map<String, List<Double>>? {
            val holders = animator.values ?: return null
            val out = LinkedHashMap<String, List<Double>>()
            for (h in holders) {
                val text = h.toString()
                val nums = text.substringAfter(':', "").trim().split(Regex("\\s+")).mapNotNull { it.toDoubleOrNull() }
                if (nums.isNotEmpty()) out[h.propertyName.orEmpty().ifEmpty { "value" }] = nums
            }
            return out.ifEmpty { null }
        }

        private fun read(property: String?): Double? {
            val v: Any? = if (property == null) animator.animatedValue else animator.getAnimatedValue(property)
            return when (v) {
                is Float -> v.toString().toDouble()
                is Number -> v.toDouble()
                else -> null
            }
        }

        private fun site(sid: String, label: String?, writable: Boolean? = null) =
            SignalSite(sid, at.file, at.line, at.component, label, column = 0, writable = writable)

        /** Read-only: playback replays an animator through its `:time` track. */
        inner class ValueSignal(sid: String, label: String?, private val property: String?) : Signal {
            override val site = site(sid, label, writable = false)
            override fun read() = read(property)
        }

        inner class TimeSignal(sid: String, label: String) : Signal {
            override val site = site(sid, label)
            private var scrub: ValueAnimator? = null
            private var resume = false

            override fun read(): Double = (if (animator.isRunning) animator.currentPlayTime else lastPlayTime).toDouble()

            override fun hold() {
                if (scrub != null) return
                resume = animator.isRunning && !animator.isPaused
                if (animator.isStarted) animator.pause()
                scrub = animator.clone().also {
                    it.removeUpdateListener(updates)
                    it.removeListener(lifecycle)
                }
            }

            override fun write(v: Double) {
                (scrub ?: return).currentPlayTime = v.toLong().coerceAtLeast(0)
            }

            override fun release() {
                val s = scrub ?: return
                scrub = null
                if (resume) animator.resume() else s.currentPlayTime = lastPlayTime
            }
        }
    }

    private fun targetName(target: Any): String {
        val view = target as? android.view.View
        if (view != null && view.id != android.view.View.NO_ID) {
            runCatching { return view.resources.getResourceEntryName(view.id) }
        }
        return target.javaClass.simpleName
    }
}
