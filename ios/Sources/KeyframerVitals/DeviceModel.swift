import Foundation

/// Device class from the model identifier and memory. The server keeps the authoritative table (it maps
/// models to names and tiers); this is the device's own guess, sent as `tier` so reports from models
/// the server does not know yet still slice.
enum DeviceModel {
    /// `iPhone15,3` → ("iPhone", 15). Nil for anything else (`arm64` from a Mac, a simulator without
    /// its variables).
    static func parse(_ model: String) -> (family: String, major: Int)? {
        let letters = model.prefix { $0.isLetter }
        let rest = model.dropFirst(letters.count)
        guard !letters.isEmpty, let major = Int(rest.prefix { $0.isNumber }), rest.dropFirst(String(major).count).first == "," else { return nil }
        return (String(letters), major)
    }

    /// iPhone: A11 and A12 (iPhone10, iPhone11) low, A13 to A15 (iPhone12 to iPhone14) mid, A16 and later
    /// high. iPad: up to A12 low, A13 mid, A14 / M1 and later high. Under 3 GB of memory is low whatever
    /// the chip; an unknown model goes by memory alone.
    static func tier(model: String?, memoryGb: Double?) -> VitalsTier? {
        var tier: VitalsTier?
        if let model, let p = parse(model) {
            switch p.family {
            case "iPhone": tier = p.major <= 11 ? .low : p.major <= 14 ? .mid : .high
            case "iPad": tier = p.major <= 11 ? .low : p.major == 12 ? .mid : .high
            case "iPod": tier = .low
            default: break
            }
        }
        if let memoryGb, memoryGb > 0 {
            if memoryGb < 3 { return .low }
            if tier == nil { tier = memoryGb < 6 ? .mid : .high }
        }
        return tier
    }

    /// Physical memory in whole gigabytes (a 4 GB iPhone reports a little less).
    static func memoryGb(bytes: UInt64) -> Double {
        (Double(bytes) / 1_073_741_824).rounded()
    }

    /// `utsname.machine`: `iPhone17,1` on a device. A simulator says its simulated model instead.
    static func identifier(environment: [String: String] = ProcessInfo.processInfo.environment) -> String? {
        #if targetEnvironment(simulator)
        if let m = environment["SIMULATOR_MODEL_IDENTIFIER"], !m.isEmpty { return m }
        #endif
        var u = utsname()
        guard uname(&u) == 0 else { return nil }
        let machine = withUnsafeBytes(of: &u.machine) { raw in
            String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self)
        }
        return machine.isEmpty ? nil : machine
    }
}
