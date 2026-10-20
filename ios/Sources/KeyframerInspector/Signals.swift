#if canImport(UIKit)
import QuartzCore
import UIKit

/// What a layer is called in the panel: `card` in `ViewController`, from (in order) a name given to
/// `track`, its accessibility identifier, the stored property that holds its view, or its type. Cells
/// get their index path (`icon#0.3`) so every row records its own values; sublayers get their own name.
struct LayerNaming: Hashable {
    var name: String
    var owner: String?

    /// The signal id of one scalar track of this layer: `ViewController.card/position.x`.
    func id(_ path: String) -> String {
        "\(owner.map { "\($0)." } ?? "")\(name)/\(path)"
    }
}

/// The layers being watched, one track per scalar property, by signal id. A layer that is replaced
/// (a screen shown again) takes over its id, so recordings follow it like React Native's shared values.
/// Values the app pushes (KeyframerInspectorSwiftUI's traces) are tracks too, read from their source.
@MainActor final class SignalRegistry {
    final class Track {
        weak var layer: CALayer?
        /// For a pushed value: where it lives (freed with the view that pushed it) and which scalar.
        weak var source: KeyframerValueSource?
        let index: Int
        let path: String
        let site: InspectorSignalSite

        init(layer: CALayer, path: String, site: InspectorSignalSite) {
            self.layer = layer
            self.path = path
            self.site = site
            index = 0
        }

        init(source: KeyframerValueSource, index: Int, site: InspectorSignalSite) {
            self.source = source
            self.index = index
            path = ""
            self.site = site
        }

        var isAlive: Bool { layer != nil || source != nil }

        /// What shows now: the layer's presentation value, or the value last pushed.
        func read() -> Double? {
            if let layer { return LayerValue.number((layer.presentation() ?? layer).value(forKeyPath: path)) }
            guard let source, index < source.values.count, source.values[index].isFinite else { return nil }
            return source.values[index]
        }
    }

    private(set) var tracks: [String: Track] = [:]
    private var order: [String] = []
    private var namingCache: [ObjectIdentifier: (WeakBox<CALayer>, LayerNaming)] = [:]

    var ids: [String] { order }
    var sites: [InspectorSignalSite] { order.compactMap { tracks[$0]?.site } }

    func track(_ id: String) -> Track? { tracks[id] }

    /// Registers one scalar track. Returns its site when the id is new (to report to the panel).
    func ensure(layer: CALayer, path: String, naming: LayerNaming, file: String, line: Int, kind: InspectorSignalSite.Kind? = nil) -> InspectorSignalSite? {
        let id = naming.id(path)
        if let existing = tracks[id] {
            if existing.layer !== layer { tracks[id] = Track(layer: layer, path: path, site: existing.site) }
            return nil
        }
        // Every track is writable: pins can hold any animatable key path, scroll offsets scroll the view.
        let site = InspectorSignalSite(id: id, file: file, line: line, component: naming.owner, name: "\(naming.name).\(path)", kind: kind)
        tracks[id] = Track(layer: layer, path: path, site: site)
        order.append(id)
        return site
    }

    /// Registers one pushed scalar. Returns its site when the id is new.
    func ensure(source: KeyframerValueSource, index: Int, site: InspectorSignalSite) -> InspectorSignalSite? {
        if let existing = tracks[site.id] {
            if existing.source !== source || existing.index != index { tracks[site.id] = Track(source: source, index: index, site: existing.site) }
            return nil
        }
        tracks[site.id] = Track(source: source, index: index, site: site)
        order.append(site.id)
        return site
    }

    /// The signal ids of one layer's tracks.
    func ids(of layer: CALayer) -> [String] {
        order.filter { tracks[$0]?.layer === layer }
    }

    /// Forgets the tracks whose layer (or pushed value) was freed: their screen closed. Returns their
    /// ids, for `unsignal`.
    func prune() -> [String] {
        let gone = order.filter { tracks[$0]?.isAlive != true }
        guard !gone.isEmpty else { return [] }
        for id in gone { tracks[id] = nil }
        order.removeAll { tracks[$0] == nil }
        namingCache = namingCache.filter { $0.value.0.value != nil }
        return gone
    }

    /// Layers with animations of the app attached right now (the inspector's own excluded).
    func animatedLayers() -> [CALayer] {
        var seen = Set<ObjectIdentifier>()
        return tracks.values.compactMap { track -> CALayer? in
            guard let layer = track.layer, seen.insert(ObjectIdentifier(layer)).inserted else { return nil }
            return (layer.animationKeys() ?? []).contains(where: { !$0.hasPrefix("kf.") }) ? layer : nil
        }
    }

    func naming(for layer: CALayer) -> LayerNaming {
        let key = ObjectIdentifier(layer)
        if let cached = namingCache[key], cached.0.value === layer { return cached.1 }
        let naming = Self.name(layer)
        namingCache[key] = (WeakBox(layer), naming)
        return naming
    }

    private static func name(_ layer: CALayer) -> LayerNaming {
        var host: CALayer? = layer
        while let l = host, !(l.delegate is UIView) { host = l.superlayer }
        guard let view = host?.delegate as? UIView else {
            return LayerNaming(name: layer.name ?? typeName(layer), owner: nil)
        }
        var name = Registry.name(of: view) ?? view.accessibilityIdentifier.flatMap { $0.isEmpty ? nil : $0 } ?? propertyName(of: view) ?? typeName(view)
        if let index = cellIndex(of: view) { name += "#\(index)" }
        if host !== layer { name += ".\(layer.name ?? typeName(layer))" }
        return LayerNaming(name: name, owner: owner(of: view).map(typeName))
    }

    static func owner(of view: UIView) -> UIViewController? {
        var r: UIResponder? = view
        while let cur = r {
            if let vc = cur as? UIViewController { return vc }
            r = cur.next
        }
        return nil
    }

    /// The stored property holding `view` in the closest view or controller up the responder chain
    /// that has one: `card` for `let card = UIView()` in a view controller.
    private static func propertyName(of view: UIView) -> String? {
        var holder = view.next
        var depth = 0
        while let h = holder, depth < 12 {
            var mirror: Mirror? = Mirror(reflecting: h)
            while let m = mirror {
                for child in m.children {
                    guard let label = child.label, let held = child.value as? UIView, held === view else { continue }
                    return label.replacingOccurrences(of: "$__lazy_storage_$_", with: "").trimmingCharacters(in: CharacterSet(charactersIn: "_"))
                }
                mirror = m.superclassMirror
            }
            if h is UIViewController && !(h is UINavigationController) { break }
            holder = h.next
            depth += 1
        }
        return nil
    }

    private static func cellIndex(of view: UIView) -> String? {
        var v: UIView? = view
        while let cur = v {
            if let cell = cur as? UICollectionViewCell, let cv = cell.superview as? UICollectionView, let ip = cv.indexPath(for: cell) {
                return "\(ip.section).\(ip.item)"
            }
            if let cell = cur as? UITableViewCell {
                var s = cell.superview
                while let sv = s, !(sv is UITableView) { s = sv.superview }
                if let tv = s as? UITableView, let ip = tv.indexPath(for: cell) { return "\(ip.section).\(ip.row)" }
            }
            v = cur.superview
        }
        return nil
    }

    static func typeName(_ object: AnyObject) -> String {
        String(describing: type(of: object))
    }
}
#endif
