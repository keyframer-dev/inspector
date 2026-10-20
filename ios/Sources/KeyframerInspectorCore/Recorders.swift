import Foundation

/// Who records what: `record`'s `recorder` (an id each editor keeps for its connection; nil is the one
/// anonymous recorder older editors share). The app records while any recorder is on, sampling the
/// union of their signals, so one editor stopping does not stop another's recording (QA 0.2.0, N21).
public struct Recorders: Hashable, Sendable {
    private struct Recorder: Hashable, Sendable {
        var all = false
        var ids = Set<String>()
        var isEmpty: Bool { !all && ids.isEmpty }
    }

    private var byId: [String: Recorder] = [:]

    public init() {}

    /// Nobody records.
    public var isEmpty: Bool { byId.isEmpty }
    /// Some recorder asked for `*`: every value, including ones that appear while recording.
    public var recordsAll: Bool { byId.values.contains { $0.all } }
    /// The signal ids asked for by name, across every recorder.
    public var ids: Set<String> { byId.values.reduce(into: Set<String>()) { $0.formUnion($1.ids) } }
    public var count: Int { byId.count }

    /// `on`: the ids join that recorder (`*`: everything). Off: they leave it, or all of it with `*`.
    /// A recorder left with nothing goes away.
    public mutating func apply(_ signalIds: [String], on: Bool, recorder: String?) {
        let key = recorder ?? ""
        var r = byId[key] ?? Recorder()
        if on {
            if signalIds.contains("*") { r.all = true }
            r.ids.formUnion(signalIds.filter { $0 != "*" })
        } else if signalIds.contains("*") {
            r = Recorder()
        } else {
            r.ids.subtract(signalIds)
        }
        byId[key] = r.isEmpty ? nil : r
    }

    /// The last editor left: every recorder goes.
    public mutating func removeAll() {
        byId = [:]
    }
}
