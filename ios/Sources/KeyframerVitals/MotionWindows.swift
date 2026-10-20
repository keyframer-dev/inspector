import Foundation

/// When the frame meter may run (production.md 2.1, "Motion windows"): from an animation's start to
/// its expected end, from a touch down to 1.5 s after the last touch up (scroll deceleration), plus
/// 250 ms after the last window closes. Outside them nothing runs: no display link, no timer.
struct MotionWindows {
    static let touchTailMs = 1500.0
    static let closeTailMs = 250.0
    /// Animations that repeat forever (or for very long) keep the meter on for this long at most: a
    /// spinner is measured for its first seconds, not for as long as the screen is open.
    static let longestRunMs = 5000.0

    private(set) var openUntil = -Double.infinity
    private var touches = Set<Int>()
    private var touchUntil = -Double.infinity
    private var scrolling = false

    /// An animation (or a traced change) from `start` to `end`.
    mutating func animation(start: Double, end: Double) {
        openUntil = max(openUntil, min(end, start + Self.longestRunMs))
    }

    /// A finger went down. `scroll`: over a scroll view.
    mutating func touchBegan(_ id: Int, scroll: Bool, at t: Double) {
        if touches.isEmpty { scrolling = false }
        touches.insert(id)
        scrolling = scrolling || scroll
        touchUntil = max(touchUntil, t)
    }

    mutating func touchEnded(_ id: Int, at t: Double) {
        guard touches.remove(id) != nil else { return }
        if touches.isEmpty { touchUntil = t + Self.touchTailMs }
    }

    /// Every finger lifted or cancelled at once (the app resigned active).
    mutating func cancelTouches(at t: Double) {
        if !touches.isEmpty { touchUntil = t + Self.touchTailMs }
        touches = []
    }

    /// The touch window at `t`: a finger is down, or one lifted less than 1.5 s ago.
    func touch(at t: Double) -> TouchState {
        guard !touches.isEmpty || t <= touchUntil else { return .none }
        return scrolling ? .scroll : .gesture
    }

    /// Whether the meter should run at `t`.
    func isOpen(at t: Double) -> Bool {
        !touches.isEmpty || t <= max(openUntil, touchUntil) + Self.closeTailMs
    }

    /// Forgets everything (the app went to the background).
    mutating func reset() {
        self = MotionWindows()
    }
}
