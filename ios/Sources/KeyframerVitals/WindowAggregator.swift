import Foundation

/// What started an animation, before it has an index in the report.
struct SiteInfo: Equatable {
    enum Ref: Equatable {
        /// A name the developer gave (`trace`, `.vitalsTrace`), plus a type name when known.
        case name(String, type: String?)
        /// An instruction offset in an app image, resolved later from the uploaded dSYM.
        case native(image: VitalsImage, offset: UInt64, type: String?)
    }
    var ref: Ref
    /// UIView.animate, CABasicAnimation, trace, SwiftUI…
    var fn: String
    var prop: String?
    var component: String?

    /// Identity within a window: one site per call site, whatever properties it animates.
    var identity: String {
        switch ref {
        case let .name(name, _): return "n:\(name)"
        case let .native(image, offset, _): return "x:\(image.debugId):\(offset)"
        }
    }
}

/// Whether a touch window is open while a frame is drawn, and over a scroll view.
enum TouchState { case none, gesture, scroll }

/// The counters of one session window (production.md 1): per screen histograms against the frame
/// budget, per site counters ("frames dropped while this ran"), idle baselines and the worst frames
/// with a cause. Pure: times are milliseconds on one monotonic clock (CACurrentMediaTime x 1000), so the
/// tests drive it with plain numbers.
struct WindowAggregator {
    static let thread = VitalsThread.js.rawValue
    /// A frame ending this soon after a navigation is `screen-mount`.
    static let mountMs = 500.0
    /// `burst`: this many animations started within the frame or this long before it.
    static let burstCount = 6
    static let burstLeadMs = 50.0
    static let otherScreen = "Other"

    private struct ScreenAcc {
        var name: String
        var ms = 0.0
        var stats = VitalsThreadStats()
    }

    private struct SiteAcc {
        var info: SiteInfo
        var runs = 0
        var runsReduceMotion = 0
        var activeMs = 0.0
        var activeUntil = -Double.infinity
        var lastStart = -Double.infinity
        var frames = 0
        var missed = 0
        var hitchMs = 0.0
        var worstMs = 0.0
        var msByScreen: [Int: Double] = [:]
    }

    private struct Run {
        var site: Int
        var start: Double
        var end: Double
    }

    private var screens: [ScreenAcc] = []
    private var screenIndex: [String: Int] = [:]
    private var current: Int?
    private var screenSince: Double?
    private var sites: [SiteAcc] = []
    private var siteIndex: [String: Int] = [:]
    private var images: [VitalsImage] = []
    private var runs: [Run] = []
    private var starts: [Double] = []
    private var worst: [VitalsWorstFrame] = []
    private var lastNavAt: Double?

    private(set) var foregroundMs = 0.0
    private(set) var measuredMs = 0.0
    private var foregroundSince: Double?

    /// Anything happened worth a checkpoint since the last one.
    private(set) var changed = false

    init() {}

    // MARK: Foreground time

    mutating func resume(at t: Double) {
        guard foregroundSince == nil else { return }
        foregroundSince = t
        if current != nil { screenSince = t }
    }

    mutating func suspend(at t: Double) {
        guard let since = foregroundSince else { return }
        foregroundMs += max(0, t - since)
        foregroundSince = nil
        closeScreen(at: t)
    }

    func foregroundMs(at t: Double) -> Double {
        foregroundMs + (foregroundSince.map { max(0, t - $0) } ?? 0)
    }

    // MARK: Screens

    /// The screen on top changed (a view controller appeared, or `setScreen`). `name` is masked already.
    mutating func setScreen(_ name: String, at t: Double, navigation: Bool = true) {
        if navigation { lastNavAt = t }
        let index = screenSlot(name)
        guard index != current else { return }
        closeScreen(at: t)
        current = index
        screenSince = foregroundSince == nil ? nil : t
        changed = true
    }

    /// A navigation started (a view controller is about to appear): the next frames are `screen-mount`.
    mutating func navigation(at t: Double) {
        lastNavAt = t
    }

    private mutating func screenSlot(_ name: String) -> Int {
        if let i = screenIndex[name] { return i }
        if screens.count >= Vitals.maxScreens - 1 {
            if let other = screenIndex[Self.otherScreen] { return other }
            if screens.count >= Vitals.maxScreens { return screens.count - 1 }
            screens.append(ScreenAcc(name: Self.otherScreen))
            screenIndex[Self.otherScreen] = screens.count - 1
            return screens.count - 1
        }
        screens.append(ScreenAcc(name: name))
        screenIndex[name] = screens.count - 1
        return screens.count - 1
    }

    private mutating func closeScreen(at t: Double) {
        if let i = current, let since = screenSince {
            screens[i].ms += max(0, t - since)
        }
        screenSince = nil
    }

    private mutating func currentScreen() -> Int {
        if let current { return current }
        let i = screenSlot("Unknown")
        current = i
        screenSince = foregroundSince
        return i
    }

    // MARK: Animations

    /// An animation started at `start` and is expected to end at `end` (its delay and duration). Returns
    /// false when the site could not be recorded (the window's site or image cap is full).
    @discardableResult
    mutating func animationStarted(_ info: SiteInfo, start: Double, end: Double, reduceMotion: Bool = false) -> Bool {
        starts.append(start)
        if starts.count > 64 { starts.removeFirst(starts.count - 64) }
        guard let site = siteSlot(info) else { return false }
        let screen = currentScreen()
        var s = sites[site]
        // One UIView.animate block adds an animation per property, in the same instant: one run.
        if start - s.lastStart > 1 || start < s.lastStart {
            s.runs += 1
            if reduceMotion { s.runsReduceMotion += 1 }
        }
        s.lastStart = start
        let from = max(start, s.activeUntil)
        if end > from {
            s.activeMs += end - from
            s.msByScreen[screen, default: 0] += end - from
        }
        s.activeUntil = max(s.activeUntil, end)
        if s.info.prop == nil { s.info.prop = info.prop }
        sites[site] = s
        runs.append(Run(site: site, start: start, end: end))
        changed = true
        return true
    }

    private mutating func siteSlot(_ info: SiteInfo) -> Int? {
        if let i = siteIndex[info.identity] { return i }
        guard sites.count < Vitals.maxSites else { return nil }
        if case let .native(image, _, _) = info.ref, imageSlot(image) == nil { return nil }
        sites.append(SiteAcc(info: info))
        siteIndex[info.identity] = sites.count - 1
        return sites.count - 1
    }

    private mutating func imageSlot(_ image: VitalsImage) -> Int? {
        if let i = images.firstIndex(where: { $0.debugId == image.debugId }) { return i }
        guard images.count < Vitals.maxImages else { return nil }
        images.append(image)
        return images.count - 1
    }

    /// Whether a tracked animation is expected to run at `t` (motion windows use it).
    func isAnimating(at t: Double) -> Bool {
        runs.contains { $0.start <= t && $0.end > t }
    }

    // MARK: Frames

    /// A frame of the main thread ended at `t`. `touch` says whether a touch window was open.
    mutating func frame(_ f: VitalsFrame, at t: Double, touch: TouchState) {
        let screen = currentScreen()
        let begin = t - f.ms
        runs.removeAll { $0.end < begin - 1000 }
        let active = Array(Set(runs.filter { $0.start < t && $0.end > begin }.map(\.site))).sorted()
        let hitch = max(0, f.ms - f.budget)

        var st = screens[screen].stats
        st.frames += 1
        st.hist[Vitals.bucket(missed: f.missed)] += 1
        if f.ms >= Vitals.frozenMs { st.frozen += 1 }
        st.hitchMs += hitch
        if active.isEmpty {
            st.idleFrames += 1
            st.idleMissed += f.missed
        }
        screens[screen].stats = st
        measuredMs += f.ms

        for i in active {
            sites[i].frames += 1
            sites[i].missed += f.missed
            sites[i].hitchMs += hitch
            sites[i].worstMs = max(sites[i].worstMs, f.ms)
        }

        if f.missed > 0 {
            let started = starts.filter { $0 >= begin - Self.burstLeadMs && $0 <= t }.count
            var cause = VitalsCause.unknown
            var afterNav: Double?
            if let nav = lastNavAt, t >= nav, t - nav <= Self.mountMs {
                cause = .screenMount
                afterNav = (t - nav).rounded()
            } else if started >= Self.burstCount {
                cause = .burst
            } else if touch != .none, starts.allSatisfy({ $0 < begin || $0 > t }) {
                cause = touch == .scroll ? .scroll : .gesture
            }
            let frame = VitalsWorstFrame(
                thread: .js, ms: Self.tenth(f.ms), missed: f.missed, screen: screen, sites: active,
                cause: cause, afterNavMs: afterNav
            )
            if worst.count < Vitals.worstFrames || f.ms > (worst.last?.ms ?? 0) {
                worst.append(frame)
                worst.sort { $0.ms > $1.ms }
                if worst.count > Vitals.worstFrames { worst.removeLast() }
            }
        }
        changed = true
    }

    // MARK: The report

    /// Clears the checkpoint flag (the caller wrote a checkpoint).
    mutating func checkpointed() {
        changed = false
    }

    static func tenth(_ v: Double) -> Double { (v * 10).rounded() / 10 }

    struct Context {
        var app: VitalsReport.App
        var device: VitalsReport.Device
        var display: VitalsReport.Display
        var state: VitalsReport.State
        var nonce: String
        var seq: Int
        var sampleRate: Double
        /// Whether the project collects Reduce Motion (`runsReduceMotion` is left out otherwise).
        var reduceMotion: Bool
    }

    /// The window as a report at `t`, without changing the window (checkpoints call it too).
    func report(at t: Double, ended: VitalsEnded, context c: Context) -> VitalsReport {
        var screenMs = screens.map(\.ms)
        if let i = current, let since = screenSince { screenMs[i] += max(0, t - since) }
        let foreground = foregroundMs(at: t)
        let outScreens = screens.enumerated().map { i, s -> VitalsScreen in
            var st = s.stats
            st.hitchMs = Self.tenth(st.hitchMs)
            return VitalsScreen(name: s.name, ms: min(screenMs[i], foreground).rounded(), threads: st.frames > 0 ? [Self.thread: st] : [:])
        }
        let outSites = sites.map { s -> VitalsSite in
            let ref: VitalsSiteRef
            let key: String?
            switch s.info.ref {
            case let .name(name, type):
                ref = .name(name: name, type: type)
                key = name
            case let .native(image, offset, type):
                ref = .native(image: images.firstIndex(of: image) ?? 0, offset: offset, type: type)
                key = nil
            }
            let screen = s.msByScreen.max { a, b in a.value < b.value || (a.value == b.value && a.key > b.key) }?.key ?? current ?? 0
            return VitalsSite(
                ref: ref, key: key, fn: s.info.fn, component: s.info.component, prop: s.info.prop,
                screen: min(screen, max(0, screens.count - 1)), runs: s.runs, activeMs: min(s.activeMs, foreground).rounded(),
                frames: s.frames, missed: s.missed, hitchMs: Self.tenth(s.hitchMs), worstMs: Self.tenth(s.worstMs),
                runsReduceMotion: c.reduceMotion ? s.runsReduceMotion : nil
            )
        }
        return VitalsReport(
            app: c.app,
            sdk: .init(name: Vitals.sdkName, version: Vitals.sdkVersion),
            device: c.device,
            display: c.display,
            state: c.state,
            session: .init(
                nonce: c.nonce, seq: c.seq, sampleRate: c.sampleRate,
                foregroundMs: foreground.rounded(), measuredMs: min(measuredMs, foreground).rounded(), ended: ended
            ),
            screens: outScreens,
            sites: outSites,
            worst: worst,
            images: images.isEmpty ? nil : images
        )
    }
}
