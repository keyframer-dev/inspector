@file:OptIn(VitalsExtensionApi::class)

package dev.keyframer.vitals.compose

import androidx.compose.animation.core.AnimationSpec
import androidx.compose.animation.core.AnimationVector
import androidx.compose.animation.core.TargetBasedAnimation
import androidx.compose.animation.core.TwoWayConverter
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import dev.keyframer.vitals.VitalsExtensionApi
import dev.keyframer.vitals.VitalsExtensions
import dev.keyframer.vitals.VitalsRun
import dev.keyframer.vitals.VitalsSite

/*
 * How tracked Compose animations reach Motion Vitals. Each tracked call finds its call site once, from
 * the stack of its first composition (the composable that called it), and reports a run from each
 * start to its end (or its estimated end), so the frames drawn meanwhile count against it.
 */

/** One tracked call's runs: one at a time, a new start ends the one before. Main thread. */
internal class Runs(private val start: (Double?) -> Any?, private val end: (Any?) -> Unit) {
    private var current: Any? = null
    var started = 0
        private set

    fun start(durationMs: Double?) {
        stop()
        current = start.invoke(durationMs)
        started++
    }

    fun stop() {
        val c = current ?: return
        current = null
        end(c)
    }

    companion object {
        fun of(site: VitalsSite) = Runs({ VitalsExtensions.start(site, it) }, { VitalsExtensions.end(it as VitalsRun?) })
    }
}

/** Starts a run when the target changes after the first composition: `animate*AsState`'s rule. */
internal class TargetChanges<T>(initial: T, private val runs: Runs) {
    private var last: T = initial

    /** Called after each composition with the target it used. */
    fun committed(target: T, durationMs: () -> Double?) {
        if (target == last) return
        last = target
        runs.start(durationMs())
    }

    fun finished() = runs.stop()
}

/** The call's site, found on its first composition (null before start, or with no app frame). */
@Composable
internal fun rememberRuns(fn: String, name: String?, prop: String? = null): Runs? = remember {
    if (!VitalsExtensions.started) return@remember null
    VitalsExtensions.setFramework("Compose")
    VitalsExtensions.site(Throwable().stackTrace, name, fn, prop)?.let { Runs.of(it) }
}

/** Ends the call's run when it leaves the composition. */
@Composable
internal fun EndOnDispose(runs: Runs?) {
    DisposableEffect(runs) { onDispose { runs?.stop() } }
}

internal object Durations {
    /** How long an animation runs from `from` to `to` (delay included), or null when it repeats forever. */
    fun <T, V : AnimationVector> ms(spec: AnimationSpec<T>, converter: TwoWayConverter<T, V>, from: T, to: T, velocity: V? = null): Double? = runCatching {
        val nanos = TargetBasedAnimation(spec, converter, from, to, velocity).durationNanos
        // An infinite spec reports a duration no animation reaches.
        if (nanos >= Long.MAX_VALUE / 4) null else nanos / 1e6
    }.getOrNull()
}

/** A label Compose gives by default names nothing. */
internal fun String?.unlessDefault(default: String): String? = this?.takeIf { it != default && it.isNotBlank() }
