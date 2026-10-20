package dev.keyframer.inspector.compose

import androidx.compose.animation.VectorConverter
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.AnimationSpec
import androidx.compose.animation.core.AnimationVector
import androidx.compose.animation.core.SpringSpec
import androidx.compose.animation.core.TwoWayConverter
import androidx.compose.animation.core.VectorConverter
import androidx.compose.animation.core.VisibilityThreshold
import androidx.compose.animation.core.spring
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.Dp
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch

/*
 * animate*AsState that the inspector sees: the same parameters and behaviour as Compose's, plus an
 * `anim` event on every start (its spec, from and to, how long it runs, where it is written) and the
 * value as a signal that is recorded, played back and captured. The panel's live edits to the spec
 * (duration, delay, damping ratio, stiffness) apply on the next start.
 *
 * Swap `animateFloatAsState` for `kfAnimateFloatAsState`; release builds link the no-op module, whose
 * functions are Compose's own. `label` names the value in the panel (Compose's default labels are left
 * out).
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
    return trackedValueAsState(targetValue, Float.VectorConverter, spec, visibilityThreshold, label.unlessDefault("FloatAnimation"), finishedListener, "animateFloatAsState", null)
}

/** Compose's animateDpAsState, tracked. */
@Composable
fun kfAnimateDpAsState(
    targetValue: Dp,
    animationSpec: AnimationSpec<Dp> = dpSpring,
    label: String = "DpAnimation",
    finishedListener: ((Dp) -> Unit)? = null,
): State<Dp> = trackedValueAsState(targetValue, Dp.VectorConverter, animationSpec, null, label.unlessDefault("DpAnimation"), finishedListener, "animateDpAsState", null)

/** Compose's animateIntAsState, tracked. */
@Composable
fun kfAnimateIntAsState(
    targetValue: Int,
    animationSpec: AnimationSpec<Int> = intSpring,
    label: String = "IntAnimation",
    finishedListener: ((Int) -> Unit)? = null,
): State<Int> = trackedValueAsState(targetValue, Int.VectorConverter, animationSpec, null, label.unlessDefault("IntAnimation"), finishedListener, "animateIntAsState", null)

/** Compose's animateOffsetAsState, tracked: x and y are two signals. */
@Composable
fun kfAnimateOffsetAsState(
    targetValue: Offset,
    animationSpec: AnimationSpec<Offset> = offsetSpring,
    label: String = "OffsetAnimation",
    finishedListener: ((Offset) -> Unit)? = null,
): State<Offset> = trackedValueAsState(targetValue, Offset.VectorConverter, animationSpec, null, label.unlessDefault("OffsetAnimation"), finishedListener, "animateOffsetAsState", listOf("x", "y"))

/** Compose's animateColorAsState, tracked: alpha and the Oklab components Compose animates in. */
@Composable
fun kfAnimateColorAsState(
    targetValue: Color,
    animationSpec: AnimationSpec<Color> = colorSpring,
    label: String = "ColorAnimation",
    finishedListener: ((Color) -> Unit)? = null,
): State<Color> {
    val converter = remember(targetValue.colorSpace) { (Color.VectorConverter)(targetValue.colorSpace) }
    return trackedValueAsState(targetValue, converter, animationSpec, null, label.unlessDefault("ColorAnimation"), finishedListener, "animateColorAsState", listOf("alpha", "l", "a", "b"))
}

/** Compose's animateValueAsState, tracked: one signal per component of the converter's vector. */
@Composable
fun <T, V : AnimationVector> kfAnimateValueAsState(
    targetValue: T,
    typeConverter: TwoWayConverter<T, V>,
    animationSpec: AnimationSpec<T> = remember { spring() },
    visibilityThreshold: T? = null,
    label: String = "ValueAnimation",
    finishedListener: ((T) -> Unit)? = null,
): State<T> = trackedValueAsState(targetValue, typeConverter, animationSpec, visibilityThreshold, label.unlessDefault("ValueAnimation"), finishedListener, "animateValueAsState", null)

private fun String.unlessDefault(default: String): String? = takeIf { it != default && it.isNotEmpty() }

/**
 * Compose's animateValueAsState (an Animatable fed the latest target through a conflated channel),
 * with the start reported and the value tracked. Written out rather than wrapped so playback can write
 * the value (snapTo) and each start is seen as it happens.
 */
@Composable
internal fun <T, V : AnimationVector> trackedValueAsState(
    targetValue: T,
    typeConverter: TwoWayConverter<T, V>,
    animationSpec: AnimationSpec<T>,
    visibilityThreshold: T?,
    label: String?,
    finishedListener: ((T) -> Unit)?,
    fn: String,
    components: List<String>?,
): State<T> {
    val animatable = remember { Animatable(targetValue, typeConverter, visibilityThreshold, label ?: fn) }
    val listener by rememberUpdatedState(finishedListener)
    val animSpec: AnimationSpec<T> by rememberUpdatedState(
        animationSpec.run {
            if (visibilityThreshold != null && this is SpringSpec && this.visibilityThreshold != visibilityThreshold) {
                spring(dampingRatio, stiffness, visibilityThreshold)
            } else {
                this
            }
        },
    )
    val latest by rememberUpdatedState(targetValue)
    val channel = remember { Channel<T>(Channel.CONFLATED) }
    val tracker = rememberValueTracker(fn, label, animatable, components)
    SideEffect {
        channel.trySend(targetValue)
    }
    if (tracker != null) {
        // Let go after playback: back to wherever the app's state says.
        SideEffect { tracker.onRelease = { channel.trySend(latest) } }
    }
    LaunchedEffect(channel) {
        for (target in channel) {
            // Two targets before this resumes: only the newest counts (Compose does the same).
            val newTarget = channel.tryReceive().getOrNull() ?: target
            launch {
                if (tracker?.held == true) return@launch
                if (newTarget != animatable.targetValue) {
                    val spec = tracker?.started(newTarget, animSpec) ?: animSpec
                    animatable.animateTo(newTarget, spec)
                    listener?.invoke(animatable.value)
                }
            }
        }
    }
    return animatable.asState()
}

/** The tracker for an Animatable in this composition, or null when the inspector is not running. */
@Composable
internal fun <T, V : AnimationVector> rememberValueTracker(fn: String, label: String?, animatable: Animatable<T, V>, components: List<String>?): ValueTracker<T, V>? {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val tracker = remember(animatable) {
        val stack = Throwable().stackTrace
        locate(stack)?.let { ValueTracker(it, stack, fn, label, animatable, components, scope).also { t -> t.ownedBy(context) } }
    }
    DisposableEffect(tracker) {
        tracker?.attach()
        onDispose { tracker?.detach() }
    }
    return tracker
}
