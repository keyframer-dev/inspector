import Foundation

/// The device facts a report carries, read when a window starts and when it is sent.
struct DeviceFacts {
    var device: VitalsReport.Device
    /// The display's top rate.
    var hz: Double
    /// The rate frames are counted against: `hz`, or 60 on an iPhone app without
    /// CADisableMinimumFrameDurationOnPhone (the system caps it there whatever the display can do).
    var meterHz: Double
    var adaptive: Bool?
    var lowPower: Bool
    var thermal: VitalsThermal
    /// Read only when the project collects Reduce Motion.
    var reduceMotion: Bool?
}

/// Everything the reporter needs from the platform, injected so the session logic runs in `swift test`.
struct ReporterEnvironment {
    /// Monotonic milliseconds (CACurrentMediaTime x 1000): frames, windows, foreground time.
    var now: () -> Double
    /// Wall time: the 30 s background gap, sessions per day, the config's age, the kill switch.
    var wallNow: () -> Date = Date.init
    var random: () -> Double = { Double.random(in: 0..<1) }
    /// The device as it is now. `collect`: what the project allows.
    var facts: (VitalsConfig.Collect) -> DeviceFacts
    /// Sends one report body.
    var send: (Data, @escaping (Uploader.Outcome) -> Void) -> Void
    /// Fetches the project's config.
    var fetchConfig: (@escaping (Result<VitalsConfig, Uploader.Outcome>) -> Void) -> Void
    /// Runs `body` on the main queue after `seconds`.
    var after: (Double, @escaping () -> Void) -> Void
    /// Whether the app is in the foreground.
    var isActive: () -> Bool
}

struct ReporterOptions {
    var appId: String?
    var appVersion: String
    var build: String?
    var environment: String
    var sampleRate: Double
    /// "SwiftUI" or "UIKit": read at send time.
    var framework: () -> String? = { nil }
}

/// The session logic of production.md 2.1 on one thread (the main one): session windows with a nonce
/// kept in memory, sampling once per session, at most 3 reported sessions per device per day, the
/// motion-window meter, 60 s checkpoints, the retry queue, config and the kill switch.
final class Reporter {
    struct Session {
        var nonce: String
        var seq: Int
        var sampleRate: Double
        var sampled: Bool
        var collect: VitalsConfig.Collect
    }

    /// When the retry queue is tried after `start`, in seconds (production.md 2.1).
    static let retryDelays: [Double] = [10, 60, 300, 1800]
    static let checkpointMs = 60_000.0

    let options: ReporterOptions
    let store: VitalsStore
    private let env: ReporterEnvironment

    private(set) var enabled = true
    private(set) var session: Session?
    private(set) var window: WindowAggregator?
    private var backgroundAt: Date?
    private var foreground = false
    private var screenName: String?
    private var facts: DeviceFacts?
    private var sawReduceMotion = false
    private var sawLowPower = false
    private var worstThermal = VitalsThermal.nominal

    private(set) var meter = VitalsFrameMeter()
    private(set) var motion = MotionWindows()
    private(set) var metering = false
    private var lastCheckpoint = 0.0

    private var deferredThisLaunch = false
    private var inFlight = Set<String>()
    private var flushWhenActive = false

    init(options: ReporterOptions, store: VitalsStore, environment: ReporterEnvironment) {
        self.options = options
        self.store = store
        self.env = environment
    }

    // MARK: Config

    var config: VitalsConfig { store.config()?.config ?? .defaults }

    var allowed: Bool {
        enabled && Policy.allows(config: config, stopUntil: store.stopUntil, now: env.wallNow())
    }

    /// Whether the current session measures: the swizzles' fast path.
    var isSampled: Bool { session?.sampled == true && window != nil }

    // MARK: Lifecycle

    /// Called once by `KeyframerVitals.start`: a checkpoint left by the last launch joins the retry
    /// queue, the queue is tried 10 s, 1, 5 and 30 minutes later, and the config is fetched 10 s later
    /// when the cached one is a day old.
    func start() {
        guard Policy.allows(config: config, stopUntil: store.stopUntil, now: env.wallNow()) else { return }
        if let checkpoint = store.takeCheckpoint() { store.enqueue(checkpoint) }
        for delay in Self.retryDelays {
            env.after(delay) { [weak self] in self?.flushPending() }
        }
        env.after(10) { [weak self] in self?.refreshConfigIfStale() }
        if env.isActive() { didBecomeActive() }
    }

    func setEnabled(_ on: Bool) {
        guard on != enabled else { return }
        enabled = on
        if on {
            if foreground { resumeSession() } else if env.isActive() { didBecomeActive() }
        } else {
            endSession()
            store.clearAll()
        }
    }

    func didBecomeActive() {
        guard !foreground else { return }
        foreground = true
        if flushWhenActive { flushWhenActive = false; flushPending() }
        resumeSession()
    }

    /// In the foreground: continues the session (back within 30 s) with a new window, or starts one.
    private func resumeSession() {
        guard allowed else { return }
        let t = env.now()
        let wall = env.wallNow()
        if let s = session, let bg = backgroundAt, wall.timeIntervalSince(bg) * 1000 < Vitals.sessionGapMs, wall >= bg {
            // The same session: a new window with the next seq.
            if s.sampled { openWindow(at: t) }
        } else if session == nil || backgroundAt != nil {
            startSession(at: t)
        }
        backgroundAt = nil
    }

    /// The app went to the background: the window is sent (`done` when the request finished, for the
    /// background task) and the session waits 30 s for the app to come back.
    func didEnterBackground(done: @escaping () -> Void = {}) {
        guard foreground else { return done() }
        foreground = false
        let t = env.now()
        stopMeter()
        motion.reset()
        backgroundAt = env.wallNow()
        guard var w = window, let s = session else { return done() }
        w.suspend(at: t)
        window = nil
        store.clearCheckpoint()
        session?.seq += 1
        guard allowed, let body = encode(w, at: t, ended: .background, session: s) else { return done() }
        send(body, done: done)
    }

    private func startSession(at t: Double) {
        let cached = store.config()?.config
        let c = cached ?? .defaults
        // The project's config decides once the device has one; until then, `start(sampleRate:)`.
        let rate = min(1, max(0, cached?.sampleRate ?? options.sampleRate))
        let devOK = options.environment != "development" || c.collect.development
        let sampled = devOK && Policy.sample(rate: rate, random: env.random()) && store.takeSessionSlot()
        session = Session(nonce: Self.nonce(), seq: 0, sampleRate: rate, sampled: sampled, collect: c.collect)
        window = nil
        if sampled { openWindow(at: t) }
    }

    private func openWindow(at t: Double) {
        guard let s = session else { return }
        var w = WindowAggregator()
        w.resume(at: t)
        if let name = screenName { w.setScreen(name, at: t, navigation: false) }
        window = w
        lastCheckpoint = t
        let f = env.facts(s.collect)
        facts = f
        sawReduceMotion = f.reduceMotion == true
        sawLowPower = f.lowPower
        worstThermal = f.thermal
        meter.hz = f.meterHz
    }

    private func endSession() {
        stopMeter()
        motion.reset()
        session = nil
        window = nil
    }

    /// A 128-bit random nonce, hex: in memory only, a new one per session.
    static func nonce() -> String {
        var g = SystemRandomNumberGenerator()
        return (0..<2).map { _ in String(format: "%016llx", g.next() as UInt64) }.joined()
    }

    // MARK: Facts

    /// Low Power Mode, thermal state, Reduce Motion or the display changed: "any time true in this window".
    func deviceChanged() {
        guard let s = session, window != nil else { return }
        let f = env.facts(s.collect)
        sawReduceMotion = sawReduceMotion || f.reduceMotion == true
        sawLowPower = sawLowPower || f.lowPower
        worstThermal = max(worstThermal, f.thermal)
        if f.meterHz != facts?.meterHz { meter.hz = f.meterHz }
        facts = f
    }

    // MARK: Events from the app

    func setScreen(_ name: String, navigation: Bool = true) {
        let masked = Mask.screenName(name)
        screenName = masked
        window?.setScreen(masked, at: env.now(), navigation: navigation)
    }

    /// A screen is about to appear: frames in the next 500 ms are `screen-mount`.
    func navigationStarted() {
        window?.navigation(at: env.now())
    }

    /// An animation started now and runs for `durationMs` (nil: forever). Opens a motion window.
    func animationStarted(_ info: SiteInfo?, durationMs: Double?) {
        guard isSampled else { return }
        let t = env.now()
        let end = t + min(durationMs ?? .infinity, MotionWindows.longestRunMs)
        if let info {
            let rm = session?.collect.reduceMotion == true && facts?.reduceMotion == true
            window?.animationStarted(info, start: t, end: end, reduceMotion: rm)
        }
        motion.animation(start: t, end: end)
        rollWindowIfFull(at: t)
    }

    func touchBegan(_ id: Int, scroll: Bool) {
        guard isSampled else { return }
        motion.touchBegan(id, scroll: scroll, at: env.now())
    }

    func touchEnded(_ id: Int) {
        guard isSampled else { return }
        motion.touchEnded(id, at: env.now())
    }

    // MARK: The meter

    /// Whether the display link should run now.
    func wantsFrames() -> Bool {
        isSampled && foreground && motion.isOpen(at: env.now())
    }

    /// The display link started at `t` (ms).
    func meterStarted(at t: Double) {
        metering = true
        meter.start(at: t)
    }

    func stopMeter() {
        metering = false
        meter.pause()
    }

    /// One display link callback at `t` (ms). Returns whether the link should keep running.
    @discardableResult
    func frame(at t: Double) -> Bool {
        guard isSampled, foreground else { return false }
        if let f = meter.tick(t) {
            window?.frame(f, at: t, touch: motion.touch(at: t))
        }
        rollWindowIfFull(at: t)
        checkpointIfDue(at: t)
        return motion.isOpen(at: t)
    }

    /// 10 minutes of foreground time fill a window: it is sent (`ended: window`) and the next begins.
    private func rollWindowIfFull(at t: Double) {
        guard var w = window, let s = session, w.foregroundMs(at: t) >= Vitals.windowMs else { return }
        w.suspend(at: t)
        store.clearCheckpoint()
        session?.seq += 1
        if let body = encode(w, at: t, ended: .window, session: s) { send(body) }
        openWindow(at: t)
    }

    /// Every 60 s while something moves, the open window is saved, to be sent on the next launch with
    /// `ended: unknown` if this one dies first.
    private func checkpointIfDue(at t: Double) {
        guard let w = window, let s = session, w.changed, t - lastCheckpoint >= Self.checkpointMs else { return }
        lastCheckpoint = t
        if let body = encode(w, at: t, ended: .unknown, session: s) { store.writeCheckpoint(body) }
        window?.checkpointed()
    }

    /// Writes a checkpoint now (tests, and the app terminating).
    func checkpointNow() {
        guard let w = window, let s = session else { return }
        let t = env.now()
        lastCheckpoint = t
        if let body = encode(w, at: t, ended: .unknown, session: s) { store.writeCheckpoint(body) }
    }

    // MARK: Encoding

    func report(_ w: WindowAggregator, at t: Double, ended: VitalsEnded, session s: Session) -> VitalsReport {
        let f = facts ?? env.facts(s.collect)
        let ctx = WindowAggregator.Context(
            app: .init(id: options.appId, version: options.appVersion, build: options.build, platform: "ios",
                       framework: options.framework(), environment: options.environment, debugId: nil),
            device: {
                var d = f.device
                if !s.collect.deviceModel { d.model = nil }
                return d
            }(),
            display: .init(hz: f.hz, adaptive: f.adaptive, targetHz: min(meter.targetHz, f.hz)),
            state: .init(
                reduceMotion: s.collect.reduceMotion ? sawReduceMotion : nil,
                lowPower: sawLowPower, thermal: worstThermal
            ),
            nonce: s.nonce, seq: s.seq, sampleRate: s.sampleRate, reduceMotion: s.collect.reduceMotion
        )
        return w.report(at: t, ended: ended, context: ctx)
    }

    private func encode(_ w: WindowAggregator, at t: Double, ended: VitalsEnded, session s: Session) -> Data? {
        report(w, at: t, ended: ended, session: s).trimmed(toBytes: Vitals.maxBytes)
    }

    // MARK: Sending

    private func send(_ body: Data, done: @escaping () -> Void = {}) {
        let id = store.enqueue(body)
        guard !deferredThisLaunch else { return done() }
        transmit(id: id, body: body, done: done)
    }

    private func transmit(id: String, body: Data, done: @escaping () -> Void = {}) {
        inFlight.insert(id)
        env.send(body) { [weak self] outcome in
            guard let self else { return done() }
            self.inFlight.remove(id)
            switch outcome {
            case let .sent(config):
                self.store.remove(id)
                if let config { self.apply(config) }
            case .rejected:
                self.store.remove(id)
            case .stop:
                self.kill()
            case .retry:
                break
            case .deferred:
                self.deferredThisLaunch = true
            }
            done()
        }
    }

    /// Sends what waits in the queue, one request at a time, only in the foreground.
    func flushPending() {
        guard enabled, Policy.allows(config: config, stopUntil: store.stopUntil, now: env.wallNow()), !deferredThisLaunch else { return }
        guard env.isActive() else { flushWhenActive = true; return }
        guard inFlight.isEmpty, let next = store.pending().first else { return }
        transmit(id: next.id, body: next.body) { [weak self] in
            // Keep going while sends succeed; a failure leaves the rest for the next try.
            guard let self, !self.store.pending().contains(where: { $0.id == next.id }) else { return }
            self.flushPending()
        }
    }

    func refreshConfigIfStale() {
        let cached = store.config()
        guard Policy.shouldFetch(fetchedAt: cached?.fetchedAt, ttlSec: cached?.config.ttlSec, now: env.wallNow()) else { return }
        env.fetchConfig { [weak self] result in
            guard let self else { return }
            switch result {
            case let .success(config): self.apply(config)
            case .failure(.stop): self.kill()
            case .failure: break
            }
        }
    }

    func apply(_ config: VitalsConfig) {
        store.saveConfig(config)
        if config.stop == true { return kill() }
        if !Policy.allows(config: config, stopUntil: store.stopUntil, now: env.wallNow()) {
            endSession()
        }
    }

    /// 401, 410 or `stop`: off on this device for 7 days, everything waiting dropped.
    func kill() {
        store.stopUntil = env.wallNow().addingTimeInterval(Policy.stopSeconds)
        store.clearAll()
        endSession()
    }
}

extension VitalsReport {
    /// The report's JSON at most `bytes` long: the sites that saw the fewest frames go first (and the
    /// worst frames' references to them, and images nothing points to any more). Nil if it cannot fit.
    func trimmed(toBytes bytes: Int) -> Data? {
        var r = self
        while true {
            guard let data = try? r.encoded() else { return nil }
            if data.count <= bytes { return data }
            if r.sites.isEmpty {
                if r.worst.isEmpty { return nil }
                r.worst.removeLast()
                continue
            }
            let keep = Set(r.sites.indices.sorted { r.sites[$0].frames > r.sites[$1].frames }.prefix(r.sites.count / 2))
            var remap: [Int: Int] = [:]
            var sites: [VitalsSite] = []
            for (i, s) in r.sites.enumerated() where keep.contains(i) {
                remap[i] = sites.count
                sites.append(s)
            }
            r.worst = r.worst.map { w in var w = w; w.sites = w.sites.compactMap { remap[$0] }; return w }
            if let images = r.images {
                var used: [Int: Int] = [:]
                var kept: [VitalsImage] = []
                sites = sites.map { s in
                    guard case let .native(image, offset, type) = s.ref else { return s }
                    if used[image] == nil { used[image] = kept.count; kept.append(images[image]) }
                    var s = s
                    s.ref = .native(image: used[image]!, offset: offset, type: type)
                    return s
                }
                r.images = kept.isEmpty ? nil : kept
            }
            r.sites = sites
        }
    }
}
