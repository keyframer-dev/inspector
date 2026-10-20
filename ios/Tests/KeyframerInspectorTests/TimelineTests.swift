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

    // MARK: Time control

    func testWindowClockSlowsPausesStepsAndHandsBack() throws {
        let root = CALayer()
        let child = CALayer()
        root.addSublayer(child)
        let clocks = WindowClocks()
        let t0 = CACurrentMediaTime()
        let local0 = child.convertTime(t0, from: nil)

        clocks.set(scale: 0.25, keyWindow: root, now: t0)
        XCTAssertEqual(root.speed, 0.25)
        XCTAssertEqual(child.convertTime(t0, from: nil), local0, accuracy: 1e-6, "no jump")
        XCTAssertEqual(child.convertTime(t0 + 4, from: nil) - local0, 1, accuracy: 1e-6)

        clocks.set(scale: 0, keyWindow: root, now: t0 + 4)
        XCTAssertEqual(root.speed, 0)
        XCTAssertEqual(child.convertTime(t0 + 9, from: nil) - local0, 1, accuracy: 1e-6, "paused")
        clocks.step(frames: 6, hz: 60, now: t0 + 9)
        XCTAssertEqual(child.convertTime(t0 + 10, from: nil) - local0, 1.1, accuracy: 1e-6, "six frames of 60 Hz")

        // 1x: running again from where it was, behind the real clock while something animates.
        clocks.set(scale: 1, keyWindow: root, now: t0 + 10)
        XCTAssertEqual(clocks.scale, 1)
        XCTAssertEqual(root.speed, 1)
        XCTAssertEqual(child.convertTime(t0 + 11, from: nil) - local0, 2.1, accuracy: 1e-6)
        let spin = CABasicAnimation(keyPath: "transform.rotation.z")
        spin.duration = 100
        child.add(spin, forKey: "spin")
        clocks.settle(now: t0 + 11)
        XCTAssertNotEqual(root.timeOffset, 0, "still something running: not handed back yet")
        child.removeAllAnimations()
        clocks.settle(now: t0 + 12)
        XCTAssertEqual(root.speed, 1)
        XCTAssertEqual(root.timeOffset, 0)
        XCTAssertEqual(root.beginTime, 0)
    }

    func testEditorLeavingRestoresAtOnce() {
        let root = CALayer()
        let clocks = WindowClocks()
        clocks.set(scale: 0, keyWindow: root, now: CACurrentMediaTime())
        XCTAssertEqual(root.speed, 0)
        clocks.restore(now: CACurrentMediaTime())
        XCTAssertEqual(clocks.scale, 1)
        XCTAssertEqual(root.speed, 1)
        XCTAssertEqual(root.timeOffset, 0)
        XCTAssertEqual(root.beginTime, 0)
    }

    /// A recording made at half speed and then paused: a moment of it lands where the animation was
    /// on the window's clock. Measuring the rate now (paused: 0) would put every moment in the same place.
    func testScrubsARecordingMadeInSlowMotion() throws {
        let root = CALayer()
        let child = CALayer()
        root.addSublayer(child)
        let clocks = WindowClocks()
        let t0 = CACurrentMediaTime() - 100
        clocks.set(scale: 0.5, keyWindow: root, now: t0)
        let anim = CABasicAnimation(keyPath: "position.x")
        anim.fromValue = 0
        anim.toValue = 100
        anim.duration = 10
        let begin = child.convertTime(t0, from: nil)
        clocks.set(scale: 0, keyWindow: root, now: t0 + 2)

        let scrubber = Scrubber()
        let recorded = [RecordedAnimation(layer: child, anim: anim, begin: begin)]
        scrubber.seek(toMedia: t0 + 1, live: [], recorded: recorded, context: { clocks.context(of: $0) })
        let copy = try XCTUnwrap(child.animationKeys()?.compactMap { child.animation(forKey: $0) as? CABasicAnimation }.first { $0.toValue as? Int == 100 })
        XCTAssertEqual(progress(child, copy), 0.05, accuracy: 1e-6, "1 s of media at half speed: 0.5 s in")
        scrubber.seek(toMedia: t0 + 50, live: [], recorded: recorded, context: { clocks.context(of: $0) })
        XCTAssertEqual(progress(child, copy), 0.1, accuracy: 1e-6, "paused at 1 s in")
        scrubber.end()
        clocks.restore(now: CACurrentMediaTime())
    }

    /// Delays read on the layer's own clock: UIKit's relative beginTime is the delay as written.
    func testAnimationBeginsOnTheLayersClock() {
        let layer = CALayer()
        let now = CACurrentMediaTime()
        let relative = CABasicAnimation(keyPath: "opacity")
        relative.beginTime = 0.2
        relative.setValue("relative", forKey: "beginTimeMode")
        let r = Inspector.begin(of: relative, on: layer, now: now)
        XCTAssertEqual(r.delay, 0.2, accuracy: 1e-9)
        XCTAssertEqual(r.local, layer.convertTime(now, from: nil) + 0.2, accuracy: 1e-9)
        let plain = Inspector.begin(of: CABasicAnimation(keyPath: "opacity"), on: layer, now: now)
        XCTAssertEqual(plain.delay, 0)
        let absolute = CABasicAnimation(keyPath: "opacity")
        absolute.beginTime = layer.convertTime(now, from: nil) + 0.5
        XCTAssertEqual(Inspector.begin(of: absolute, on: layer, now: now).delay, 0.5, accuracy: 1e-9)
    }

    // MARK: Render hints that need views

    func testABlurAboveTheAnimatedViewIsSeen() {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 400, height: 800))
        // A new window is hidden until shown.
        window.isHidden = false
        let card = UIView(frame: CGRect(x: 20, y: 100, width: 160, height: 160))
        window.addSubview(card)
        let blur = UIVisualEffectView(effect: UIBlurEffect(style: .regular))
        blur.frame = CGRect(x: 0, y: 0, width: 400, height: 120)
        window.addSubview(blur)
        XCTAssertNotNil(LayerWatch.blur(over: card.layer, name: { _ in "card" }), "overlaps the card's top")
        XCTAssertEqual(LayerWatch.window(of: card.layer), window.layer)
        blur.frame.origin.y = 400
        XCTAssertNil(LayerWatch.blur(over: card.layer, name: { _ in "card" }), "below it on screen")
        blur.frame.origin.y = 0
        blur.isHidden = true
        XCTAssertNil(LayerWatch.blur(over: card.layer, name: { _ in "card" }))
        // Behind the card (earlier in the list) it is not re-blurred by the card's motion.
        blur.isHidden = false
        window.sendSubviewToBack(blur)
        XCTAssertNil(LayerWatch.blur(over: card.layer, name: { _ in "card" }))
        // A blur that moves itself.
        XCTAssertNotNil(LayerWatch.blur(over: blur.layer, name: { _ in "blur" }))
    }

    func testVisibilityChangesAreReportedOnce() {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 400, height: 800))
        // A new window is hidden until shown.
        window.isHidden = false
        let card = UIView(frame: CGRect(x: 20, y: 100, width: 160, height: 160))
        window.addSubview(card)
        let watch = LayerWatch()
        XCTAssertNil(watch.visibilityChange(of: card.layer), "first seen visible: nothing to say")
        card.frame.origin.x = 900
        XCTAssertEqual(watch.visibilityChange(of: card.layer)?.reason, .offscreen)
        XCTAssertTrue(watch.isOutOfSight(card.layer))
        XCTAssertNil(watch.visibilityChange(of: card.layer), "no change")
        card.removeFromSuperview()
        XCTAssertEqual(watch.visibilityChange(of: card.layer)?.reason, .detached)
        window.addSubview(card)
        card.frame.origin.x = 20
        let back = watch.visibilityChange(of: card.layer)
        XCTAssertEqual(back?.visible, true)
        XCTAssertNil(back?.reason)
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
