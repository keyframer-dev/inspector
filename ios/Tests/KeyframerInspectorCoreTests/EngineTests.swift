import QuartzCore
import XCTest
@testable import KeyframerInspectorCore

#if os(macOS)
func boxed(_ p: CGPoint) -> NSValue { NSValue(point: p) }
func boxed(_ r: CGRect) -> NSValue { NSValue(rect: r) }
#else
import UIKit
func boxed(_ p: CGPoint) -> NSValue { NSValue(cgPoint: p) }
func boxed(_ r: CGRect) -> NSValue { NSValue(cgRect: r) }
#endif

final class FrameMeterTests: XCTestCase {
    // The same cases as react-native/src/frameMeter.test.ts.
    func testReads60FpsAndCountsALongFrame() {
        var m = FrameMeter(thread: .ui, windowMs: 250)
        var t = 0.0
        for i in 0...30 {
            t = Double(i) * (1000.0 / 60)
            m.tick(t)
        }
        XCTAssertEqual(m.stats.first?.fps, 60)
        XCTAssertEqual(m.stats.first?.dropped, 0)
        XCTAssertEqual(m.drops, [])
        t += 50
        m.tick(t)
        XCTAssertEqual(m.drops, [InspectorFrameDrop(t: t, thread: .ui, ms: 50, dropped: 2)])
    }

    func testLearns120HzFromMostFrames() {
        var m = FrameMeter(thread: .ui, windowMs: 250)
        for i in 0...40 { m.tick(Double(i) * (1000.0 / 120)) }
        XCTAssertEqual(m.interval, 1000.0 / 120, accuracy: 1e-9)
        var j = FrameMeter(thread: .ui, windowMs: 250)
        var t = 0.0
        for i in 0..<20 {
            t += i == 5 ? 4 : 1000.0 / 60
            j.tick(t)
        }
        XCTAssertEqual(j.interval, 1000.0 / 60, accuracy: 1e-9)
        XCTAssertEqual(j.drops, [])
    }
}

final class SampleCompressorTests: XCTestCase {
    func testKeepsTheLastHeldSampleBeforeAMove() {
        var c = SampleCompressor()
        var out: [InspectorSample] = []
        for (t, v) in [(0.0, 0.0), (16, 0), (32, 0), (1000, 0), (1016, 5), (1032, 10), (1048, 10), (1064, 10)] {
            out += c.push(id: "a", t: t, v: v)
        }
        out += c.finish()
        XCTAssertEqual(out.map(\.t), [0, 1000, 1016, 1032, 1064])
        XCTAssertEqual(out.map(\.v), [0, 0, 5, 10, 10])
    }

    func testTracksAreIndependent() {
        var c = SampleCompressor()
        XCTAssertEqual(c.push(id: "a", t: 0, v: 1).count, 1)
        XCTAssertEqual(c.push(id: "b", t: 0, v: 1).count, 1)
        XCTAssertEqual(c.push(id: "a", t: 16, v: 1).count, 0)
        XCTAssertEqual(c.push(id: "b", t: 16, v: 2).count, 1)
        XCTAssertEqual(c.finish().map(\.id), ["a"])
    }
}

final class LayerValueTests: XCTestCase {
    func testScalarPaths() {
        XCTAssertEqual(LayerKeyPath.scalarPaths(for: "position"), ["position.x", "position.y"])
        XCTAssertEqual(LayerKeyPath.scalarPaths(for: "opacity"), ["opacity"])
        XCTAssertEqual(LayerKeyPath.scalarPaths(for: "transform.scale"), ["transform.scale"])
        XCTAssertEqual(LayerKeyPath.scalarPaths(for: "transform").count, 5)
        XCTAssertEqual(LayerKeyPath.scalarPaths(for: "backgroundColor"), [])
    }

    /// The paths are ones Core Animation's key-value coding reads.
    func testPathsReadFromALayer() {
        let layer = CALayer()
        layer.position = CGPoint(x: 10, y: 20)
        layer.bounds = CGRect(x: 0, y: 5, width: 100, height: 50)
        layer.transform = CATransform3DRotate(CATransform3DMakeScale(2, 2, 1), .pi / 2, 0, 0, 1)
        layer.opacity = 0.5
        func read(_ p: String) -> Double? { LayerValue.number(layer.value(forKeyPath: p)) }
        XCTAssertEqual(read("position.x"), 10)
        XCTAssertEqual(read("position.y"), 20)
        XCTAssertEqual(read("bounds.origin.y"), 5)
        XCTAssertEqual(read("bounds.size.width"), 100)
        XCTAssertEqual(read("transform.scale.x") ?? 0, 2, accuracy: 1e-6)
        XCTAssertEqual(read("transform.rotation.z") ?? 0, .pi / 2, accuracy: 1e-6)
        XCTAssertEqual(read("opacity"), 0.5)
    }

    func testBoxedValuesAsJSON() {
        XCTAssertEqual(LayerValue.json(NSNumber(value: 0.25)), 0.25)
        XCTAssertEqual(LayerValue.json(boxed(CGPoint(x: 1, y: 2))), ["x": 1, "y": 2])
        XCTAssertEqual(LayerValue.json(boxed(CGRect(x: 1, y: 2, width: 3, height: 4))), ["x": 1, "y": 2, "width": 3, "height": 4])
        XCTAssertEqual(LayerValue.json(NSValue(caTransform3D: CATransform3DMakeScale(2, 3, 1)))["scaleY"], 3)
        XCTAssertEqual(LayerValue.json(CGColor(srgbRed: 1, green: 0, blue: 0, alpha: 1)), "#ff0000ff")
        XCTAssertEqual(LayerValue.json(nil), .null)
    }
}

final class AnimationInfoTests: XCTestCase {
    func testSpringParamsAndImplicitValues() {
        let spring = CASpringAnimation(keyPath: "position")
        spring.mass = 1
        spring.stiffness = 200
        spring.damping = 20
        spring.duration = 0.6
        spring.fromValue = boxed(CGPoint(x: 0, y: 0))
        let info = AnimationInfo(spring, delayMs: 100, to: boxed(CGPoint(x: 0, y: 120)))
        XCTAssertEqual(info.keyPath, "position")
        XCTAssertEqual(info.args[0], ["x": 0, "y": 120])
        XCTAssertEqual(info.args[1]["animation"], "CASpringAnimation")
        XCTAssertEqual(info.args[1]["duration"], 600)
        XCTAssertEqual(info.args[1]["delay"], 100)
        XCTAssertEqual(info.args[1]["from"], ["x": 0, "y": 0])
        let paths = info.params.map(\.path)
        XCTAssertEqual(paths, ["1.duration", "1.mass", "1.stiffness", "1.damping", "1.dampingRatio", "1.initialVelocity"])
        XCTAssertNotNil(info.args[1]["settlingDuration"])
    }

    func testDurationIncludesDelayAndRepeats() {
        let a = CABasicAnimation(keyPath: "opacity")
        a.duration = 0.25
        XCTAssertEqual(AnimationInfo.durationMs(of: a, delayMs: 100), 350)
        a.repeatCount = 2
        a.autoreverses = true
        XCTAssertEqual(AnimationInfo.durationMs(of: a), 1000)
        a.repeatCount = .infinity
        XCTAssertNil(AnimationInfo.durationMs(of: a), "forever: left out")
        XCTAssertNil(AnimationInfo(a).durationMs)
    }

    func testTimingAndKeyframes() {
        let basic = CABasicAnimation(keyPath: "opacity")
        basic.duration = 0.25
        basic.timingFunction = CAMediaTimingFunction(name: .easeOut)
        basic.toValue = 0
        let info = AnimationInfo(basic)
        XCTAssertEqual(info.args[0], 0)
        XCTAssertEqual(info.args[1]["easing"], "easeOut")
        XCTAssertEqual(info.args[1]["bezier"], [0, 0, 0.58, 1])

        let keyframes = CAKeyframeAnimation(keyPath: "transform.scale")
        keyframes.values = [1, 1.2, 1]
        keyframes.keyTimes = [0, 0.5, 1]
        keyframes.repeatCount = .infinity
        let k = AnimationInfo(keyframes)
        XCTAssertEqual(k.args[0], 1)
        XCTAssertEqual(k.args[1]["values"], [1, 1.2, 1])
        XCTAssertEqual(k.args[1]["repeatCount"], "infinite")
    }

    func testOverridesEditACopy() throws {
        let spring = CASpringAnimation(keyPath: "position.y")
        spring.stiffness = 100
        spring.damping = 10
        spring.duration = 0.4
        let edited = try XCTUnwrap(AnimationInfo.applying(["1.stiffness": 400, "1.damping": 30], to: spring) as? CASpringAnimation)
        XCTAssertEqual(edited.stiffness, 400)
        XCTAssertEqual(edited.damping, 30)
        XCTAssertEqual(edited.duration, edited.settlingDuration, accuracy: 1e-9)
        XCTAssertEqual(spring.stiffness, 100, "the original is untouched")
        XCTAssertEqual(try XCTUnwrap(AnimationInfo.applying(["1.duration": 900], to: spring)).duration, 0.9, accuracy: 1e-9)
        XCTAssertNil(AnimationInfo.applying([:], to: spring))
        XCTAssertNil(AnimationInfo.applying(["1.stiffness": 1], to: CABasicAnimation(keyPath: "opacity")))
    }

    func testDampingRatioIsReportedAndTuned() throws {
        let spring = CASpringAnimation(keyPath: "position.y")
        spring.mass = 1
        spring.stiffness = 100
        spring.damping = 10
        let ratio = try XCTUnwrap(AnimationInfo(spring).params.first { $0.path == "1.dampingRatio" })
        XCTAssertEqual(ratio.value, 0.5, accuracy: 1e-9)
        // With a new stiffness the ratio holds: damping follows it.
        let edited = try XCTUnwrap(AnimationInfo.applying(["1.dampingRatio": 0.8, "1.stiffness": 400], to: spring) as? CASpringAnimation)
        XCTAssertEqual(Double(edited.damping), 0.8 * 2 * 20, accuracy: 1e-6)
        XCTAssertEqual(edited.duration, edited.settlingDuration, accuracy: 1e-9)
        let explicit = try XCTUnwrap(AnimationInfo.applying(["1.dampingRatio": 0.8, "1.damping": 12], to: spring) as? CASpringAnimation)
        XCTAssertEqual(explicit.damping, 12)
    }

    func testLayerClock() {
        let c = LayerClock(local0: 100, media0: 50, rate: 1)
        XCTAssertEqual(c.local(atMedia: 49.5), 99.5)
        XCTAssertEqual(LayerClock(local0: 0, media0: 0, rate: 0.5).local(atMedia: 2), 1)
    }
}
