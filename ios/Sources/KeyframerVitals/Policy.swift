import Foundation

/// The rules that decide whether this device reports, from the cached config (production.md 2.1,
/// "Config and kill switch"). Pure.
enum Policy {
    /// Off on this device for this long after a 401, a 410 or `stop`.
    static let stopSeconds = 7 * 86400.0
    /// A config is fetched again at most once a day (longer when its `ttlSec` says so).
    static let minFetchSeconds = 86400.0

    /// Whether `version` is below `minimum` (numeric dot parts; a pre-release suffix is ignored).
    static func isBelow(_ version: String, minimum: String) -> Bool {
        func parts(_ s: String) -> [Int] {
            let core = s.split(separator: "-", maxSplits: 1).first.map(String.init) ?? s
            return core.split(separator: ".").map { Int($0.filter(\.isNumber)) ?? 0 }
        }
        let a = parts(version), b = parts(minimum)
        for i in 0..<max(a.count, b.count) {
            let x = i < a.count ? a[i] : 0, y = i < b.count ? b[i] : 0
            if x != y { return x < y }
        }
        return false
    }

    /// Whether the reporter may measure and send now.
    static func allows(config: VitalsConfig, stopUntil: Date?, now: Date, sdkVersion: String = Vitals.sdkVersion) -> Bool {
        if let stopUntil, stopUntil > now { return false }
        if !config.enabled || config.stop == true { return false }
        if let min = config.minSdk?["ios"], isBelow(sdkVersion, minimum: min) { return false }
        return true
    }

    /// Whether the cached config is old enough to fetch again.
    static func shouldFetch(fetchedAt: Date?, ttlSec: Double?, now: Date) -> Bool {
        guard let fetchedAt else { return true }
        let age = now.timeIntervalSince(fetchedAt)
        return age < 0 || age >= max(ttlSec ?? 0, minFetchSeconds)
    }

    /// Sampling, decided once per session at its start.
    static func sample(rate: Double, random: Double) -> Bool {
        rate > 0 && random < min(1, rate)
    }
}
