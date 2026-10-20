#if canImport(UIKit)
import QuartzCore
import SwiftUI
@_spi(SwiftUI) import KeyframerInspector

// SwiftUI runs its animations itself: on the main thread, from its own clock, interpolating the values
// views were given. They never pass through Core Animation's addAnimation:forKey: (the choke point the
// UIKit side swizzles), and SwiftUI has no public hook that sees every animation. What it does offer,
// and what this module uses:
//
// - `Animatable`: a modifier whose `animatableData` SwiftUI interpolates gets every frame's value, spring
//   overshoot included. That is how `.keyframerTrace` samples a value while it animates.
// - `.transaction`: a closure that sees the Transaction (with its Animation) that changes the views
//   inside it, the implicit `.animation(_:value:)` around it included, and may change it. That is how a
//   change is reported with its animation, edited by the panel's overrides, and slowed by the editor.
// - Transaction keys (iOS 17): `withKeyframerAnimation` stamps its call site on the transaction it
//   starts, so a traced value knows the exact line that animated it. On iOS 15 and 16 the stamp is
//   matched by time instead (the update that follows within a few frames).

/// `withAnimation` that the Keyframer inspector reports with this exact call site (`#fileID`, `#line`):
/// every `.keyframerTrace`d value it changes is an `anim` event from here (`fn: "withAnimation"`), with
/// the animation's parameters; one that changes no traced value is reported on its own, without a
/// target. While the inspector is not running it is `withAnimation`, nothing more.
///
///     withKeyframerAnimation(.spring(response: 0.5, dampingFraction: 0.6)) {
///         cardOffset = lifted ? -120 : 0
///     }
@discardableResult
public func withKeyframerAnimation<Result>(
    _ animation: Animation? = .default,
    file: String = #fileID, filePath: String = #filePath, line: Int = #line, column: Int = #column,
    _ body: () throws -> Result
) rethrows -> Result {
    let site = TraceCallSite(file: file, filePath: filePath, line: line, column: column)
    guard Thread.isMainThread, let stamp = MainActor.assumeIsolated({ AnimationStamp.begin(animation, at: site) }) else {
        return try withAnimation(animation, body)
    }
    if #available(iOS 17, *) {
        var transaction = Transaction(animation: stamp.started)
        transaction[StampKey.self] = stamp
        return try withTransaction(transaction, body)
    }
    AnimationStamp.pending = stamp
    return try withAnimation(stamp.started, body)
}

extension View {
    /// Reports `value` to the Keyframer inspector as a signal named `name` (`Owner.name`, the owner being
    /// this file's name; a point or size is one signal per component, `card/x`, `card/y`) and samples it
    /// every frame while SwiftUI animates it. A change made with an animation (withKeyframerAnimation,
    /// withAnimation, `.animation(_:value:)` around this modifier) is an `anim` event; the panel's
    /// overrides edit the next one from that call site, and the editor's slow motion slows it.
    ///
    ///     RoundedRectangle(cornerRadius: 24)
    ///         .offset(y: cardOffset)
    ///         .keyframerTrace("card", value: cardOffset)
    ///         .animation(.spring, value: cardOffset)     // implicit animations go outside it
    ///
    /// `value` is anything SwiftUI can animate: a number (Double, CGFloat), CGPoint, CGSize, CGRect,
    /// Angle, UnitPoint, or a type of the app's own. Put it inside (before) the `.animation` modifiers
    /// that animate the same value, so it sees their animation. In a list, give each row its own name
    /// (`"card#\(index)"`): instances sharing a name share a signal, the newest one recorded.
    public func keyframerTrace<V: VectorArithmetic>(
        _ name: String, value: V,
        file: String = #fileID, filePath: String = #filePath, line: Int = #line, column: Int = #column
    ) -> some View {
        // Numbers are VectorArithmetic on every iOS; they are Animatable only from iOS 17.
        modifier(KeyframerTraceModifier(name: name, data: value, shape: .of(value), site: TraceCallSite(file: file, filePath: filePath, line: line, column: column)))
    }

    /// `.keyframerTrace` for a value that animates through its `animatableData`: CGPoint, CGSize,
    /// CGRect, Angle, UnitPoint, a type of the app's own.
    @_disfavoredOverload
    public func keyframerTrace<V: Animatable>(
        _ name: String, value: V,
        file: String = #fileID, filePath: String = #filePath, line: Int = #line, column: Int = #column
    ) -> some View {
        modifier(KeyframerTraceModifier(name: name, data: value.animatableData, shape: .of(value), site: TraceCallSite(file: file, filePath: filePath, line: line, column: column)))
    }
}

// MARK: - Call sites and stamps

/// Where a trace or a withKeyframerAnimation was written.
struct TraceCallSite: Equatable {
    let file: String
    let filePath: String
    let line: Int
    let column: Int

    /// The file's name without its folder and extension: what the panel shows as the component.
    var owner: String {
        let last = file.split(separator: "/").last.map(String.init) ?? file
        return last.hasSuffix(".swift") ? String(last.dropLast(6)) : last
    }

    @MainActor var path: String { SwiftUIBridge.path(file: file, filePath: filePath) }
    @MainActor var id: String { "\(path):\(line):\(column)" }
}

@available(iOS 17, *)
struct StampKey: TransactionKey {
    static var defaultValue: AnimationStamp? { nil }
}

/// One withKeyframerAnimation call: where it was, what it asked for and what it started.
final class AnimationStamp: @unchecked Sendable {
    /// iOS 15 and 16: the last stamp, for the update that follows it.
    nonisolated(unsafe) static var pending: AnimationStamp?
    /// How long a stamp waits for the update it caused before it is reported on its own.
    static let claimWindow: TimeInterval = 0.1

    let site: TraceCallSite
    /// What the app passed.
    let original: Animation?
    /// With the panel's edits for this call site (before the editor's speed).
    let edited: Animation?
    /// What runs: `edited` at the editor's speed.
    let started: Animation?
    let symbols: [String]?
    let at = CACurrentMediaTime()
    /// A traced value reported it.
    var claimed = false

    private init(site: TraceCallSite, original: Animation?, edited: Animation?, started: Animation?, symbols: [String]?) {
        self.site = site
        self.original = original
        self.edited = edited
        self.started = started
        self.symbols = symbols
    }

    @MainActor static func begin(_ animation: Animation?, at site: TraceCallSite) -> AnimationStamp? {
        guard SwiftUIBridge.isRunning else { return nil }
        SwiftUIBridge.markUsed()
        var edited = animation
        if let a = animation, let edits = SwiftUIBridge.overrides(for: site.id), let e = SwiftUIAnimationInfo(a).applying(edits) { edited = e }
        let stamp = AnimationStamp(
            site: site, original: animation, edited: edited, started: Tracing.atEditorSpeed(edited),
            symbols: SwiftUIBridge.isRecording ? Thread.callStackSymbols : nil
        )
        // No traced value took it: reported on its own, without a target.
        DispatchQueue.main.asyncAfter(deadline: .now() + claimWindow) {
            MainActor.assumeIsolated { stamp.reportIfUnclaimed() }
        }
        return stamp
    }

    /// The stamp of the transaction a traced value changed in, if withKeyframerAnimation started it.
    static func current(_ transaction: Transaction) -> AnimationStamp? {
        if #available(iOS 17, *) { return transaction[StampKey.self] }
        guard let p = pending, CACurrentMediaTime() - p.at < claimWindow else { return nil }
        return p
    }

    @MainActor private func reportIfUnclaimed() {
        if Self.pending === self { Self.pending = nil }
        guard !claimed, let edited, SwiftUIBridge.isRunning else { return }
        let info = SwiftUIAnimationInfo(edited)
        let callSite = InspectorCallSite(
            id: site.id, file: site.path, line: site.line, column: site.column, fn: "withAnimation",
            component: site.owner, target: nil, prop: nil, params: info.params
        )
        SwiftUIBridge.report(site: callSite, args: [.null, .object(info.config)], durationMs: info.durationMs, symbols: symbols)
    }
}

// MARK: - The trace

struct KeyframerTraceModifier<Data: VectorArithmetic>: ViewModifier {
    let name: String
    let data: Data
    let shape: Scalars.Shape
    let site: TraceCallSite
    @StateObject private var box = TraceBox()

    func body(content: Content) -> some View {
        let target = Scalars.of(data)
        box.prepare(name: name, labels: shape.labels(count: target.count), site: site, values: target)
        // The transaction closure is outside the sampler: what it changes (edits, the editor's speed)
        // reaches the sampled value and the view alike.
        return content
            .modifier(TraceSampler(animatableData: data, box: box))
            .transaction { [box, name, site] t in box.observe(&t, target: target, name: name, site: site) }
    }
}

/// Gets every frame's value while SwiftUI animates it (Animatable), and keeps it where the
/// inspector's sampler reads it. SwiftUI sets `animatableData` on every frame of an animation but does
/// not evaluate this modifier's body for it (its output does not change), so the setter is the hook.
struct TraceSampler<Data: VectorArithmetic>: ViewModifier, Animatable {
    var animatableData: Data {
        didSet { box.present(animatableData) }
    }

    let box: TraceBox

    func body(content: Content) -> some View {
        content
    }
}

/// One traced view's state, kept by SwiftUI for as long as the view lives (its signals leave the
/// catalog when it goes).
final class TraceBox: ObservableObject, @unchecked Sendable {
    let source = KeyframerValueSource()
    /// The inspector it registered with: a new one (stopped and started again) needs it again.
    private weak var session: AnyObject?
    private var registeredName: String?
    private var labels: [String] = []
    /// The value last given (the target of an animation), to tell a change.
    private var last: [Double]?

    func prepare(name: String, labels: [String], site: TraceCallSite, values: [Double]) {
        // SwiftUI calls the transaction closure for changes, not when the view appears: the first value
        // comes from here. (Later bodies already carry the new value before the closure runs.)
        if last == nil { last = values }
        guard Thread.isMainThread else { return }
        MainActor.assumeIsolated {
            guard let current = SwiftUIBridge.session else {
                session = nil
                return
            }
            if session === current, registeredName == name, self.labels == labels { return }
            SwiftUIBridge.markUsed()
            session = current
            registeredName = name
            self.labels = labels
            if source.values.count != values.count { source.values = values }
            let base = "\(site.owner).\(name)"
            let path = site.path
            let sites = labels.map { label in
                InspectorSignalSite(
                    id: label.isEmpty ? base : "\(base)/\(label)", file: path, line: site.line, column: site.column,
                    component: site.owner, name: label.isEmpty ? name : "\(name).\(label)", kind: .value, writable: false
                )
            }
            SwiftUIBridge.register(source, sites: sites)
        }
    }

    /// Every frame of an animation.
    func present<Data: VectorArithmetic>(_ data: Data) {
        guard session != nil else { return }
        source.values = Scalars.of(data)
    }

    /// A transaction reached the traced view: when it changed the value with an animation, that is an
    /// `anim` event, and the animation gets the panel's edits and the editor's speed. Without one the
    /// value jumps (nothing interpolates it).
    func observe(_ t: inout Transaction, target: [Double], name: String, site: TraceCallSite) {
        let previous = last
        last = target
        guard Thread.isMainThread, session != nil, let previous, previous != target else { return }
        guard t.animation != nil else {
            source.values = target
            return
        }
        let from = source.values
        var transaction = t
        MainActor.assumeIsolated {
            Tracing.changed(&transaction, from: from, to: target, labels: labels, name: name, site: site)
        }
        t = transaction
    }
}

@MainActor enum Tracing {
    /// `animation` at the editor's slow motion. Paused (0) is left alone: SwiftUI fixes an animation's
    /// speed when it starts, so a paused one would never resume.
    static func atEditorSpeed(_ animation: Animation?) -> Animation? {
        let scale = SwiftUIBridge.timeScale
        guard let animation, scale > 0, scale != 1 else { return animation }
        return animation.speed(scale)
    }

    static func changed(_ t: inout Transaction, from: [Double], to: [Double], labels: [String], name: String, site: TraceCallSite) {
        guard let animation = t.animation else { return }
        let stamp = AnimationStamp.current(t)
        stamp?.claimed = true
        // withKeyframerAnimation's own animation, unless an implicit `.animation` around the trace
        // replaced it: then that one is what runs, and it was not slowed yet.
        let stamped = stamp.map { animation == $0.started } ?? false
        let base = (stamped ? stamp?.edited : nil) ?? animation
        let location = stamp?.site ?? site
        let siteId = "\(location.id)/\(name)"
        var effective = base
        if let edits = SwiftUIBridge.overrides(for: siteId), let edited = SwiftUIAnimationInfo(base).applying(edits) { effective = edited }
        let info = SwiftUIAnimationInfo(effective)
        var config = info.config
        config["from"] = Scalars.json(from, labels: labels)
        let callSite = InspectorCallSite(
            id: siteId, file: location.path, line: location.line, column: location.column,
            fn: stamp == nil ? "Transaction" : "withAnimation", component: location.owner, target: name, prop: nil, params: info.params
        )
        SwiftUIBridge.report(site: callSite, args: [Scalars.json(to, labels: labels), .object(config)], durationMs: info.durationMs, symbols: stamp?.symbols)
        let running = atEditorSpeed(effective)
        if running != animation { t.animation = running }
    }
}

// MARK: - Values as scalars

enum Scalars {
    /// The numbers inside an animatable value (AnimatablePair nests them): one signal each.
    static func of(_ data: Any) -> [Double] {
        if let d = data as? Double { return [d] }
        if let c = data as? CGFloat { return [Double(c)] }
        var out: [Double] = []
        collect(data, into: &out, depth: 0)
        return out
    }

    private static func collect(_ value: Any, into out: inout [Double], depth: Int) {
        guard out.count < 16, depth < 8 else { return }
        switch value {
        case let d as Double: out.append(d)
        case let c as CGFloat: out.append(Double(c))
        case let f as Float: out.append(Double(f))
        default:
            for child in Mirror(reflecting: value).children { collect(child.value, into: &out, depth: depth + 1) }
        }
    }

    /// What kind of value was traced, for naming its scalars.
    enum Shape {
        case point, size, rect, other

        static func of<V>(_ value: V) -> Shape {
            switch value {
            case is CGPoint, is UnitPoint: return .point
            case is CGSize: return .size
            case is CGRect: return .rect
            default: return .other
            }
        }

        /// What each scalar is called: `x`/`y` for a point, `width`/`height` for a size, none for a number.
        func labels(count: Int) -> [String] {
            switch (self, count) {
            case (.point, 2): return ["x", "y"]
            case (.size, 2): return ["width", "height"]
            case (.rect, 4): return ["x", "y", "width", "height"]
            default: return count == 1 ? [""] : (0..<count).map(String.init)
            }
        }
    }

    /// A value for the anim event's args: a number, or an object by label.
    static func json(_ values: [Double], labels: [String]) -> JSONValue {
        if values.count == 1, labels.first?.isEmpty ?? true { return .number(values[0]) }
        var object: [String: JSONValue] = [:]
        for (i, v) in values.enumerated() { object[i < labels.count && !labels[i].isEmpty ? labels[i] : String(i)] = .number(v) }
        return .object(object)
    }
}
#endif
