package dev.keyframer.vitals.internal

import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** Frame arithmetic shared by every counter (production.md 1, "Frame counting"). */
internal object FrameMath {
    /**
     * Frames missed by a frame that cost `costMs` against a `budgetMs` deadline: the cost-based rule
     * (FrameMetrics measures work, not gaps), `ceil((cost - 1) / budget) - 1`, never below 0.
     */
    fun missed(costMs: Double, budgetMs: Double): Int {
        if (budgetMs <= 0 || !costMs.isFinite()) return 0
        return max(0, ceil((costMs - 1) / budgetMs).toInt() - 1)
    }

    /** 60, 90, 120 or 144: the rate a frame budget shows, snapped like the inspector's frame meter. */
    fun snapHz(budgetMs: Double): Int {
        val hz = 1000.0 / budgetMs
        return RATES.minByOrNull { kotlin.math.abs(it - hz) } ?: 60
    }

    private val RATES = intArrayOf(30, 60, 90, 120, 144).toList()
}

/** One thread's counters on one screen: `VitalsThreadStats`. */
internal class ThreadStats {
    var frames = 0
    val hist = IntArray(VitalsProtocol.BUCKETS.size)
    var frozen = 0
    var hitchMs = 0.0
    var idleFrames = 0
    var idleMissed = 0

    /** Counts one frame; returns the frames it missed. */
    fun add(costMs: Double, budgetMs: Double, idle: Boolean): Int {
        val missed = FrameMath.missed(costMs, budgetMs)
        frames++
        hist[VitalsProtocol.bucket(missed)]++
        if (costMs >= VitalsProtocol.FROZEN_MS) frozen++
        hitchMs += max(0.0, costMs - budgetMs)
        if (idle) {
            idleFrames++
            idleMissed += missed
        }
        return missed
    }

    fun toWire(): Map<String, Any?> = linkedMapOf(
        "frames" to frames,
        "hist" to hist.toList(),
        "frozen" to frozen,
        "hitchMs" to round1(hitchMs),
        "idleFrames" to idleFrames,
        "idleMissed" to idleMissed,
    )
}

internal fun round1(v: Double): Double = (v * 10).roundToInt() / 10.0

/**
 * One session window's counters: screens, call sites, the worst frames and their causes. Frames arrive
 * from JankStats on its own thread, a little after they were drawn; animation starts, touches, scrolls and
 * navigation arrive on the main thread. So every motion window keeps its start and end, and a frame is
 * matched by time to whatever was open while it was drawn (production.md 1, "Attribution").
 *
 * Times are `System.nanoTime()` nanoseconds (FrameMetrics' clock). Thread-safe: one lock, held briefly.
 */
internal class Recorder {
    private val lock = Any()

    private class Screen(val name: String) {
        var ns = 0L
        val ui = ThreadStats()
        val js = ThreadStats()
    }

    private class SiteStats {
        var runs = 0
        var activeNs = 0L
        var frames = 0
        var missed = 0
        var hitchMs = 0.0
        var worstMs = 0.0
        var runsReduceMotion = 0
        val screenNs = HashMap<Int, Long>()
    }

    /** One run of a tracked animation, from its start to its end (known, or estimated). */
    class Run internal constructor(val site: SiteInfo, val startNs: Long, internal var screen: Int, estimatedEndNs: Long) {
        @Volatile var endNs: Long = estimatedEndNs
            internal set
        @Volatile var ended = false
            internal set
        /** Time already counted in an earlier window (a run that spans a window boundary). */
        internal var countedUntilNs = startNs
    }

    private class Interval(val startNs: Long, var endNs: Long)

    private class Worst(val ms: Double, val missed: Int, val thread: String, val screen: Int, val sites: List<SiteInfo>, val cause: Cause, val afterNavMs: Double?)

    private val screens = ArrayList<Screen>()
    private val screenIndex = HashMap<String, Int>()
    private var current = -1
    private var screenSinceNs = -1L
    private var navAtNs = Long.MIN_VALUE / 2

    private val sites = LinkedHashMap<SiteInfo, SiteStats>()
    private val running = ArrayList<Run>()
    private val recentlyEnded = ArrayList<Run>()
    private val starts = ArrayList<Pair<Long, SiteInfo>>()

    private val touches = ArrayList<Interval>()
    private var touchesDown = 0
    private val scrolls = ArrayList<Interval>()

    private val worst = ArrayList<Worst>()
    private var measuredMs = 0.0
    private var frameCount = 0
    private val hzCounts = HashMap<Int, Int>()

    /** Frames this window counted (both threads see the same frames). */
    val frames: Int get() = synchronized(lock) { frameCount }

    // ---------- events from the main thread ----------

    /** The app shows `name` now (an activity resumed, or setScreen). */
    fun navigate(name: String, nowNs: Long) = synchronized(lock) {
        val idx = screenFor(name)
        if (idx == current) return@synchronized
        closeScreenTime(nowNs)
        current = idx
        screenSinceNs = nowNs
        navAtNs = nowNs
    }

    /** The app went to the background (screen time stops) or came back. */
    fun foreground(visible: Boolean, nowNs: Long) = synchronized(lock) {
        if (visible) {
            if (screenSinceNs < 0) screenSinceNs = nowNs
        } else {
            closeScreenTime(nowNs)
            screenSinceNs = -1
        }
    }

    /**
     * A tracked animation started. `durationMs`: its estimated length (delay and repeats included), null
     * when it runs until stopped. Returns the run, to pass to [animationEnd].
     */
    fun animationStart(site: SiteInfo, nowNs: Long, durationMs: Double?, reduceMotion: Boolean): Run = synchronized(lock) {
        val end = if (durationMs == null || !durationMs.isFinite() || durationMs > 3_600_000) Long.MAX_VALUE else nowNs + (max(0.0, durationMs) * 1e6).toLong()
        screenAtFrame()
        val run = Run(site, nowNs, current, end)
        val s = stats(site)
        s.runs++
        if (reduceMotion) s.runsReduceMotion++
        running.add(run)
        starts.add(nowNs to site)
        prune(nowNs)
        run
    }

    fun animationEnd(run: Run, nowNs: Long) = synchronized(lock) {
        if (run.ended) return@synchronized
        run.ended = true
        run.endNs = min(run.endNs, nowNs)
        running.remove(run)
        recentlyEnded.add(run)
        countActive(run, run.endNs)
        prune(nowNs)
    }

    /** A finger went down (`down`) or the last one came up: a touch window lasts until 1.5 s after it. */
    fun touch(down: Boolean, nowNs: Long) = synchronized(lock) {
        if (down) {
            val last = touches.lastOrNull()
            if (last != null && last.endNs >= nowNs) last.endNs = Long.MAX_VALUE else touches.add(Interval(nowNs, Long.MAX_VALUE))
            touchesDown = 1
        } else if (touchesDown > 0) {
            touchesDown = 0
            touches.lastOrNull()?.endNs = nowNs + TOUCH_TAIL_NS
        }
        prune(nowNs)
    }

    /** Something scrolled: a scroll window, until 250 ms after the last scroll. */
    fun scroll(nowNs: Long) = synchronized(lock) {
        val last = scrolls.lastOrNull()
        if (last != null && last.endNs >= nowNs) last.endNs = nowNs + SCROLL_TAIL_NS else scrolls.add(Interval(nowNs, nowNs + SCROLL_TAIL_NS))
        prune(nowNs)
    }

    // ---------- frames, from JankStats' thread ----------

    /**
     * One frame drawn. `startNs`: its intended vsync; `totalMs`: the whole frame as shown (main thread and
     * RenderThread, and the GPU on Android 12+); `mainMs`: the main thread's share; `budgetMs`: its
     * deadline (FrameMetrics.DEADLINE on Android 12+, else the display's refresh interval).
     */
    fun frame(startNs: Long, mainMs: Double, totalMs: Double, budgetMs: Double) = synchronized(lock) {
        if (budgetMs <= 0 || totalMs < 0) return@synchronized
        val endNs = startNs + (totalMs * 1e6).toLong()
        val active = activeSites(startNs, endNs)
        val idle = active.isEmpty()
        val screen = screenAtFrame()
        val missed = screen.ui.add(totalMs, budgetMs, idle)
        screen.js.add(mainMs, budgetMs, idle)
        frameCount++
        measuredMs += max(totalMs, budgetMs)
        val hz = FrameMath.snapHz(budgetMs)
        hzCounts[hz] = (hzCounts[hz] ?: 0) + 1
        for (site in active) {
            val s = stats(site)
            s.frames++
            s.missed += missed
            s.hitchMs += max(0.0, totalMs - budgetMs)
            s.worstMs = max(s.worstMs, totalMs)
        }
        if (missed > 0) considerWorst(startNs, endNs, totalMs, mainMs, budgetMs, missed, active)
    }

    private fun considerWorst(startNs: Long, endNs: Long, totalMs: Double, mainMs: Double, budgetMs: Double, missed: Int, active: List<SiteInfo>) {
        if (worst.size >= VitalsProtocol.WORST && worst.last().ms >= totalMs) return
        var cause = Cause.UNKNOWN
        var afterNav: Double? = null
        val sinceNav = endNs - navAtNs
        val startedNear = starts.filter { it.first >= startNs - BURST_LEAD_NS && it.first <= endNs }.map { it.second }.toSet()
        when {
            sinceNav in 0..SCREEN_MOUNT_NS -> {
                cause = Cause.SCREEN_MOUNT
                afterNav = round1(sinceNav / 1e6)
            }
            startedNear.size >= BURST_SITES -> cause = Cause.BURST
            startedNear.isEmpty() && open(scrolls, startNs, endNs) -> cause = Cause.SCROLL
            startedNear.isEmpty() && open(touches, startNs, endNs) -> cause = Cause.GESTURE
        }
        // The main thread blew the budget on its own: the app thread's frame. Otherwise the frame as drawn.
        val thread = if (mainMs >= budgetMs) "js" else "ui"
        worst.add(Worst(round1(totalMs), missed, thread, max(current, 0), active, cause, afterNav))
        worst.sortByDescending { it.ms }
        while (worst.size > VitalsProtocol.WORST) worst.removeAt(worst.size - 1)
    }

    private fun open(intervals: List<Interval>, startNs: Long, endNs: Long) = intervals.any { it.startNs <= endNs && it.endNs >= startNs }

    private fun activeSites(startNs: Long, endNs: Long): List<SiteInfo> {
        if (running.isEmpty() && recentlyEnded.isEmpty()) return emptyList()
        val out = LinkedHashSet<SiteInfo>()
        // Overlapping the frame's time, strictly: a run that starts as a frame ends is not in it.
        for (r in running) if (r.startNs < endNs && r.endNs > startNs) out.add(r.site)
        for (r in recentlyEnded) if (r.startNs < endNs && r.endNs > startNs) out.add(r.site)
        return out.toList()
    }

    private fun screenAtFrame(): Screen {
        if (current < 0) current = screenFor(UNKNOWN_SCREEN)
        return screens[current]
    }

    private fun screenFor(rawName: String): Int {
        screenIndex[rawName]?.let { return it }
        if (screens.size >= VitalsProtocol.MAX_SCREENS - 1 && rawName != OTHER_SCREENS) return screenFor(OTHER_SCREENS)
        screens.add(Screen(rawName))
        screenIndex[rawName] = screens.size - 1
        return screens.size - 1
    }

    private fun closeScreenTime(nowNs: Long) {
        if (current >= 0 && screenSinceNs >= 0 && nowNs > screenSinceNs) screens[current].ns += nowNs - screenSinceNs
        screenSinceNs = if (screenSinceNs >= 0) nowNs else -1
    }

    private fun stats(site: SiteInfo): SiteStats = sites.getOrPut(site) { SiteStats() }

    /** Adds a run's time since it was last counted, up to `untilNs`, to its site. */
    private fun countActive(run: Run, untilNs: Long) {
        val until = min(untilNs, run.endNs)
        if (until <= run.countedUntilNs) return
        val s = stats(run.site)
        val d = until - run.countedUntilNs
        s.activeNs += d
        s.screenNs[run.screen] = (s.screenNs[run.screen] ?: 0L) + d
        run.countedUntilNs = until
    }

    private fun prune(nowNs: Long) {
        val horizon = nowNs - KEEP_NS
        recentlyEnded.removeAll { it.endNs < horizon }
        starts.removeAll { it.first < horizon }
        touches.removeAll { it.endNs < horizon }
        scrolls.removeAll { it.endNs < horizon }
        // A run past its estimated end without an end callback (a Compose value whose finish was never
        // reported) is over: keep it for late frames, then let it go.
        val over = running.filter { it.endNs < horizon }
        for (r in over) {
            running.remove(r)
            countActive(r, r.endNs)
        }
    }

    // ---------- the window ----------

    /** What the window holds for the report: `screens`, `sites`, `worst`, and the totals the header needs. */
    class Snapshot(
        val screens: List<Map<String, Any?>>,
        val sites: List<Map<String, Any?>>,
        val worst: List<Map<String, Any?>>,
        val measuredMs: Double,
        val frames: Int,
        val targetHz: Int?,
    )

    /**
     * The window so far, without changing it (a checkpoint), or closing it (`reset`): counters start
     * again, while animations still running carry on into the next window.
     */
    fun snapshot(nowNs: Long, reset: Boolean): Snapshot = synchronized(lock) {
        for (r in running) countActive(r, nowNs)
        // Screen time up to now, without moving the screen's clock when only peeking.
        val screenNs = LongArray(screens.size) { screens[it].ns }
        if (current >= 0 && screenSinceNs in 0 until nowNs) screenNs[current] += nowNs - screenSinceNs

        // At most 200 sites: the ones that drew or missed the most frames stay.
        val chosen = sites.entries.sortedByDescending { it.value.frames + it.value.missed }.take(VitalsProtocol.MAX_SITES)
        val order = sites.keys.filter { k -> chosen.any { it.key == k } }
        val index = HashMap<SiteInfo, Int>()
        val siteList = order.mapIndexed { i, site ->
            index[site] = i
            val s = sites.getValue(site)
            val m = linkedMapOf<String, Any?>("ref" to site.ref.toWire())
            site.key?.let { m["key"] = it }
            m["fn"] = site.fn
            m["component"] = site.component
            m["prop"] = site.prop
            m["screen"] = s.screenNs.maxByOrNull { it.value }?.key ?: 0
            m["runs"] = s.runs
            m["activeMs"] = Math.round(s.activeNs / 1e6)
            m["frames"] = s.frames
            m["missed"] = s.missed
            m["hitchMs"] = round1(s.hitchMs)
            m["worstMs"] = round1(s.worstMs)
            if (s.runsReduceMotion > 0) m["runsReduceMotion"] = s.runsReduceMotion
            m
        }
        val worstList = worst.map { w ->
            linkedMapOf<String, Any?>(
                "thread" to w.thread,
                "ms" to w.ms,
                "missed" to w.missed,
                "screen" to w.screen,
                "sites" to w.sites.mapNotNull { index[it] },
                "cause" to w.cause.wire,
            ).apply { w.afterNavMs?.let { put("afterNavMs", it) } }
        }
        val screenList = screens.mapIndexed { i, s ->
            val threads = LinkedHashMap<String, Any?>()
            if (s.ui.frames > 0) threads["ui"] = s.ui.toWire()
            if (s.js.frames > 0) threads["js"] = s.js.toWire()
            linkedMapOf<String, Any?>("name" to s.name, "ms" to Math.round(screenNs[i] / 1e6), "threads" to threads)
        }
        val target = hzCounts.maxByOrNull { it.value }?.key
        val snap = Snapshot(screenList, siteList, worstList, round1(measuredMs), frameCount, target)
        if (reset) clearWindow(nowNs)
        snap
    }

    /** Drops the window's counters (a new window, or setEnabled(false)). Running animations carry on. */
    private fun clearWindow(nowNs: Long) {
        val keepScreen = current.takeIf { it >= 0 }?.let { screens[it].name }
        screens.clear()
        screenIndex.clear()
        current = -1
        if (keepScreen != null) {
            current = screenFor(keepScreen)
            if (screenSinceNs >= 0) screenSinceNs = nowNs
        }
        sites.clear()
        // Runs still going count in the next window too, from here on, and as a run there.
        val carried = running.toList()
        running.clear()
        recentlyEnded.clear()
        for (r in carried) {
            r.countedUntilNs = nowNs
            r.screen = screenAtFrame().let { current }
            running.add(r)
            stats(r.site).runs++
        }
        worst.clear()
        measuredMs = 0.0
        frameCount = 0
        hzCounts.clear()
    }

    fun clear(nowNs: Long) = synchronized(lock) { clearWindow(nowNs) }

    companion object {
        const val UNKNOWN_SCREEN = "(unknown)"
        const val OTHER_SCREENS = "(other)"
        const val TOUCH_TAIL_NS = 1_500_000_000L
        const val SCROLL_TAIL_NS = 250_000_000L
        const val SCREEN_MOUNT_NS = 500_000_000L
        const val BURST_LEAD_NS = 50_000_000L
        const val BURST_SITES = 6
        /** How long finished runs and input windows are kept for frames that arrive late. */
        const val KEEP_NS = 2_000_000_000L
    }
}
