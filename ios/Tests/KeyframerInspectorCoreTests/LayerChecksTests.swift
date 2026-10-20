import QuartzCore
import XCTest
@testable import KeyframerInspectorCore

/// Visibility rules on plain layer trees. Layers that were never rendered have no presentation tree,
/// so these read the model; the presentation side runs in the example app (Tools/editor.ts smoke).
final class LayerVisibilityTests: XCTestCase {
    private func window() -> CALayer {
        let root = CALayer()
        root.bounds = CGRect(x: 0, y: 0, width: 400, height: 800)
        root.position = CGPoint(x: 200, y: 400)
        return root
    }

    private func layer(_ frame: CGRect, in parent: CALayer) -> CALayer {
        let l = CALayer()
        l.frame = frame
        parent.addSublayer(l)
        return l
    }

    func testVisibleInsideTheWindow() {
        let root = window()
        let card = layer(CGRect(x: 10, y: 10, width: 100, height: 100), in: root)
        XCTAssertNil(LayerVisibility.reason(of: card, in: root))
        // Partly in is in.
        card.frame.origin.x = 350
        XCTAssertNil(LayerVisibility.reason(of: card, in: root))
    }

    func testDetached() {
        let root = window()
        let card = layer(CGRect(x: 10, y: 10, width: 100, height: 100), in: CALayer())
        XCTAssertEqual(LayerVisibility.reason(of: card, in: root), .detached)
        XCTAssertEqual(LayerVisibility.reason(of: card, in: nil), .detached)
    }

    func testHiddenOrTransparentAnywhereAbove() {
        let root = window()
        let container = layer(CGRect(x: 0, y: 0, width: 400, height: 400), in: root)
        let card = layer(CGRect(x: 10, y: 10, width: 100, height: 100), in: container)
        container.isHidden = true
        XCTAssertEqual(LayerVisibility.reason(of: card, in: root), .hidden)
        container.isHidden = false
        container.opacity = 0.005
        XCTAssertEqual(LayerVisibility.reason(of: card, in: root), .hidden)
        container.opacity = 1
        card.opacity = 0
        XCTAssertEqual(LayerVisibility.reason(of: card, in: root), .hidden)
        card.opacity = 1
        // Scaled to nothing.
        card.transform = CATransform3DMakeScale(0, 0, 1)
        XCTAssertEqual(LayerVisibility.reason(of: card, in: root), .hidden)
    }

    /// N20b: a view fading in from alpha 0 is not hidden by its own fade; a hidden ancestor still hides it.
    func testAFadeInIsNotHidden() {
        let root = window()
        let container = layer(CGRect(x: 0, y: 0, width: 400, height: 400), in: root)
        let card = layer(CGRect(x: 10, y: 10, width: 100, height: 100), in: container)
        card.opacity = 0
        XCTAssertEqual(LayerVisibility.reason(of: card, in: root), .hidden)
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0
        fade.toValue = 1
        fade.duration = 1
        card.add(fade, forKey: "fade")
        XCTAssertNil(LayerVisibility.reason(of: card, in: root), "its own fade")
        container.opacity = 0
        XCTAssertEqual(LayerVisibility.reason(of: card, in: root), .hidden, "an ancestor at 0 still hides it")
        container.opacity = 1
        card.removeAnimation(forKey: "fade")
        let pin = CABasicAnimation(keyPath: "opacity")
        card.add(pin, forKey: "kf.pin.opacity")
        XCTAssertEqual(LayerVisibility.reason(of: card, in: root), .hidden, "the inspector's pin is not a fade")
        card.removeAllAnimations()
        let group = CAAnimationGroup()
        group.animations = [CABasicAnimation(keyPath: "position.x"), CABasicAnimation(keyPath: "opacity")]
        card.add(group, forKey: "entrance")
        XCTAssertNil(LayerVisibility.reason(of: card, in: root), "a fade inside a group")
    }

    func testOutsideTheWindow() {
        let root = window()
        let card = layer(CGRect(x: 500, y: 10, width: 100, height: 100), in: root)
        XCTAssertEqual(LayerVisibility.reason(of: card, in: root), .offscreen)
        card.frame.origin = CGPoint(x: 10, y: -150)
        XCTAssertEqual(LayerVisibility.reason(of: card, in: root), .offscreen)
    }

    /// A clipping layer above (a scroll view) hides what is scrolled out of it, inside the window too.
    func testClippedByAScrollingAncestor() {
        let root = window()
        let strip = layer(CGRect(x: 0, y: 100, width: 400, height: 50), in: root)
        strip.masksToBounds = true
        let chip = layer(CGRect(x: 1000, y: 0, width: 80, height: 50), in: strip)
        XCTAssertEqual(LayerVisibility.reason(of: chip, in: root), .offscreen)
        strip.bounds.origin.x = 950
        XCTAssertNil(LayerVisibility.reason(of: chip, in: root))
        // Without clipping it would show (below the strip, inside the window).
        strip.bounds.origin.x = 0
        strip.masksToBounds = false
        chip.frame.origin.x = 100
        chip.frame.origin.y = 200
        XCTAssertNil(LayerVisibility.reason(of: chip, in: root))
    }

    /// A shape layer draws its path anywhere around its (empty) bounds: never called offscreen.
    func testSizelessLayersAreNotJudgedByGeometry() {
        let root = window()
        let shape = CAShapeLayer()
        shape.position = CGPoint(x: 900, y: 900)
        root.addSublayer(shape)
        XCTAssertNil(LayerVisibility.reason(of: shape, in: root))
    }
}

final class RenderHintTests: XCTestCase {
    private func names(_ l: CALayer) -> String { l.name ?? "layer" }

    private func tree() -> (root: CALayer, container: CALayer, card: CALayer) {
        let root = CALayer()
        root.bounds = CGRect(x: 0, y: 0, width: 400, height: 800)
        let container = CALayer()
        container.name = "container"
        container.frame = CGRect(x: 0, y: 0, width: 400, height: 400)
        root.addSublayer(container)
        let card = CALayer()
        card.name = "card"
        card.frame = CGRect(x: 10, y: 10, width: 100, height: 100)
        container.addSublayer(card)
        return (root, container, card)
    }

    private func hints(_ layer: CALayer, _ keyPaths: [String], root: CALayer) -> [String: String] {
        Dictionary(uniqueKeysWithValues: RenderHints.check(layer, keyPaths: keyPaths, root: root, name: names).map { ($0.hint, $0.detail) })
    }

    func testShadowWithoutAPath() {
        let (root, container, card) = tree()
        card.shadowOpacity = 0.25
        card.shadowRadius = 12
        let found = hints(card, ["position"], root: root)
        XCTAssertEqual(found["shadow-path"], "shadowOpacity 0.25, shadowRadius 12 and no shadowPath on card")
        card.shadowPath = CGPath(rect: card.bounds, transform: nil)
        XCTAssertNil(hints(card, ["position"], root: root)["shadow-path"])
        // An ancestor's shadow is worked out from what moves inside it.
        container.shadowOpacity = 0.5
        XCTAssertEqual(hints(card, ["position"], root: root)["shadow-path"], "shadowOpacity 0.5, shadowRadius 3 and no shadowPath on container, above it")
        // The window itself is not looked at.
        container.shadowOpacity = 0
        root.shadowOpacity = 1
        XCTAssertNil(hints(card, ["position"], root: root)["shadow-path"])
    }

    func testMaskOnTheLayerOrAbove() {
        let (root, container, card) = tree()
        XCTAssertNil(hints(card, ["position"], root: root)["mask"])
        container.mask = CALayer()
        XCTAssertEqual(hints(card, ["position"], root: root)["mask"], "a mask layer on container, above it")
    }

    func testGroupOpacityOnlyWhenOpacityAnimatesOverSeveralThings() {
        let (root, _, card) = tree()
        card.allowsGroupOpacity = true
        card.addSublayer(CALayer())
        // One sublayer and nothing of its own: nothing to composite.
        XCTAssertNil(hints(card, ["opacity"], root: root)["group-opacity"])
        card.backgroundColor = CGColor(gray: 0.5, alpha: 1)
        XCTAssertNotNil(hints(card, ["opacity"], root: root)["group-opacity"])
        XCTAssertNil(hints(card, ["position"], root: root)["group-opacity"], "only an opacity animation")
        card.allowsGroupOpacity = false
        XCTAssertNil(hints(card, ["opacity"], root: root)["group-opacity"])
        card.allowsGroupOpacity = true
        card.backgroundColor = nil
        card.addSublayer(CALayer())
        XCTAssertNotNil(hints(card, ["opacity"], root: root)["group-opacity"], "two sublayers")
    }

    func testRasterizingWhatChanges() {
        let (root, container, card) = tree()
        card.shouldRasterize = true
        XCTAssertNil(hints(card, ["position"], root: root)["rasterize"], "moving a rasterized layer reuses its cache")
        XCTAssertNil(hints(card, ["transform.rotation.z", "opacity"], root: root)["rasterize"])
        XCTAssertEqual(hints(card, ["bounds.size.width"], root: root)["rasterize"], "shouldRasterize on card while bounds.size.width animates what it draws")
        card.shouldRasterize = false
        container.shouldRasterize = true
        XCTAssertEqual(hints(card, ["position"], root: root)["rasterize"], "shouldRasterize on container, above card, whose position animates")
    }

    func testAPlainLayerHasNoHints() {
        let (root, _, card) = tree()
        XCTAssertTrue(RenderHints.check(card, keyPaths: ["position", "opacity"], root: root, name: names).isEmpty)
    }
}
