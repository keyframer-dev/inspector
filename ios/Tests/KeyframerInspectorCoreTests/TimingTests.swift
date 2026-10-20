import QuartzCore
import XCTest
@testable import KeyframerInspectorCore

/// The `time` message's clock math: a window layer's timing changed without a jump, paused and stepped,
/// handed back, and read back later by the scrubber.
final class TimeControlTests: XCTestCase {
    func testSlowPauseStepResumeRestore() throws {
        var c = TimeControl(original: LayerTiming())
        XCTAssertTrue(c.isRestored)

        // A quarter of the speed from media 100: local time carries on from 100.
        c.set(scale: 0.25, atMedia: 100)
        XCTAssertEqual(c.timing.local(atParent: 100), 100, accuracy: 1e-9)
        XCTAssertEqual(c.timing.local(atParent: 104), 101, accuracy: 1e-9)

        // Paused at 104: local time holds.
        c.set(scale: 0, atMedia: 104)
        XCTAssertEqual(c.timing.local(atParent: 110), 101, accuracy: 1e-9)

        // Three frames of a 120 Hz display.
        let stepped = try XCTUnwrap(c.step(frames: 3, hz: 120, atMedia: 110))
        XCTAssertEqual(stepped.local(atParent: 111), 101.025, accuracy: 1e-9)

        // 1x again: on from where it was, behind the real clock.
        c.set(scale: 1, atMedia: 120)
        XCTAssertEqual(c.timing.local(atParent: 121), 102.025, accuracy: 1e-9)
        XCTAssertFalse(c.isRestored, "still lagging the real clock")

        // The app's own timing back: local is media time again.
        XCTAssertEqual(c.restore(atMedia: 130), LayerTiming())
        XCTAssertTrue(c.isRestored)
        XCTAssertEqual(c.map.local(atMedia: 130), 130, accuracy: 1e-9)

        // The history still reads the past right (what scrubbing a slowed recording needs).
        XCTAssertEqual(c.map.local(atMedia: 99), 99, accuracy: 1e-9)
        XCTAssertEqual(c.map.local(atMedia: 102), 100.5, accuracy: 1e-9)
        XCTAssertEqual(c.map.local(atMedia: 107), 101, accuracy: 1e-9)
        XCTAssertEqual(c.map.local(atMedia: 125), 106.025, accuracy: 1e-9)
    }

    func testStepsOnlyWhilePaused() {
        var c = TimeControl(original: LayerTiming())
        XCTAssertNil(c.step(frames: 1, hz: 60, atMedia: 1))
        c.set(scale: 0.5, atMedia: 1)
        XCTAssertNil(c.step(frames: 1, hz: 60, atMedia: 2))
        c.set(scale: 0, atMedia: 3)
        XCTAssertNil(c.step(frames: 0, hz: 60, atMedia: 4))
        XCTAssertNotNil(c.step(frames: 1, hz: 60, atMedia: 4))
    }

    /// The rules every SDK shares (N19): ignored but answered, 0 pauses, 0.01 to 1, steps floored and
    /// clamped to 1 to 120 frames.
    func testSanitizing() {
        XCTAssertNil(TimeControl.sanitize(scale: nil), "missing or not a number")
        XCTAssertNil(TimeControl.sanitize(scale: .nan))
        XCTAssertNil(TimeControl.sanitize(scale: -1))
        XCTAssertNil(TimeControl.sanitize(scale: .infinity))
        XCTAssertEqual(TimeControl.sanitize(scale: 0), 0)
        XCTAssertEqual(TimeControl.sanitize(scale: 0.001), 0.01)
        XCTAssertEqual(TimeControl.sanitize(scale: 0.25), 0.25)
        XCTAssertEqual(TimeControl.sanitize(scale: 1), 1)
        XCTAssertEqual(TimeControl.sanitize(scale: 4), 1, "never faster than real time")
        XCTAssertEqual(TimeControl.sanitize(scale: 100), 1)
        XCTAssertNil(TimeControl.sanitize(step: nil))
        XCTAssertNil(TimeControl.sanitize(step: 0))
        XCTAssertEqual(TimeControl.sanitize(step: 0.4), 1, "clamped to at least one frame")
        XCTAssertNil(TimeControl.sanitize(step: -3))
        XCTAssertEqual(TimeControl.sanitize(step: 1.6), 1, "floored")
        XCTAssertEqual(TimeControl.sanitize(step: 6), 6)
        XCTAssertEqual(TimeControl.sanitize(step: 1e6), 120)
    }

    /// Core Animation keeps speed as a Float; the map holds that Float, so it never drifts from the layer.
    func testSpeedIsWhatTheLayerKeeps() {
        var c = TimeControl(original: LayerTiming())
        XCTAssertEqual(c.set(scale: 0.1, atMedia: 0).speed, Double(Float(0.1)))
        // Relative to the app's own speed.
        var fast = TimeControl(original: LayerTiming(speed: 2))
        XCTAssertEqual(fast.set(scale: 0.5, atMedia: 0).speed, 1)
        fast.set(scale: 0, atMedia: 1)
        let paused = fast.map.local(atMedia: 1.5)
        fast.step(frames: 1, hz: 100, atMedia: 2)
        // One frame at the app's own speed (2): two hundredths of the layer's time.
        XCTAssertEqual(fast.map.local(atMedia: 2) - paused, 0.02, accuracy: 1e-9)
    }

    func testForgettingKeepsWhatIsNeeded() {
        var map = TimeMap(initial: LayerTiming())
        map.set(LayerTiming().retimed(atParent: 10, speed: 0.5), atMedia: 10)
        map.set(LayerTiming(speed: 0, beginTime: 20, timeOffset: 15), atMedia: 20)
        let before = map.local(atMedia: 15)
        map.forget(before: 15)
        XCTAssertEqual(map.changes.count, 1)
        XCTAssertEqual(map.local(atMedia: 15), before, accuracy: 1e-9)
        XCTAssertEqual(map.local(atMedia: 30), 15, accuracy: 1e-9)

        // Thousands of steps: the oldest half is folded away, the recent clock is intact.
        var steps = TimeMap(initial: LayerTiming())
        for i in 0..<5000 { steps.set(LayerTiming(speed: 0, beginTime: Double(i), timeOffset: Double(i) / 120), atMedia: Double(i)) }
        XCTAssertLessThanOrEqual(steps.changes.count, TimeMap.maxChanges)
        XCTAssertEqual(steps.local(atMedia: 4999.5), 4999.0 / 120, accuracy: 1e-9)
    }

    /// The scrubber's clock for a layer under a time-controlled window goes through its history.
    func testLayerClockReadsThroughTheMap() {
        var c = TimeControl(original: LayerTiming())
        c.set(scale: 0.25, atMedia: 100)
        c.set(scale: 0, atMedia: 104)
        // Measured at media 110, where the window (and the layer, at rate 1 to it) shows 101.
        let clock = LayerClock(local0: 101, media0: 110, rate: 1, map: c.map)
        XCTAssertEqual(clock.local(atMedia: 102), 100.5, accuracy: 1e-9)
        XCTAssertEqual(clock.local(atMedia: 99), 99, accuracy: 1e-9)
        XCTAssertEqual(clock.local(atMedia: 108), 101, accuracy: 1e-9)
        // Without a map: linear, as before.
        XCTAssertEqual(LayerClock(local0: 100, media0: 50, rate: 1).local(atMedia: 49.5), 99.5)
    }
}

final class FrameMeterDisplayTests: XCTestCase {
    /// At 120 Hz the first window already counts against 8.3 ms, not 16.7.
    func testCountsAgainstTheDisplaysRate() {
        var m = FrameMeter(thread: .js, windowMs: 250, hz: 120)
        XCTAssertEqual(m.interval, 1000.0 / 120, accuracy: 1e-9)
        var t = 0.0
        for _ in 0..<5 {
            m.tick(t)
            t += 1000.0 / 120
        }
        t += 1000.0 / 120 * 2
        m.tick(t)
        XCTAssertEqual(m.drops.first?.dropped, 2)

        var old = FrameMeter(thread: .js, windowMs: 250)
        t = 0
        for _ in 0..<5 {
            old.tick(t)
            t += 1000.0 / 120
        }
        t += 1000.0 / 120 * 2
        old.tick(t)
        XCTAssertEqual(old.drops.first?.dropped, 1, "without hz the first window is measured at 60 Hz")
    }

    /// A 60 Hz display never learns 120 Hz from callbacks that bunch up.
    func testNeverFasterThanTheDisplay() {
        var m = FrameMeter(thread: .js, windowMs: 100, hz: 60)
        var t = 0.0
        for _ in 0..<40 {
            m.tick(t)
            t += 8
        }
        XCTAssertEqual(m.interval, 1000.0 / 60, accuracy: 1e-9)
        var unbounded = FrameMeter(thread: .js, windowMs: 100)
        t = 0
        for _ in 0..<40 {
            unbounded.tick(t)
            t += 8
        }
        XCTAssertEqual(unbounded.interval, 1000.0 / 120, accuracy: 1e-9)
    }

    /// N1: the main thread blocked right after `record`, before the display link ticked: one long frame.
    func testAStallAtTheStartIsMeasured() {
        var m = FrameMeter(thread: .js, hz: 60)
        m.start(at: 0)
        m.tick(-3)
        m.tick(160)
        XCTAssertEqual(m.drops, [InspectorFrameDrop(t: 160, thread: .js, ms: 160, dropped: 9)])
        var unseeded = FrameMeter(thread: .js, hz: 60)
        unseeded.tick(160)
        unseeded.tick(176.7)
        XCTAssertEqual(unseeded.drops, [], "without a start the stall is the baseline: what N1 was")
    }

    /// Low Power Mode: the display drops to 60 Hz mid-recording.
    func testANewRateStartsFromItsBudget() {
        var m = FrameMeter(thread: .js, hz: 120)
        m.hz = 60
        XCTAssertEqual(m.interval, 1000.0 / 60, accuracy: 1e-9)
    }
}
