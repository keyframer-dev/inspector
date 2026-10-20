import Foundation

/// One frame as the field counts it: how long it took, the budget it was counted against, and how
/// many vsyncs it missed.
struct VitalsFrame: Equatable {
    var ms: Double
    var budget: Double
    var missed: Int
}

/// The frame meter's math, copied from KeyframerInspectorCore's FrameMeter (itself a port of
/// react-native/src/frameMeter.ts) so field and local numbers agree; the field reporter does not
/// link the development inspector's core (it holds the relay protocol and simulator-only code). A
/// parity test feeds both the same ticks.
///
/// Gap based: `missed = round(dt / interval) - 1`, the interval being what most frames of the last
/// 250 ms window took, snapped to 60/90/120 Hz and never faster than the display (`hz`).
struct VitalsFrameMeter {
    let windowMs: Double
    private(set) var interval: Double = 1000 / 60
    /// The rate frames are counted against: the display's top rate, or 60 on an iPhone app without
    /// CADisableMinimumFrameDurationOnPhone. Setting it starts again from its budget.
    var hz: Double? {
        didSet { if let hz, hz > 0 { interval = 1000 / hz } }
    }

    private var last: Double = -1
    private var windowStart: Double = -1
    private var frames = 0
    private var fast = 0
    private var mid = 0

    init(windowMs: Double = 250, hz: Double? = nil) {
        self.windowMs = windowMs
        self.hz = hz
        if let hz, hz > 0 { interval = 1000 / hz }
    }

    /// The rate the app's frames are counted against now: 60, 90 or 120 (or the display's lower cap).
    var targetHz: Double { (1000 / interval).rounded() }

    /// Measures from `t` (ms) as if a frame was drawn then: where a motion window opens, so a stall
    /// right after it (before the display link's first callback) is a long frame.
    mutating func start(at t: Double) {
        last = t
        windowStart = t
    }

    /// Forgets the last frame: the link stopped, and the next tick is a new baseline.
    mutating func pause() {
        last = -1
    }

    /// A frame was drawn at `t` (ms). Nil for the baseline tick and for a tick not later than the last.
    mutating func tick(_ t: Double) -> VitalsFrame? {
        let previous = last
        if previous >= 0 && t <= previous { return nil }
        last = t
        if previous < 0 {
            windowStart = t
            return nil
        }
        let dt = t - previous
        let budget = interval
        if dt < 10.5 { fast += 1 } else if dt < 13 { mid += 1 }
        let lost = max(0, Int((dt / interval).rounded(.toNearestOrAwayFromZero)) - 1)
        frames += 1
        if t - windowStart >= windowMs {
            let n = frames
            let learned = fast * 2 > n ? 1000.0 / 120 : (fast + mid) * 2 > n ? 1000.0 / 90 : 1000.0 / 60
            interval = hz.map { $0 > 0 ? max(learned, 1000 / $0) : learned } ?? learned
            frames = 0
            fast = 0
            mid = 0
            windowStart = t
        }
        return VitalsFrame(ms: dt, budget: budget, missed: lost)
    }
}
