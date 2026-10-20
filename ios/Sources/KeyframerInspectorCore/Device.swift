import Foundation

/// The device the app runs on, so a relay or a CI runner can tell two apps apart (an iPhone 16 Pro and
/// an iPhone 17 simulator on one runtime).
///
/// Privacy: `name` and `id` come only from a simulator. A physical device says its hardware model
/// (`iPhone17,1`) and `simulator: false`, never its name: that is usually its owner's ("Catalin's
/// iPhone"), and recordings get shared.
public struct InspectorDevice: Codable, Hashable, Sendable {
    public var name: String?
    public var model: String?
    public var id: String?
    public var simulator: Bool?

    public init(name: String? = nil, model: String? = nil, id: String? = nil, simulator: Bool? = nil) {
        self.name = name
        self.model = model
        self.id = id
        self.simulator = simulator
    }

    public enum Kind: Sendable {
        /// An iOS simulator (decided when the app is built, never from the environment).
        case simulator
        /// A physical iPhone or iPad.
        case device
        /// Mac Catalyst or macOS.
        case mac
    }

    /// What a process of `kind` may say about its device. `model` is the hardware's (`hw.machine` on a
    /// device, `hw.model` on a Mac). A device and a Mac never read the environment nor their paths, so
    /// nothing there can put a name in.
    ///
    /// A simulator says its UDID, name and model from the SIMULATOR_* variables when its process has
    /// them. Without them (some launchers start apps with none), the UDID comes from where the app
    /// lives, `paths` (its home or bundle: `.../Devices/<UDID>/data/...`), and the name from that
    /// simulator's device.plist (`readPlist`). Only those two leave the path, never the path itself:
    /// it holds the Mac's user name. The model is then left out (device.plist has no model
    /// identifier), never the Mac's `arm64`.
    public static func describe(
        _ kind: Kind, environment: [String: String], model: String?,
        paths: [String] = [], readPlist: (String) -> [String: Any]? = { _ in nil }
    ) -> InspectorDevice {
        func value(_ s: String?) -> String? { s.flatMap { $0.isEmpty ? nil : $0 } }
        switch kind {
        case .simulator:
            let modelIdentifier = value(environment["SIMULATOR_MODEL_IDENTIFIER"])
            if let udid = value(environment["SIMULATOR_UDID"]) {
                return InspectorDevice(name: value(environment["SIMULATOR_DEVICE_NAME"]), model: modelIdentifier, id: udid, simulator: true)
            }
            guard let folder = paths.lazy.compactMap(simulatorFolder).first else {
                return InspectorDevice(model: modelIdentifier, simulator: true)
            }
            let name = readPlist("\(folder.path)/device.plist")?["name"] as? String
            return InspectorDevice(name: value(name), model: modelIdentifier, id: folder.udid, simulator: true)
        case .device:
            return InspectorDevice(model: value(model), simulator: false)
        case .mac:
            return InspectorDevice(model: value(model))
        }
    }

    /// A simulator's device folder in a path inside it (`.../Devices/<UDID>/data/Containers/...`, or a
    /// test device set's `<UDID>/data/...`): the folder and its UDID.
    static func simulatorFolder(in path: String) -> (path: String, udid: String)? {
        let pattern = #"^(.*/([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}))/data(/|$)"#
        guard let re = try? NSRegularExpression(pattern: pattern),
              let m = re.firstMatch(in: path, range: NSRange(path.startIndex..., in: path)),
              let folder = Range(m.range(at: 1), in: path), let udid = Range(m.range(at: 2), in: path)
        else { return nil }
        return (String(path[folder]), String(path[udid]).uppercased())
    }

    /// This process's device, read once.
    public static let current: InspectorDevice = {
        #if targetEnvironment(simulator)
        return describe(
            .simulator, environment: ProcessInfo.processInfo.environment, model: nil,
            paths: [NSHomeDirectory(), Bundle.main.bundlePath],
            readPlist: { NSDictionary(contentsOfFile: $0) as? [String: Any] }
        )
        #elseif targetEnvironment(macCatalyst) || os(macOS)
        return describe(.mac, environment: [:], model: sysctlString("hw.model"))
        #else
        return describe(.device, environment: [:], model: machine())
        #endif
    }()

    /// `utsname.machine`: `iPhone17,1` on an iPhone (`arm64` on a Mac, which has `hw.model` instead).
    static func machine() -> String? {
        var u = utsname()
        guard uname(&u) == 0 else { return nil }
        return withUnsafeBytes(of: &u.machine) { raw in
            raw.bindMemory(to: CChar.self).baseAddress.map { String(cString: $0) }
        }
    }

    static func sysctlString(_ name: String) -> String? {
        var size = 0
        guard sysctlbyname(name, nil, &size, nil, 0) == 0, size > 0 else { return nil }
        var bytes = [CChar](repeating: 0, count: size)
        guard sysctlbyname(name, &bytes, &size, nil, 0) == 0 else { return nil }
        return String(cString: bytes)
    }
}
