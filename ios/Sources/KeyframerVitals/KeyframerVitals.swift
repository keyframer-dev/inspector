#if canImport(UIKit)
import Foundation
import QuartzCore
import UIKit

/// Motion Vitals: slow frames from production, per screen and per animation, for the Keyframer
/// dashboard. Release-safe and separate from the development inspector (`KeyframerInspector`).
///
/// Like Sentry, it does nothing until `start` is called, then it reports: an app that needs consent
/// calls `start` after it, or `setEnabled(false)` to stop. Reports never carry screenshots, text,
/// values, touches, identifiers or absolute times (production.md 1, "What a report never contains").
///
///     KeyframerVitals.start(key: "kfp_live_…")
///
/// Debug builds send nothing unless `environment: .development` is passed.
public enum KeyframerVitals {
    public enum Environment: String, Sendable {
        case production
        case development
    }

    /// Starts reporting. `appVersion` and `build` default to the bundle's CFBundleShortVersionString and
    /// CFBundleVersion. `sampleRate` is the share of sessions that report until the project's config
    /// says otherwise. Returns false when it did not start: a key that is not a `kfp_` field key, a
    /// debug build without `environment`, or a second call.
    @MainActor @discardableResult
    public static func start(
        key: String,
        appVersion: String? = nil,
        build: String? = nil,
        environment: Environment? = nil,
        sampleRate: Double = 0.1,
        endpoint: URL? = nil
    ) -> Bool {
        guard VitalsRuntime.shared == nil else { return false }
        guard key.hasPrefix("kfp_") else {
            log("not started: the key must be the project's field key (kfp_…)")
            return false
        }
        let env: Environment
        if let environment {
            env = environment
        } else {
            #if DEBUG
            log("off in debug builds; pass environment: .development to try it")
            return false
            #else
            env = .production
            #endif
        }
        let info = Bundle.main.infoDictionary ?? [:]
        let options = ReporterOptions(
            appId: Bundle.main.bundleIdentifier,
            appVersion: appVersion ?? info["CFBundleShortVersionString"] as? String ?? "0",
            build: build ?? info["CFBundleVersion"] as? String,
            environment: env.rawValue,
            sampleRate: sampleRate
        )
        let runtime = VitalsRuntime(options: options, key: key, endpoint: endpoint ?? Vitals.endpoint)
        VitalsRuntime.shared = runtime
        runtime.start()
        return true
    }

    /// Off: stops measuring and drops everything not sent yet (the open window, checkpoints, retries).
    /// On again: a new session starts. Kept in memory; call it on every launch the app needs it.
    @MainActor
    public static func setEnabled(_ enabled: Bool) {
        VitalsRuntime.shared?.setEnabled(enabled)
    }

    /// Names the screen on top, where view controller types do not (SwiftUI navigation, a custom
    /// container). Masked like the inspector's redaction and cut to 64 characters before it is sent.
    @MainActor
    public static func setScreen(_ name: String) {
        VitalsRuntime.shared?.setScreen(name, explicit: true)
    }

    /// Names the animations `body` starts: UIKit and Core Animation animations started inside it are
    /// reported as `name` instead of a code address, and a SwiftUI change (`withAnimation`) opens a
    /// motion window of `duration` seconds (0.5 by default) charged to `name`.
    ///
    ///     KeyframerVitals.trace("card-expand") {
    ///         withAnimation(.spring) { expanded.toggle() }
    ///     }
    @MainActor @discardableResult
    public static func trace<Result>(_ name: String, duration: TimeInterval? = nil, _ body: () throws -> Result) rethrows -> Result {
        guard let runtime = VitalsRuntime.shared else { return try body() }
        return try runtime.trace(name, duration: duration, body)
    }

    static func log(_ text: String) {
        print("[KeyframerVitals] \(text)")
    }
}

/// The UIKit side: lifecycle, the display link, the swizzles, device facts and uploads, around the
/// platform-free `Reporter`.
@MainActor
final class VitalsRuntime {
    static var shared: VitalsRuntime?

    let reporter: Reporter
    private let uploader: Uploader
    private var link: CADisplayLink?
    private var observers: [NSObjectProtocol] = []
    private var traces: [String] = []
    private var tracedStarts = 0
    private var explicitScreens = false
    private(set) var sawSwiftUI = false
    let images = ImageTable.standard()

    init(options: ReporterOptions, key: String, endpoint: URL) {
        let uploader = Uploader(endpoint: endpoint, key: key)
        self.uploader = uploader
        var options = options
        options.framework = { VitalsRuntime.shared?.sawSwiftUI == true ? "SwiftUI" : "UIKit" }
        let env = ReporterEnvironment(
            now: { CACurrentMediaTime() * 1000 },
            facts: { collect in MainActor.assumeIsolated { VitalsRuntime.facts(collect: collect) } },
            send: { body, done in uploader.send(body) { outcome in DispatchQueue.main.async { done(outcome) } } },
            fetchConfig: { done in uploader.fetchConfig { result in DispatchQueue.main.async { done(result) } } },
            after: { seconds, body in
                let job = MainJob(body)
                DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { job.run() }
            },
            isActive: { MainActor.assumeIsolated { UIApplication.shared.applicationState != .background } }
        )
        reporter = Reporter(options: options, store: .standard(), environment: env)
    }

    func start() {
        let center = NotificationCenter.default
        func on(_ name: Notification.Name, _ body: @escaping @MainActor (VitalsRuntime) -> Void) {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { if let self { body(self) } }
            })
        }
        on(UIApplication.didBecomeActiveNotification) { $0.becameActive() }
        on(UIApplication.didEnterBackgroundNotification) { $0.enteredBackground() }
        on(UIApplication.willTerminateNotification) { $0.reporter.checkpointNow() }
        on(.NSProcessInfoPowerStateDidChange) { $0.reporter.deviceChanged() }
        on(ProcessInfo.thermalStateDidChangeNotification) { $0.reporter.deviceChanged() }
        on(UIAccessibility.reduceMotionStatusDidChangeNotification) { $0.reporter.deviceChanged() }
        reporter.start()
        sync()
    }

    private func becameActive() {
        reporter.didBecomeActive()
        sync()
    }

    private func enteredBackground() {
        stopLink()
        let app = UIApplication.shared
        var task = UIBackgroundTaskIdentifier.invalid
        let end = {
            guard task != .invalid else { return }
            app.endBackgroundTask(task)
            task = .invalid
        }
        // The window is sent while the app still runs: a few seconds are enough for 1 to 3 KB.
        task = app.beginBackgroundTask(withName: "KeyframerVitals", expirationHandler: { MainActor.assumeIsolated { end() } })
        reporter.didEnterBackground { MainActor.assumeIsolated { end() } }
        sync()
    }

    func setEnabled(_ on: Bool) {
        if !on { stopLink() }
        reporter.setEnabled(on)
        sync()
    }

    /// Installs the swizzles the first time a session is sampled, and tells them whether to look.
    private func sync() {
        let active = reporter.isSampled
        if active {
            VitalsSwizzles.installOnce()
            VitalsTap.calibrate()
        }
        VitalsTap.isActive = active
        if !active { stopLink() }
    }

    // MARK: Screens

    func setScreen(_ name: String, explicit: Bool) {
        if explicit { explicitScreens = true }
        reporter.setScreen(name)
    }

    func willAppear(_ vc: UIViewController) {
        guard Self.isScreen(vc) else { return }
        reporter.navigationStarted()
    }

    func didAppear(_ vc: UIViewController) {
        guard Self.isScreen(vc) else { return }
        let name = String(describing: type(of: vc))
        if name.hasPrefix("UIHostingController") {
            sawSwiftUI = true
            // SwiftUI screens are named by `.vitalsScreen` / `setScreen` once the app uses them.
            if explicitScreens { return }
        }
        reporter.setScreen(name)
    }

    /// A screen of the app's own: its controller class comes from the app, or hosts SwiftUI. Containers
    /// (navigation, tabs, split, page) are not screens; what they show is (the inspector's rule).
    static func isScreen(_ vc: UIViewController) -> Bool {
        if vc is UINavigationController || vc is UITabBarController || vc is UISplitViewController || vc is UIPageViewController { return false }
        return AppClasses.isApp(type(of: vc)) || String(describing: type(of: vc)).hasPrefix("UIHostingController")
    }

    // MARK: Animations

    func trace<Result>(_ name: String, duration: TimeInterval?, _ body: () throws -> Result) rethrows -> Result {
        traces.append(name)
        let before = tracedStarts
        defer {
            traces.removeLast()
            if tracedStarts == before {
                // Nothing went through Core Animation: a SwiftUI change, timed by its estimate.
                animationStarted(SiteInfo(ref: .name(Self.cut(name), type: nil), fn: "trace"), durationMs: (duration ?? 0.5) * 1000)
            }
        }
        return try body()
    }

    /// A `.vitalsTrace` value changed.
    func traced(_ name: String, duration: TimeInterval?) {
        sawSwiftUI = true
        animationStarted(SiteInfo(ref: .name(Self.cut(name), type: nil), fn: "SwiftUI"), durationMs: (duration ?? 0.5) * 1000)
    }

    /// The trace name around a Core Animation start happening now, if any (and counts the start, so
    /// the trace knows something went through Core Animation).
    func traceForStart() -> String? {
        guard let name = traces.last else { return nil }
        tracedStarts += 1
        return Self.cut(name)
    }

    func animationStarted(_ info: SiteInfo?, durationMs: Double?) {
        reporter.animationStarted(info, durationMs: durationMs)
        ensureLink()
    }

    static func cut(_ s: String) -> String { String(s.prefix(160)) }

    // MARK: Touches

    func handle(_ event: UIEvent) {
        guard event.type == .touches, let touches = event.allTouches else { return }
        for touch in touches {
            let id = ObjectIdentifier(touch).hashValue
            switch touch.phase {
            case .began:
                reporter.touchBegan(id, scroll: Self.isOverScrollView(touch.view))
            case .ended, .cancelled:
                reporter.touchEnded(id)
            default:
                continue
            }
        }
        ensureLink()
    }

    static func isOverScrollView(_ view: UIView?) -> Bool {
        var v = view
        while let cur = v {
            if let scroll = cur as? UIScrollView, scroll.isScrollEnabled { return true }
            v = cur.superview
        }
        return false
    }

    // MARK: The display link

    /// Starts the display link when a motion window is open. It asks for 60 Hz and accepts more, never
    /// the 120 Hz the inspector's Ticker asks for: in the field the meter must not raise the display's
    /// rate it is measuring. On ProMotion the meter then sees at least every 60 Hz frame, and every
    /// frame when the app's own animations run the display faster.
    private func ensureLink() {
        guard link == nil, reporter.wantsFrames() else { return }
        let link = CADisplayLink(target: VitalsLinkTarget(), selector: #selector(VitalsLinkTarget.tick(_:)))
        let hz = Float(Self.displayHz())
        let base = min(60, hz)
        link.preferredFrameRateRange = CAFrameRateRange(minimum: base, maximum: max(base, Float(Self.meterHz(display: Double(hz)))), preferred: base)
        link.add(to: .main, forMode: .common)
        self.link = link
        reporter.meterStarted(at: CACurrentMediaTime() * 1000)
    }

    fileprivate func tick(_ link: CADisplayLink) {
        if !reporter.frame(at: link.timestamp * 1000) { stopLink() }
    }

    private func stopLink() {
        guard let link else { return }
        link.invalidate()
        self.link = nil
        reporter.stopMeter()
    }

    // MARK: Device

    static func displayHz() -> Double {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let screen = scenes.first { $0.activationState == .foregroundActive }?.screen ?? scenes.first?.screen
        let hz = Double(screen?.maximumFramesPerSecond ?? 60)
        return hz > 0 ? hz : 60
    }

    /// On iPhone a display link runs at 60 Hz at most unless the app's Info.plist has
    /// CADisableMinimumFrameDurationOnPhone, whatever the display can do (the inspector's rule).
    static func meterHz(display hz: Double) -> Double {
        let unlocked = Bundle.main.object(forInfoDictionaryKey: "CADisableMinimumFrameDurationOnPhone") as? Bool == true
        return UIDevice.current.userInterfaceIdiom == .phone && !unlocked ? min(hz, 60) : hz
    }

    static func facts(collect: VitalsConfig.Collect) -> DeviceFacts {
        let info = ProcessInfo.processInfo
        let model = DeviceModel.identifier()
        let memory = DeviceModel.memoryGb(bytes: info.physicalMemory)
        let hz = displayHz()
        let thermal: VitalsThermal
        switch info.thermalState {
        case .fair: thermal = .fair
        case .serious: thermal = .serious
        case .critical: thermal = .critical
        default: thermal = .nominal
        }
        return DeviceFacts(
            device: .init(os: "ios", osMajor: info.operatingSystemVersion.majorVersion, model: model.map { String($0.prefix(64)) },
                          tier: DeviceModel.tier(model: model, memoryGb: memory), memoryGb: memory),
            hz: hz, meterHz: meterHz(display: hz), adaptive: hz > 60 ? true : nil,
            lowPower: info.isLowPowerModeEnabled, thermal: thermal,
            reduceMotion: collect.reduceMotion ? UIAccessibility.isReduceMotionEnabled : nil
        )
    }
}

/// A main-queue job handed through a `@Sendable` closure: it only ever runs on the main queue.
private struct MainJob: @unchecked Sendable {
    let run: () -> Void
    init(_ run: @escaping () -> Void) { self.run = run }
}

/// CADisplayLink retains its target; this one reaches the runtime without keeping it.
private final class VitalsLinkTarget: NSObject {
    @objc func tick(_ link: CADisplayLink) {
        MainActor.assumeIsolated { VitalsRuntime.shared?.tick(link) }
    }
}

/// Whether a class is the app's own: its bundle lives inside the app bundle (the main executable or an
/// embedded framework). Cached per class.
enum AppClasses {
    @MainActor private static var cache: [ObjectIdentifier: Bool] = [:]
    private static let appPath = Bundle.main.bundlePath + "/"

    @MainActor static func isApp(_ cls: AnyClass) -> Bool {
        let id = ObjectIdentifier(cls)
        if let known = cache[id] { return known }
        let bundle = Bundle(for: cls)
        let mine = bundle == Bundle.main || (bundle.bundlePath + "/").hasPrefix(appPath)
        if cache.count > 2000 { cache = [:] }
        cache[id] = mine
        return mine
    }
}
#endif
