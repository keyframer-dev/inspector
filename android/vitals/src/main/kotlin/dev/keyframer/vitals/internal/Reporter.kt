package dev.keyframer.vitals.internal

import java.util.concurrent.Executor

internal interface Clock {
    /** Monotonic, counting deep sleep: session gaps and window time. */
    fun elapsedMs(): Long
    /** FrameMetrics' clock: animation starts and touches are matched to frames with it. */
    fun nanos(): Long
    /** Wall time: only for the 7-day limits and config age, kept on the device, never sent. */
    fun wallMs(): Long
    /** The local date, for the 3 sessions a day count. */
    fun day(): String
}

/** Delayed work on the main thread. */
internal fun interface Scheduler {
    fun post(delayMs: Long, task: () -> Unit): () -> Unit
}

/** What the reporter reads from the device; an interface so tests run without one. */
internal interface DeviceProbe {
    fun device(collectModel: Boolean): DeviceInfo
    fun display(): Pair<Int, Boolean?>
    fun powerSave(): Boolean
    fun thermal(): Int
    fun animationsOff(): Boolean
    fun dataSaver(): Boolean
}

internal class ReporterOptions(
    val key: String,
    val endpoint: String,
    val sdkVersion: String,
    /** The app's sample rate, used until the project's config arrives. */
    val sampleRate: Double,
    /** null: this build does not report (a debuggable build without `environment`). */
    val environment: String?,
    val app: AppInfo,
)

/**
 * The reporter's logic, apart from Android's callbacks (AndroidHooks feeds it): sessions, sampling,
 * windows, checkpoints, uploads, retries, config and the kill switch (production.md 2.1). Main thread,
 * except [frame] (JankStats' thread, straight into the locked Recorder) and the IO executor.
 */
internal class Reporter(
    private val options: ReporterOptions,
    private val clock: Clock,
    prefs: KeyValue,
    private val store: RetryStore,
    transport: Transport,
    private val io: Executor,
    private val scheduler: Scheduler,
    private val probe: DeviceProbe,
) {
    val configs = ConfigStore(prefs, options.sdkVersion)
    private val uploader = Uploader(options.endpoint, options.key, transport, configs, options.sdkVersion)
    val sessions = Sessions(prefs)
    val recorder = Recorder()
    private val state = WindowState()

    @Volatile var enabled = true
        private set
    @Volatile private var foreground = false
    /** Frames and animations are counted: a sampled session, allowed to report. */
    @Volatile var measuring = false
        private set
    /** AndroidHooks turns JankStats on and off with this. */
    var onMeasuring: (Boolean) -> Unit = {}
    /** The UI framework label of reports: "Views", or "Compose" once a Compose helper ran. */
    @Volatile var framework: String? = options.app.framework

    private var cancelTick: (() -> Unit)? = null
    private var cancelRetry: (() -> Unit)? = null
    private var retryStep = 0
    private var flushWhenForeground = false
    private var screenName: String? = null
    private var displayHz = 60
    private var adaptive: Boolean? = null

    /** start(): last launch's checkpoint joins the pending reports; sending and the config wait 10 s. */
    fun launch() {
        val now = clock.wallMs()
        if (!reportable(now)) {
            if (configs.killed(now)) io.execute { store.clear() }
            scheduleConfigFetch()
            return
        }
        io.execute { store.adoptCheckpoint(clock.wallMs()) }
        retryStep = 0
        scheduleRetry(RETRY_DELAYS_MS[0])
        scheduleConfigFetch()
    }

    private fun reportable(nowWallMs: Long): Boolean {
        if (!enabled || options.environment == null) return false
        if (!configs.allowed(nowWallMs)) return false
        if (options.environment == "development" && configs.current()?.collectDevelopment == false) return false
        return true
    }

    private fun sampleRate(): Double = configs.current()?.sampleRate ?: options.sampleRate

    // ---------- lifecycle ----------

    fun onForeground() {
        foreground = true
        if (!enabled) return
        val fresh = sessions.foreground(clock.elapsedMs(), clock.day(), sampleRate())
        if (fresh) {
            recorder.clear(clock.nanos())
            state.reset()
        }
        setMeasuring(sessions.sampled && reportable(clock.wallMs()))
        recorder.foreground(true, clock.nanos())
        screenName?.let { recorder.navigate(it, clock.nanos()) }
        if (measuring) {
            readState()
            scheduleTick()
        }
        if (flushWhenForeground) {
            flushWhenForeground = false
            scheduleRetry(RETRY_DELAYS_MS[0])
        }
    }

    fun onBackground() {
        foreground = false
        cancelTick?.invoke()
        cancelTick = null
        recorder.foreground(false, clock.nanos())
        sessions.background(clock.elapsedMs())
        if (measuring) closeWindow("background", send = true)
    }

    fun setEnabled(on: Boolean) {
        if (on == enabled) return
        enabled = on
        if (!on) {
            setMeasuring(false)
            cancelTick?.invoke()
            cancelTick = null
            cancelRetry?.invoke()
            cancelRetry = null
            sessions.end()
            recorder.clear(clock.nanos())
            state.reset()
            io.execute { store.clear() }
        } else {
            launch()
            if (foreground) onForeground()
        }
    }

    // ---------- what happens in the app ----------

    fun navigate(name: String) {
        screenName = name
        if (measuring) recorder.navigate(name, clock.nanos())
    }

    fun animationStart(site: SiteInfo, durationMs: Double?): Recorder.Run? {
        if (!measuring) return null
        val reduce = configs.current()?.collectReduceMotion == true && probe.animationsOff()
        if (reduce) state.reduceMotion = true
        return recorder.animationStart(site, clock.nanos(), durationMs, reduce)
    }

    fun animationEnd(run: Recorder.Run?) {
        if (run != null) recorder.animationEnd(run, clock.nanos())
    }

    fun touch(down: Boolean) {
        if (measuring) recorder.touch(down, clock.nanos())
    }

    fun scroll() {
        if (measuring) recorder.scroll(clock.nanos())
    }

    fun displayChanged() {
        val (hz, a) = probe.display()
        displayHz = hz
        adaptive = a
    }

    /** One frame from JankStats (any thread). `budgetMs` null: the display's interval. */
    fun frame(startNs: Long, mainMs: Double, totalMs: Double, budgetMs: Double?) {
        if (!measuring) return
        val fallback = 1000.0 / displayHz
        val budget = budgetMs?.takeIf { it in 4.0..50.0 } ?: fallback
        recorder.frame(startNs, mainMs, totalMs, budget)
    }

    // ---------- windows ----------

    private fun setMeasuring(on: Boolean) {
        if (measuring == on) return
        measuring = on
        if (on) displayChanged()
        onMeasuring(on)
    }

    private fun readState() {
        if (probe.powerSave()) state.lowPower = true
        val t = probe.thermal()
        if (t > state.thermal) state.thermal = t
        if (configs.current()?.collectReduceMotion == true && probe.animationsOff()) state.reduceMotion = true
    }

    /** Thermal changes reported by the platform (API 29 listener). */
    fun thermalChanged(level: Int) {
        if (level > state.thermal) state.thermal = level
    }

    fun powerSaveChanged(on: Boolean) {
        if (on) state.lowPower = true
    }

    private fun scheduleTick() {
        cancelTick?.invoke()
        val delay = minOf(CHECKPOINT_MS, sessions.windowLeftMs(clock.elapsedMs()).coerceAtLeast(1_000))
        cancelTick = scheduler.post(delay) { tick() }
    }

    private fun tick() {
        cancelTick = null
        if (!measuring || !foreground) return
        readState()
        if (sessions.windowFull(clock.elapsedMs())) {
            closeWindow("window", send = true)
        } else {
            val gz = Gzip.compress(Encoder.encode(buildReport("unknown", reset = false)))
            io.execute { store.writeCheckpoint(gz) }
        }
        scheduleTick()
    }

    private fun buildReport(ended: String, reset: Boolean): Map<String, Any?> {
        val s = sessions.session!!
        val snap = recorder.snapshot(clock.nanos(), reset)
        val c = configs.current()
        val collectReduce = c?.collectReduceMotion == true
        return Encoder.report(
            app = options.app.copy(framework = framework),
            sdkVersion = options.sdkVersion,
            device = probe.device(c?.collectDeviceModel != false),
            displayHz = displayHz,
            adaptive = adaptive,
            state = state,
            collectReduceMotion = collectReduce,
            nonce = s.nonce,
            seq = s.seq,
            sampleRate = s.sampleRate,
            foregroundMs = sessions.windowForegroundMs(clock.elapsedMs()),
            ended = ended,
            snap = snap,
        ).also { lastFrames = snap.frames }
    }

    private var lastFrames = 0

    /** Closes the open window: its report goes to the pending store and, unless deferred, is sent now. */
    private fun closeWindow(ended: String, send: Boolean) {
        val s = sessions.session ?: return
        readState()
        val report = buildReport(ended, reset = true)
        // A later window of a session where nothing was drawn adds nothing (the first one counts the session).
        val empty = s.seq > 0 && lastFrames == 0
        sessions.windowClosed()
        state.reset()
        val gz = if (empty) null else Gzip.compress(Encoder.encode(report))
        io.execute {
            store.clearCheckpoint()
            if (gz != null) store.add(gz, clock.wallMs())
            if (send) flush()
        }
    }

    // ---------- sending ----------

    private fun scheduleRetry(delayMs: Long) {
        cancelRetry?.invoke()
        cancelRetry = scheduler.post(delayMs) {
            cancelRetry = null
            if (!foreground) {
                flushWhenForeground = true
            } else {
                io.execute { flush() }
            }
        }
    }

    /** IO thread: sends what is pending, oldest first; stops at the first that must wait. */
    private fun flush() {
        val now = clock.wallMs()
        if (!enabled) return
        if (configs.killed(now)) {
            store.clear()
            return
        }
        if (probe.dataSaver()) return
        for (p in store.list(now)) {
            val bytes = p.read()
            if (bytes == null) {
                store.remove(p)
                continue
            }
            when (uploader.sendReport(bytes, clock.wallMs())) {
                Uploader.Outcome.DONE -> store.remove(p)
                Uploader.Outcome.RETRY -> {
                    scheduler.post(0) { retryLater() }
                    return
                }
                Uploader.Outcome.KILLED -> {
                    store.clear()
                    scheduler.post(0) { killed() }
                    return
                }
            }
        }
        scheduler.post(0) { retryStep = 0 }
    }

    /** The next retry: 1, 5, then 30 minutes. After that, reports wait for the next window or launch. */
    private fun retryLater() {
        retryStep++
        if (retryStep < RETRY_DELAYS_MS.size) scheduleRetry(RETRY_DELAYS_MS[retryStep])
    }

    /** 401, 410 or `stop`: nothing more is measured or sent on this device for 7 days. */
    private fun killed() {
        setMeasuring(false)
        cancelTick?.invoke()
        cancelTick = null
        recorder.clear(clock.nanos())
    }

    private fun scheduleConfigFetch() {
        scheduler.post(RETRY_DELAYS_MS[0]) {
            io.execute {
                val now = clock.wallMs()
                if (configs.killed(now) || !configs.stale(now)) return@execute
                uploader.fetchConfig(now)
                if (configs.killed(now)) {
                    store.clear()
                    scheduler.post(0) { killed() }
                }
            }
        }
    }

    companion object {
        const val CHECKPOINT_MS = 60_000L
        /** 10 s after launch, then after 1, 5 and 30 minutes, in the foreground only. */
        val RETRY_DELAYS_MS = longArrayOf(10_000, 60_000, 5 * 60_000, 30 * 60_000)
    }
}
