#if canImport(UIKit)
import QuartzCore
import UIKit
@_exported import KeyframerInspectorCore

/// The Keyframer runtime inspector for UIKit apps.
///
///     #if DEBUG
///     KeyframerInspector.start()                                   // ws://127.0.0.1:8790
///     KeyframerInspector.start(.init(host: "192.168.1.20"))        // a device, against the Mac
///     #endif
///
/// Once started, every Core Animation animation the app's code starts (UIView.animate,
/// UIViewPropertyAnimator, CABasicAnimation, CASpringAnimation, keyframes) is reported to the panel
/// with its call site; the layers it moves become signals the panel can record, scrub and play back.
public enum KeyframerInspector {
    public struct Configuration {
        /// The relay's host. The simulator reaches the Mac at 127.0.0.1; a device needs the Mac's LAN
        /// address (and the app's Info.plist needs NSLocalNetworkUsageDescription and
        /// NSAllowsLocalNetworking). `KEYFRAMER_INSPECTOR_HOST` in the environment wins.
        public var host: String
        public var port: Int
        /// The name the panel shows. Defaults to the bundle's display name.
        public var appName: String
        /// Images besides the app's executable whose frames count as app code (embedded frameworks
        /// of your own), by image name as `Thread.callStackSymbols` prints it.
        public var appModules: [String]
        /// Report animations started by UIKit itself too (keyboard, navigation bars, the text cursor).
        /// Off: only animations with an app frame on the stack, or inside `trace`, are reported.
        public var reportSystemAnimations: Bool
        /// Lets the panel export frames (`capture`).
        public var captureScreen: Bool
        /// Records a scroll view's offset once a finger touches it (its `bounds.origin`).
        public var trackScrollViews: Bool
        /// Release builds do nothing unless this is true.
        public var allowInRelease: Bool
        /// The app's source folder on this Mac, sent in the hello: `trace` call sites become paths relative
        /// to it, which the panel opens in an editor and "Apply to code" writes to. `KEYFRAMER_ROOT` in the
        /// environment wins (in the scheme's Run environment: `$(SRCROOT)`).
        public var sourceRoot: String?

        public init(
            host: String? = nil,
            port: Int? = nil,
            appName: String? = nil,
            appModules: [String] = [],
            reportSystemAnimations: Bool = false,
            captureScreen: Bool = true,
            trackScrollViews: Bool = true,
            allowInRelease: Bool = false,
            sourceRoot: String? = nil
        ) {
            let env = ProcessInfo.processInfo.environment
            self.host = env["KEYFRAMER_INSPECTOR_HOST"] ?? host ?? "127.0.0.1"
            self.port = env["KEYFRAMER_INSPECTOR_PORT"].flatMap(Int.init) ?? port ?? 8790
            let info = Bundle.main.infoDictionary
            self.appName = appName ?? (info?["CFBundleDisplayName"] as? String) ?? (info?["CFBundleName"] as? String) ?? "app"
            self.appModules = appModules
            self.reportSystemAnimations = reportSystemAnimations
            self.captureScreen = captureScreen
            self.trackScrollViews = trackScrollViews
            self.allowInRelease = allowInRelease
            self.sourceRoot = (env["KEYFRAMER_ROOT"] ?? sourceRoot).flatMap { $0.isEmpty ? nil : $0 }
        }

        /// `ws://host:port/app?name=<app name>&platform=ios`, the relay's app endpoint.
        public var url: URL {
            var c = URLComponents()
            c.scheme = "ws"
            c.host = host
            c.port = port
            c.path = "/app"
            c.queryItems = [URLQueryItem(name: "name", value: appName), URLQueryItem(name: "platform", value: "ios")]
            return c.url!
        }
    }

    /// Connects to the relay and starts watching animations. Does nothing in release builds unless
    /// `allowInRelease` is set, or when `KEYFRAMER_INSPECTOR=0` is in the environment.
    @MainActor @discardableResult
    public static func start(_ configuration: Configuration = Configuration()) -> Bool {
        let env = ProcessInfo.processInfo.environment["KEYFRAMER_INSPECTOR"]
        if env == "0" { return false }
        #if !DEBUG
            if !configuration.allowInRelease && env != "1" { return false }
        #endif
        Inspector.shared?.stop()
        Swizzles.installOnce()
        let inspector = Inspector(config: configuration)
        Inspector.shared = inspector
        inspector.start()
        return true
    }

    @MainActor public static func stop() {
        Inspector.shared?.stop()
        Inspector.shared = nil
    }

    @MainActor public static var isRunning: Bool { Inspector.shared != nil }

    /// Marks the animations started in `body` with this exact call site (`#fileID:#line:#column`),
    /// instead of the closest one a stack can give. `name` is what the panel calls the target.
    ///
    ///     KeyframerInspector.trace("card") {
    ///         UIView.animate(withDuration: 0.4) { self.card.center.y += 120 }
    ///     }
    @discardableResult
    public static func trace<T>(
        _ name: String? = nil, file: String = #fileID, filePath: String = #filePath, line: Int = #line, column: Int = #column, _ body: () throws -> T
    ) rethrows -> T {
        ExplicitSites.stack.append(ExplicitSite(file: file, filePath: filePath, line: line, column: column, name: name))
        defer { ExplicitSites.stack.removeLast() }
        return try body()
    }

    /// Records a view the app moves itself (a drag that sets `center`), not only through animations.
    /// Its layer's `keyPaths` become signals right away, named `name`.
    @MainActor
    public static func track(_ view: UIView, as name: String, keyPaths: [String] = ["position", "transform", "opacity"], file: String = #fileID, line: Int = #line) {
        Registry.names[ObjectIdentifier(view)] = (WeakBox(view), name)
        // Kept for an inspector started later, too.
        Registry.tracked.append((WeakBox(view.layer), keyPaths, file, line))
        Inspector.shared?.track(layer: view.layer, keyPaths: keyPaths, file: file, line: line)
    }

    /// What `replay` from the panel runs: re-present the screen, re-fire an entrance.
    @MainActor @discardableResult
    public static func registerReplay(_ run: @escaping @MainActor () -> Void) -> () -> Void {
        let token = UUID()
        Registry.replay = (token, run)
        return { if Registry.replay?.0 == token { Registry.replay = nil } }
    }

    /// An interaction the panel or an agent can run to reproduce something. Replaces one of the same name.
    @MainActor @discardableResult
    public static func registerScenario(_ name: String, _ run: @escaping @MainActor () async throws -> Void) -> () -> Void {
        let token = UUID()
        Registry.scenarios[name] = (token, run)
        Inspector.shared?.scenariosChanged()
        return {
            if Registry.scenarios[name]?.0 == token {
                Registry.scenarios[name] = nil
                Inspector.shared?.scenariosChanged()
            }
        }
    }

    /// How playback reaches a screen it recorded (a route is the view controller's type name). Return
    /// false when it is not one you know. Without one, playback can still pop back to a controller of
    /// that type in the current navigation stack.
    @MainActor
    public static func registerNavigator(_ navigate: @escaping @MainActor (_ route: String, _ params: [String: JSONValue]?) -> Bool) {
        Registry.navigator = navigate
    }

    /// Fires the control with this accessibility identifier the way a tap would (its primary action,
    /// or touchUpInside): for scenarios.
    @MainActor @discardableResult
    public static func tap(_ accessibilityIdentifier: String) -> Bool {
        guard let control = UIApplication.shared.kf_windows.lazy.compactMap({ $0.kf_find(accessibilityIdentifier) as? UIControl }).first else { return false }
        control.sendActions(for: control.allControlEvents.contains(.primaryActionTriggered) ? .primaryActionTriggered : .touchUpInside)
        return true
    }

    /// Freezes every animated layer at `ms` on the last recording's clock (Core Animation's own
    /// timeline: speed 0 plus timeOffset), until `endScrub()`.
    @MainActor public static func scrub(toRecordingTime ms: Double) {
        Inspector.shared?.scrub(ms)
    }

    @MainActor public static func endScrub() {
        Inspector.shared?.scrub(nil)
    }

    /// A note on the recording's timeline.
    @MainActor public static func note(_ text: String) {
        Inspector.shared?.note(text)
    }
}

struct ExplicitSite {
    let file: String
    /// The absolute path (#filePath): made relative to the configured source root when inside it.
    var filePath: String? = nil
    let line: Int
    let column: Int
    let name: String?

    /// `file` relative to `root` when the source lives there (`Example/Cards.swift`), else the module path (#fileID).
    func path(under root: String?) -> String {
        guard let root, let filePath else { return file }
        let base = root.hasSuffix("/") ? root : root + "/"
        return filePath.hasPrefix(base) ? String(filePath.dropFirst(base.count)) : file
    }
}

/// `trace` scopes, innermost last. Animations are started on the main thread; a scope on another
/// thread only marks that thread's animations, which are rare.
enum ExplicitSites {
    private static let key = "dev.keyframer.inspector.sites"

    static var stack: [ExplicitSite] {
        get { Thread.current.threadDictionary[key] as? [ExplicitSite] ?? [] }
        set { Thread.current.threadDictionary[key] = newValue }
    }

    static var current: ExplicitSite? { stack.last }
}

final class WeakBox<T: AnyObject> {
    weak var value: T?
    init(_ value: T) { self.value = value }
}

/// What the app registered, kept across start/stop like React Native's module-level registries.
@MainActor enum Registry {
    static var replay: (UUID, @MainActor () -> Void)?
    static var scenarios: [String: (UUID, @MainActor () async throws -> Void)] = [:]
    static var navigator: (@MainActor (String, [String: JSONValue]?) -> Bool)?
    static var names: [ObjectIdentifier: (WeakBox<UIView>, String)] = [:]
    static var tracked: [(layer: WeakBox<CALayer>, keyPaths: [String], file: String, line: Int)] = []

    static var scenarioNames: [String] { scenarios.keys.sorted() }

    static func name(of view: UIView) -> String? {
        guard let entry = names[ObjectIdentifier(view)], entry.0.value === view else { return nil }
        return entry.1
    }
}

extension UIApplication {
    var kf_windows: [UIWindow] {
        connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
    }

    var kf_keyWindow: UIWindow? {
        kf_windows.first(where: \.isKeyWindow) ?? kf_windows.first
    }
}

extension UIView {
    func kf_find(_ identifier: String) -> UIView? {
        if accessibilityIdentifier == identifier { return self }
        for sub in subviews {
            if let hit = sub.kf_find(identifier) { return hit }
        }
        return nil
    }
}
#endif
