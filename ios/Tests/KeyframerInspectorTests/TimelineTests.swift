#if canImport(UIKit)
import QuartzCore
import XCTest
@testable import KeyframerInspector

/// Core Animation state the scrubber and pins leave on layers, on a real iOS runtime (a simulator):
/// `xcodebuild test -scheme KeyframerInspector -destination 'id=<simulator>'`.
///
/// A hostless test bundle has no render context, so presentation values are not computed here; what
/// is checked is the timing each layer is left with (the local time an animation is shown at). The
/// rendered result is checked end to end, by the frames `Tools/editor.ts smoke` captures.
@MainActor
final class TimelineTests: XCTestCase {
    /// How far into `anim` (0...1) a frozen layer shows it.
    private func progress(_ layer: CALayer, _ anim: CAAnimation) -> Double {
        (layer.timeOffset - anim.beginTime) / anim.duration
    }

    func testScrubsALiveAnimationAndRestores() throws {
        let layer = CALayer()
        let begin = CACurrentMediaTime()
        let anim = CABasicAnimation(keyPath: "position.x")
        anim.fromValue = 0
        anim.toValue = 100
        anim.duration = 10
        anim.beginTime = begin
        layer.add(anim, forKey: "move")
        let attached = try XCTUnwrap(layer.animation(forKey: "move"))

        let scrubber = Scrubber()
        scrubber.seek(toMedia: begin + 2.5, live: [layer], recorded: [])
        XCTAssertTrue(scrubber.isActive)
        XCTAssertEqual(layer.speed, 0)
        XCTAssertEqual(progress(layer, attached), 0.25, accuracy: 1e-6)
        scrubber.seek(toMedia: begin + 7.5, live: [layer], recorded: [])
        XCTAssertEqual(progress(layer, attached), 0.75, accuracy: 1e-6)

        scrubber.end()
        XCTAssertFalse(scrubber.isActive)
        XCTAssertEqual(layer.speed, 1)
        XCTAssertEqual(layer.timeOffset, 0)
        XCTAssertEqual(layer.beginTime, 0)
        XCTAssertNotNil(layer.animation(forKey: "move"), "the app's animation is never removed")
    }

    /// A finished animation is put back from its recorded copy, at the moment it began, and the
    /// earliest one per property fills backwards.
    func testScrubsRecordedAnimationsThatAlreadyFinished() throws {
        let layer = CALayer()
        let begin = CACurrentMediaTime() - 30
        func move(_ from: Double, _ to: Double) -> CABasicAnimation {
            let a = CABasicAnimation(keyPath: "position.x")
            a.fromValue = from
            a.toValue = to
            a.duration = 2
            return a
        }
        let spin = CABasicAnimation(keyPath: "transform.rotation.z")
        spin.toValue = Double.pi
        spin.duration = 1
        let recorded = [
            RecordedAnimation(layer: layer, anim: move(200, 0), begin: begin + 5),
            RecordedAnimation(layer: layer, anim: move(0, 200), begin: begin),
            // Transient (the model never rotated): shown only while it ran.
            RecordedAnimation(layer: layer, anim: spin, begin: begin + 1, holdsEnd: false),
        ]

        let scrubber = Scrubber()
        scrubber.seek(toMedia: begin + 1, live: [], recorded: recorded)
        // Core Animation lists (and applies) them in beginTime order.
        let anims = try (layer.animationKeys() ?? []).map { try XCTUnwrap(layer.animation(forKey: $0) as? CABasicAnimation) }
        XCTAssertEqual(anims.map(\.keyPath), ["position.x", "position.x", "transform.rotation.z", "position.x"])
        let (base, first, spun, second) = (anims[0], anims[1], anims[2], anims[3])
        XCTAssertEqual(base.fromValue as? Double, 0, "under everything: the first held animation's start")
        XCTAssertEqual(base.toValue as? Double, 0)
        XCTAssertEqual(base.fillMode, .both)
        XCTAssertEqual(first.toValue as? Double, 200)
        XCTAssertEqual(first.fillMode, .forwards, "held after it ended")
        XCTAssertEqual(spun.fillMode, .removed, "transient: only while it ran")
        XCTAssertEqual(second.fillMode, .forwards)
        XCTAssertFalse(first.isRemovedOnCompletion)
        XCTAssertEqual(progress(layer, first), 0.5, accuracy: 1e-6)
        XCTAssertEqual(second.beginTime - first.beginTime, 5, accuracy: 1e-6)

        scrubber.end()
        XCTAssertEqual(layer.animationKeys() ?? [], [])
        XCTAssertEqual(layer.speed, 1)
    }

    func testPinsHoldAValueUntilReleased() throws {
        let layer = CALayer()
        let pins = PinBoard()
        pins.set(layer, path: "position.x", value: 42)
        let pin = try XCTUnwrap(layer.animation(forKey: "kf.pin.position.x") as? CABasicAnimation)
        XCTAssertEqual(pin.fromValue as? Double, 42)
        XCTAssertEqual(pin.toValue as? Double, 42)
        XCTAssertEqual(pin.fillMode, .both)
        XCTAssertEqual(layer.position.x, 0, "the model is untouched")
        XCTAssertFalse(pins.isEmpty)
        pins.releaseAll()
        XCTAssertNil(layer.animation(forKey: "kf.pin.position.x"))
        XCTAssertTrue(pins.isEmpty)
    }

    func testPinningAScrollOffsetScrollsTheView() {
        let scroll = UIScrollView(frame: CGRect(x: 0, y: 0, width: 100, height: 100))
        scroll.contentSize = CGSize(width: 1000, height: 100)
        let pins = PinBoard()
        pins.set(scroll.layer, path: "bounds.origin.x", value: 250)
        XCTAssertEqual(scroll.contentOffset.x, 250)
        XCTAssertTrue(pins.isEmpty, "a scroll view is scrolled, not pinned")
    }

    /// The swizzled add(_:forKey:) is a pass-through while no inspector runs.
    func testSwizzledAddPassesThrough() {
        Swizzles.installOnce()
        let layer = CALayer()
        let anim = CABasicAnimation(keyPath: "opacity")
        anim.toValue = 0
        layer.add(anim, forKey: "fade")
        XCTAssertNotNil(layer.animation(forKey: "fade"))
    }
}
#endif
