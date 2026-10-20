package dev.keyframer.inspector.compose

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.AnimationResult
import androidx.compose.animation.core.AnimationSpec
import androidx.compose.animation.core.AnimationVector
import androidx.compose.animation.core.AnimationVector1D
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.TwoWayConverter
import androidx.compose.animation.core.VectorConverter
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember

/* keyframer-inspector-compose's Animatable functions for release builds: Compose's own calls. */

@Composable
fun rememberKfAnimatable(
    initialValue: Float,
    label: String = "Animatable",
    visibilityThreshold: Float = Spring.DefaultDisplacementThreshold,
): Animatable<Float, AnimationVector1D> = rememberKfAnimatable(initialValue, Float.VectorConverter, label, visibilityThreshold)

@Composable
fun <T, V : AnimationVector> rememberKfAnimatable(
    initialValue: T,
    typeConverter: TwoWayConverter<T, V>,
    label: String = "Animatable",
    visibilityThreshold: T? = null,
): Animatable<T, V> = remember { Animatable(initialValue, typeConverter, visibilityThreshold, label) }

suspend fun <T, V : AnimationVector> Animatable<T, V>.kfAnimateTo(
    targetValue: T,
    animationSpec: AnimationSpec<T>? = null,
    initialVelocity: T = velocity,
    block: (Animatable<T, V>.() -> Unit)? = null,
): AnimationResult<T, V> =
    if (animationSpec == null) animateTo(targetValue, initialVelocity = initialVelocity, block = block)
    else animateTo(targetValue, animationSpec, initialVelocity, block)
