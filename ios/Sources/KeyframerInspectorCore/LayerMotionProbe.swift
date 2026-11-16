#if DEBUG || KEYFRAMER_INSPECTOR_RELEASE
import QuartzCore

/// One property of a layer that the motion probe watches, read from the model layer the way SwiftUI
/// writes it, and sampled afterwards through its Core Animation key path.
public enum MotionProp: Int, CaseIterable, Sendable {
    case x, y, width, height, opacity, translationX, translationY, scale, rotation

    /// The key path a signal reads it by (Track, presentation values).
    public var path: String {
        switch self {
        case .x: return "position.x"
        case .y: return "position.y"
        case .width: return "bounds.size.width"
        case .height: return "bounds.size.height"
        case .opacity: return "opacity"
        case .translationX: return "transform.translation.x"
        case .translationY: return "transform.translation.y"
        case .scale: return "transform.scale.x"
        case .rotation: return "transform.rotation.z"
        }
    }

    /// How far from where it started it has to go to count as moved: half a point, a hundredth of
    /// opacity, half a percent of scale, about a third of a degree.
    var threshold: Double {
        switch self {
        case .x, .y, .width, .height, .translationX, .translationY: return 0.5
        case .opacity: return 0.01
        case .scale, .rotation: return 0.005
        }
    }

    /// What the signal animates, for the panel and the problems engine (an opacity is a fade).
    public var kind: String {
        switch self {
        case .x, .y, .translationX, .translationY: return "position"
        case .width, .height: return "size"
        case .opacity: return "opacity"
        case .scale: return "scale"
        case .rotation: return "rotation"
        }
    }
}

/// A layer's watched values (MotionProp), from its model layer.
public struct MotionValues: Equatable, Sendable {
    var x, y, width, height, opacity, translationX, translationY, scale, rotation: Double

    public init(_ layer: CALayer) {
        let p = layer.position
        let s = layer.bounds.size
        let t = layer.transform
        x = p.x
        y = p.y
        width = s.width
        height = s.height
        opacity = Double(layer.opacity)
        translationX = t.m41
        translationY = t.m42
        scale = (t.m11 * t.m11 + t.m12 * t.m12).squareRoot()
        rotation = atan2(t.m12, t.m11)
    }

    static func - (a: MotionValues, b: MotionValues) -> MotionValues {
        var d = a
        d.x -= b.x
        d.y -= b.y
        d.width -= b.width
        d.height -= b.height
        d.opacity -= b.opacity
        d.translationX -= b.translationX
        d.translationY -= b.translationY
        d.scale -= b.scale
        d.rotation -= b.rotation
        return d
    }

    /// Two changes that are one motion: equal to a tenth of each property's threshold.
    func matches(_ other: MotionValues) -> Bool {
        MotionProp.allCases.allSatisfy { abs(self[$0] - other[$0]) <= $0.threshold / 10 }
    }

    public subscript(_ prop: MotionProp) -> Double {
        switch prop {
        case .x: return x
        case .y: return y
        case .width: return width
        case .height: return height
        case .opacity: return opacity
        case .translationX: return translationX
        case .translationY: return translationY
        case .scale: return scale
        case .rotation: return rotation
        }
    }
}

/// Layers that move together, found by LayerMotionProbe: one of them (the first found) stands for the
/// rest. `props` are the properties that went past their threshold in this frame, so a group comes
/// back once more for each property that starts moving later (an ease-in turns before it grows), with
/// every value the layer had since the probe began.
public struct MotionGroup {
    public let layer: CALayer
    public let label: String
    public let props: [MotionProp]
    /// Probe time (the caller's clock) and the values then: where it started, then each frame it changed.
    public let history: [(t: Double, values: MotionValues)]
}

/// What moves on screen after an animation starts, when nothing reports it: SwiftUI interpolates
/// on the main thread and writes the layers' model values every frame, without a CAAnimation. Begun
/// with the layer tree as it is (before the change is applied), the probe reads every layer on every
/// frame while things move: at least `minMs`, until `quietMs` after the last change, at most `maxMs`. A
/// layer that changed on two frames and went past a threshold has moved; layers that started moving on
/// the same frame and moved by the same amounts are one group, the first of them standing for it, so a
/// sliding page of thirty layers is one curve. A single change is a jump (a CAAnimation's model value,
/// a relayout), not motion.
///
/// `classify` says which layers are candidates and what to call them (nil: not one), asked the first
/// time a layer changes: most never do. Not thread-safe: the main thread's.
public final class LayerMotionProbe {
    private enum Kind {
        case unknown, skipped
        case named(String)
    }

    private struct Entry {
        weak var layer: CALayer?
        var kind = Kind.unknown
        /// When it was first read: the probe's start, or later for a layer added meanwhile.
        var seen: Double
        var base: MotionValues
        var last: MotionValues
        var changes = 0
        var history: [(t: Double, values: MotionValues)] = []
        /// Moving with a group another layer stands for: no longer read.
        var joined = false
        /// Stands for a group: read until the end, its properties reported as they start moving.
        var reported: Set<MotionProp>?
    }

    private struct Group {
        let frame: Int
        let delta: MotionValues
    }

    public let maxGroups: Int
    public let maxLayers: Int
    public let minMs: Double
    public let quietMs: Double
    public let maxMs: Double
    public private(set) var until: Double = -.infinity
    public private(set) var isActive = false
    private var cap: Double = -.infinity
    private var entries: [ObjectIdentifier: Entry] = [:]
    private var groups: [Group] = []
    private var frameIndex = 0

    public init(maxGroups: Int = 8, maxLayers: Int = 3000, minMs: Double = 400, quietMs: Double = 300, maxMs: Double = 3000) {
        self.maxGroups = maxGroups
        self.maxLayers = maxLayers
        self.minMs = minMs
        self.quietMs = quietMs
        self.maxMs = maxMs
    }

    /// Starts watching from `root` at `t` (ms), or keeps watching longer when it already does (an
    /// animation started while another runs).
    public func begin(root: CALayer, at t: Double) {
        cap = t + maxMs
        until = min(cap, max(until, t + minMs))
        guard !isActive else { return }
        isActive = true
        frameIndex = 0
        groups = []
        entries.reserveCapacity(1024)
        var count = 0
        walk(root, count: &count) { layer, id in
            let values = MotionValues(layer)
            entries[id] = Entry(layer: layer, seen: t, base: values, last: values)
        }
    }

    /// One frame at `t`: the groups that started moving, or moved in another property, in it. Past
    /// `until` it ends.
    public func frame(root: CALayer, at t: Double, classify: (CALayer) -> String?) -> [MotionGroup] {
        guard isActive else { return [] }
        guard t <= until else {
            end()
            return []
        }
        frameIndex += 1
        var found: [MotionGroup] = []
        var count = 0
        walk(root, count: &count) { layer, id in
            guard var e = entries[id], e.layer === layer else {
                // New since the probe began (a view inserted by the change), or a freed layer's address
                // reused: watched from here on.
                let values = MotionValues(layer)
                entries[id] = Entry(layer: layer, seen: t, base: values, last: values)
                return
            }
            if case .skipped = e.kind { return }
            guard !e.joined else { return }
            let now = MotionValues(layer)
            guard now != e.last else { return }
            if case .unknown = e.kind {
                e.kind = classify(layer).map(Kind.named) ?? .skipped
                if case .skipped = e.kind {
                    entries[id] = e
                    return
                }
            }
            guard case .named(let label) = e.kind else { return }
            until = min(cap, max(until, t + quietMs))
            if e.changes == 0 { e.history = [(e.seen, e.base)] }
            e.changes += 1
            e.last = now
            e.history.append((t, now))
            let moved = MotionProp.allCases.filter { abs(now[$0] - e.base[$0]) >= $0.threshold }
            if let reported = e.reported {
                let new = moved.filter { !reported.contains($0) }
                if !new.isEmpty {
                    e.reported = reported.union(new)
                    found.append(MotionGroup(layer: layer, label: label, props: new, history: e.history))
                }
            } else if e.changes >= 2, !moved.isEmpty {
                let delta = now - e.base
                if groups.contains(where: { $0.frame == frameIndex && $0.delta.matches(delta) }) {
                    e.joined = true
                    e.history = []
                } else if groups.count < maxGroups {
                    groups.append(Group(frame: frameIndex, delta: delta))
                    e.reported = Set(moved)
                    found.append(MotionGroup(layer: layer, label: label, props: moved, history: e.history))
                }
            }
            entries[id] = e
        }
        return found
    }

    public func end() {
        isActive = false
        entries = [:]
        groups = []
        until = -.infinity
        cap = -.infinity
    }

    private func walk(_ layer: CALayer, count: inout Int, _ visit: (CALayer, ObjectIdentifier) -> Void) {
        guard count < maxLayers else { return }
        count += 1
        visit(layer, ObjectIdentifier(layer))
        guard let subs = layer.sublayers else { return }
        for s in subs { walk(s, count: &count, visit) }
    }
}
#endif
