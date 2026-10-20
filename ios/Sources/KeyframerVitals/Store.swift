import Foundation

/// What the reporter keeps on the device, and nothing else:
///
/// - UserDefaults (suite `dev.keyframer.vitals`, required reason CA92.1): the cached project config and
///   when it was fetched, the kill switch's end, and today's count of reported sessions (local only,
///   never sent).
/// - Application Support/KeyframerVitals (excluded from backups): the open window's checkpoint and the
///   retry queue. Each entry carries its save time in its own JSON, so no file timestamps are read.
///
/// No identifier is stored: a stored report holds its session's nonce only until it is sent, and a
/// session is never resumed from disk.
final class VitalsStore {
    static let maxPending = 5
    static let maxPendingBytes = 100 * 1024
    static let pendingDays = 7.0

    struct Pending: Codable, Equatable {
        var id: String
        /// Seconds since 1970, when it was saved. Local only: reports never carry absolute times.
        var savedAt: Double
        var body: Data
    }

    let directory: URL
    let defaults: UserDefaults
    private let now: () -> Date

    init(directory: URL, defaults: UserDefaults, now: @escaping () -> Date = Date.init) {
        self.directory = directory
        self.defaults = defaults
        self.now = now
    }

    /// The app's store: Application Support/KeyframerVitals and the `dev.keyframer.vitals` suite.
    static func standard() -> VitalsStore {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        return VitalsStore(directory: base.appendingPathComponent("KeyframerVitals", isDirectory: true), defaults: UserDefaults(suiteName: "dev.keyframer.vitals") ?? .standard)
    }

    private func ensureDirectory() {
        guard !FileManager.default.fileExists(atPath: directory.path) else { return }
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var url = directory
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? url.setResourceValues(values)
    }

    // MARK: Config and kill switch

    private enum Key {
        static let config = "config"
        static let configFetchedAt = "configFetchedAt"
        static let stopUntil = "stopUntil"
        static let day = "day"
        static let dayCount = "dayCount"
    }

    func config() -> (config: VitalsConfig, fetchedAt: Date)? {
        guard let data = defaults.data(forKey: Key.config),
              let config = try? JSONDecoder().decode(VitalsConfig.self, from: data) else { return nil }
        let at = defaults.double(forKey: Key.configFetchedAt)
        return (config, Date(timeIntervalSince1970: at))
    }

    func saveConfig(_ config: VitalsConfig) {
        guard let data = try? JSONEncoder().encode(config) else { return }
        defaults.set(data, forKey: Key.config)
        defaults.set(now().timeIntervalSince1970, forKey: Key.configFetchedAt)
    }

    /// Until when the reporter is off on this device (401, 410 or `stop` from ingest).
    var stopUntil: Date? {
        get {
            let t = defaults.double(forKey: Key.stopUntil)
            return t > 0 ? Date(timeIntervalSince1970: t) : nil
        }
        set {
            if let newValue { defaults.set(newValue.timeIntervalSince1970, forKey: Key.stopUntil) } else { defaults.removeObject(forKey: Key.stopUntil) }
        }
    }

    // MARK: Sessions per day

    /// Takes one of today's reported sessions (at most `limit` a day); false when today's are used up.
    func takeSessionSlot(limit: Int = Vitals.maxSessionsPerDay) -> Bool {
        let today = Self.dayKey(now())
        var count = defaults.string(forKey: Key.day) == today ? defaults.integer(forKey: Key.dayCount) : 0
        guard count < limit else { return false }
        count += 1
        defaults.set(today, forKey: Key.day)
        defaults.set(count, forKey: Key.dayCount)
        return true
    }

    static func dayKey(_ date: Date) -> String {
        let c = Calendar.current.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    // MARK: Checkpoint

    private var checkpointURL: URL { directory.appendingPathComponent("checkpoint.json") }
    private var queueURL: URL { directory.appendingPathComponent("pending.json") }

    func writeCheckpoint(_ body: Data) {
        ensureDirectory()
        try? body.write(to: checkpointURL, options: [.atomic])
    }

    func clearCheckpoint() {
        try? FileManager.default.removeItem(at: checkpointURL)
    }

    /// The checkpoint a previous launch left (it ended without going to the background), removed.
    func takeCheckpoint() -> Data? {
        guard let data = try? Data(contentsOf: checkpointURL) else { return nil }
        clearCheckpoint()
        return data
    }

    // MARK: Retry queue

    func pending() -> [Pending] {
        guard let data = try? Data(contentsOf: queueURL),
              let list = try? JSONDecoder().decode([Pending].self, from: data) else { return [] }
        return Self.pruned(list, now: now().timeIntervalSince1970)
    }

    /// Saves a report for sending; returns its id. The oldest entries go first past the limits.
    @discardableResult
    func enqueue(_ body: Data) -> String {
        let id = UUID().uuidString
        save(pending() + [Pending(id: id, savedAt: now().timeIntervalSince1970, body: body)])
        return id
    }

    func remove(_ id: String) {
        save(pending().filter { $0.id != id })
    }

    /// Drops everything waiting: `setEnabled(false)` and the kill switch.
    func clearAll() {
        try? FileManager.default.removeItem(at: queueURL)
        clearCheckpoint()
    }

    private func save(_ list: [Pending]) {
        let kept = Self.pruned(list, now: now().timeIntervalSince1970)
        if kept.isEmpty {
            try? FileManager.default.removeItem(at: queueURL)
            return
        }
        ensureDirectory()
        if let data = try? JSONEncoder().encode(kept) { try? data.write(to: queueURL, options: [.atomic]) }
    }

    /// At most 5 reports and 100 KB, none older than 7 days: the newest kept.
    static func pruned(_ list: [Pending], now: Double) -> [Pending] {
        var kept = list.filter { now - $0.savedAt < pendingDays * 86400 && $0.savedAt <= now + 86400 }
        kept.sort { $0.savedAt < $1.savedAt }
        while kept.count > maxPending || kept.reduce(0, { $0 + $1.body.count }) > maxPendingBytes {
            kept.removeFirst()
        }
        return kept
    }
}
