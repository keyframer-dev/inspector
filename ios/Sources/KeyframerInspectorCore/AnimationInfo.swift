import Foundation
import QuartzCore

/// A Core Animation animation, described the way the protocol describes a Reanimated call:
/// `args = [to, config]`, with times in ms, and `params` naming the numbers the panel may tweak
/// (`"1.duration"` is `args[1].duration`, as on React Native).
public struct AnimationInfo: Sendable {
    /// The animated key path (`position`, `transform.scale`), `transition` for a CATransition, or the
    /// key paths of a group joined with `+`.
    public var keyPath: String
    public var args: [JSONValue]
    public var params: [InspectorParam]
    /// How long it runs, delay included: delay + duration x repeats (twice when it autoreverses), at its
    /// speed. Nil when it repeats forever.
    public var durationMs: Double?

    /// - Parameters:
    ///   - delayMs: how far in the future it begins (its beginTime minus now), in ms.
    ///   - from/to: the values it runs between when the animation leaves them implicit (UIKit sets
    ///     only `fromValue`; the model value is the destination).
    public init(_ anim: CAAnimation, delayMs: Double = 0, from: Any? = nil, to: Any? = nil) {
        var config: [String: JSONValue] = ["animation": .string(String(describing: type(of: anim)))]
        var params: [InspectorParam] = []
        func num(_ key: String, _ value: Double, tweakable: Bool = true) {
            let v = (value * 1000).rounded() / 1000
            config[key] = .number(v)
            if tweakable { params.append(InspectorParam(path: "1.\(key)", value: v)) }
        }
        num("duration", anim.duration * 1000)
        // A delay is a beginTime on the layer's clock, read here but not edited.
        if delayMs > 0.5 { num("delay", delayMs, tweakable: false) }
        if anim.speed != 1 { num("speed", Double(anim.speed)) }
        if anim.repeatCount > 0 { config["repeatCount"] = anim.repeatCount.isFinite ? .number(Double(anim.repeatCount)) : .string("infinite") }
        if anim.autoreverses { config["autoreverses"] = true }
        if let tf = anim.timingFunction { config.merge(Self.timing(tf)) { _, new in new } }
        if anim.isRemovedOnCompletion == false { config["removedOnCompletion"] = false }

        var target: JSONValue = .null
        switch anim {
        case let spring as CASpringAnimation:
            num("mass", Double(spring.mass))
            num("stiffness", Double(spring.stiffness))
            num("damping", Double(spring.damping))
            // What UIKit takes (usingSpringWithDamping:, dampingRatio:): 1 is critically damped.
            let critical = 2 * (Double(spring.stiffness) * Double(spring.mass)).squareRoot()
            if critical > 0 { num("dampingRatio", Double(spring.damping) / critical) }
            num("initialVelocity", Double(spring.initialVelocity))
            num("settlingDuration", spring.settlingDuration * 1000, tweakable: false)
            Self.fromTo(spring, from: from, to: to, into: &config, target: &target)
        case let basic as CABasicAnimation:
            Self.fromTo(basic, from: from, to: to, into: &config, target: &target)
        case let keyframe as CAKeyframeAnimation:
            if let values = keyframe.values {
                config["values"] = .array(values.prefix(32).map(LayerValue.json))
                target = values.last.map(LayerValue.json) ?? .null
            }
            if let times = keyframe.keyTimes { config["keyTimes"] = .array(times.prefix(32).map { .number($0.doubleValue) }) }
            config["calculationMode"] = .string(keyframe.calculationMode.rawValue)
            if keyframe.path != nil { config["path"] = true }
        case let group as CAAnimationGroup:
            config["animations"] = .array((group.animations ?? []).map { .string(Self.keyPath(of: $0)) })
        case let transition as CATransition:
            config["transition"] = .string(transition.type.rawValue)
            if let sub = transition.subtype { config["subtype"] = .string(sub.rawValue) }
        default:
            break
        }
        if let prop = anim as? CAPropertyAnimation, prop.isAdditive { config["additive"] = true }
        self.durationMs = Self.durationMs(of: anim, delayMs: delayMs)
        self.keyPath = Self.keyPath(of: anim)
        self.args = [target, .object(config)]
        self.params = params
    }

    public static func durationMs(of anim: CAAnimation, delayMs: Double = 0) -> Double? {
        var seconds = anim.duration
        if anim.repeatDuration > 0 {
            guard anim.repeatDuration.isFinite else { return nil }
            seconds = anim.repeatDuration
        } else if anim.repeatCount > 0 {
            guard anim.repeatCount.isFinite else { return nil }
            seconds *= Double(anim.repeatCount)
        }
        if anim.autoreverses { seconds *= 2 }
        if anim.speed > 0 { seconds /= Double(anim.speed) }
        return ((max(0, delayMs) + seconds * 1000) * 10).rounded() / 10
    }

    /// UIKit's own bookkeeping animations (a property animator's progress), not motion.
    public static let privateKeyPaths: Set<String> = ["uiFractionalProgress"]

    public static func keyPath(of anim: CAAnimation) -> String {
        switch anim {
        case let p as CAPropertyAnimation: return p.keyPath ?? "?"
        case let g as CAAnimationGroup: return (g.animations ?? []).map(keyPath(of:)).joined(separator: "+")
        case is CATransition: return "transition"
        default: return String(describing: type(of: anim))
        }
    }

    /// `from` and the target are absolute layer values. An additive animation (what UIKit builds for
    /// UIView.animate and property animators) runs a delta on top of the model value, so its own
    /// values go as `delta`/`deltaTo` and the layer's before and after values as from and target.
    private static func fromTo(_ basic: CABasicAnimation, from: Any?, to: Any?, into config: inout [String: JSONValue], target: inout JSONValue) {
        if basic.isAdditive {
            if let f = basic.fromValue { config["delta"] = LayerValue.json(f) }
            if let t = basic.toValue { config["deltaTo"] = LayerValue.json(t) }
            if let from { config["from"] = LayerValue.json(from) }
            target = LayerValue.json(to)
            return
        }
        if let f = basic.fromValue ?? from { config["from"] = LayerValue.json(f) }
        if let by = basic.byValue { config["by"] = LayerValue.json(by) }
        if let t = basic.toValue ?? to { target = LayerValue.json(t) }
    }

    /// The named curve when it is one of Core Animation's, and the control points either way.
    public static func timing(_ tf: CAMediaTimingFunction) -> [String: JSONValue] {
        var p: [Float] = [0, 0]
        var cps: [Double] = []
        for i in 1...2 {
            tf.getControlPoint(at: i, values: &p)
            cps += [Double(p[0]), Double(p[1])]
        }
        let rounded = cps.map { ($0 * 1000).rounded() / 1000 }
        let named: [(String, [Double])] = [
            ("linear", [0, 0, 1, 1]),
            ("easeIn", [0.42, 0, 1, 1]),
            ("easeOut", [0, 0, 0.58, 1]),
            ("easeInEaseOut", [0.42, 0, 0.58, 1]),
            ("default", [0.25, 0.1, 0.25, 1]),
        ]
        var out: [String: JSONValue] = ["bezier": .array(rounded.map { .number($0) })]
        if let name = named.first(where: { $0.1 == rounded })?.0 { out["easing"] = .string(name) }
        return out
    }

    /// A copy of `anim` with the panel's edits for its call site applied (`"1.duration"` → ms), or nil
    /// when nothing applies. A spring whose physics changed also gets the duration it now needs to settle.
    public static func applying(_ edits: [String: Double], to anim: CAAnimation) -> CAAnimation? {
        guard !edits.isEmpty, let copy = anim.copy() as? CAAnimation else { return nil }
        var changed = false
        var physics = false
        var ratio: Double?
        for (path, value) in edits {
            guard path.hasPrefix("1.") else { continue }
            switch String(path.dropFirst(2)) {
            case "duration": copy.duration = value / 1000; changed = true
            case "speed": copy.speed = Float(value); changed = true
            case "mass": (copy as? CASpringAnimation)?.mass = CGFloat(value); physics = true
            case "stiffness": (copy as? CASpringAnimation)?.stiffness = CGFloat(value); physics = true
            case "damping": (copy as? CASpringAnimation)?.damping = CGFloat(value); physics = true
            case "initialVelocity": (copy as? CASpringAnimation)?.initialVelocity = CGFloat(value); physics = true
            case "dampingRatio": ratio = value
            default: continue
            }
        }
        // A damping ratio sets the damping for the spring's (possibly edited) stiffness and mass; an
        // explicit damping wins.
        if let ratio, edits["1.damping"] == nil, let spring = copy as? CASpringAnimation {
            spring.damping = CGFloat(ratio * 2 * (Double(spring.stiffness) * Double(spring.mass)).squareRoot())
            physics = true
        }
        if physics, let spring = copy as? CASpringAnimation {
            changed = true
            if edits["1.duration"] == nil { spring.duration = spring.settlingDuration }
        }
        return changed ? copy : nil
    }
}
