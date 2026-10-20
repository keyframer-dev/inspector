import Foundation
import XCTest
@testable import KeyframerVitals

/// A clock, a network and a scheduler the tests drive by hand.
final class FakePlatform {
    var t = 0.0
    var wall = Date(timeIntervalSince1970: 1_000_000)
    var random = 0.0
    var active = true
    var reduceMotion = false
    var sent: [VitalsReport] = []
    /// Outcomes for the next sends, in order; `.sent(nil)` once they run out.
    var outcomes: [Uploader.Outcome] = []
    var scheduled: [(at: Double, run: () -> Void)] = []
    var fetched: Result<VitalsConfig, Uploader.Outcome> = .failure(.retry)
    var fetches = 0

    func environment() -> ReporterEnvironment {
        ReporterEnvironment(
            now: { [unowned self] in t },
            wallNow: { [unowned self] in wall },
            random: { [unowned self] in random },
            facts: { [unowned self] collect in
                DeviceFacts(device: .init(os: "ios", osMajor: 18, model: "iPhone15,3", tier: .high, memoryGb: 6), hz: 60, meterHz: 60, adaptive: nil,
                            lowPower: false, thermal: .nominal, reduceMotion: collect.reduceMotion ? reduceMotion : nil)
            },
            send: { [unowned self] body, done in
                sent.append(try! JSONDecoder().decode(VitalsReport.self, from: body))
                done(outcomes.isEmpty ? .sent(nil) : outcomes.removeFirst())
            },
            fetchConfig: { [unowned self] done in fetches += 1; done(fetched) },
            after: { [unowned self] seconds, body in scheduled.append((wall.timeIntervalSince1970 + seconds, body)) },
            isActive: { [unowned self] in active }
        )
    }

    /// Moves both clocks on by `ms` and runs what was scheduled until then.
    func advance(_ ms: Double) {
        t += ms
        wall += ms / 1000
        let due = scheduled.filter { $0.at <= wall.timeIntervalSince1970 }
        scheduled.removeAll { $0.at <= wall.timeIntervalSince1970 }
        for job in due { job.run() }
    }
}

final class ReporterTests: XCTestCase {
    private var stores: [VitalsStore] = []

    override func tearDown() {
        for s in stores { try? FileManager.default.removeItem(at: s.directory) }
        stores = []
        super.tearDown()
    }

    private func make(_ p: FakePlatform, store: VitalsStore? = nil, environment: String = "production", rate: Double = 0.1) -> Reporter {
        let s = store ?? temporaryStore { p.wall }
        stores.append(s)
        return Reporter(
            options: ReporterOptions(appId: "com.acme.app", appVersion: "2.0", build: "7", environment: environment, sampleRate: rate, framework: { "UIKit" }),
            store: s, environment: p.environment()
        )
    }

    /// Some motion: an animation from a named site, a second of frames at 60 Hz with one long frame.
    private func move(_ r: Reporter, _ p: FakePlatform) {
        r.animationStarted(SiteInfo(ref: .name("card", type: nil), fn: "trace"), durationMs: 500)
        XCTAssertTrue(r.wantsFrames())
        r.meterStarted(at: p.t)
        for i in 0..<60 {
            p.advance(i == 10 ? 50 : 1000 / 60)
            r.frame(at: p.t)
        }
    }

    func testSampledSessionSendsAWindowPerForeground() throws {
        let p = FakePlatform()
        let r = make(p)
        r.start()
        XCTAssertTrue(r.isSampled)
        r.setScreen("FeedViewController")
        move(r, p)
        var running = true
        for _ in 0..<200 where running {
            p.advance(1000 / 60)
            running = r.frame(at: p.t)
        }
        XCTAssertFalse(running, "the motion window closed: the link stops")
        r.stopMeter()
        r.didEnterBackground()
        XCTAssertEqual(p.sent.count, 1)
        let first = p.sent[0]
        XCTAssertEqual(first.session.seq, 0)
        XCTAssertEqual(first.session.ended, .background)
        XCTAssertEqual(first.session.sampleRate, 0.1)
        XCTAssertEqual(first.screens.first?.name, "FeedViewController")
        XCTAssertEqual(first.sites.first?.ref, .name(name: "card", type: nil))
        XCTAssertGreaterThan(first.screens[0].threads["js"]!.frames, 50)
        XCTAssertEqual(first.worst.first?.missed, 2)
        XCTAssertEqual(first.app.framework, "UIKit")
        XCTAssertEqual(first.device.model, "iPhone15,3")
        XCTAssertNil(first.state.reduceMotion, "not collected by default")
        XCTAssertEqual(r.store.pending(), [], "sent, so nothing waits")

        // Back within 30 s: the same session, its next window.
        p.advance(20_000)
        r.didBecomeActive()
        move(r, p)
        r.didEnterBackground()
        XCTAssertEqual(p.sent[1].session.seq, 1)
        XCTAssertEqual(p.sent[1].session.nonce, first.session.nonce)
        XCTAssertEqual(p.sent[1].screens.first?.name, "FeedViewController", "the screen carries over")

        // Back after 30 s: a new session, a new nonce, sampled again.
        p.advance(31_000)
        r.didBecomeActive()
        r.didEnterBackground()
        XCTAssertEqual(p.sent[2].session.seq, 0)
        XCTAssertNotEqual(p.sent[2].session.nonce, first.session.nonce)
    }

    func testStartRateUntilTheProjectSaysOtherwise() {
        let p = FakePlatform()
        p.random = 0.5
        let r = make(p, rate: 0.8)
        r.start()
        XCTAssertTrue(r.isSampled, "no config yet: the rate passed to start")
        var config = VitalsConfig.defaults
        config.sampleRate = 0.2
        r.apply(config)
        r.didEnterBackground()
        p.advance(60_000)
        r.didBecomeActive()
        XCTAssertFalse(r.isSampled, "the project's rate once known")
    }

    func testUnsampledSessionsDoNothing() {
        let p = FakePlatform()
        p.random = 0.5
        let r = make(p)
        r.start()
        XCTAssertFalse(r.isSampled)
        r.animationStarted(SiteInfo(ref: .name("x", type: nil), fn: "trace"), durationMs: 300)
        XCTAssertFalse(r.wantsFrames())
        r.didEnterBackground()
        XCTAssertEqual(p.sent, [])
    }

    func testThreeSessionsPerDay() {
        let p = FakePlatform()
        let r = make(p, rate: 1)
        r.start()
        var sampled: [Bool] = []
        for _ in 0..<5 {
            sampled.append(r.isSampled)
            r.didEnterBackground()
            p.advance(60_000)
            r.didBecomeActive()
        }
        XCTAssertEqual(sampled, [true, true, true, false, false])
    }

    func testTenMinutesFillAWindow() {
        let p = FakePlatform()
        let r = make(p)
        r.start()
        p.advance(Vitals.windowMs - 1000)
        move(r, p)
        XCTAssertEqual(p.sent.count, 1)
        XCTAssertEqual(p.sent[0].session.ended, .window)
        XCTAssertEqual(p.sent[0].session.seq, 0)
        XCTAssertGreaterThanOrEqual(p.sent[0].session.foregroundMs, Vitals.windowMs)
        r.didEnterBackground()
        XCTAssertEqual(p.sent[1].session.seq, 1)
        XCTAssertLessThan(p.sent[1].session.foregroundMs, 2000)
    }

    func testCheckpointIsSentOnTheNextLaunch() throws {
        let p = FakePlatform()
        let store = temporaryStore { p.wall }
        let r = make(p, store: store)
        r.start()
        move(r, p)
        r.stopMeter()
        p.advance(Reporter.checkpointMs)
        move(r, p)
        // The app is killed here: nothing was sent.
        XCTAssertEqual(p.sent, [])

        let p2 = FakePlatform()
        p2.wall = p.wall + 3600
        p2.random = 0.9
        let next = Reporter(options: r.options, store: store, environment: p2.environment())
        next.start()
        XCTAssertEqual(store.pending().count, 1, "the checkpoint joined the retry queue")
        p2.advance(10_000)
        XCTAssertEqual(p2.sent.count, 1, "sent 10 s after start")
        XCTAssertEqual(p2.sent[0].session.ended, .unknown)
        XCTAssertGreaterThan(p2.sent[0].session.measuredMs, 900)
        XCTAssertEqual(store.pending(), [])
    }

    func testRetriesAreForegroundOnlyAndDeferredOnLowDataMode() {
        let p = FakePlatform()
        let r = make(p)
        r.start()
        p.outcomes = [.retry]
        p.active = false
        r.didEnterBackground()
        XCTAssertEqual(r.store.pending().count, 1, "a failed send waits")
        p.advance(10_000)
        XCTAssertEqual(p.sent.count, 1, "not retried while in the background")
        p.active = true
        r.didBecomeActive()
        XCTAssertEqual(p.sent.count, 2, "retried on coming back")
        XCTAssertEqual(r.store.pending(), [])

        p.outcomes = [.deferred]
        p.active = false
        r.didEnterBackground()
        XCTAssertEqual(r.store.pending().count, 1)
        p.active = true
        r.didBecomeActive()
        p.advance(3_600_000)
        XCTAssertEqual(p.sent.count, 3, "Low Data Mode: nothing more this launch")
        XCTAssertEqual(r.store.pending().count, 1)
    }

    func testRejectedReportsAreDropped() {
        let p = FakePlatform()
        let r = make(p)
        r.start()
        p.outcomes = [.rejected]
        r.didEnterBackground()
        XCTAssertEqual(r.store.pending(), [])
    }

    func testKillSwitch() {
        let p = FakePlatform()
        let r = make(p)
        r.start()
        p.outcomes = [.stop]
        r.didEnterBackground()
        XCTAssertEqual(r.store.stopUntil, p.wall.addingTimeInterval(7 * 86400))
        XCTAssertEqual(r.store.pending(), [])
        r.didBecomeActive()
        XCTAssertNil(r.session, "off for 7 days")

        let again = make(p, store: r.store)
        again.start()
        XCTAssertNil(again.session)
        p.wall += 7 * 86400 + 1
        let later = make(p, store: r.store)
        later.start()
        XCTAssertNotNil(later.session, "back after 7 days")
    }

    func testStopInAnUploadResponse() throws {
        let p = FakePlatform()
        let r = make(p)
        r.start()
        let stop = try JSONDecoder().decode(VitalsIngestResponse.self, from: Data(contentsOf: XCTUnwrap(protocolFile("fixtures/vitals/ingest-response-stop.json"))))
        p.outcomes = [.sent(stop.config)]
        r.didEnterBackground()
        XCTAssertNotNil(r.store.stopUntil)
    }

    func testSetEnabledFalseStopsAndDrops() {
        let p = FakePlatform()
        let r = make(p)
        r.start()
        move(r, p)
        r.checkpointNow()
        r.store.enqueue(Data("old".utf8))
        r.setEnabled(false)
        XCTAssertFalse(r.isSampled)
        XCTAssertEqual(r.store.pending(), [])
        XCTAssertNil(r.store.takeCheckpoint())
        r.didEnterBackground()
        p.advance(3_600_000)
        XCTAssertEqual(p.sent, [])
        p.advance(60_000)
        r.didBecomeActive()
        XCTAssertNil(r.session, "stays off")
        r.setEnabled(true)
        XCTAssertTrue(r.isSampled)
    }

    func testConfigFromResponsesAndDailyFetch() throws {
        let p = FakePlatform()
        var config = try JSONDecoder().decode(VitalsConfig.self, from: Data(contentsOf: XCTUnwrap(protocolFile("fixtures/vitals/config.json"))))
        config.collect.reduceMotion = true
        config.sampleRate = 1
        p.fetched = .success(config)
        p.reduceMotion = true
        let r = make(p)
        r.start()
        p.advance(10_000)
        XCTAssertEqual(p.fetches, 1)
        XCTAssertEqual(r.store.config()?.config, config)
        p.advance(3_600_000)
        let again = make(p, store: r.store)
        again.refreshConfigIfStale()
        XCTAssertEqual(p.fetches, 1, "at most once a day")

        // The next session uses the config: rate 1, Reduce Motion collected.
        r.didEnterBackground()
        p.advance(60_000)
        p.random = 0.99
        r.didBecomeActive()
        XCTAssertTrue(r.isSampled)
        move(r, p)
        r.didEnterBackground()
        let last = try XCTUnwrap(p.sent.last)
        XCTAssertEqual(last.session.sampleRate, 1)
        XCTAssertEqual(last.state.reduceMotion, true)
        XCTAssertEqual(last.sites.first?.runsReduceMotion, 1)

        // A response that turns the project off ends the session at once.
        var off = config
        off.enabled = false
        p.advance(60_000)
        r.didBecomeActive()
        XCTAssertTrue(r.isSampled)
        r.apply(off)
        XCTAssertFalse(r.isSampled)
    }

    func testModelsOffAndDevelopmentReports() {
        let p = FakePlatform()
        let store = temporaryStore { p.wall }
        var config = VitalsConfig.defaults
        config.collect.deviceModel = false
        config.collect.development = false
        config.sampleRate = 1
        store.saveConfig(config)
        let dev = make(p, store: store, environment: "development")
        dev.start()
        XCTAssertFalse(dev.isSampled, "the project does not collect development reports")

        let prod = make(p, store: store)
        prod.start()
        prod.didEnterBackground()
        XCTAssertNil(p.sent.last?.device.model)
        XCTAssertEqual(p.sent.last?.device.tier, .high)
    }

    func testMinSdkTurnsItOff() {
        let p = FakePlatform()
        let store = temporaryStore { p.wall }
        var config = VitalsConfig.defaults
        config.minSdk = ["ios": "99.0.0"]
        store.saveConfig(config)
        let r = make(p, store: store)
        r.start()
        XCTAssertNil(r.session)
        XCTAssertTrue(p.scheduled.isEmpty, "nothing scheduled either")
    }
}
