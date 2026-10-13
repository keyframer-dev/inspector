import Foundation

/// Counts one thread's frames while a recording runs: its frame rate per window and every long frame.
/// A line-for-line port of react-native/src/frameMeter.ts, so iOS and React Native recordings
/// read the same. The refresh interval is what most frames of the last window took, snapped to
/// 60/90/120 Hz: not the shortest, because a jittery loop sometimes delivers two callbacks a few ms apart.
public struct FrameMeter: Sendable {
    public let thread: InspectorThread
    public let windowMs: Double
    public private(set) var interval: Double = 1000 / 60
    private var last: Double = -1
    private var windowStart: Double = -1
    private var frames = 0
    private var dropped = 0
    private var fast = 0
    private var mid = 0
    /// Finished windows and long frames, drained by the caller.
    public var stats: [InspectorFrameStat] = []
    public var drops: [InspectorFrameDrop] = []

    public init(thread: InspectorThread, windowMs: Double = 250) {
        self.thread = thread
        self.windowMs = windowMs
    }

    /// A frame was drawn at `t` (ms).
    public mutating func tick(_ t: Double) {
        let previous = last
        last = t
        if previous < 0 {
            windowStart = t
            return
        }
        let dt = t - previous
        if dt <= 0 { return }
        if dt < 10.5 { fast += 1 } else if dt < 13 { mid += 1 }
        let lost = max(0, Int((dt / interval).rounded(.toNearestOrAwayFromZero)) - 1)
        if lost > 0 {
            dropped += lost
            drops.append(InspectorFrameDrop(t: t, thread: thread, ms: (dt * 10).rounded() / 10, dropped: lost))
        }
        frames += 1
        let span = t - windowStart
        if span >= windowMs {
            stats.append(InspectorFrameStat(t: t, thread: thread, fps: (Double(frames) * 1000 / span).rounded(), dropped: dropped))
            let n = frames
            interval = fast * 2 > n ? 1000 / 120 : (fast + mid) * 2 > n ? 1000 / 90 : 1000 / 60
            frames = 0
            dropped = 0
            fast = 0
            mid = 0
            windowStart = t
        }
    }

    public mutating func drain() -> (stats: [InspectorFrameStat], drops: [InspectorFrameDrop]) {
        defer {
            stats = []
            drops = []
        }
        return (stats, drops)
    }
}
