import Foundation
import KeyframerInspectorCore
import XCTest
@testable import KeyframerVitals

final class FrameMeterParityTests: XCTestCase {
    /// The field meter counts exactly what the inspector's FrameMeter counts, frame by frame, and learns
    /// the same rate: 60, 90 and 120 Hz runs, jitter, stalls, a display cap and a rate change.
    func testSameLostFramesAndIntervalAsInspectorMeter() {
        var rng = SplitMix(seed: 7)
        let scenarios: [(hz: Double?, base: Double)] = [(nil, 1000 / 60), (120, 1000 / 120), (120, 1000 / 60), (90, 1000 / 90), (60, 1000 / 120), (nil, 1000 / 120)]
        for (hz, base) in scenarios {
            var core = FrameMeter(thread: .js, hz: hz)
            var field = VitalsFrameMeter(hz: hz)
            core.start(at: 0)
            field.start(at: 0)
            var t = 0.0
            var coreLost = 0
            var fieldLost = 0
            for i in 0..<3000 {
                var gap = base + Double(rng.next() % 100) / 100 - 0.5
                if i % 97 == 0 { gap += base * Double(1 + rng.next() % 6) }
                if i % 1000 == 999 { gap = 750 }
                if i == 1500 { core.hz = 60; field.hz = 60 }
                t += gap
                core.tick(t)
                let drops = core.drain().drops
                let f = field.tick(t)
                let lost = drops.reduce(0) { $0 + $1.dropped }
                coreLost += lost
                fieldLost += f?.missed ?? 0
                XCTAssertEqual(f?.missed ?? 0, lost, "hz \(String(describing: hz)) frame \(i)")
                XCTAssertEqual(field.interval, core.interval, accuracy: 1e-9, "hz \(String(describing: hz)) frame \(i)")
            }
            XCTAssertEqual(coreLost, fieldLost)
            XCTAssertGreaterThan(fieldLost, 0)
        }
    }

    func testBudgetAndTarget() {
        var m = VitalsFrameMeter(hz: 120)
        XCTAssertEqual(m.targetHz, 120)
        m.start(at: 0)
        let f = m.tick(25)!
        XCTAssertEqual(f.budget, 1000 / 120, accuracy: 1e-9)
        XCTAssertEqual(f.missed, 2)
        XCTAssertNil(m.tick(25), "a tick not later than the last is left out")
        m.pause()
        XCTAssertNil(m.tick(1000), "after a pause the next tick is a baseline")
        XCTAssertEqual(m.tick(1000 + 1000 / 120)?.missed, 0)
    }
}

struct SplitMix {
    var state: UInt64
    init(seed: UInt64) { state = seed }
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}

final class MaskTests: XCTestCase {
    func testMasksLikeRedactTs() {
        XCTAssertEqual(Mask.maskText("Profile ada@example.com"), "Profile [email]")
        XCTAssertEqual(Mask.maskText("Order 1234567"), "Order [number]")
        XCTAssertEqual(Mask.maskText("User 9b2f1c3e-1d2a-4b5c-8d7e-0f1a2b3c4d5e"), "User [id]")
        XCTAssertEqual(Mask.maskText("/reset?token=abc123&x=1"), "/reset?token=[redacted]&x=1")
        XCTAssertEqual(Mask.maskText("key kf_abcdefgh12345"), "key [token]")
        XCTAssertEqual(Mask.maskText("call +1 (555) 123-4567"), "call [number]")
        XCTAssertEqual(Mask.maskText("FeedViewController"), "FeedViewController")
        XCTAssertEqual(Mask.maskText("Step 12"), "Step 12", "short numbers stay")
    }

    func testScreenNames() {
        XCTAssertEqual(Mask.screenName(String(repeating: "A", count: 100)).count, 64)
        XCTAssertEqual(Mask.screenName("  "), "Unknown")
        XCTAssertEqual(Mask.screenName("UIHostingController<ContentView>"), "UIHostingController<ContentView>")
    }
}

final class AggregatorTests: XCTestCase {
    private func frame(_ w: inout WindowAggregator, at t: Double, ms: Double, missed: Int, touch: TouchState = .none) {
        w.frame(VitalsFrame(ms: ms, budget: 1000 / 60, missed: missed), at: t, touch: touch)
    }

    private func context(reduceMotion: Bool = false) -> WindowAggregator.Context {
        .init(app: .init(version: "1", platform: "ios", environment: "production"), device: .init(os: "ios", osMajor: 18),
              display: .init(hz: 60, targetHz: 60), state: .init(), nonce: "abcdefgh12", seq: 0, sampleRate: 1, reduceMotion: reduceMotion)
    }

    func testHistogramIdleAndSites() {
        var w = WindowAggregator()
        w.resume(at: 0)
        w.setScreen("Feed", at: 0, navigation: false)
        let site = SiteInfo(ref: .name("card", type: nil), fn: "trace", prop: "scale", component: nil)
        w.animationStarted(site, start: 100, end: 200)
        frame(&w, at: 50, ms: 16.7, missed: 0)          // idle
        frame(&w, at: 70, ms: 20, missed: 0)            // idle (ends before the run)
        frame(&w, at: 150, ms: 50, missed: 2)           // during the run
        frame(&w, at: 216, ms: 66, missed: 3)           // overlaps the run's end
        frame(&w, at: 1100, ms: 800, missed: 47)        // idle, frozen
        let r = w.report(at: 2000, ended: .window, context: context())
        let st = r.screens[0].threads["js"]!
        XCTAssertEqual(st.frames, 5)
        XCTAssertEqual(st.hist, [2, 0, 1, 1, 0, 0, 0, 1])
        XCTAssertEqual(st.frozen, 1)
        XCTAssertEqual(st.idleFrames, 3)
        XCTAssertEqual(st.idleMissed, 47)
        XCTAssertEqual(st.hitchMs, WindowAggregator.tenth(0.0333 + 3.3333 + 33.3333 + 49.3333 + 783.3333), accuracy: 1e-9)
        XCTAssertEqual(r.sites.count, 1)
        XCTAssertEqual(r.sites[0].frames, 2)
        XCTAssertEqual(r.sites[0].missed, 5)
        XCTAssertEqual(r.sites[0].worstMs, 66)
        XCTAssertEqual(r.sites[0].runs, 1)
        XCTAssertEqual(r.sites[0].activeMs, 100)
        XCTAssertEqual(r.sites[0].key, "card")
        XCTAssertEqual(r.screens[0].ms, 2000)
        XCTAssertEqual(r.session.measuredMs, (16.7 + 20 + 50 + 66 + 800).rounded())
        XCTAssertEqual(r.session.foregroundMs, 2000)
    }

    func testOneBlockIsOneRunAndActiveTimeIsAUnion() {
        var w = WindowAggregator()
        w.resume(at: 0)
        let image = VitalsImage(debugId: "00112233445566778899aabbccddeeff", kind: "macho", name: "Acme", arch: "arm64")
        let a = SiteInfo(ref: .native(image: image, offset: 0x40, type: nil), fn: "UIView.animate", prop: "position", component: nil)
        var b = a
        b.prop = "bounds"
        w.animationStarted(a, start: 10, end: 310)
        w.animationStarted(b, start: 10.2, end: 310)   // same block, another property
        w.animationStarted(a, start: 200, end: 500)    // a second run overlapping the first
        let r = w.report(at: 1000, ended: .window, context: context())
        XCTAssertEqual(r.sites.count, 1)
        XCTAssertEqual(r.sites[0].runs, 2)
        XCTAssertEqual(r.sites[0].activeMs, 490)
        XCTAssertEqual(r.sites[0].prop, "position")
        XCTAssertNil(r.sites[0].key, "native sites are keyed by the server after symbolication")
        XCTAssertEqual(r.sites[0].ref, .native(image: 0, offset: 0x40, type: nil))
        XCTAssertEqual(r.images, [image])
    }

    func testCauses() {
        var w = WindowAggregator()
        w.resume(at: 0)
        w.setScreen("A", at: 1000)                             // navigation at 1000
        frame(&w, at: 1300, ms: 100, missed: 5)                // screen-mount, 300 ms after
        for i in 0..<6 {
            w.animationStarted(SiteInfo(ref: .name("s\(i)", type: nil), fn: "trace"), start: 3000 + Double(i), end: 3100)
        }
        frame(&w, at: 3040, ms: 80, missed: 4)                 // burst
        frame(&w, at: 5000, ms: 60, missed: 3, touch: .scroll) // scroll, nothing started
        frame(&w, at: 6000, ms: 40, missed: 1, touch: .gesture)
        frame(&w, at: 7000, ms: 35, missed: 1)                 // unknown
        frame(&w, at: 8000, ms: 34, missed: 1)                 // sixth slow frame: not among the 5 longest
        let r = w.report(at: 9000, ended: .window, context: context())
        XCTAssertEqual(r.worst.map(\.cause), [.screenMount, .burst, .scroll, .gesture, .unknown])
        XCTAssertEqual(r.worst.map(\.ms), [100, 80, 60, 40, 35])
        XCTAssertEqual(r.worst[0].afterNavMs, 300)
        XCTAssertEqual(r.worst[1].sites, [0, 1, 2, 3, 4, 5])
        XCTAssertTrue(r.worst.allSatisfy { $0.thread == .js })
    }

    func testScreensTimeAndCap() {
        var w = WindowAggregator()
        w.resume(at: 0)
        w.setScreen("A", at: 0)
        w.setScreen("B", at: 400)
        w.suspend(at: 1000)                // background: no screen time
        w.resume(at: 5000)
        w.setScreen("A", at: 5500)
        let r = w.report(at: 6000, ended: .background, context: context())
        XCTAssertEqual(r.screens.map(\.name), ["A", "B"])
        XCTAssertEqual(r.screens.map(\.ms), [900, 1100])
        XCTAssertEqual(r.session.foregroundMs, 2000)

        var many = WindowAggregator()
        many.resume(at: 0)
        for i in 0..<60 { many.setScreen("S\(i)", at: Double(i)) }
        let capped = many.report(at: 100, ended: .window, context: context())
        XCTAssertEqual(capped.screens.count, Vitals.maxScreens)
        XCTAssertEqual(capped.screens.last?.name, "Other")
    }

    func testSiteCapAndReduceMotion() {
        var w = WindowAggregator()
        w.resume(at: 0)
        for i in 0..<250 {
            w.animationStarted(SiteInfo(ref: .name("s\(i)", type: nil), fn: "trace"), start: Double(i * 10), end: Double(i * 10 + 5), reduceMotion: i == 0)
        }
        XCTAssertEqual(w.report(at: 5000, ended: .window, context: context()).sites.count, Vitals.maxSites)
        XCTAssertNil(w.report(at: 5000, ended: .window, context: context()).sites[0].runsReduceMotion, "left out unless the project collects it")
        XCTAssertEqual(w.report(at: 5000, ended: .window, context: context(reduceMotion: true)).sites[0].runsReduceMotion, 1)
    }

    func testTrimToBytes() throws {
        var w = WindowAggregator()
        w.resume(at: 0)
        let image = VitalsImage(debugId: "00112233445566778899aabbccddeeff", kind: "macho", name: "Acme", arch: "arm64")
        for i in 0..<200 {
            let ref: SiteInfo.Ref = i % 2 == 0 ? .native(image: image, offset: UInt64(i), type: String(repeating: "T", count: 100)) : .name(String(repeating: "n", count: 100) + "\(i)", type: nil)
            w.animationStarted(SiteInfo(ref: ref, fn: "UIView.animate", prop: "position"), start: Double(i), end: Double(i) + 1000)
        }
        frame(&w, at: 500, ms: 100, missed: 5)
        let report = w.report(at: 2000, ended: .window, context: context())
        XCTAssertGreaterThan(try report.encoded().count, Vitals.maxBytes)
        let data = try XCTUnwrap(report.trimmed(toBytes: Vitals.maxBytes))
        XCTAssertLessThanOrEqual(data.count, Vitals.maxBytes)
        let trimmed = try JSONDecoder().decode(VitalsReport.self, from: data)
        XCTAssertLessThan(trimmed.sites.count, 200)
        XCTAssertTrue(trimmed.worst.allSatisfy { $0.sites.allSatisfy { $0 < trimmed.sites.count } })
    }
}

final class MotionWindowTests: XCTestCase {
    func testAnimationAndTouchWindows() {
        var m = MotionWindows()
        XCTAssertFalse(m.isOpen(at: 0))
        m.animation(start: 0, end: 300)
        XCTAssertTrue(m.isOpen(at: 300))
        XCTAssertTrue(m.isOpen(at: 550), "250 ms after the last window")
        XCTAssertFalse(m.isOpen(at: 551))
        m.touchBegan(1, scroll: true, at: 1000)
        XCTAssertTrue(m.isOpen(at: 99_000), "open while a finger is down")
        XCTAssertEqual(m.touch(at: 5000), .scroll)
        m.touchEnded(1, at: 100_000)
        XCTAssertEqual(m.touch(at: 101_500), .scroll, "1.5 s after the last touch up")
        XCTAssertEqual(m.touch(at: 101_501), TouchState.none)
        XCTAssertTrue(m.isOpen(at: 101_750))
        XCTAssertFalse(m.isOpen(at: 101_751))
        m.touchBegan(2, scroll: false, at: 200_000)
        XCTAssertEqual(m.touch(at: 200_001), .gesture)
    }

    func testForeverAnimationsAreCapped() {
        var m = MotionWindows()
        m.animation(start: 0, end: .infinity)
        XCTAssertTrue(m.isOpen(at: 5000))
        XCTAssertFalse(m.isOpen(at: 5251))
    }
}
