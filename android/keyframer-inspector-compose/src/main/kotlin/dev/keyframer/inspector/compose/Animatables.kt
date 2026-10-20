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
    val stack = Throwable().stackTrace
    @Suppress("UNCHECKED_CAST")
    val tracked = ValueTracker.byAnimatable[this] as ValueTracker<T, V>?
    val spec = AnimateToTracker.started(this, tracked, stack, targetValue, animationSpec ?: spring(), animationSpec == null)
    return if (spec == null) animateTo(targetValue, initialVelocity = initialVelocity, block = block)
    else animateTo(targetValue, spec, initialVelocity, block)
}

/** Reports one kfAnimateTo, from where it is written. */
internal object AnimateToTracker {
    /** The spec to run, or null to keep the Animatable's own default (no edits for it). */
    fun <T, V : AnimationVector> started(
        animatable: Animatable<T, V>,
        tracked: ValueTracker<T, V>?,
        stack: Array<StackTraceElement>,
        target: T,
        spec: AnimationSpec<T>,
        isDefault: Boolean,
    ): AnimationSpec<T>? {
        val at = locate(stack) ?: return if (isDefault) null else spec
        val reporter = object : Tracker(at, stack, "Animatable.animateTo", tracked?.label ?: animatable.label.takeIf { it != "Animatable" }) {
            override fun makeSignals() = emptyList<dev.keyframer.inspector.core.Signal>()
            fun run(): AnimationSpec<T> {
                val effective = Specs.withOverrides(spec, overrides())
                val from = animatable.value
                val args = Specs.describe(effective)
                val a = Specs.components(animatable.typeConverter, from)
                val b = Specs.components(animatable.typeConverter, target)
                args["values"] = a.indices.associate { i -> (label ?: "value").let { if (a.size > 1) "$it.$i" else it } to listOf(a[i], b.getOrElse(i) { a[i] }) }
                report(effective, args, Specs.durationMs(effective, animatable.typeConverter, from, target, animatable.velocityVector))
                return effective
            }
        }
        val effective = reporter.run()
        return if (isDefault && effective === spec) null else effective
    }
}
