import Foundation

/// Counts one thread's frames while a recording runs: its frame rate per window and every long frame.
/// A line-for-line port of react-native/src/frameMeter.ts, so iOS and React Native recordings
/// read the same. The refresh interval is what most frames of the last window took, snapped to
/// 60/90/120 Hz: not the shortest, because a jittery loop sometimes delivers two callbacks a few ms apart.
///
/// With `hz` (the display's rate, InspectorDisplay.hz) the meter starts from that frame budget instead
/// of 60 Hz, so the first window of a 120 Hz recording is not measured against 16.7 ms, and it never
/// learns a rate faster than the display can show.
public struct FrameMeter: Sendable {
    public let thread: InspectorThread
    public let windowMs: Double
    public private(set) var interval: Double = 1000 / 60
    /// The display's top rate. Setting it (Low Power Mode capped the display) starts again from its budget.
    public var hz: Double? {
        didSet { if let hz, hz > 0 { interval = 1000 / hz } }
    }

    private var last: Double = -1
    private var windowStart: Double = -1
    private var frames = 0
    private var dropped = 0
    private var fast = 0
    private var mid = 0
    /// Finished windows and long frames, drained by the caller.
    public var stats: [InspectorFrameStat] = []
    public var drops: [InspectorFrameDrop] = []

    public init(thread: InspectorThread, windowMs: Double = 250, hz: Double? = nil) {
        self.thread = thread
        self.windowMs = windowMs
        self.hz = hz
        if let hz, hz > 0 { interval = 1000 / hz }
    }

    /// Measures from `t` (ms) as if a frame was drawn then: where a recording starts. A main-thread
    /// stall right after it (before the display link's first callback) is then a long frame, where the
    /// first tick after the stall would otherwise have been the baseline (QA 0.2.0, N1).
    public mutating func start(at t: Double) {
        last = t
        windowStart = t
    }

    /// A frame was drawn at `t` (ms). A tick that is not later than the last one (a display link
    /// timestamp from just before `start`) is left out.
    public mutating func tick(_ t: Double) {
        let previous = last
        if previous >= 0 && t <= previous { return }
        last = t
        if previous < 0 {
            windowStart = t
            return
        }
        let dt = t - previous
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
            let learned = fast * 2 > n ? 1000.0 / 120 : (fast + mid) * 2 > n ? 1000.0 / 90 : 1000.0 / 60
            interval = hz.map { $0 > 0 ? max(learned, 1000 / $0) : learned } ?? learned
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
