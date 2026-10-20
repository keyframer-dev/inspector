@file:OptIn(VitalsExtensionApi::class)

package dev.keyframer.vitals.compose

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.AnimationResult
import androidx.compose.animation.core.AnimationSpec
import androidx.compose.animation.core.AnimationVector
import androidx.compose.animation.core.InfiniteTransition
import androidx.compose.animation.core.Transition
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.updateTransition
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.snapshotFlow
import dev.keyframer.vitals.VitalsExtensionApi
import dev.keyframer.vitals.VitalsExtensions

/**
 * Animatable.animateTo, tracked: a run from the call to its end (finished or interrupted). Named by the
 * Animatable's label (`Animatable(0f, label = "sheet")`), else by where kfAnimateTo is written.
 * `animationSpec` null is the Animatable's own default spring.
 */
suspend fun <T, V : AnimationVector> Animatable<T, V>.kfAnimateTo(
    targetValue: T,
    animationSpec: AnimationSpec<T>? = null,
    initialVelocity: T = velocity,
    block: (Animatable<T, V>.() -> Unit)? = null,
): AnimationResult<T, V> {
    val site = if (VitalsExtensions.measuring) {
        VitalsExtensions.setFramework("Compose")
        VitalsExtensions.site(Throwable().stackTrace, label.unlessDefault("Animatable"), "Animatable.animateTo")
    } else {
        null
    }
    val run = site?.let {
        val estimate = Durations.ms(animationSpec ?: spring(), typeConverter, value, targetValue, typeConverter.convertToVector(initialVelocity))
        VitalsExtensions.start(it, estimate)
    }
    try {
        return if (animationSpec == null) animateTo(targetValue, initialVelocity = initialVelocity, block = block)
        else animateTo(targetValue, animationSpec, initialVelocity, block)
    } finally {
        VitalsExtensions.end(run)
    }
}

/**
 * Compose's updateTransition, tracked: each change of state is a run while the transition runs (all
 * its child animations together). Named by `label`, else by where it is written.
 */
@Composable
fun <S> kfUpdateTransition(targetState: S, label: String? = null): Transition<S> {
    val transition = updateTransition(targetState, label)
    val runs = rememberRuns("updateTransition", label)
    EndOnDispose(runs)
    if (runs != null) {
        LaunchedEffect(runs, transition) {
            snapshotFlow { transition.isRunning }.collect { running ->
                if (running) runs.start(transition.totalDurationNanos / 1e6) else runs.stop()
            }
        }
    }
    return transition
}

/**
 * Compose's rememberInfiniteTransition, tracked: one run for as long as it is in the composition. Like a
 * spinner, it is charged with every frame dropped meanwhile; the dashboard ranks sites by what they
 * add over their screen's baseline, so a constant loop sinks unless it is the problem.
 */
@Composable
fun rememberKfInfiniteTransition(label: String = "InfiniteTransition"): InfiniteTransition {
    val transition = rememberInfiniteTransition(label)
    val runs = rememberRuns("rememberInfiniteTransition", label.unlessDefault("InfiniteTransition"))
    DisposableEffect(runs) {
        runs?.start(null)
        onDispose { runs?.stop() }
    }
    return transition
}
