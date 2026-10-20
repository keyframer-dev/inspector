package dev.keyframer.vitals.compose

import androidx.compose.animation.VectorConverter
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.AnimationSpec
import androidx.compose.animation.core.AnimationVector
import androidx.compose.animation.core.TwoWayConverter
import androidx.compose.animation.core.VectorConverter
import androidx.compose.animation.core.VisibilityThreshold
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.animateIntAsState
import androidx.compose.animation.core.animateOffsetAsState
import androidx.compose.animation.core.animateValueAsState
import androidx.compose.animation.core.spring
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.remember
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp

/*
 * animate*AsState that Motion Vitals sees: Compose's own call with the same parameters, plus a run from
 * each change of target to the animation's end, so the frames drawn meanwhile count against it. The
 * label names it in the dashboard (`kfAnimateFloatAsState(scale, label = "cart-badge")`); without one,
 * the call site does (where it is written, named from the R8 mapping in minified builds).
 *
 * The same names as the inspector's dev.keyframer.inspector.compose helpers: swap `animateFloatAsState`
 * for `kfAnimateFloatAsState` and import the one the build needs.
 */

private val floatSpring = spring<Float>()
private val dpSpring = spring(visibilityThreshold = Dp.VisibilityThreshold)
private val intSpring = spring(visibilityThreshold = Int.VisibilityThreshold)
private val offsetSpring = spring(visibilityThreshold = Offset.VisibilityThreshold)
private val colorSpring = spring<Color>()

/** Compose's animateFloatAsState, tracked. */
@Composable
fun kfAnimateFloatAsState(
    targetValue: Float,
    animationSpec: AnimationSpec<Float> = floatSpring,
    visibilityThreshold: Float = 0.01f,
    label: String = "FloatAnimation",
    finishedListener: ((Float) -> Unit)? = null,
): State<Float> {
    val spec = if (animationSpec === floatSpring) remember(visibilityThreshold) { spring(visibilityThreshold = visibilityThreshold) } else animationSpec
    val changes = rememberChanges(targetValue, "animateFloatAsState", label.unlessDefault("FloatAnimation"))
    val state = animateFloatAsState(targetValue, spec, visibilityThreshold, label) { v ->
        changes?.finished()
        finishedListener?.invoke(v)
    }
    Committed(changes, targetValue, spec, Float.VectorConverter, state)
    return state
}

/** Compose's animateDpAsState, tracked. */
@Composable
fun kfAnimateDpAsState(
    targetValue: Dp,
    animationSpec: AnimationSpec<Dp> = dpSpring,
    label: String = "DpAnimation",
    finishedListener: ((Dp) -> Unit)? = null,
): State<Dp> {
    val changes = rememberChanges(targetValue, "animateDpAsState", label.unlessDefault("DpAnimation"))
    val state = animateDpAsState(targetValue, animationSpec, label) { v ->
        changes?.finished()
        finishedListener?.invoke(v)
    }
    Committed(changes, targetValue, animationSpec, Dp.VectorConverter, state)
    return state
}

/** Compose's animateIntAsState, tracked. */
@Composable
fun kfAnimateIntAsState(
    targetValue: Int,
    animationSpec: AnimationSpec<Int> = intSpring,
    label: String = "IntAnimation",
    finishedListener: ((Int) -> Unit)? = null,
): State<Int> {
    val changes = rememberChanges(targetValue, "animateIntAsState", label.unlessDefault("IntAnimation"))
    val state = animateIntAsState(targetValue, animationSpec, label) { v ->
        changes?.finished()
        finishedListener?.invoke(v)
    }
    Committed(changes, targetValue, animationSpec, Int.VectorConverter, state)
    return state
}

/** Compose's animateOffsetAsState, tracked. */
@Composable
fun kfAnimateOffsetAsState(
    targetValue: Offset,
    animationSpec: AnimationSpec<Offset> = offsetSpring,
    label: String = "OffsetAnimation",
    finishedListener: ((Offset) -> Unit)? = null,
): State<Offset> {
    val changes = rememberChanges(targetValue, "animateOffsetAsState", label.unlessDefault("OffsetAnimation"))
    val state = animateOffsetAsState(targetValue, animationSpec, label) { v ->
        changes?.finished()
        finishedListener?.invoke(v)
    }
    Committed(changes, targetValue, animationSpec, Offset.VectorConverter, state)
    return state
}

/** Compose's animateColorAsState, tracked. */
@Composable
fun kfAnimateColorAsState(
    targetValue: Color,
    animationSpec: AnimationSpec<Color> = colorSpring,
    label: String = "ColorAnimation",
    finishedListener: ((Color) -> Unit)? = null,
): State<Color> {
    val changes = rememberChanges(targetValue, "animateColorAsState", label.unlessDefault("ColorAnimation"))
    val state = animateColorAsState(targetValue, animationSpec, label) { v ->
        changes?.finished()
        finishedListener?.invoke(v)
    }
    val converter = remember(targetValue.colorSpace) { (Color.VectorConverter)(targetValue.colorSpace) }
    Committed(changes, targetValue, animationSpec, converter, state)
    return state
}

/** Compose's animateValueAsState, tracked. */
@Composable
fun <T, V : AnimationVector> kfAnimateValueAsState(
    targetValue: T,
    typeConverter: TwoWayConverter<T, V>,
    animationSpec: AnimationSpec<T> = remember { spring() },
    visibilityThreshold: T? = null,
    label: String = "ValueAnimation",
    finishedListener: ((T) -> Unit)? = null,
): State<T> {
    val changes = rememberChanges(targetValue, "animateValueAsState", label.unlessDefault("ValueAnimation"))
    val state = animateValueAsState(targetValue, typeConverter, animationSpec, visibilityThreshold, label) { v ->
        changes?.finished()
        finishedListener?.invoke(v)
    }
    Committed(changes, targetValue, animationSpec, typeConverter, state)
    return state
}

@Composable
private fun <T> rememberChanges(target: T, fn: String, name: String?): TargetChanges<T>? {
    val runs = rememberRuns(fn, name)
    EndOnDispose(runs)
    return remember(runs) { runs?.let { TargetChanges(target, it) } }
}

/** After each composition: a new target starts a run, as long as the spec takes from where the value is now. */
@Composable
private fun <T, V : AnimationVector> Committed(changes: TargetChanges<T>?, target: T, spec: AnimationSpec<T>, converter: TwoWayConverter<T, V>, state: State<T>) {
    if (changes == null) return
    SideEffect { changes.committed(target) { Durations.ms(spec, converter, state.value, target) } }
}
