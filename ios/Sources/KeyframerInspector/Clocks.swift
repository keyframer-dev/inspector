#if canImport(UIKit)
import QuartzCore
import UIKit

/// Slow motion, pause and step for Core Animation (the `time` message): the key window's layer runs on
/// a clock of the inspector's (speed, beginTime, timeOffset), and every animation under it follows,
/// whoever started it: UIView.animate, property animators, keyframes, springs, hand-built ones. Core
/// Animation computes them from that clock in the render server, so nothing per animation is touched.
///
/// Changing speed keeps the window's local time continuous (TimeControl). Back at 1 the speed is the
/// app's again but the clock still lags the real one by the time spent slowed; the window gets its own
/// timing back as soon as nothing animates under it (or after a few seconds, when something repeats
/// forever), and at once when the editor leaves. A window that becomes key while time runs slowed
/// joins at the same speed.
///
/// What does not follow: SwiftUI's own animations (its renderer runs them on the main thread from its
/// clock, except the ones KeyframerInspectorSwiftUI can reach), UIScrollView deceleration, UIKit
/// Dynamics and the app's own CADisplayLinks and timers.
@MainActor final class WindowClocks {
    private final class Entry {
        weak var layer: CALayer?
        var control: TimeControl
        /// Since when it waits to get its own timing back.
        var settling: CFTimeInterval?

        init(layer: CALayer) {
            self.layer = layer
            control = TimeControl(original: LayerTiming(speed: Double(layer.speed), beginTime: layer.beginTime, timeOffset: layer.timeOffset))
        }
    }

    /// How long a window may keep running behind the real clock after 1x, with something animating.
    private static let maxSettle: CFTimeInterval = 5
    /// A layer tree bigger than this counts as busy (walking it would cost more than it saves).
    private static let maxLayersWalked = 4000

    private var entries: [ObjectIdentifier: Entry] = [:]
    /// What every controlled window runs at, and what the app answers to `time`.
    private(set) var scale: Double = 1

    /// The window layers whose clock the inspector holds (the scrubber leaves them alone).
    var layers: [CALayer] { entries.values.compactMap(\.layer) }

    func set(scale: Double, keyWindow: CALayer?, now: CFTimeInterval) {
        self.scale = scale
        if let keyWindow { adopt(keyWindow, now: now) }
        for entry in entries.values {
            guard let layer = entry.layer else { continue }
            // Already there (a step repeats the pause, 1x again while settling): nothing to change.
            if entry.control.scale == scale { continue }
            apply(entry.control.set(scale: scale, atMedia: now), to: layer)
            entry.settling = scale == 1 ? now : nil
        }
        prune()
    }

    /// While paused: every controlled window `frames` frames of a `hz` display forward.
    func step(frames: Double, hz: Double, now: CFTimeInterval) {
        for entry in entries.values {
            guard let layer = entry.layer, let timing = entry.control.step(frames: frames, hz: hz, atMedia: now) else { continue }
            apply(timing, to: layer)
        }
    }

    /// The app's own timing back on every window, now (the editor left).
    func restore(now: CFTimeInterval) {
        scale = 1
        for entry in entries.values {
            guard let layer = entry.layer, !entry.control.isRestored else { continue }
            apply(entry.control.restore(atMedia: now), to: layer)
            entry.settling = nil
        }
    }

    /// A window that became key while time runs at another speed joins it. Checked a few times a second.
    func follow(keyWindow: CALayer?, now: CFTimeInterval) {
        guard scale != 1, let keyWindow, entries[ObjectIdentifier(keyWindow)]?.layer !== keyWindow else { return }
        adopt(keyWindow, now: now)
        if let entry = entries[ObjectIdentifier(keyWindow)] { apply(entry.control.set(scale: scale, atMedia: now), to: keyWindow) }
    }

    /// After 1x: hands each window its own timing once nothing animates under it, so its clock is the
    /// real one again (app code that sets beginTime from CACurrentMediaTime() relies on that).
    func settle(now: CFTimeInterval) {
        for entry in entries.values {
            guard let since = entry.settling, let layer = entry.layer else { continue }
            if now - since > Self.maxSettle || !Self.animates(layer) {
                apply(entry.control.restore(atMedia: now), to: layer)
                entry.settling = nil
            }
        }
    }

    /// The window `layer` is in and its clock's history, when the inspector has touched that clock.
    func context(of layer: CALayer) -> (root: CALayer, map: TimeMap)? {
        guard !entries.isEmpty else { return nil }
        var cur: CALayer? = layer
        var depth = 0
        while let c = cur, depth < 256 {
            if let entry = entries[ObjectIdentifier(c)], entry.layer === c {
                return entry.control.map.changes.isEmpty ? nil : (c, entry.control.map)
            }
            cur = c.superlayer
            depth += 1
        }
        return nil
    }

    /// A new recording starts: older history is not needed to scrub it.
    func forget(before media: CFTimeInterval) {
        for entry in entries.values { entry.control.forget(before: media) }
    }

    private func adopt(_ layer: CALayer, now: CFTimeInterval) {
        let id = ObjectIdentifier(layer)
        if entries[id]?.layer === layer { return }
        entries[id] = Entry(layer: layer)
    }

    private func prune() {
        entries = entries.filter { $0.value.layer != nil }
    }

    private func apply(_ timing: LayerTiming, to layer: CALayer) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        layer.speed = Float(timing.speed)
        layer.beginTime = timing.beginTime
        layer.timeOffset = timing.timeOffset
        CATransaction.commit()
    }

    /// Whether any animation of the app's (not the inspector's pins and scrub copies) is attached
    /// somewhere under `root`.
    private static func animates(_ root: CALayer) -> Bool {
        var stack = [root]
        var walked = 0
        while let layer = stack.popLast() {
            walked += 1
            if walked > maxLayersWalked { return true }
            if let keys = layer.animationKeys(), keys.contains(where: { !$0.hasPrefix("kf.") }) { return true }
            if let subs = layer.sublayers { stack += subs }
            if let mask = layer.mask { stack.append(mask) }
        }
        return false
    }
}
#endif
