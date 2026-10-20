package dev.keyframer.inspector.compose

import androidx.compose.animation.core.InfiniteTransition
import androidx.compose.animation.core.Transition
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.updateTransition
import androidx.compose.runtime.Composable

/* keyframer-inspector-compose's transitions for release builds: Compose's own functions. */

@Composable
fun <S> kfUpdateTransition(targetState: S, label: String? = null): Transition<S> = updateTransition(targetState, label)

@Composable
fun rememberKfInfiniteTransition(label: String = "InfiniteTransition"): InfiniteTransition = rememberInfiniteTransition(label)
