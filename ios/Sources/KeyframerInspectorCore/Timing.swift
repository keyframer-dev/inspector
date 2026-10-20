import Foundation

/// A layer's own clock (CAMediaTiming): its local time is `(parent - beginTime) * speed + timeOffset`,
/// where `parent` is its superlayer's local time, media time (CACurrentMediaTime) for a window's layer.
public struct LayerTiming: Hashable, Sendable {
    public var speed: Double
    public var beginTime: Double
    public var timeOffset: Double

    public init(speed: Double = 1, beginTime: Double = 0, timeOffset: Double = 0) {
        self.speed = speed
        self.beginTime = beginTime
        self.timeOffset = timeOffset
    }

    public func local(atParent t: Double) -> Double {
        (t - beginTime) * speed + timeOffset
    }

    /// The same clock from `t` on at another speed: local time carries on from where it is, so nothing
    /// under the layer jumps. (Setting `speed` alone would rescale the whole past, a jump of hours.)
    public func retimed(atParent t: Double, speed: Double) -> LayerTiming {
        LayerTiming(speed: speed, beginTime: t, timeOffset: local(atParent: t))
    }
}

/// A window layer's timing over media time, every change the inspector made to it: what lets a
/// recording made in slow motion, or paused and stepped, be scrubbed on its own clock afterwards.
public struct TimeMap: Hashable, Sendable {
    public struct Change: Hashable, Sendable {
        public var media: Double
        public var timing: LayerTiming
    }

    /// Steps add a change each; past this the oldest half is folded into `initial`.
    public static let maxChanges = 4096

    /// The timing before the first change kept.
    public private(set) var initial: LayerTiming
    public private(set) var changes: [Change] = []

    public init(initial: LayerTiming) {
        self.initial = initial
    }

    public var current: LayerTiming { changes.last?.timing ?? initial }

    public func timing(atMedia m: Double) -> LayerTiming {
        // Changes are in time order; the moments asked for are mostly recent ones.
        for change in changes.reversed() where change.media <= m { return change.timing }
        return initial
    }

    /// The layer's local time at media time `m`.
    public func local(atMedia m: Double) -> Double {
        timing(atMedia: m).local(atParent: m)
    }

    public mutating func set(_ timing: LayerTiming, atMedia m: Double) {
        // Media time only moves forward; anything later than `m` would be a clock that went back.
        while let last = changes.last, last.media > m { changes.removeLast() }
        if let last = changes.last, last.media == m {
            changes[changes.count - 1].timing = timing
        } else {
            changes.append(Change(media: m, timing: timing))
        }
        if changes.count > Self.maxChanges { forget(before: changes[changes.count / 2].media) }
    }

    /// Keeps what is needed to read times from `m` on (the start of the last recording).
    public mutating func forget(before m: Double) {
        let atM = timing(atMedia: m)
        let kept = changes.filter { $0.media > m }
        guard kept.count != changes.count else { return }
        initial = atM
        changes = kept
    }
}

/// Slow motion, pause and step for one window layer, as the editor's `time` message asks. Pure state:
/// the caller puts the returned timing on the layer (iOS: the key window's, so every UIView and Core
/// Animation animation under it follows).
///
/// - A speed change keeps local time continuous, so animations slow down or pause where they are.
/// - A step, while paused, moves local time `frames / hz` seconds on: one frame of the display each.
/// - `restore` puts the app's own timing back. Local time then jumps to where the real clock is, so
///   animations still running finish at once; the caller does it when nothing is left to jump (or
///   when the editor is gone).
public struct TimeControl: Hashable, Sendable {
    // The `time` rules every SDK shares (QA 0.2.0, N19): a scale that is not a finite number of at
    // least 0 is ignored (and still answered), 0 pauses, others run between 0.01 and 1 (the panel's
    // speeds and the MCP tool's 0 to 1); a step counts only while paused, in whole frames from 1 to 120.
    /// The fastest: real time.
    public static let maxScale = 1.0
    /// The slowest that still moves; anything slower, but not 0, runs at this.
    public static let minScale = 0.01
    /// The most frames one step advances (the MCP tool's maximum).
    public static let maxStep = 120.0

    /// The window's timing before the inspector touched it.
    public let original: LayerTiming
    public private(set) var map: TimeMap
    /// 1 normal, 0.25 a quarter of the speed, 0 paused.
    public private(set) var scale: Double = 1

    public init(original: LayerTiming) {
        self.original = original
        self.map = TimeMap(initial: original)
    }

    public var timing: LayerTiming { map.current }
    /// Running on the app's own timing again: nothing left to hand back.
    public var isRestored: Bool { scale == 1 && map.current == original }

    /// The scale the app runs at for a requested one: 0 pauses, others between `minScale` and
    /// `maxScale`. Nil (missing, not a number, infinite, negative): ignore the message, though it is
    /// still answered.
    public static func sanitize(scale: Double?) -> Double? {
        guard let scale, scale.isFinite, scale >= 0 else { return nil }
        return scale == 0 ? 0 : min(max(scale, minScale), maxScale)
    }

    /// Whole frames forward (a fraction is floored) from 1 to `maxStep`. Nil: no step (missing, not a
    /// finite number, or not forward). It counts only in a message whose scale is 0.
    public static func sanitize(step: Double?) -> Double? {
        guard let step, step.isFinite, step > 0 else { return nil }
        return min(max(step.rounded(.down), 1), maxStep)
    }

    /// Runs the clock at `scale` times the app's own speed from `now` (media time), without a jump.
    @discardableResult
    public mutating func set(scale: Double, atMedia now: Double) -> LayerTiming {
        self.scale = scale
        // Core Animation keeps speed as a Float: the map holds what the layer will really have.
        let speed = Double(Float(scale * original.speed))
        let timing = map.current.retimed(atParent: now, speed: speed)
        map.set(timing, atMedia: now)
        return timing
    }

    /// While paused: `frames` frames of a `hz` display forward. Nil when not paused.
    @discardableResult
    public mutating func step(frames: Double, hz: Double, atMedia now: Double) -> LayerTiming? {
        guard scale == 0, frames > 0, hz > 0 else { return nil }
        var timing = map.current
        timing.timeOffset += frames / hz * original.speed
        map.set(timing, atMedia: now)
        return timing
    }

    /// The app's own timing again, from `now`.
    @discardableResult
    public mutating func restore(atMedia now: Double) -> LayerTiming {
        scale = 1
        if map.current != original { map.set(original, atMedia: now) }
        return original
    }

    /// Forgets history older than `m` (a new recording starts there).
    public mutating func forget(before m: Double) {
        map.forget(before: m)
    }
}

/// A layer's local time as a function of media time, measured before the layer is frozen: what lets
/// a frozen layer (speed 0) be seeked with `timeOffset` to any moment of the app's own timeline.
public struct LayerClock: Hashable, Sendable {
    public var local0: Double
    public var media0: Double
    /// Local seconds per media second (the product of speeds up the layer tree; 1 almost always). With
    /// a `map`, per second of the window's clock instead.
    public var rate: Double
    /// The time-controlled window's history, when the layer is under one: its clock did not run at one
    /// speed since the recording (slow motion, a pause, steps), so media time goes through it first.
    public var map: TimeMap?

    public init(local0: Double, media0: Double, rate: Double, map: TimeMap? = nil) {
        self.local0 = local0
        self.media0 = media0
        self.rate = rate
        self.map = map
    }

    public func local(atMedia m: Double) -> Double {
        guard let map else { return local0 + (m - media0) * rate }
        return local0 + (map.local(atMedia: m) - map.local(atMedia: media0)) * rate
    }
}
