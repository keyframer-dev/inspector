package dev.keyframer.inspector.compose

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.AnimationResult
import androidx.compose.animation.core.AnimationSpec
import androidx.compose.animation.core.AnimationVector
import androidx.compose.animation.core.AnimationVector1D
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.TwoWayConverter
import androidx.compose.animation.core.VectorConverter
import androidx.compose.animation.core.spring
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import dev.keyframer.inspector.core.CallSites
import dev.keyframer.inspector.core.InspectorSession
import dev.keyframer.inspector.core.Signal
import dev.keyframer.inspector.core.StackFrame
import java.util.WeakHashMap

/**
 * An Animatable the inspector sees: remembered like `remember { Animatable(initialValue) }`, its value
 * a signal (recorded, played back, captured). Start it with [kfAnimateTo] to report each animation
 * with its spec; a plain animateTo still moves the recorded value, it just is not reported.
 */
@Composable
fun rememberKfAnimatable(
    initialValue: Float,
    label: String = "Animatable",
    visibilityThreshold: Float = Spring.DefaultDisplacementThreshold,
): Animatable<Float, AnimationVector1D> = rememberKfAnimatable(initialValue, Float.VectorConverter, label, visibilityThreshold)

/** [rememberKfAnimatable] for any type Compose can animate: one signal per component of its vector. */
@Composable
fun <T, V : AnimationVector> rememberKfAnimatable(
    initialValue: T,
    typeConverter: TwoWayConverter<T, V>,
    label: String = "Animatable",
    visibilityThreshold: T? = null,
): Animatable<T, V> {
    val animatable = remember { Animatable(initialValue, typeConverter, visibilityThreshold, label) }
    val tracker = rememberValueTracker("Animatable", label.takeIf { it != "Animatable" }, animatable, null)
    DisposableEffect(tracker) {
        if (tracker != null) ValueTracker.byAnimatable[animatable] = tracker
        onDispose { ValueTracker.byAnimatable.remove(animatable) }
    }
    return animatable
}

/**
 * Animatable.animateTo, reported: the spec (with the panel's live edits for this call applied), from
 * and to, and how long it runs. The call site is where kfAnimateTo is written. `animationSpec` null is
 * the Animatable's own default spring.
 *
 * The call site comes from this call's stack, which is read off the main thread unless the panel has
 * live edits that may be for it: then it is read now, to run the edited spec.
 */
suspend fun <T, V : AnimationVector> Animatable<T, V>.kfAnimateTo(
    targetValue: T,
    animationSpec: AnimationSpec<T>? = null,
    initialVelocity: T = velocity,
    block: (Animatable<T, V>.() -> Unit)? = null,
): AnimationResult<T, V> {
    if (liveSession == null) {
        return if (animationSpec == null) animateTo(targetValue, initialVelocity = initialVelocity, block = block)
        else animateTo(targetValue, animationSpec, initialVelocity, block)
    }
    // Taken on every call: one Animatable can be animated from several places, each a call site of its own.
    val spec = inspectorWork {
        val taken = Throwable()
        @Suppress("UNCHECKED_CAST")
        val tracked = ValueTracker.byAnimatable[this] as ValueTracker<T, V>?
        AnimateToTracker.started(this, tracked, taken, targetValue, animationSpec ?: spring(), animationSpec == null)
    }
    return if (spec == null) animateTo(targetValue, initialVelocity = initialVelocity, block = block)
    else animateTo(targetValue, spec, initialVelocity, block)
}

/** Reports each kfAnimateTo, from where it is written. */
internal object AnimateToTracker {
    /**
     * Reporters by Animatable, then by the app frame kfAnimateTo was called from: made on a call site's
     * first call and reused after, so a spring started on every drag end makes one, not one per drag.
     * Reporters hold no Animatable, so the weak keys can go.
     */
    private val reporters = WeakHashMap<Animatable<*, *>, HashMap<StackTraceElement, Reporter>>()

    /**
     * The spec to run, or null to keep the Animatable's own default (no edits for it). With no live edits
     * at all, nothing about this call is needed now: `taken`'s stack is read off the main thread and the
     * call reported when it is back, with the time it started and its values as they were then.
     */
    fun <T, V : AnimationVector> started(
        animatable: Animatable<T, V>,
        tracked: ValueTracker<T, V>?,
        taken: Throwable,
        target: T,
        spec: AnimationSpec<T>,
        isDefault: Boolean,
    ): AnimationSpec<T>? {
        val s = liveSession ?: return if (isDefault) null else spec
        val label = tracked?.label ?: animatable.label.takeIf { it != "Animatable" }
        if (s.overrides.isNotEmpty()) {
            val stack = taken.stackTrace
            val frame = firstAppFrame(stack) ?: return if (isDefault) null else spec
            val effective = reporter(animatable, frame, stack, label).run(animatable, target, spec, stack)
            return if (isDefault && effective === spec) null else effective
        }
        val start = s.animStart()
        val from = animatable.value
        val velocity = animatable.velocityVector.let { Specs.vector(it, Specs.floats(it)) }
        val prefixes = libraryPrefixes
        readStack(taken, { stack ->
            val frame = CallSites.firstAppFrame(stack, prefixes)
            Triple(frame, stack, if (frame != null && start.recording) s.frames(stack) else null)
        }) { (frame, stack, frames) ->
            if (frame != null) reporter(animatable, frame, stack, label).ran(animatable.typeConverter, from, velocity, target, spec, start, frames)
        }
        return if (isDefault) null else spec
    }

    private fun <T, V : AnimationVector> reporter(animatable: Animatable<T, V>, frame: StackTraceElement, stack: Array<StackTraceElement>, label: String?): Reporter =
        reporters.getOrPut(animatable) { HashMap() }.getOrPut(frame) { Reporter(CallSites.site(frame), stack, label) }

    private class Reporter(at: CallSites.Located, stack: Array<StackTraceElement>, label: String?) :
        Tracker(at, stack, "Animatable.animateTo", label) {
        override fun makeSignals() = emptyList<Signal>()

        /** One call: reported with this call's stack, the panel's edits applied to the spec it runs. */
        fun <T, V : AnimationVector> run(animatable: Animatable<T, V>, target: T, spec: AnimationSpec<T>, stack: Array<StackTraceElement>): AnimationSpec<T> {
            val effective = Specs.withOverrides(spec, overrides())
            val from = animatable.value
            report(effective, args(animatable.typeConverter, from, target, effective), Specs.durationMs(effective, animatable.typeConverter, from, target, animatable.velocityVector), stack = stack)
            return effective
        }

        /** One call that ran `spec` from `from` at `start`, with no edits: reported now that its stack was read. */
        fun <T, V : AnimationVector> ran(
            converter: TwoWayConverter<T, V>,
            from: T,
            velocity: V,
            target: T,
            spec: AnimationSpec<T>,
            start: InspectorSession.AnimStart,
            frames: List<StackFrame>?,
        ) {
            report(spec, args(converter, from, target, spec), Specs.durationMs(spec, converter, from, target, velocity), start, frames)
        }

        private fun <T, V : AnimationVector> args(converter: TwoWayConverter<T, V>, from: T, target: T, spec: AnimationSpec<T>): LinkedHashMap<String, Any?> {
            val args = Specs.describe(spec)
            val a = Specs.components(converter, from)
            val b = Specs.components(converter, target)
            args["values"] = a.indices.associate { i -> (label ?: "value").let { if (a.size > 1) "$it.$i" else it } to listOf(a[i], b.getOrElse(i) { a[i] }) }
            return args
        }
    }
}
