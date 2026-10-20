package dev.keyframer.inspector.compose

import androidx.compose.animation.core.AnimationSpec
import androidx.compose.animation.core.AnimationVector
import androidx.compose.animation.core.AnimationVector1D
import androidx.compose.animation.core.AnimationVector2D
import androidx.compose.animation.core.AnimationVector3D
import androidx.compose.animation.core.AnimationVector4D
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.DurationBasedAnimationSpec
import androidx.compose.animation.core.Ease
import androidx.compose.animation.core.EaseIn
import androidx.compose.animation.core.EaseInOut
import androidx.compose.animation.core.EaseOut
import androidx.compose.animation.core.Easing
import androidx.compose.animation.core.FastOutLinearInEasing
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.InfiniteRepeatableSpec
import androidx.compose.animation.core.KeyframesSpec
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.LinearOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.RepeatableSpec
import androidx.compose.animation.core.SnapSpec
import androidx.compose.animation.core.SpringSpec
import androidx.compose.animation.core.TargetBasedAnimation
import androidx.compose.animation.core.TweenSpec
import androidx.compose.animation.core.TwoWayConverter
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.repeatable
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import dev.keyframer.inspector.core.Param

/**
 * What an AnimationSpec says, for `anim` events: a config object shaped like the Views SDK's args
 * (`duration`, `delay`, `iterationCount`, `direction` where they apply) plus Compose's own (`type`,
 * `easing`, `dampingRatio`, `stiffness`); the live-tunable numbers as params; the spec with the panel's
 * overrides applied; and how long it runs, from Compose's own math (a spring's settle time included).
 */
internal object Specs {
    private val easings: List<Pair<Easing, String>> = listOf(
        FastOutSlowInEasing to "FastOutSlowInEasing",
        LinearOutSlowInEasing to "LinearOutSlowInEasing",
        FastOutLinearInEasing to "FastOutLinearInEasing",
        LinearEasing to "LinearEasing",
        Ease to "Ease",
        EaseIn to "EaseIn",
        EaseOut to "EaseOut",
        EaseInOut to "EaseInOut",
    )

    fun easingName(e: Easing): String =
        easings.firstOrNull { it.first === e }?.second ?: if (e is CubicBezierEasing) e.toString() else e.javaClass.simpleName.ifEmpty { "Easing" }

    fun describe(spec: AnimationSpec<*>): LinkedHashMap<String, Any?> = when (spec) {
        is TweenSpec<*> -> linkedMapOf("type" to "tween", "duration" to spec.durationMillis, "delay" to spec.delay, "easing" to easingName(spec.easing))
        is SpringSpec<*> -> linkedMapOf("type" to "spring", "dampingRatio" to spec.dampingRatio, "stiffness" to spec.stiffness)
        is SnapSpec<*> -> linkedMapOf("type" to "snap", "duration" to 0, "delay" to spec.delay)
        is KeyframesSpec<*> -> linkedMapOf("type" to "keyframes", "duration" to spec.config.durationMillis, "delay" to spec.config.delayMillis)
        is RepeatableSpec<*> -> repeated("repeatable", spec.iterations, spec.repeatMode, spec.animation)
        is InfiniteRepeatableSpec<*> -> repeated("infiniteRepeatable", null, spec.repeatMode, spec.animation)
        else -> linkedMapOf("type" to spec.javaClass.simpleName.ifEmpty { "AnimationSpec" })
    }

    private fun repeated(type: String, iterations: Int?, mode: RepeatMode, inner: DurationBasedAnimationSpec<*>): LinkedHashMap<String, Any?> {
        val each = describe(inner)
        return linkedMapOf(
            "type" to type,
            "duration" to each["duration"],
            "delay" to each["delay"],
            "iterationCount" to (iterations ?: "infinite"),
            "direction" to (if (mode == RepeatMode.Reverse) "alternate" else "normal"),
            "animation" to each,
        )
    }

    /** The numbers the panel can tune live: what [withOverrides] applies. */
    fun params(spec: AnimationSpec<*>): List<Param> = when (spec) {
        is TweenSpec<*> -> listOf(Param("duration", spec.durationMillis.toDouble()), Param("delay", spec.delay.toDouble()))
        is SpringSpec<*> -> listOf(Param("dampingRatio", spec.dampingRatio.toDouble()), Param("stiffness", spec.stiffness.toDouble()))
        is RepeatableSpec<*> -> (spec.animation as? TweenSpec<*>)?.let { params(it) + Param("iterationCount", spec.iterations.toDouble()) }.orEmpty()
        is InfiniteRepeatableSpec<*> -> (spec.animation as? TweenSpec<*>)?.let { params(it) }.orEmpty()
        else -> emptyList()
    }

    /** `spec` with the panel's live edits for its call site, applied on the next start. */
    fun <T> withOverrides(spec: AnimationSpec<T>, o: Map<String, Double>?): AnimationSpec<T> {
        if (o.isNullOrEmpty()) return spec
        return when (spec) {
            is TweenSpec<T> -> tweened(spec, o)
            is SpringSpec<T> -> spring(
                dampingRatio = o["dampingRatio"]?.toFloat()?.coerceAtLeast(0.01f) ?: spec.dampingRatio,
                stiffness = o["stiffness"]?.toFloat()?.coerceAtLeast(0.01f) ?: spec.stiffness,
                visibilityThreshold = spec.visibilityThreshold,
            )
            is RepeatableSpec<T> -> (spec.animation as? TweenSpec<T>)?.let {
                repeatable(o["iterationCount"]?.toInt()?.coerceAtLeast(1) ?: spec.iterations, tweened(it, o), spec.repeatMode, spec.initialStartOffset)
            } ?: spec
            is InfiniteRepeatableSpec<T> -> (spec.animation as? TweenSpec<T>)?.let {
                infiniteRepeatable(tweened(it, o), spec.repeatMode, spec.initialStartOffset)
            } ?: spec
            else -> spec
        }
    }

    private fun <T> tweened(spec: TweenSpec<T>, o: Map<String, Double>): TweenSpec<T> = tween(
        durationMillis = o["duration"]?.toInt()?.coerceAtLeast(0) ?: spec.durationMillis,
        delayMillis = o["delay"]?.toInt()?.coerceAtLeast(0) ?: spec.delay,
        easing = spec.easing,
    )

    /** How long it runs from `from` to `to` (delay included), or null when it repeats forever. */
    fun <T, V : AnimationVector> durationMs(spec: AnimationSpec<T>, converter: TwoWayConverter<T, V>, from: T, to: T, velocity: V?): Long? = runCatching {
        val nanos = TargetBasedAnimation(spec, converter, from, to, velocity).durationNanos
        // An infinite spec reports a duration no animation reaches.
        if (nanos >= Long.MAX_VALUE / 4) null else (nanos + 500_000) / 1_000_000
    }.getOrNull()

    /** The value's components as numbers, for samples and keyframe values. */
    fun <T, V : AnimationVector> components(converter: TwoWayConverter<T, V>, value: T): List<Float> = runCatching {
        floats(converter.convertToVector(value)).toList()
    }.getOrDefault(emptyList())

    /** A vector's numbers (its indexed accessors are internal to Compose; the named ones are public). */
    fun floats(v: AnimationVector): FloatArray = when (v) {
        is AnimationVector1D -> floatArrayOf(v.value)
        is AnimationVector2D -> floatArrayOf(v.v1, v.v2)
        is AnimationVector3D -> floatArrayOf(v.v1, v.v2, v.v3)
        is AnimationVector4D -> floatArrayOf(v.v1, v.v2, v.v3, v.v4)
    }

    /** A vector of the same size as `like`, holding `f`. */
    @Suppress("UNCHECKED_CAST")
    fun <V : AnimationVector> vector(like: V, f: FloatArray): V = when (like) {
        is AnimationVector1D -> AnimationVector(f[0])
        is AnimationVector2D -> AnimationVector(f[0], f[1])
        is AnimationVector3D -> AnimationVector(f[0], f[1], f[2])
        is AnimationVector4D -> AnimationVector(f[0], f[1], f[2], f[3])
    } as V
}
