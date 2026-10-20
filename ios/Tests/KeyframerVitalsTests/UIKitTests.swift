#if canImport(UIKit)
import QuartzCore
import UIKit
import XCTest
@testable import KeyframerVitals

/// Runs on an iOS simulator (xcodebuild test): the swizzle's stack capture, calibrated, lands on the
/// caller of `-addAnimation:forKey:`, in debug and in an optimized build.
@MainActor
final class UIKitTests: XCTestCase {
    @inline(never)
    private func addBetweenMarkers(_ layer: CALayer) -> Range<UInt> {
        let animation = CABasicAnimation(keyPath: "position")
        let before = vitalsReturnAddresses(max: 2).first ?? 0
        layer.add(animation, forKey: "move")
        let after = vitalsReturnAddresses(max: 2).first ?? 0
        return (before + 1)..<after
    }

    func testCalibratedSkipFindsTheCaller() throws {
        VitalsSwizzles.installOnce()
        VitalsTap.calibrate()
        XCTAssertGreaterThanOrEqual(VitalsTap.skip, 1)
        XCTAssertLessThanOrEqual(VitalsTap.skip, 8)
        var captured: [UInt] = []
        VitalsTap.probe = { captured = $0 }
        defer { VitalsTap.probe = nil }
        let range = addBetweenMarkers(CALayer())
        XCTAssertGreaterThan(captured.count, VitalsTap.skip)
        XCTAssertTrue(range.contains(captured[VitalsTap.skip]), "skip \(VitalsTap.skip): \(captured.prefix(6).map { String($0, radix: 16) }) vs \(range)")
    }

    func testDurations() {
        let layer = CALayer()
        let a = CABasicAnimation(keyPath: "opacity")
        a.duration = 0.3
        a.repeatCount = 2
        a.autoreverses = true
        XCTAssertEqual(VitalsTap.durationMs(of: a, on: layer)!, 1200, accuracy: 0.001)
        a.repeatCount = .infinity
        XCTAssertNil(VitalsTap.durationMs(of: a, on: layer))
        a.repeatCount = .greatestFiniteMagnitude
        XCTAssertNil(VitalsTap.durationMs(of: a, on: layer))
    }

    func testScreensAndScrollViews() {
        XCTAssertFalse(VitalsRuntime.isScreen(UINavigationController()))
        let scroll = UIScrollView()
        let inner = UIView()
        scroll.addSubview(inner)
        XCTAssertTrue(VitalsRuntime.isOverScrollView(inner))
        scroll.isScrollEnabled = false
        XCTAssertFalse(VitalsRuntime.isOverScrollView(inner))
    }
}
#endif
