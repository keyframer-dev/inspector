import Foundation

/// Drops repeated values from per-frame samples without changing what the panel draws.
///
/// The panel interpolates linearly between samples, so a value that holds still and then moves needs
/// the last held sample right before the move, not only the first one: a hold from 0 to 1000 ms then a
/// move at 1016 ms keeps (0, 0), (1000, 0) and (1016, v). A recording of a screen full of layers would
/// otherwise send every value of every layer every frame.
public struct SampleCompressor: Sendable {
    private struct Track: Sendable {
        var emitted: (t: Double, v: Double)
        var held: (t: Double, v: Double)?
    }

    private var tracks: [String: Track] = [:]
    public let epsilon: Double

    public init(epsilon: Double = 1e-6) {
        self.epsilon = epsilon
    }

    /// The samples to send for one reading.
    public mutating func push(id: String, t: Double, v: Double) -> [InspectorSample] {
        guard var track = tracks[id] else {
            tracks[id] = Track(emitted: (t, v), held: nil)
            return [InspectorSample(id: id, t: t, v: v)]
        }
        if abs(v - track.emitted.v) <= epsilon {
            track.held = (t, v)
            tracks[id] = track
            return []
        }
        var out: [InspectorSample] = []
        if let held = track.held, held.t > track.emitted.t { out.append(InspectorSample(id: id, t: held.t, v: held.v)) }
        out.append(InspectorSample(id: id, t: t, v: v))
        tracks[id] = Track(emitted: (t, v), held: nil)
        return out
    }

    /// The last held value of every track (the end of a recording), then forgets them all.
    public mutating func finish() -> [InspectorSample] {
        let out = tracks.compactMap { id, track -> InspectorSample? in
            guard let held = track.held, held.t > track.emitted.t else { return nil }
            return InspectorSample(id: id, t: held.t, v: held.v)
        }
        tracks = [:]
        return out.sorted { $0.t < $1.t }
    }
}
