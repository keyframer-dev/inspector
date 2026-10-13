#if canImport(UIKit)
import QuartzCore
import UIKit

/// An animation the app added, kept so a scrub can put it back on the layer's timeline after it
/// finished. `anim` is a private copy: no delegate (UIKit's completion must never fire twice) and
/// with the values UIKit leaves implicit filled in.
struct RecordedAnimation {
    weak var layer: CALayer?
    let anim: CAAnimation
    /// When it began, in media time (CACurrentMediaTime).
    let begin: CFTimeInterval
    /// The layer kept its end value afterwards (UIKit sets the model first): held after it ends. A
    /// transient one (a spin that leaves the model alone) shows only while it runs.
    var holdsEnd = true
}

/// Holds layer properties at recorded values for playback and capture.
///
/// A value is pinned with an animation of the inspector's own (`kf.pin.<path>`, from = to = value,
/// added last so it wins over the app's), not by writing the model: the app's state stays what it
/// was, and releasing the pins hands the layer straight back. Scroll offsets are the exception: the
/// real scroll view is scrolled, like React Native scrolls the real list.
@MainActor final class PinBoard {
    private var pinned: [ObjectIdentifier: (layer: WeakBox<CALayer>, keys: Set<String>)] = [:]

    var isEmpty: Bool { pinned.isEmpty }

    func set(_ layer: CALayer, path: String, value: Double) {
        if let scroll = layer.delegate as? UIScrollView, path.hasPrefix("bounds.origin.") {
            var offset = scroll.contentOffset
            if path.hasSuffix(".x") { offset.x = value } else { offset.y = value }
            scroll.setContentOffset(offset, animated: false)
            return
        }
        let key = "kf.pin.\(path)"
        let pin = CABasicAnimation(keyPath: path)
        pin.fromValue = value
        pin.toValue = value
        pin.beginTime = layer.convertTime(CACurrentMediaTime(), from: nil) - 1
        pin.duration = 1e7
        pin.fillMode = .both
        pin.isRemovedOnCompletion = false
        layer.add(pin, forKey: key)
        let id = ObjectIdentifier(layer)
        var entry = pinned[id] ?? (WeakBox(layer), [])
        entry.keys.insert(key)
        pinned[id] = entry
    }

    func releaseAll() {
        for (_, entry) in pinned {
            guard let layer = entry.layer.value else { continue }
            for key in entry.keys { layer.removeAnimation(forKey: key) }
        }
        pinned = [:]
    }
}

/// Seeks Core Animation's own timeline: every animated layer is frozen (`speed = 0`) and moved with
/// `timeOffset`, so springs and keyframes show exactly what they rendered, between samples too.
///
/// Animations that already finished are put back from the recorded copies, each at the moment it
/// began (`beginTime` on the layer's clock); the app's attached animations are never removed (that
/// would fire their completion handlers). `end()` takes the copies off and restores each layer's
/// speed, timeOffset and beginTime, so the app continues on the real clock as if nothing happened.
@MainActor final class Scrubber {
    private struct Frozen {
        let layer: WeakBox<CALayer>
        let speed: Float
        let timeOffset: CFTimeInterval
        let beginTime: CFTimeInterval
        let clock: LayerClock
        var added: [String]
    }

    private var frozen: [ObjectIdentifier: Frozen] = [:]
    private var copies = 0

    var isActive: Bool { !frozen.isEmpty }

    /// `media`: the moment to show, in media time.
    func seek(toMedia media: CFTimeInterval, live: [CALayer], recorded: [RecordedAnimation]) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        defer { CATransaction.commit() }
        if !isActive { begin(live: live, recorded: recorded) }
        for (_, f) in frozen {
            f.layer.value?.timeOffset = f.clock.local(atMedia: media)
        }
    }

    private func begin(live: [CALayer], recorded: [RecordedAnimation]) {
        let now = CACurrentMediaTime()
        func freeze(_ layer: CALayer) -> Frozen {
            let id = ObjectIdentifier(layer)
            if let f = frozen[id] { return f }
            let local0 = layer.convertTime(now, from: nil)
            let rate = layer.convertTime(now + 1, from: nil) - local0
            let f = Frozen(layer: WeakBox(layer), speed: layer.speed, timeOffset: layer.timeOffset, beginTime: layer.beginTime, clock: LayerClock(local0: local0, media0: now, rate: rate), added: [])
            frozen[id] = f
            return f
        }
        for layer in live { _ = freeze(layer) }
        // Core Animation applies a layer's animations in beginTime order (a later one wins where they
        // overlap), whatever order they were added in. Each copy keeps its own beginTime, held after it
        // ends only when the layer kept its end value. Under them, per property (`transform` covers
        // `transform.rotation.z`), a constant at the first held animation's start value, beginning
        // long before: what the layer showed before anything ran.
        var based = Set<String>()
        for rec in recorded.sorted(by: { $0.begin < $1.begin }) {
            guard let layer = rec.layer, let copy = rec.anim.copy() as? CAAnimation else { continue }
            var f = freeze(layer)
            let begin = f.clock.local(atMedia: rec.begin)
            let root = AnimationInfo.keyPath(of: copy).split(separator: ".").first.map(String.init) ?? ""
            if rec.holdsEnd, based.insert("\(ObjectIdentifier(layer).hashValue)|\(root)").inserted, let base = Self.startValue(of: copy) {
                let hold = CABasicAnimation(keyPath: base.keyPath)
                hold.fromValue = base.value
                hold.toValue = base.value
                hold.beginTime = begin - 100_000
                hold.duration = 100_000
                hold.fillMode = .both
                hold.isRemovedOnCompletion = false
                copies += 1
                layer.add(hold, forKey: "kf.scrub.\(copies)")
                f.added.append("kf.scrub.\(copies)")
            }
            copy.beginTime = begin
            // A UIKit copy reads beginTime as a delay ("relative"): this one is a time on the layer's clock.
            if copy.value(forKey: "beginTimeMode") != nil { copy.setValue("absolute", forKey: "beginTimeMode") }
            copy.fillMode = rec.holdsEnd ? .forwards : .removed
            copy.isRemovedOnCompletion = false
            copies += 1
            let key = "kf.scrub.\(copies)"
            layer.add(copy, forKey: key)
            f.added.append(key)
            frozen[ObjectIdentifier(layer)] = f
        }
        for (_, f) in frozen {
            guard let layer = f.layer.value else { continue }
            layer.timeOffset = f.clock.local0
            layer.speed = 0
        }
    }

    /// The value an animation starts from, when it states one.
    private static func startValue(of anim: CAAnimation) -> (keyPath: String, value: Any)? {
        switch anim {
        case let basic as CABasicAnimation:
            guard !basic.isAdditive, let keyPath = basic.keyPath, let from = basic.fromValue else { return nil }
            return (keyPath, from)
        case let keyframes as CAKeyframeAnimation:
            guard !keyframes.isAdditive, let keyPath = keyframes.keyPath, let first = keyframes.values?.first else { return nil }
            return (keyPath, first)
        default:
            return nil
        }
    }

    func end() {
        guard isActive else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for (_, f) in frozen {
            guard let layer = f.layer.value else { continue }
            for key in f.added { layer.removeAnimation(forKey: key) }
            layer.speed = f.speed
            layer.timeOffset = f.timeOffset
            layer.beginTime = f.beginTime
        }
        CATransaction.commit()
        frozen = [:]
    }
}
#endif
