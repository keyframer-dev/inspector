#if canImport(UIKit)
import QuartzCore
import UIKit

/// What the inspector checks on animated layers besides reporting them:
///
/// - Visibility, while recording: a layer that animates while it is removed from the window, hidden,
///   at alpha 0 or outside the window spends frames nobody sees. Checked when an animation is added and
///   a few times a second while animations run (LayerVisibility); a change is a `visibility` marker.
/// - Render hints: how the layer is drawn costs the render server more than it needs to (a shadow
///   without a path, a mask, a blur over it, group opacity, rasterizing what changes). Checked when an
///   animation is added, sent once per layer and hint.
@MainActor final class LayerWatch {
    private var seen: [ObjectIdentifier: (layer: WeakBox<CALayer>, reason: InspectorVisibilityReason?)] = [:]
    private var hints: [ObjectIdentifier: (layer: WeakBox<CALayer>, sent: [String: InspectorRenderHint])] = [:]
    private var blurChecked: [ObjectIdentifier: (layer: WeakBox<CALayer>, at: CFTimeInterval)] = [:]

    /// Walking views for a blur costs more than reading layer properties: once per layer every few seconds.
    private static let blurInterval: CFTimeInterval = 2

    // MARK: Visibility

    /// The change since the visibility last reported for `layer`, if any. A layer first seen visible
    /// says nothing (that is what everyone assumes).
    ///
    /// `adding`: an animation is being added right now. The presentation tree still shows the state
    /// before it and the model where it ends (after any delay); where they disagree (a view about to
    /// come into view or leave it) nothing is known yet, and the next check, a few times a second,
    /// reads what shows.
    func visibilityChange(of layer: CALayer, adding: Bool = false) -> (visible: Bool, reason: InspectorVisibilityReason?)? {
        let key = ObjectIdentifier(layer)
        let sight = LayerVisibility.sight(of: layer, in: Self.window(of: layer))
        if adding && (sight.model == nil) != (sight.shown == nil) { return nil }
        let reason = sight.shown
        let before = seen[key].flatMap { $0.layer.value === layer ? $0 : nil }
        seen[key] = (WeakBox(layer), reason)
        if let before { return before.reason == reason ? nil : (reason == nil, reason) }
        return reason == nil ? nil : (false, reason)
    }

    /// Last seen out of sight: worth looking at again until it comes back.
    func isOutOfSight(_ layer: CALayer) -> Bool {
        guard let entry = seen[ObjectIdentifier(layer)], entry.layer.value === layer else { return false }
        return entry.reason != nil
    }

    func resetVisibility() {
        seen = [:]
    }

    // MARK: Render hints

    /// What each hint is about on the layer: its id is the layer's name and this (`card/shadowPath`),
    /// the same whatever animates first (QA 0.2.0, N17). Group opacity's is the opacity signal itself.
    static let hintProperty = ["shadow-path": "shadowPath", "mask": "mask", "blur": "blur", "group-opacity": "opacity", "rasterize": "shouldRasterize"]

    /// Hints not sent yet for a layer that just got an animation of `keyPaths`. `id` turns the layer
    /// property a hint is about into its id.
    func newHints(for layer: CALayer, keyPaths: [String], id: (String) -> String, now: CFTimeInterval, name: (CALayer) -> String) -> [InspectorRenderHint] {
        let key = ObjectIdentifier(layer)
        var sent = hints[key].flatMap { $0.layer.value === layer ? $0.sent : nil } ?? [:]
        var found = RenderHints.check(layer, keyPaths: keyPaths, root: Self.window(of: layer), name: name).map { ($0.hint, $0.detail) }
        let lastBlur = blurChecked[key].flatMap { $0.layer.value === layer ? $0.at : nil }
        if sent["blur"] == nil, lastBlur.map({ now - $0 > Self.blurInterval }) ?? true {
            blurChecked[key] = (WeakBox(layer), now)
            if let detail = Self.blur(over: layer, name: name) { found.append(("blur", detail)) }
        }
        var out: [InspectorRenderHint] = []
        for (hint, detail) in found where sent[hint] == nil {
            let h = InspectorRenderHint(id: id(Self.hintProperty[hint] ?? hint), hint: hint, detail: detail)
            sent[hint] = h
            out.append(h)
        }
        if !out.isEmpty || hints[key] == nil { hints[key] = (WeakBox(layer), sent) }
        return out
    }

    /// The hints of layers still on screen somewhere, for an editor that joins later.
    var liveHints: [InspectorRenderHint] {
        hints.values.filter { $0.layer.value != nil }.flatMap { $0.sent.values }.sorted { ($0.id, $0.hint) < ($1.id, $1.hint) }
    }

    /// Forgets freed layers (once a second).
    func prune() {
        seen = seen.filter { $0.value.layer.value != nil }
        hints = hints.filter { $0.value.layer.value != nil }
        blurChecked = blurChecked.filter { $0.value.layer.value != nil }
    }

    // MARK: Layers and views

    /// The window `layer` is in: the nearest layer above it that a UIWindow owns (a window's layer may
    /// itself sit under the scene's layers).
    static func window(of layer: CALayer) -> CALayer? {
        var cur: CALayer? = layer
        var depth = 0
        while let c = cur, depth < 256 {
            if c.delegate is UIWindow { return c }
            cur = c.superlayer
            depth += 1
        }
        return nil
    }

    /// A blur drawn above the view `layer` belongs to, overlapping where it is and where it goes: a
    /// UIVisualEffectView blurs what is behind it again every frame something there moves. Also a blur
    /// view that moves itself.
    static func blur(over layer: CALayer, name: (CALayer) -> String) -> String? {
        var host: CALayer? = layer
        while let l = host, !(l.delegate is UIView) { host = l.superlayer }
        guard let view = host?.delegate as? UIView, let window = view.window else { return nil }
        if let effectView = view as? UIVisualEffectView, isBlur(effectView.effect) {
            return "\(name(layer)) is a blur (\(typeName(effectView.effect))) that moves: what it blurs changes every frame"
        }
        var frame = view.convert(view.bounds, to: window)
        if let shown = view.layer.presentation(), let superview = view.superview {
            frame = frame.union(superview.convert(shown.frame, to: window))
        }
        guard frame.width > 0, frame.height > 0 else { return nil }
        var budget = 400
        var branch = view
        while let parent = branch.superview, budget > 0 {
            // Subviews later in the list are drawn above this branch.
            if let i = parent.subviews.firstIndex(of: branch) {
                for above in parent.subviews[(i + 1)...] {
                    if let hit = findBlur(in: above, overlapping: frame, window: window, depth: 0, budget: &budget) {
                        return "a blur (\(typeName(hit.effect))) above \(name(layer)), over where it moves: blurred again every frame"
                    }
                }
            }
            branch = parent
        }
        return nil
    }

    private static func findBlur(in view: UIView, overlapping frame: CGRect, window: UIWindow, depth: Int, budget: inout Int) -> UIVisualEffectView? {
        budget -= 1
        guard budget > 0, !view.isHidden, view.alpha >= 0.01 else { return nil }
        let rect = view.convert(view.bounds, to: window)
        if let effectView = view as? UIVisualEffectView, isBlur(effectView.effect) {
            return rect.intersects(frame) ? effectView : nil
        }
        // A view that clips holds nothing outside itself.
        if view.clipsToBounds && !rect.intersects(frame) { return nil }
        guard depth < 6 else { return nil }
        for sub in view.subviews {
            if let hit = findBlur(in: sub, overlapping: frame, window: window, depth: depth + 1, budget: &budget) { return hit }
        }
        return nil
    }

    /// UIBlurEffect, and UIGlassEffect (iOS 26, which samples what is behind it too), matched by name
    /// so the SDK still builds with older SDKs.
    private static func isBlur(_ effect: UIVisualEffect?) -> Bool {
        guard let effect else { return false }
        return effect is UIBlurEffect || typeName(effect).contains("Glass")
    }

    private static func typeName(_ effect: UIVisualEffect?) -> String {
        effect.map { String(describing: type(of: $0)) } ?? "UIVisualEffectView"
    }
}
#endif
