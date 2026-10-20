package dev.keyframer.inspector.compose

import android.util.Log
import androidx.compose.runtime.MonotonicFrameClock
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.InternalComposeUiApi
import androidx.compose.ui.platform.AndroidUiDispatcher
import androidx.compose.ui.platform.WindowRecomposerFactory
import androidx.compose.ui.platform.WindowRecomposerPolicy
import androidx.compose.ui.platform.createLifecycleAwareWindowRecomposer
import dev.keyframer.inspector.KeyframerExtensionApi
import dev.keyframer.inspector.KeyframerExtensions
import dev.keyframer.inspector.core.TimeClock

/**
 * Installed by Keyframer.start when this module is in the app (it is looked up by name). It names
 * Compose in the hello, and gives every Compose window a frame clock that runs on the inspector's
 * animation time: the editor's slow motion, pause and step then reach every Compose animation
 * (animate*AsState, Animatable, transitions, AnimatedVisibility, flings), tracked or not, without
 * the jumps a duration scale change makes.
 */
@KeyframerExtensionApi
@OptIn(InternalComposeUiApi::class, ExperimentalComposeUiApi::class)
object KeyframerCompose {
    private var factory: WindowRecomposerFactory? = null

    @JvmStatic
    fun install() {
        KeyframerExtensions.setFramework("compose")
        if (factory != null) return
        val default = WindowRecomposerFactory.LifecycleAware
        val ours = WindowRecomposerFactory { view ->
            try {
                val base = AndroidUiDispatcher.CurrentThread
                val clock = base[MonotonicFrameClock] ?: return@WindowRecomposerFactory default.createRecomposer(view)
                view.createLifecycleAwareWindowRecomposer(base + ScaledFrameClock(clock) { KeyframerExtensions.timeClock })
            } catch (e: Throwable) {
                // A Compose version without these internals: windows keep Compose's own clock.
                Log.w("Keyframer", "Compose windows run on their own clock: $e")
                default.createRecomposer(view)
            }
        }
        // Compose has no public way to read the factory in place, so this replaces it: an app that sets
        // its own must do so after Keyframer.start (it then keeps Compose's clock).
        WindowRecomposerPolicy.setFactory(ours)
        factory = ours
    }
}

/**
 * A window's frame clock on the inspector's animation time ([TimeClock]): the real frame time while the
 * speed was never touched, scaled, held or stepped once it was. Never runs backwards.
 */
internal class ScaledFrameClock(private val base: MonotonicFrameClock, private val time: () -> TimeClock?) : MonotonicFrameClock {
    private var last = Long.MIN_VALUE

    override suspend fun <R> withFrameNanos(onFrame: (frameTimeNanos: Long) -> R): R = base.withFrameNanos { real ->
        val clock = time()
        var t = if (clock == null || clock.untouched) real else (clock.frame(real / 1e6) * 1e6).toLong()
        if (t < last) t = last
        last = t
        onFrame(t)
    }
}
