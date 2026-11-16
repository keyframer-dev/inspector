#if canImport(UIKit) && (DEBUG || KEYFRAMER_INSPECTOR_RELEASE)
import ObjectiveC
import QuartzCore
import UIKit

/// The automatic signals of a withKeyframerAnimation: what it moved on screen when no `.keyframerTrace`
/// samples it. SwiftUI interpolates on the main thread and writes its layers' model values every
/// frame, so while recording, a stamp starts LayerMotionProbe over the key window and every group of
/// layers that moves becomes a layer signal of that call site (`SidePage.NavigationStack/position.x`),
/// sampled like any other from then on. Only the app's layers count: SwiftUI's own drawing and the
/// UIKit containers it hosts (a NavigationStack), and views of the app's own classes; UIKit's bars,
/// glass and cells move along with them and are left out.
@MainActor final class LayerMotion {
    struct Found {
        let layer: CALayer
        let naming: LayerNaming
        let props: [MotionProp]
        let history: [(t: Double, values: MotionValues)]
        let site: Site
        let token: ObjectIdentifier
    }

    /// The withKeyframerAnimation the probe watches for.
    struct Site {
        let file: String
        let line: Int
        let column: Int
        let owner: String
    }

    private enum Label {
        case none
        /// SwiftUI's own layer, or a container it hosts: called this, numbered per call site.
        case named(String)
        /// A view of the app's own class: named like any layer (LayerNaming).
        case view
    }

    private struct ClassPair: Hashable {
        let layer: ObjectIdentifier
        let delegate: ObjectIdentifier?
    }

    private let probe = LayerMotionProbe()
    private let signals: SignalRegistry
    private var site: Site?
    private var token: ObjectIdentifier?
    private var labels: [ClassPair: Label] = [:]
    private var names: [ObjectIdentifier: (WeakBox<CALayer>, LayerNaming)] = [:]
    private var counts: [String: Int] = [:]
    /// The first signal each stamp moved: the target of its anim event when no traced value took it.
    private var moved: [ObjectIdentifier: (t: Double, id: String)] = [:]

    init(signals: SignalRegistry) {
        self.signals = signals
    }

    var isActive: Bool { probe.isActive }

    /// A stamp began at `t` (recording ms): watch while things move.
    func begin(_ token: ObjectIdentifier, site: Site, root: CALayer, at t: Double) {
        self.site = site
        self.token = token
        probe.begin(root: root, at: t)
    }

    /// One frame: the groups that started moving in it, named.
    func frame(root: CALayer, at t: Double) -> [Found] {
        guard let site, let token else { return [] }
        let groups = probe.frame(root: root, at: t, classify: classify)
        return groups.map { g in
            Found(layer: g.layer, naming: naming(of: g.layer, label: g.label, owner: site.owner), props: g.props, history: g.history, site: site, token: token)
        }
    }

    func didRegister(_ id: String, for token: ObjectIdentifier, at t: Double) {
        guard moved[token] == nil else { return }
        if moved.count > 32 { moved = moved.filter { $0.value.t > t - 5000 } }
        moved[token] = (t, id)
    }

    func movedSignal(of token: ObjectIdentifier) -> String? {
        moved[token]?.id
    }

    func end() {
        probe.end()
        site = nil
        token = nil
    }

    /// Classified once per pair of classes (the layer's and its delegate's); the string checks only run
    /// for a pair not seen before.
    private func classify(_ layer: CALayer) -> String? {
        let delegate: AnyClass? = layer.delegate.flatMap { object_getClass($0) }
        let pair = ClassPair(layer: ObjectIdentifier(object_getClass(layer) ?? CALayer.self), delegate: delegate.map(ObjectIdentifier.init))
        let label: Label
        if let known = labels[pair] {
            label = known
        } else {
            label = Self.label(layer: object_getClass(layer), delegate: delegate)
            labels[pair] = label
        }
        switch label {
        case .none: return nil
        case .named(let name): return name
        case .view: return ""
        }
    }

    private static func label(layer: AnyClass?, delegate: AnyClass?) -> Label {
        guard let delegate else { return .none }
        // The runtime names, never `String(describing:)` first: a SwiftUI view's generic type name runs
        // to thousands of characters, and building it took 150 ms over one window's classes.
        let d = NSStringFromClass(delegate)
        if d.hasSuffix("_SwiftUILayerDelegate") || d.hasSuffix("_SwiftUISDFLayerDelegate") {
            let l = layer.map(NSStringFromClass) ?? ""
            if l.contains("SDF") { return .named("glass") }
            if l.contains("Drawing") { return .named("drawing") }
            if l.contains("Image") { return .named("image") }
            if l.contains("Gradient") { return .named("gradient") }
            if l.contains("Shape") { return .named("shape") }
            return .named("view")
        }
        if d.contains("UIKitPlatformViewHost") { return .named(hosted(String(describing: delegate)) ?? "platform view") }
        if d.contains("CellHostingView") { return .named("row") }
        if d.contains("HostingView") { return .named("hosting view") }
        if delegate is UIView.Type, isApps(delegate) { return .view }
        return .none
    }

    private static let appBundle = Bundle.main.bundlePath

    /// A class of the app's own: its image is in the app's bundle (the executable, its debug dylib, an
    /// embedded framework). Read from the image name, without `Bundle(for:)`.
    private static func isApps(_ cls: AnyClass) -> Bool {
        guard let image = class_getImageName(cls) else { return false }
        return String(cString: image).hasPrefix(appBundle)
    }

    /// `NavigationStack` for `UIKitPlatformViewHost<PlatformViewControllerRepresentableAdaptor<NavigationStackRepresentable>>`:
    /// the innermost generic argument, without SwiftUI's suffixes.
    private static func hosted(_ name: String) -> String? {
        guard let open = name.lastIndex(of: "<") else { return nil }
        var inner = String(name[name.index(after: open)...].prefix { $0 != ">" && $0 != "," })
        if let dot = inner.lastIndex(of: ".") { inner = String(inner[inner.index(after: dot)...]) }
        for suffix in ["Representable", "Adaptor"] where inner.hasSuffix(suffix) { inner = String(inner.dropLast(suffix.count)) }
        return inner.isEmpty ? nil : inner
    }

    /// The same layer keeps its name across stamps; SwiftUI's are numbered per call site and kind
    /// (`drawing`, `drawing 2`).
    private func naming(of layer: CALayer, label: String, owner: String) -> LayerNaming {
        let key = ObjectIdentifier(layer)
        if let known = names[key], known.0.value === layer { return known.1 }
        let naming: LayerNaming
        if label.isEmpty {
            naming = signals.naming(for: layer)
        } else {
            let n = (counts["\(owner).\(label)"] ?? 0) + 1
            counts["\(owner).\(label)"] = n
            naming = LayerNaming(name: n == 1 ? label : "\(label) \(n)", owner: owner)
        }
        if names.count > 256 { names = names.filter { $0.value.0.value != nil } }
        names[key] = (WeakBox(layer), naming)
        return naming
    }
}
#endif
