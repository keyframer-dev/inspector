package dev.keyframer.inspector

import android.os.Handler
import android.os.Looper
import android.os.Process
import android.util.Log
import android.view.Choreographer
import dev.keyframer.inspector.core.Cancellable
import dev.keyframer.inspector.core.Clock
import dev.keyframer.inspector.core.FrameLoop
import dev.keyframer.inspector.core.OwnTime
import dev.keyframer.inspector.core.Scheduler
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

internal val mainHandler = Handler(Looper.getMainLooper())

internal fun isMainThread() = Looper.myLooper() == Looper.getMainLooper()

/**
 * The inspector's own work on the main thread (see OwnTime), shared by the session and every entry
 * point of this layer and keyframer-inspector-compose: long frames while recording say how much of
 * them it was.
 */
internal val ownTime = OwnTime()

/** `block`, timed as the inspector's work when it runs on the main thread (the only thread timed). */
internal inline fun <R> timed(block: () -> R): R = if (isMainThread()) ownTime.time(block) else block()

/** On the main thread (now when already there), timed as the inspector's work. */
internal inline fun onMain(crossinline block: () -> Unit) {
    if (isMainThread()) ownTime.time { block() } else mainHandler.post { ownTime.time { block() } }
}

/**
 * Stacks read off the main thread. Taking one is two steps on Android: `Throwable()` records the frames,
 * cheaply (about 6 µs at the depth of a Compose click handler, 65 frames, on an API 35 emulator), and
 * its `stackTrace` makes an element of each, with its class, method, file and line (about 35 µs at that
 * depth, and more with the event's frames made from it). The first is done where the call happens; the
 * second, when nothing needs its answer within the frame, here, and what comes of it goes back to the
 * main thread.
 */
internal object Stacks {
    /** At background priority: what it does can wait, the app's threads cannot. */
    private val worker: ExecutorService by lazy {
        Executors.newSingleThreadExecutor { r ->
            Thread({
                Process.setThreadPriority(Process.THREAD_PRIORITY_BACKGROUND)
                r.run()
            }, "keyframer-stacks").apply { isDaemon = true }
        }
    }

    /**
     * `taken`'s stack, made into what `read` makes of it on the worker, then `then` with that on the main
     * thread (timed as the inspector's work). In order: what is read first comes back first.
     */
    fun <T> read(taken: Throwable, read: (Array<StackTraceElement>) -> T, then: (T) -> Unit) {
        worker.execute {
            val made = try {
                read(taken.stackTrace)
            } catch (e: Throwable) {
                Log.w("Keyframer", "reading a stack: $e")
                return@execute
            }
            mainHandler.post {
                try {
                    ownTime.time { then(made) }
                } catch (e: Throwable) {
                    // The inspector must never break the app.
                    Log.w("Keyframer", "after reading a stack: $e")
                }
            }
        }
    }
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
