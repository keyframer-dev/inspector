#if DEBUG || KEYFRAMER_INSPECTOR_RELEASE
import Foundation

/// What the inspector is told when the app is launched, outside its code: the environment (the scheme,
/// `SIMCTL_CHILD_*` for the simulator) and launch arguments, which `xcrun simctl launch` and
/// `xcrun devicectl device process launch` pass to a simulator and a device alike. The environment wins.
///
///     -keyframer YES                  on (NO: off)              KEYFRAMER_INSPECTOR=1 (0)
///     -keyframerHost 192.168.1.20     the relay's host          KEYFRAMER_INSPECTOR_HOST
///     -keyframerPort 18797            the relay's port          KEYFRAMER_INSPECTOR_PORT
///     -keyframerSystem YES            UIKit's own animations    KEYFRAMER_INSPECTOR_SYSTEM=1
public struct LaunchOptions: Equatable, Sendable {
    /// On (true) or off (false) when said, else nil.
    public var enabled: Bool?
    /// `KEYFRAMER_INSPECTOR=1` in the environment: on even in a release build.
    public var enabledByEnvironment: Bool
    public var host: String?
    public var port: Int?
    public var reportSystemAnimations: Bool?

    /// `arguments`: the launch arguments' defaults domain (`-name value` pairs).
    public init(environment: [String: String], arguments: [String: Any]) {
        func flag(_ value: Any?) -> Bool? {
            if let n = value as? NSNumber { return n.boolValue }
            switch (value as? String)?.lowercased() {
            case "yes", "true", "1": return true
            case "no", "false", "0": return false
            default: return nil
            }
        }
        func text(_ value: Any?) -> String? {
            guard let s = (value as? String) ?? (value as? NSNumber)?.stringValue else { return nil }
            let trimmed = s.trimmingCharacters(in: .whitespaces)
            return trimmed.isEmpty ? nil : trimmed
        }
        enabled = flag(environment["KEYFRAMER_INSPECTOR"]) ?? flag(arguments["keyframer"])
        enabledByEnvironment = flag(environment["KEYFRAMER_INSPECTOR"]) == true
        host = text(environment["KEYFRAMER_INSPECTOR_HOST"]) ?? text(arguments["keyframerHost"])
        port = text(environment["KEYFRAMER_INSPECTOR_PORT"]).flatMap(Int.init) ?? text(arguments["keyframerPort"]).flatMap(Int.init)
        reportSystemAnimations = flag(environment["KEYFRAMER_INSPECTOR_SYSTEM"]) ?? flag(arguments["keyframerSystem"])
    }

    /// This process's: its environment and launch arguments (only the arguments' domain, so a value an
    /// app happened to store in its own defaults turns nothing on).
    public static var current: LaunchOptions {
        LaunchOptions(
            environment: ProcessInfo.processInfo.environment,
            arguments: UserDefaults.standard.volatileDomain(forName: UserDefaults.argumentDomain)
        )
    }

    /// Asked for at launch: turned on, or given a host, and not turned off.
    public var asked: Bool {
        enabled ?? (host != nil)
    }
}
#endif
