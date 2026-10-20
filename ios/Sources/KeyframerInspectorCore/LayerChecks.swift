import Foundation
import QuartzCore

/// Whether an animated layer can be seen, from Core Animation alone: cheap enough to ask when an
/// animation is added and a few times a second while animations run.
public enum LayerVisibility {
    /// Below this a layer draws nothing (UIKit's own cut-off for hit testing).
    public static let minimumOpacity: Float = 0.01

    /// Why `layer` cannot be seen in `root` (a window's layer) right now, or nil when some of it shows.
    ///
    /// - `detached`: not under `root` (removed from the window, or no window at all).
    /// - `hidden`: it or a layer above it is hidden or at opacity 0, or a transform collapsed it.
    /// - `offscreen`: none of it is inside the window and every clipping layer above it (a scroll view
    ///   scrolled away, a view moved out of the screen).
    ///
    /// Read from the presentation tree (what shows now), or the model before anything was rendered. A
    /// layer without a size (a shape layer drawing its path anywhere) is never called offscreen. A
    /// layer's own fade does not hide it: while an opacity animation is attached to it, its own opacity
    /// is not counted (a view fading in from 0 is not hidden; QA 0.2.0, N20b), the layers above it are.
    public static func reason(of layer: CALayer, in root: CALayer?) -> InspectorVisibilityReason? {
        sight(of: layer, in: root).shown
    }

    /// The same judged twice: by the model (where animations are going: UIKit sets it to the end value
    /// first, before any delay) and by what shows now. While an animation is being added the two
    /// disagree for a view moving into view or out of it.
    public static func sight(of layer: CALayer, in root: CALayer?) -> (model: InspectorVisibilityReason?, shown: InspectorVisibilityReason?) {
        guard let root else { return (.detached, .detached) }
        var chain: [CALayer] = []
        var cur: CALayer? = layer
        while let c = cur, chain.count < 256 {
            chain.append(c)
            if c === root { break }
            cur = c.superlayer
        }
        guard chain.last === root else { return (.detached, .detached) }
        let fading = fades(layer)
        let model = judge(chain, ownFade: fading)
        guard let shown = presentationChain(of: layer, count: chain.count) else { return (model, model) }
        return (model, judge(shown, ownFade: fading))
    }

    /// An opacity animation of the app's is attached to `layer` (the inspector's pins are not fades).
    static func fades(_ layer: CALayer) -> Bool {
        func isFade(_ a: CAAnimation?) -> Bool {
            if let p = a as? CAPropertyAnimation { return p.keyPath == "opacity" }
            if let g = a as? CAAnimationGroup { return (g.animations ?? []).contains(where: isFade) }
            return false
        }
        return (layer.animationKeys() ?? []).contains { !$0.hasPrefix("kf.") && isFade(layer.animation(forKey: $0)) }
    }

    /// `chain`: a layer, then each layer above it up to the window's.
    private static func judge(_ chain: [CALayer], ownFade: Bool = false) -> InspectorVisibilityReason? {
        for (i, l) in chain.enumerated() where l.isHidden || (l.opacity < minimumOpacity && !(i == 0 && ownFade)) { return .hidden }
        let leaf = chain[0]
        let top = chain[chain.count - 1]
        guard leaf.bounds.width > 0, leaf.bounds.height > 0 else { return nil }
        var rect = leaf === top ? leaf.bounds : leaf.convert(leaf.bounds, to: top)
        // A transform scaled it to nothing.
        if !(rect.width > 0 && rect.height > 0) { return .hidden }
        rect = rect.intersection(top.bounds)
        for clip in chain.dropFirst().dropLast() where clip.masksToBounds {
            rect = rect.intersection(clip.convert(clip.bounds, to: top))
        }
        return rect.isNull || rect.width <= 0 || rect.height <= 0 ? .offscreen : nil
    }

    /// The presentation layers of `layer` and the `count - 1` layers above it, walked in the
    /// presentation tree itself (its layers point at each other), or nil when that tree is not complete.
    private static func presentationChain(of layer: CALayer, count: Int) -> [CALayer]? {
        guard var p = layer.presentation() else { return nil }
        var out = [p]
        while out.count < count {
            guard let up = p.superlayer else { return nil }
            out.append(up)
            p = up
        }
        return out
    }
}

/// Something about how an animated layer is drawn that costs more than it needs to, found on the
/// layer or above it. `layer` is the one with the property (the animated layer or an ancestor).
public struct RenderHintFinding {
    public var hint: String
    public var detail: String
    public var layer: CALayer
}

/// The render hints Core Animation alone can tell, for a layer that just got an animation of
/// `keyPaths`. The keys are the protocol's: "shadow-path", "mask", "group-opacity", "rasterize" (the
/// UIKit side adds "blur", which needs views). Each is about work the render server repeats every
/// frame while the animation runs.
public enum RenderHints {
    /// Moving or fading a layer does not change what it draws: a rasterized layer keeps its cache.
    static let compositeOnly: Set<String> = [
        "position", "position.x", "position.y", "zPosition", "anchorPoint", "anchorPoint.x", "anchorPoint.y", "opacity",
    ]

    static func isCompositeOnly(_ keyPath: String) -> Bool {
        compositeOnly.contains(keyPath) || keyPath == "transform" || keyPath.hasPrefix("transform.")
    }

    /// - Parameters:
    ///   - root: the window's layer: ancestors are looked at up to it, not including it.
    ///   - name: what the details call a layer (the inspector's naming: `card`, `CardsViewController.card`).
    public static func check(_ layer: CALayer, keyPaths: [String], root: CALayer?, name: (CALayer) -> String) -> [RenderHintFinding] {
        var ancestors: [CALayer] = []
        var up = layer.superlayer
        while let a = up, a !== root, ancestors.count < 64 {
            ancestors.append(a)
            up = a.superlayer
        }
        let chain = [layer] + ancestors
        func whose(_ l: CALayer) -> String { l === layer ? name(l) : "\(name(l)), above it" }
        var found: [RenderHintFinding] = []

        // A shadow without a path is worked out from the layer's pixels (and its sublayers') on every
        // frame something in it moves; an ancestor's shadow too when the animated layer is inside it.
        if let l = chain.first(where: { $0.shadowOpacity > 0 && $0.shadowPath == nil && !$0.bounds.isEmpty }) {
            let detail = "shadowOpacity \(round2(Double(l.shadowOpacity))), shadowRadius \(round2(Double(l.shadowRadius))) and no shadowPath on \(whose(l))"
            found.append(RenderHintFinding(hint: "shadow-path", detail: detail, layer: l))
        }
        // A mask is an offscreen pass every frame the content under it changes.
        if let l = chain.first(where: { $0.mask != nil }) {
            found.append(RenderHintFinding(hint: "mask", detail: "a mask layer on \(whose(l))", layer: l))
        }
        // Fading a layer that composites several things (sublayers over its own content) draws the
        // group offscreen first on every frame of the fade.
        if keyPaths.contains("opacity"), layer.allowsGroupOpacity {
            let subs = (layer.sublayers ?? []).filter { !$0.isHidden && $0.opacity > 0 }
            let ownContent = layer.contents != nil || layer.borderWidth > 0 || (layer.backgroundColor.map { $0.alpha > 0 } ?? false)
            if subs.count >= 2 || (subs.count == 1 && ownContent) {
                let detail = "opacity animates on \(name(layer)), which draws \(subs.count) sublayer\(subs.count == 1 ? "" : "s") over its own content as a group (allowsGroupOpacity)"
                found.append(RenderHintFinding(hint: "group-opacity", detail: detail, layer: layer))
            }
        }
        // A rasterized layer is cached as a bitmap: drawn again every frame something in it changes.
        if layer.shouldRasterize, let changing = keyPaths.first(where: { !isCompositeOnly($0) }) {
            found.append(RenderHintFinding(hint: "rasterize", detail: "shouldRasterize on \(name(layer)) while \(changing) animates what it draws", layer: layer))
        } else if let l = ancestors.first(where: \.shouldRasterize), let keyPath = keyPaths.first {
            found.append(RenderHintFinding(hint: "rasterize", detail: "shouldRasterize on \(name(l)), above \(name(layer)), whose \(keyPath) animates", layer: l))
        }
        return found
    }

    private static func round2(_ x: Double) -> String {
        let r = (x * 100).rounded() / 100
        return r == r.rounded() ? String(Int(r)) : String(r)
    }
}
