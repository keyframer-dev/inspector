package dev.keyframer.inspector.compose

import androidx.compose.animation.core.InfiniteTransition
import androidx.compose.animation.core.Transition
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.updateTransition
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext

/**
 * Compose's updateTransition, tracked: each change of state is an `anim` event (from, to, every child
 * animation's spec, the total duration), the transition's play time is a signal, and so is each child
 * made on it with Compose's own `animateFloat`, `animateDp`, `animateColor` and the like (by its label).
 * Children are read only: playback shows them through the recording, not by seeking the transition.
 */
@Composable
fun <S> kfUpdateTransition(targetState: S, label: String? = null): Transition<S> {
    val transition = updateTransition(targetState, label)
    val context = LocalContext.current
    val tracker = remember(transition) {
        val stack = Throwable().stackTrace
        locate(stack)?.let { TransitionTracker(it, stack, label, transition).also { t -> t.ownedBy(context) } }
    }
    DisposableEffect(tracker) {
        tracker?.attach()
        onDispose { tracker?.detach() }
    }
    if (tracker != null) {
        // The children compose after this call; their effects have run by the time side effects do.
        SideEffect { tracker.syncChildren() }
        LaunchedEffect(tracker, targetState) { tracker.targetChanged() }
    }
    return transition
}

/**
 * Compose's rememberInfiniteTransition, tracked: each child made on it (animateFloat, animateColor, by
 * its label) is a signal and is reported once, when it starts, with its spec.
 */
@Composable
fun rememberKfInfiniteTransition(label: String = "InfiniteTransition"): InfiniteTransition {
    val transition = rememberInfiniteTransition(label)
    val context = LocalContext.current
    val tracker = remember(transition) {
        val stack = Throwable().stackTrace
        locate(stack)?.let { InfiniteTracker(it, stack, label.takeIf { l -> l != "InfiniteTransition" }, transition).also { t -> t.ownedBy(context) } }
    }
    DisposableEffect(tracker) {
        tracker?.attach()
        onDispose { tracker?.detach() }
    }
    if (tracker != null) SideEffect { tracker.syncChildren() }
    return transition
}
