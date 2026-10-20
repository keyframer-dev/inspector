import KeyframerInspectorCore
import SwiftUI
import XCTest
@testable import KeyframerInspectorSwiftUI

/// SwiftUI's Animation read through Mirror (SwiftUI's core is the same on macOS, so this runs under
/// `swift test`). These pin the shapes the reader knows; a SwiftUI that changes them fails here first.
final class SwiftUIAnimationInfoTests: XCTestCase {
    func testBezierCurvesAndTheirNames() {
        let easeInOut = SwiftUIAnimationInfo(.easeInOut(duration: 0.5))
        XCTAssertEqual(easeInOut.kind, .bezier)
        XCTAssertEqual(easeInOut.duration, 0.5)
        XCTAssertEqual(easeInOut.curve, [0.42, 0, 0.58, 1])
        XCTAssertEqual(easeInOut.name, "easeInOut")
        XCTAssertEqual(easeInOut.config["duration"], 500)
        XCTAssertEqual(easeInOut.config["easing"], "easeInOut")
        XCTAssertEqual(easeInOut.params, [InspectorParam(path: "1.duration", value: 500)])
        XCTAssertEqual(easeInOut.durationMs, 500)

        XCTAssertEqual(SwiftUIAnimationInfo(.linear(duration: 0.3)).name, "linear")
        XCTAssertEqual(SwiftUIAnimationInfo(.easeIn(duration: 0.3)).name, "easeIn")
        XCTAssertEqual(SwiftUIAnimationInfo(.easeOut).name, "easeOut")
        let custom = SwiftUIAnimationInfo(.timingCurve(0.2, 0.8, 0.2, 1, duration: 0.5))
        XCTAssertEqual(custom.name, "timingCurve")
        XCTAssertEqual(custom.curve, [0.2, 0.8, 0.2, 1])
        XCTAssertNil(custom.config["easing"])
    }

    func testSprings() throws {
        let spring = SwiftUIAnimationInfo(.spring(response: 0.5, dampingFraction: 0.6))
        XCTAssertEqual(spring.kind, .spring)
        XCTAssertEqual(spring.response, 0.5)
        XCTAssertEqual(spring.dampingFraction, 0.6)
        XCTAssertEqual(spring.config["animation"], "spring")
        XCTAssertEqual(spring.config["response"], 500)
        XCTAssertEqual(spring.params.map(\.path), ["1.response", "1.dampingFraction"])
        if #available(macOS 14, *) {
            let settle = try XCTUnwrap(spring.durationMs)
            XCTAssertEqual(settle, 1200.6, accuracy: 1)
        }
        // .smooth, .snappy and .bouncy are springs with a response and damping fraction too.
        XCTAssertEqual(SwiftUIAnimationInfo(.bouncy).kind, .spring)

        let interpolating = SwiftUIAnimationInfo(.interpolatingSpring(stiffness: 170, damping: 15))
        XCTAssertEqual(interpolating.kind, .interpolatingSpring)
        XCTAssertEqual(interpolating.stiffness, 170)
        XCTAssertEqual(interpolating.damping, 15)
        XCTAssertEqual(interpolating.mass, 1)
        XCTAssertEqual(interpolating.initialVelocity, 0)
        XCTAssertEqual(interpolating.params.map(\.path), ["1.mass", "1.stiffness", "1.damping", "1.initialVelocity"])
    }

    func testModifiers() {
        let delayed = SwiftUIAnimationInfo(.easeOut(duration: 0.35).delay(0.2))
        XCTAssertEqual(delayed.kind, .bezier)
        XCTAssertEqual(delayed.delay, 0.2)
        XCTAssertEqual(delayed.config["delay"], 200)
        XCTAssertEqual(delayed.durationMs, 550)

        let fast = SwiftUIAnimationInfo(.linear(duration: 1).speed(2))
        XCTAssertEqual(fast.speed, 2)
        XCTAssertEqual(fast.durationMs, 500)
        XCTAssertEqual(fast.params.map(\.path), ["1.duration", "1.speed"])

        let repeated = SwiftUIAnimationInfo(.easeIn(duration: 0.3).repeatCount(3, autoreverses: true))
        XCTAssertEqual(repeated.repeats, .count(3))
        XCTAssertTrue(repeated.autoreverses)
        XCTAssertEqual(repeated.config["repeatCount"], 3)
        XCTAssertEqual(repeated.durationMs, 900, "SwiftUI counts each way as one")

        let forever = SwiftUIAnimationInfo(.linear(duration: 1).repeatForever(autoreverses: false))
        XCTAssertEqual(forever.repeats, .forever)
        XCTAssertEqual(forever.config["repeatCount"], "infinite")
        XCTAssertNil(forever.durationMs)
    }

    func testDefaultIsNamedButNotTweakable() {
        let info = SwiftUIAnimationInfo(.default)
        XCTAssertEqual(info.kind, .standard)
        XCTAssertEqual(info.name, "default")
        XCTAssertEqual(info.params, [])
        XCTAssertNil(info.applying(["1.duration": 900]))
    }

    /// What was read builds the same animation again, so an override changes only what it edits.
    func testRebuildsTheSameAnimation() {
        let animations: [Animation] = [
            .easeInOut(duration: 0.5),
            .spring(response: 0.4, dampingFraction: 0.7),
            .interpolatingSpring(mass: 2, stiffness: 120, damping: 9, initialVelocity: 1),
            .linear(duration: 0.25).delay(0.1),
            .easeIn(duration: 0.3).repeatCount(2, autoreverses: true),
        ]
        for a in animations {
            let info = SwiftUIAnimationInfo(a)
            XCTAssertEqual(info.animation().map(SwiftUIAnimationInfo.init), info, "\(a)")
        }
    }

    func testOverridesRebuildWithTheEdits() throws {
        let spring = SwiftUIAnimationInfo(.spring(response: 0.5, dampingFraction: 0.6))
        let edited = SwiftUIAnimationInfo(try XCTUnwrap(spring.applying(["1.response": 800, "1.dampingFraction": 0.9])))
        XCTAssertEqual(edited.response, 0.8)
        XCTAssertEqual(edited.dampingFraction, 0.9)

        let curve = SwiftUIAnimationInfo(.easeInOut(duration: 0.5).delay(0.2))
        let slower = SwiftUIAnimationInfo(try XCTUnwrap(curve.applying(["1.duration": 1200])))
        XCTAssertEqual(slower.duration, 1.2)
        XCTAssertEqual(slower.curve, [0.42, 0, 0.58, 1])
        XCTAssertEqual(slower.delay, 0.2, "what was not edited stays")
        XCTAssertNil(curve.applying(["1.stiffness": 300]), "not a parameter of a curve")
        XCTAssertNil(curve.applying([:]))
    }

    /// An animation type of the app's own is named, not guessed at.
    func testUnknownAnimationsAreNamedByType() {
        if #available(macOS 14, *) {
            let info = SwiftUIAnimationInfo(Animation(Wobble()))
            XCTAssertEqual(info.kind, .other("Wobble"))
            XCTAssertEqual(info.config["animation"], "Wobble")
            XCTAssertEqual(info.params, [])
        }
    }
}

@available(macOS 14, *)
private struct Wobble: CustomAnimation {
    var cycles = 3.0
    func animate<V: VectorArithmetic>(value: V, time: TimeInterval, context: inout AnimationContext<V>) -> V? {
        time > 1 ? nil : value.scaled(by: time)
    }
}
