import CoreGraphics
import Foundation
import KeyframerInspectorCore
import SwiftUI

/// A SwiftUI `Animation`, described the way the protocol describes an animation: `config` for
/// `args[1]`, the numbers the panel may tweak (`params`), how long it runs, and the same animation
/// rebuilt with the panel's edits.
///
/// SwiftUI says nothing public about an Animation besides Equatable and its description, so this reads
/// its structure with Mirror: `BezierAnimation` (duration and curve), `FluidSpringAnimation` (response,
/// dampingFraction, blendDuration), `SpringAnimation` (mass, stiffness, damping, initialVelocity),
/// `DefaultAnimation`, and the delay, speed and repeat modifiers, as SwiftUI builds them on iOS 17
/// to 26. Best effort: a shape it does not know is named by its type, with nothing to tweak. Times are
/// in ms, like every SDK's (`response: 500` is `.spring(response: 0.5)`).
public struct SwiftUIAnimationInfo: Equatable {
    public enum Kind: Equatable {
        /// `.linear`, `.easeIn`, `.easeOut`, `.easeInOut`, `.timingCurve`.
        case bezier
        /// `.spring`, `.smooth`, `.snappy`, `.bouncy` (response and damping fraction).
        case spring
        /// `.interpolatingSpring` (mass, stiffness, damping).
        case interpolatingSpring
        /// `.default`: SwiftUI does not say what it is.
        case standard
        /// A type this does not read (a CustomAnimation of the app's own).
        case other(String)
    }

    public enum Repeat: Equatable {
        case count(Int)
        case forever
    }

    public var kind: Kind
    /// Seconds, for a bezier.
    public var duration: Double?
    /// The bezier's control points: x1, y1, x2, y2.
    public var curve: [Double]?
    public var response: Double?
    public var dampingFraction: Double?
    public var blendDuration: Double?
    public var mass: Double?
    public var stiffness: Double?
    public var damping: Double?
    public var initialVelocity: Double?
    /// Seconds.
    public var delay: Double = 0
    public var speed: Double = 1
    public var repeats: Repeat?
    public var autoreverses = false

    public init(_ animation: Animation) {
        kind = .other("Animation")
        var found: Kind?
        var unknown: String?
        read(animation, found: &found, unknown: &unknown, depth: 0)
        kind = found ?? .other(unknown ?? "Animation")
    }

    // MARK: Reading

    private mutating func read(_ value: Any, found: inout Kind?, unknown: inout String?, depth: Int) {
        guard depth < 12 else { return }
        let mirror = Mirror(reflecting: value)
        let type = String(describing: mirror.subjectType)
        let base = type.split(separator: "<").first.map(String.init) ?? type
        func child(_ label: String) -> Any? { mirror.children.first { $0.label == label }.map { Self.unwrap($0.value) } ?? nil }
        func number(_ label: String) -> Double? { child(label).flatMap(Self.number) }
        switch base {
        case "BezierAnimation":
            found = found ?? .bezier
            duration = number("duration")
            curve = child("curve").flatMap(Self.controlPoints)
        case "FluidSpringAnimation":
            found = found ?? .spring
            response = number("response")
            dampingFraction = number("dampingFraction")
            blendDuration = number("blendDuration")
        case "SpringAnimation":
            found = found ?? .interpolatingSpring
            mass = number("mass")
            stiffness = number("stiffness")
            damping = number("damping")
            // A _Velocity wrapper around the number.
            initialVelocity = child("initialVelocity").flatMap { v in Self.number(v) ?? Mirror(reflecting: v).children.first.flatMap { Self.number($0.value) } }
        case "DefaultAnimation":
            found = found ?? .standard
        case "DelayAnimation":
            delay += number("delay") ?? 0
        case "SpeedAnimation":
            speed *= number("speed") ?? 1
        case "RepeatAnimation":
            let count = child("repeatCount").flatMap { $0 as? Int }
            repeats = count.map { .count($0) } ?? .forever
            autoreverses = (child("autoreverses") as? Bool) ?? false
        default:
            let wrapper = base == "Animation" || base.hasPrefix("AnyAnimator") || base.contains("ModifiedContent") || base.hasPrefix("_")
            if !wrapper, unknown == nil, mirror.displayStyle == .struct || mirror.displayStyle == .class { unknown = base }
            for c in mirror.children { read(c.value, found: &found, unknown: &unknown, depth: depth + 1) }
        }
    }

    /// The value inside an Optional, nil for none, the value itself otherwise.
    private static func unwrap(_ value: Any) -> Any? {
        let m = Mirror(reflecting: value)
        guard m.displayStyle == .optional else { return value }
        return m.children.first?.value
    }

    private static func number(_ value: Any) -> Double? {
        switch value {
        case let d as Double: return d
        case let c as CGFloat: return Double(c)
        case let f as Float: return Double(f)
        case let i as Int: return Double(i)
        default: return nil
        }
    }

    /// SwiftUI keeps a bezier as its polynomial (UnitCurve.CubicSolver: x(t) = ax t³ + bx t² + cx t, and
    /// the same for y); the control points come back as x1 = cx / 3, x2 = (bx + 2 cx) / 3.
    private static func controlPoints(_ solver: Any) -> [Double]? {
        let c = Mirror(reflecting: solver).children
        func n(_ label: String) -> Double? { c.first { $0.label == label }.flatMap { number($0.value) } }
        guard let bx = n("bx"), let cx = n("cx"), let by = n("by"), let cy = n("cy") else { return nil }
        return [cx / 3, cy / 3, (bx + 2 * cx) / 3, (by + 2 * cy) / 3].map { ($0 * 1000).rounded() / 1000 }
    }

    // MARK: Protocol

    private static let namedCurves: [(String, [Double])] = [
        ("linear", [0, 0, 1, 1]),
        ("easeIn", [0.42, 0, 1, 1]),
        ("easeOut", [0, 0, 0.58, 1]),
        ("easeInOut", [0.42, 0, 0.58, 1]),
    ]

    /// What made it, as SwiftUI spells it: `easeInOut`, `timingCurve`, `spring`, `interpolatingSpring`,
    /// `default`, or the type of one it does not read.
    public var name: String {
        switch kind {
        case .bezier: return curve.flatMap { c in Self.namedCurves.first { $0.1 == c }?.0 } ?? "timingCurve"
        case .spring: return "spring"
        case .interpolatingSpring: return "interpolatingSpring"
        case .standard: return "default"
        case .other(let type): return type
        }
    }

    /// `args[1]` of the anim event: times in ms.
    public var config: [String: JSONValue] {
        var c: [String: JSONValue] = ["animation": .string(name)]
        func ms(_ s: Double) -> JSONValue { .number(Self.round3(s * 1000)) }
        switch kind {
        case .bezier:
            if let duration { c["duration"] = ms(duration) }
            if let curve {
                c["bezier"] = .array(curve.map { .number($0) })
                if let named = Self.namedCurves.first(where: { $0.1 == curve })?.0 { c["easing"] = .string(named) }
            }
        case .spring:
            if let response { c["response"] = ms(response) }
            if let dampingFraction { c["dampingFraction"] = .number(Self.round3(dampingFraction)) }
            if let blendDuration, blendDuration > 0 { c["blendDuration"] = ms(blendDuration) }
        case .interpolatingSpring:
            for (key, value) in [("mass", mass), ("stiffness", stiffness), ("damping", damping), ("initialVelocity", initialVelocity)] {
                if let value { c[key] = .number(Self.round3(value)) }
            }
        case .standard, .other:
            break
        }
        if let settling = settlingDuration { c["settlingDuration"] = ms(settling) }
        if delay > 0 { c["delay"] = ms(delay) }
        if speed != 1 { c["speed"] = .number(Self.round3(speed)) }
        switch repeats {
        case .count(let n)?: c["repeatCount"] = .number(Double(n))
        case .forever?: c["repeatCount"] = "infinite"
        case nil: break
        }
        if autoreverses { c["autoreverses"] = true }
        return c
    }

    /// The numbers the panel may tweak: what `applying` can rebuild.
    public var params: [InspectorParam] {
        var p: [InspectorParam] = []
        func add(_ key: String, _ value: Double?, ms: Bool = false) {
            if let value { p.append(InspectorParam(path: "1.\(key)", value: Self.round3(ms ? value * 1000 : value))) }
        }
        switch kind {
        case .bezier where curve != nil:
            add("duration", duration, ms: true)
        case .spring:
            add("response", response, ms: true)
            add("dampingFraction", dampingFraction)
        case .interpolatingSpring:
            add("mass", mass)
            add("stiffness", stiffness)
            add("damping", damping)
            add("initialVelocity", initialVelocity)
        default:
            return []
        }
        if speed != 1 { add("speed", speed) }
        return p
    }

    /// How long a spring takes to settle, in seconds (SwiftUI's own Spring, iOS 17 and later).
    public var settlingDuration: Double? {
        guard #available(iOS 17, macOS 14, tvOS 17, watchOS 10, *) else { return nil }
        switch kind {
        case .spring:
            guard let response, let dampingFraction, response > 0 else { return nil }
            return Spring(response: response, dampingRatio: dampingFraction).settlingDuration
        case .interpolatingSpring:
            guard let stiffness, let damping, stiffness > 0 else { return nil }
            return Spring(mass: mass ?? 1, stiffness: stiffness, damping: damping).settlingDuration
        default:
            return nil
        }
    }

    /// How long it runs, delay included, at its speed; nil when it repeats forever or is not known.
    public var durationMs: Double? {
        let once: Double?
        switch kind {
        case .bezier: once = duration
        case .spring, .interpolatingSpring: once = settlingDuration
        case .standard, .other: once = nil
        }
        guard var seconds = once, speed > 0 else { return nil }
        switch repeats {
        case .forever?: return nil
        case .count(let n)?: seconds *= Double(max(n, 1))
        case nil: break
        }
        return Self.round1((delay + seconds) / speed * 1000)
    }

    // MARK: Rebuilding

    /// The same animation built again from what was read; nil for a kind this cannot build.
    public func animation() -> Animation? {
        var a: Animation
        switch kind {
        case .bezier:
            guard let duration, let c = curve, c.count == 4 else { return nil }
            a = .timingCurve(c[0], c[1], c[2], c[3], duration: duration)
        case .spring:
            guard let response, let dampingFraction else { return nil }
            a = .spring(response: response, dampingFraction: dampingFraction, blendDuration: blendDuration ?? 0)
        case .interpolatingSpring:
            guard let stiffness, let damping else { return nil }
            a = .interpolatingSpring(mass: mass ?? 1, stiffness: stiffness, damping: damping, initialVelocity: initialVelocity ?? 0)
        case .standard, .other:
            return nil
        }
        if delay > 0 { a = a.delay(delay) }
        if speed != 1 { a = a.speed(speed) }
        switch repeats {
        case .count(let n)?: a = a.repeatCount(n, autoreverses: autoreverses)
        case .forever?: a = a.repeatForever(autoreverses: autoreverses)
        case nil: break
        }
        return a
    }

    /// The animation with the panel's edits for its call site (`"1.response"` → ms), or nil when none
    /// applies.
    public func applying(_ edits: [String: Double]) -> Animation? {
        var copy = self
        var changed = false
        for (path, value) in edits where path.hasPrefix("1.") && value.isFinite {
            switch (kind, String(path.dropFirst(2))) {
            case (.bezier, "duration"): copy.duration = max(0, value) / 1000
            case (.spring, "response"): copy.response = max(0.001, value / 1000)
            case (.spring, "dampingFraction"): copy.dampingFraction = max(0, value)
            case (.interpolatingSpring, "mass"): copy.mass = max(0.001, value)
            case (.interpolatingSpring, "stiffness"): copy.stiffness = max(0.001, value)
            case (.interpolatingSpring, "damping"): copy.damping = max(0, value)
            case (.interpolatingSpring, "initialVelocity"): copy.initialVelocity = value
            case (_, "speed") where value > 0: copy.speed = value
            default: continue
            }
            changed = true
        }
        return changed ? copy.animation() : nil
    }

    private static func round3(_ x: Double) -> Double { (x * 1000).rounded() / 1000 }
    private static func round1(_ x: Double) -> Double { (x * 10).rounded() / 10 }
}
