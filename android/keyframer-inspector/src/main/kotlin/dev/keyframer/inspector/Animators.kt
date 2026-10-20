package dev.keyframer.inspector

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.AnimatorSet
import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.app.Activity
import android.os.Build
import android.view.View
import android.view.Window
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
 *
 * The view an animator moves (an ObjectAnimator's target, or the one passed to kfTrack) is watched for
 * visibility while recording and checked for render hints on each start.
 */
internal class AnimatorTracker(private val session: () -> InspectorSession?) {
    private val tracked = LinkedHashMap<String, Tracked>()
    private var overrides: Map<String, Map<String, Double>> = emptyMap()

    /** The window on top, for render hints about blurs above an animated view. */
    var topWindow: () -> Window? = { null }

    fun track(animator: Animator, name: String?, owner: Activity?, stack: Array<StackTraceElement>, extraPrefixes: List<String>, view: View? = null) {
        val frame = CallSites.firstAppFrame(stack, extraPrefixes) ?: return
        val located = CallSites.site(frame)
        // The name is part of the id: one line that tracks "row1" to "row50" in a loop tracks fifty
        // animators, each with ids of its own that stay the same from run to run.
        val slot = name?.let { "${located.id}:$it" } ?: located.id
        when (animator) {
            is ValueAnimator -> register(animator, located, slot, name, owner, stack, null, view)
            is AnimatorSet -> animator.childAnimations.forEachIndexed { i, child ->
                // A set's children share its call site; on API 26+ the set drives them, so seeking a child
                // shows that child only. Good enough to see each part; a set-level time track is a next step.
                if (child is ValueAnimator) register(child, located, "$slot/$i", name?.let { "$it[$i]" }, owner, stack, animator, view)
            }
        }
    }

    /** The ids of every tracked animator, for tests. */
    val ids: Set<String> get() = tracked.keys.toSet()

    /**
     * The running animators the editor's `time` holds: an AnimatorSet as a whole where it drives its
     * children (API 26+), each animator otherwise.
     */
    fun runningRoots(): List<Animator> {
        val out = LinkedHashSet<Animator>()
        for (t in tracked.values) {
            val root: Animator = t.parent?.takeIf { Build.VERSION.SDK_INT >= 26 } ?: t.animator
            if (root.isRunning) out.add(root)
        }
        return out.toList()
    }

    /** The views of tracked animators, for visibility markers while recording. */
    fun visibilityTargets(): List<ViewTarget> = tracked.values.mapNotNull { it.viewTarget() }

    private fun register(
        animator: ValueAnimator,
        at: CallSites.Located,
        baseId: String,
        name: String?,
        owner: Activity?,
        stack: Array<StackTraceElement>,
        parent: AnimatorSet?,
        view: View?,
    ) {
        if (tracked.values.any { it.animator === animator }) return
        // Several animators from one line under one name (rows of a list) get #2, #3. One replaces an
        // earlier one only when it is that one made again: the same view, after the earlier one ran its
        // course (a one-shot created on every tap), or when the earlier one's screen is going away (a
        // screen created again, whose old activity may still be finishing). Animators made in a loop and
        // started later have not run yet, so each keeps its own id.
        var id = baseId
        var n = 1
        while (true) {
            val existing = tracked[id] ?: break
            if (existing.replaceableBy(animator, view)) {
                existing.dispose()
                break
            }
            id = "$baseId#${++n}"
        }
        val t = Tracked(animator, at, id, name, WeakReference(owner), stack, parent, view)
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
        /** The AnimatorSet it was tracked through, which drives it on API 26+. */
        val parent: AnimatorSet?,
        explicitView: View?,
    ) {
        val ownedByActivity = owner.get() != null
        /** It started at least once (a one-shot made again replaces only one that has run). */
        private var ran = false
        private var lastPlayTime = 0L
        private var pending: Map<String, Double>? = null
        private val signalIds = ArrayList<String>()
        /** Property → its value signal id ("" for an animator of one value). */
        private val valueIds = LinkedHashMap<String, String>()
        private val explicitView = explicitView?.let { WeakReference(it) }
        /** Set on each start: render hints are read on the first frame that follows. */
        private var checkHints = false
        private val hintsSent = HashSet<String>()

        /** The view it animates: the one passed to kfTrack, else an ObjectAnimator's target. */
        val view: View?
            get() = explicitView?.get() ?: (animator as? ObjectAnimator)?.target as? View

        /** What it moves: the view passed to kfTrack, or an ObjectAnimator's target (a view or not). */
        private val target: Any?
            get() = explicitView?.get() ?: (animator as? ObjectAnimator)?.target

        /** See register: `next`, from the same line under the same name, is this animator made again. */
        fun replaceableBy(next: ValueAnimator, nextView: View?): Boolean {
            val screenGone = ownedByActivity && owner.get().let { it == null || it.isDestroyed || it.isFinishing }
            if (screenGone) return true
            val nextTarget: Any? = nextView ?: (next as? ObjectAnimator)?.target
            return ran && !animator.isStarted && target === nextTarget
        }

        fun viewTarget(): ViewTarget? {
            val v = view ?: return null
            if (valueIds.isEmpty()) return null
            return ViewTarget(valueIds.values.toList(), v, active = animator.isRunning, animatesAlpha = "alpha" in valueIds.keys)
        }

        private val fn = when (animator) {
            is ObjectAnimator -> "ObjectAnimator"
            else -> "ValueAnimator"
        }

        private val properties: List<String>
            get() = animator.values?.map { it.propertyName.orEmpty() } ?: listOf("")

        private val updates = ValueAnimator.AnimatorUpdateListener { a ->
            lastPlayTime = a.currentPlayTime
            if (checkHints) {
                checkHints = false
                renderHints()
            }
        }

        private val lifecycle = object : AnimatorListenerAdapter() {
            override fun onAnimationStart(animation: Animator) {
                // The start's own stack when it holds app code (a tap handler), else where it was tracked.
                val now = Throwable().stackTrace
                val stack = if (CallSites.firstAppFrame(now) != null) now else registeredFrom
                session()?.reportAnim(callSite(), listOf(args()), stack, durationMs())
                ran = true
                checkHints = true
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
                add(s, ValueSignal(id, label, null, props.firstOrNull()?.ifEmpty { null }))
                valueIds[props.firstOrNull().orEmpty()] = id
            } else {
                for (p in props) {
                    add(s, ValueSignal("$id:$p", listOfNotNull(name, p).joinToString("."), p, p.ifEmpty { null }))
                    valueIds[p] = "$id:$p"
                }
            }
            add(s, TimeSignal("$id:time", listOfNotNull(label, "time").joinToString(" ")))
        }

        /** Once per hint and value signal: a view that keeps animating the same way says it once. */
        private fun renderHints() {
            val v = view ?: return
            val s = session() ?: return
            val found = runCatching { RenderHints.check(v, valueIds.keys, topWindow()) }.getOrDefault(emptyList())
            for (f in found) {
                val sid = f.property?.let { valueIds[it] } ?: valueIds.values.firstOrNull() ?: id
                if (hintsSent.add("$sid:${f.hint}")) s.reportRenderHint(sid, f.hint, f.detail)
            }
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

        private fun site(sid: String, label: String?, writable: Boolean? = null, prop: String? = null, kind: String? = null) =
            SignalSite(sid, at.file, at.line, at.component, label, column = 0, writable = writable, kind = kind, prop = prop)

        /** Read-only: playback replays an animator through its `:time` track. `prop`: the property's name. */
        inner class ValueSignal(sid: String, label: String?, private val property: String?, prop: String?) : Signal {
            override val site = site(sid, label, writable = false, prop = prop)
            override fun read() = read(property)
        }

        /** The play time, `kind: "time"`: what playback writes to replay the animator; not a value on screen. */
        inner class TimeSignal(sid: String, label: String) : Signal {
            override val site = site(sid, label, kind = "time")
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
