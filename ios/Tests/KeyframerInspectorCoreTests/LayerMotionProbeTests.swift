import QuartzCore
import XCTest
@testable import KeyframerInspectorCore

/// The probe behind the automatic signal of a SwiftUI animation nothing traces: what moved, grouped by
/// how it moved.
final class LayerMotionProbeTests: XCTestCase {
    private func layer(_ name: String, x: Double = 0, in parent: CALayer) -> CALayer {
        let l = CALayer()
        l.name = name
        l.position = CGPoint(x: x, y: 0)
        l.bounds = CGRect(x: 0, y: 0, width: 100, height: 40)
        parent.addSublayer(l)
        return l
    }

    func testLayersMovingTogetherAreOneGroupAndJumpsAreNot() {
        CATransaction.setDisableActions(true)
        let root = CALayer()
        let page = (0..<3).map { layer("text \($0)", x: Double($0) * 120, in: root) }
        let badge = layer("badge", in: root)
        let jumper = layer("jumper", in: root)
        let chrome = layer("chrome", in: root)
        let classify = { (l: CALayer) -> String? in l.name == "chrome" || l === root ? nil : "view" }

        let probe = LayerMotionProbe()
        probe.begin(root: root, at: 100)
        XCTAssertTrue(probe.isActive)
        var found: [MotionGroup] = []
        for (i, t) in [116.0, 133, 150, 166].enumerated() {
            let dx = Double(i + 1) * 30
            for (j, l) in page.enumerated() { l.position.x = Double(j) * 120 + dx }
            badge.opacity = Float(1 - Double(i + 1) * 0.2)
            chrome.position.y = Double(i + 1) * 10
            if i == 0 { jumper.position.y = 200 }
            found += probe.frame(root: root, at: t, classify: classify)
        }
        XCTAssertEqual(found.count, 2)
        let moving = found.first { $0.props == [.x] }
        XCTAssertTrue(moving?.layer === page[0], "the first of the page's layers stands for it")
        XCTAssertEqual(moving?.history.map(\.t), [100, 116, 133])
        XCTAssertEqual(moving?.history.map { $0.values[.x] }, [0, 30, 60])
        let fade = found.first { $0.props == [.opacity] }
        XCTAssertTrue(fade?.layer === badge)
        XCTAssertEqual(fade?.history.count, 3, "where it started and the two frames that made it a fade")

        // Past `until` it ends, and a later begin starts again from the tree as it is.
        XCTAssertEqual(probe.frame(root: root, at: 501, classify: classify).count, 0)
        XCTAssertFalse(probe.isActive)
    }

    func testALayerAddedMeanwhileStartsFromWhereItAppeared() {
        CATransaction.setDisableActions(true)
        let root = CALayer()
        let probe = LayerMotionProbe()
        probe.begin(root: root, at: 0)
        _ = probe.frame(root: root, at: 16, classify: { _ in "view" })
        let added = layer("sheet", x: 0, in: root)
        added.position.y = 800
        var found: [MotionGroup] = []
        for (i, t) in [33.0, 50, 66].enumerated() {
            if i > 0 { added.position.y = 800 - Double(i) * 200 }
            found += probe.frame(root: root, at: t, classify: { _ in "view" })
        }
        XCTAssertEqual(found.first?.props, [.y])
        XCTAssertEqual(found.first?.history.map(\.t), [33, 50, 66])
    }

    /// An ease-in turns a layer before it grows or fades: each property is reported once it moves,
    /// with everything since the start.
    func testPropertiesThatStartMovingLaterComeBackOnTheirOwn() {
        CATransaction.setDisableActions(true)
        let root = CALayer()
        let star = layer("star", in: root)
        let probe = LayerMotionProbe()
        probe.begin(root: root, at: 0)
        var found: [MotionGroup] = []
        for i in 1...6 {
            let k = Double(i * i) / 36
            star.setAffineTransform(CGAffineTransform(rotationAngle: k * 2.5).scaledBy(x: 1 + k * 0.03, y: 1 + k * 0.03))
            star.opacity = Float(1 - k * 0.025)
            found += probe.frame(root: root, at: Double(i) * 16, classify: { _ in "shape" })
        }
        XCTAssertEqual(found.map(\.props), [[.rotation], [.scale], [.opacity]])
        XCTAssertEqual(found.last?.history.map(\.t), [0, 16, 32, 48, 64])
    }

    /// Watched while it moves: past the first 400 ms as long as something changes, until 300 ms of
    /// quiet, never more than 3 s.
    func testWatchesWhileThingsMove() {
        CATransaction.setDisableActions(true)
        let root = CALayer()
        let slow = layer("slow", in: root)
        let probe = LayerMotionProbe()
        probe.begin(root: root, at: 0)
        var t = 0.0
        while t < 1000 {
            t += 16
            slow.position.x = t / 10
            _ = probe.frame(root: root, at: t, classify: { _ in "view" })
        }
        XCTAssertTrue(probe.isActive)
        XCTAssertEqual(probe.until, t + 300, accuracy: 0.001)
        while probe.isActive { t += 16; _ = probe.frame(root: root, at: t, classify: { _ in "view" }) }
        XCTAssertEqual(t, 1312, accuracy: 16)

        probe.begin(root: root, at: 0)
        t = 0
        while probe.isActive {
            t += 16
            slow.position.x = t
            _ = probe.frame(root: root, at: t, classify: { _ in "view" })
        }
        XCTAssertLessThanOrEqual(t, 3016)
    }

    func testNoMoreGroupsThanAllowed() {
        CATransaction.setDisableActions(true)
        let root = CALayer()
        let many = (0..<5).map { layer("l\($0)", in: root) }
        let probe = LayerMotionProbe(maxGroups: 2)
        probe.begin(root: root, at: 0)
        var found: [MotionGroup] = []
        for i in 1...3 {
            for (j, l) in many.enumerated() { l.position.x = Double(i * (j + 1) * 10) }
            found += probe.frame(root: root, at: Double(i) * 16, classify: { _ in "view" })
        }
        XCTAssertEqual(found.count, 2)
    }
}
