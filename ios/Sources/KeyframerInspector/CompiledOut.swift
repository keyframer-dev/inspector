#if canImport(UIKit) && !(DEBUG || KEYFRAMER_INSPECTOR_RELEASE)
import UIKit
@_exported import KeyframerInspectorCore

// A Release build compiles the inspector out (unless the package's `ReleaseBuilds` trait is on): this
// is the same API, doing nothing, so an app's calls build in every configuration while its binary
// carries none of the inspector. Xcode links every package product a target depends on in every
// configuration, and dead stripping kept it all (about 770 KB of code), inert.

/// The Keyframer runtime inspector, compiled out of this build: every call does nothing, `start`
/// returns false. Build with the Debug configuration, or turn on the package's `ReleaseBuilds` trait.
public enum KeyframerInspector {
    public struct Configuration {
        public var host: String
        public var port: Int
        public var appName: String
        public var appModules: [String]
        public var reportSystemAnimations: Bool
        public var captureScreen: Bool
        public var trackScrollViews: Bool
        public var allowInRelease: Bool
        public var sourceRoot: String?
        public var onlyWhenAsked: Bool

        public init(
            host: String? = nil,
            port: Int? = nil,
            appName: String? = nil,
            appModules: [String] = [],
            reportSystemAnimations: Bool = false,
            captureScreen: Bool = true,
            trackScrollViews: Bool = true,
            allowInRelease: Bool = false,
            sourceRoot: String? = nil,
            onlyWhenAsked: Bool = false
        ) {
            self.host = host ?? "127.0.0.1"
            self.port = port ?? 8790
            self.appName = appName ?? "app"
            self.appModules = appModules
            self.reportSystemAnimations = reportSystemAnimations
            self.captureScreen = captureScreen
            self.trackScrollViews = trackScrollViews
            self.allowInRelease = allowInRelease
            self.sourceRoot = sourceRoot
            self.onlyWhenAsked = onlyWhenAsked
        }
    }

    @MainActor @discardableResult
    public static func start(_ configuration: Configuration = Configuration(), filePath: StaticString = #filePath) -> Bool {
        false
    }

    @MainActor public static func stop() {}

    @MainActor public static var isRunning: Bool { false }

    @discardableResult
    public static func trace<T>(
        _ name: String? = nil, file: String = #fileID, filePath: String = #filePath, line: Int = #line, column: Int = #column, _ body: () throws -> T
    ) rethrows -> T {
        try body()
    }

    @MainActor
    public static func track(_ view: UIView, as name: String, keyPaths: [String] = ["position", "transform", "opacity"], file: String = #fileID, line: Int = #line) {}

    @MainActor @discardableResult
    public static func registerReplay(_ run: @escaping @MainActor () -> Void) -> () -> Void {
        {}
    }

    @MainActor @discardableResult
    public static func registerScenario(_ name: String, _ run: @escaping @MainActor () async throws -> Void) -> () -> Void {
        {}
    }

    @MainActor
    public static func registerNavigator(_ navigate: @escaping @MainActor (_ route: String, _ params: [String: JSONValue]?) -> Bool) {}

    @MainActor @discardableResult
    public static func tap(_ accessibilityIdentifier: String) -> Bool {
        false
    }

    @MainActor public static func scrub(toRecordingTime ms: Double) {}

    @MainActor public static func endScrub() {}

    @MainActor public static func note(_ text: String) {}
}
#endif
