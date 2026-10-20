package dev.keyframer.inspector.compose

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.AnimationSpec
import androidx.compose.animation.core.AnimationVector
import androidx.compose.animation.core.TwoWayConverter
import androidx.compose.animation.core.VisibilityThreshold
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.animateIntAsState
import androidx.compose.animation.core.animateOffsetAsState
import androidx.compose.animation.core.animateValueAsState
import androidx.compose.animation.core.spring
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.runtime.remember
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp

/* keyframer-inspector-compose's kfAnimate*AsState for release builds: Compose's own functions. */

private val floatSpring = spring<Float>()
private val dpSpring = spring(visibilityThreshold = Dp.VisibilityThreshold)
private val intSpring = spring(visibilityThreshold = Int.VisibilityThreshold)
private val offsetSpring = spring(visibilityThreshold = Offset.VisibilityThreshold)
private val colorSpring = spring<Color>()

@Composable
fun kfAnimateFloatAsState(
    targetValue: Float,
    animationSpec: AnimationSpec<Float> = floatSpring,
    visibilityThreshold: Float = 0.01f,
    label: String = "FloatAnimation",
    finishedListener: ((Float) -> Unit)? = null,
): State<Float> {
    val spec = if (animationSpec === floatSpring) remember(visibilityThreshold) { spring(visibilityThreshold = visibilityThreshold) } else animationSpec
    return animateFloatAsState(targetValue, spec, visibilityThreshold, label, finishedListener)
}

@Composable
fun kfAnimateDpAsState(
    targetValue: Dp,
    animationSpec: AnimationSpec<Dp> = dpSpring,
    label: String = "DpAnimation",
    finishedListener: ((Dp) -> Unit)? = null,
): State<Dp> = animateDpAsState(targetValue, animationSpec, label, finishedListener)

@Composable
fun kfAnimateIntAsState(
    targetValue: Int,
    animationSpec: AnimationSpec<Int> = intSpring,
    label: String = "IntAnimation",
    finishedListener: ((Int) -> Unit)? = null,
): State<Int> = animateIntAsState(targetValue, animationSpec, label, finishedListener)

@Composable
fun kfAnimateOffsetAsState(
    targetValue: Offset,
    animationSpec: AnimationSpec<Offset> = offsetSpring,
    label: String = "OffsetAnimation",
    finishedListener: ((Offset) -> Unit)? = null,
): State<Offset> = animateOffsetAsState(targetValue, animationSpec, label, finishedListener)

@Composable
fun kfAnimateColorAsState(
    targetValue: Color,
    animationSpec: AnimationSpec<Color> = colorSpring,
    label: String = "ColorAnimation",
    finishedListener: ((Color) -> Unit)? = null,
): State<Color> = animateColorAsState(targetValue, animationSpec, label, finishedListener)

@Composable
fun <T, V : AnimationVector> kfAnimateValueAsState(
    targetValue: T,
    typeConverter: TwoWayConverter<T, V>,
    animationSpec: AnimationSpec<T> = remember { spring() },
    visibilityThreshold: T? = null,
    label: String = "ValueAnimation",
    finishedListener: ((T) -> Unit)? = null,
): State<T> = animateValueAsState(targetValue, typeConverter, animationSpec, visibilityThreshold, label, finishedListener)
