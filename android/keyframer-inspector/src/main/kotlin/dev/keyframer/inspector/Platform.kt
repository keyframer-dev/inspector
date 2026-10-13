package dev.keyframer.inspector

import android.os.Handler
import android.os.Looper
import android.view.Choreographer
import dev.keyframer.inspector.core.Cancellable
import dev.keyframer.inspector.core.Clock
import dev.keyframer.inspector.core.FrameLoop
import dev.keyframer.inspector.core.Scheduler

internal val mainHandler = Handler(Looper.getMainLooper())

internal fun isMainThread() = Looper.myLooper() == Looper.getMainLooper()

internal inline fun onMain(crossinline block: () -> Unit) {
    if (isMainThread()) block() else mainHandler.post { block() }
}

internal object MainScheduler : Scheduler {
    override fun post(delayMs: Long, block: () -> Unit): Cancellable {
        val r = Runnable(block)
        mainHandler.postDelayed(r, delayMs)
        return Cancellable { mainHandler.removeCallbacks(r) }
    }
}

/**
 * System.nanoTime is CLOCK_MONOTONIC on Android: the timebase of Choreographer's frame times and of
 * MotionEvent.getEventTime (SystemClock.uptimeMillis), so frames, samples and touches share one clock.
 */
internal object AndroidClock : Clock {
    override fun nowMs() = System.nanoTime() / 1e6
    override fun wallMs() = System.currentTimeMillis()
}

/**
 * Choreographer drives the frame loop. `onFrame` runs in the frame's animation phase, so values played
 * back there are drawn in that frame. `afterFrame` runs as the first message after the frame (animators,
 * layout and draw are done), so values sampled there are the ones that frame showed, whichever order
 * Choreographer ran its animation callbacks in.
 */
internal object ChoreographerFrames : FrameLoop {
    override fun start(onFrame: (Double) -> Unit, afterFrame: (Double) -> Unit): Cancellable {
        var running = true
        val choreographer = Choreographer.getInstance()
        val callback = object : Choreographer.FrameCallback {
            override fun doFrame(frameTimeNanos: Long) {
                if (!running) return
                val vsync = frameTimeNanos / 1e6
                onFrame(vsync)
                mainHandler.postAtFrontOfQueue { if (running) afterFrame(vsync) }
                if (running) choreographer.postFrameCallback(this)
            }
        }
        choreographer.postFrameCallback(callback)
        return Cancellable {
            running = false
            choreographer.removeFrameCallback(callback)
        }
    }
}
