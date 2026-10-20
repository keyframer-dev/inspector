import Foundation
import XCTest
@testable import KeyframerInspectorCore

final class ProtocolTests: XCTestCase {
    /// Fixtures/messages.json comes from Tools/fixtures.ts, whose values tsc checks against
    /// protocol/inspector.ts. Each one must decode, and encode back to the same JSON.
    func testEveryFixtureRoundTrips() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "messages", withExtension: "json", subdirectory: "Fixtures"))
        let raw = try JSONDecoder().decode([JSONValue].self, from: Data(contentsOf: url))
        XCTAssertGreaterThan(raw.count, 20)
        for original in raw {
            let data = try JSONEncoder().encode(original)
            let message = try JSONDecoder().decode(InspectorMessage.self, from: data)
            let again = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(message))
            XCTAssertEqual(again, original, "round trip changed \(original["type"]?.string ?? "?")")
        }
    }

    func testFixturesDecodeToTheRightCases() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "messages", withExtension: "json", subdirectory: "Fixtures"))
        let messages = try JSONDecoder().decode([InspectorMessage].self, from: Data(contentsOf: url))
        guard case .appHello(let hello) = messages[0] else { return XCTFail("first fixture is the app hello") }
        XCTAssertEqual(hello.platform, "ios")
        XCTAssertEqual(hello.screen?.scale, 3)
        XCTAssertEqual(hello.protocol, 1)
        XCTAssertEqual(hello.framework, "uikit")
        XCTAssertEqual(hello.threads?["js"], InspectorThreadInfo(label: "Main", animates: true))
        XCTAssertNil(hello.threads?["ui"])
        XCTAssertTrue(hello.capabilities?.contains("scrub") == true)
        XCTAssertTrue(messages.contains { if case .scrub(t: nil) = $0 { return true }; return false })
        XCTAssertTrue(messages.contains { if case .other("apps", _) = $0 { return true }; return false })
        XCTAssertTrue(messages.contains { if case .record(["*"], true, nil) = $0 { return true }; return false })
        XCTAssertTrue(messages.contains(.record(signalIds: ["*"], on: true, recorder: "ci-7f3a")), "a recorder id")
        XCTAssertTrue(messages.contains { if case .editorHello = $0 { return true }; return false })
        XCTAssertTrue(messages.contains { if case .presence(let p) = $0 { return p.editors == 2 }; return false })
        XCTAssertTrue(messages.contains { if case .other("apply", _) = $0 { return true }; return false })
        let events = messages.compactMap { m -> [InspectorEvent]? in if case .events(let e) = m { return e }; return nil }.first
        guard case .anim(let anim)? = events?.first else { return XCTFail("anim event") }
        XCTAssertEqual(anim.site.params.first, InspectorParam(path: "1.duration", value: 600))
        XCTAssertEqual(anim.thread, .js)
        XCTAssertEqual(anim.durationMs, 700)
        XCTAssertEqual(anim.frames?.first?.offset, 23120)
        XCTAssertEqual(anim.frames?.last?.collapse, true)
        XCTAssertTrue(events?.contains(.unsignal(id: "DetailViewController.header/opacity")) == true)
        let scroll = events?.compactMap { e -> InspectorSignalSite? in if case .signal(let s) = e, s.kind == .scroll { return s }; return nil }.first
        XCTAssertEqual(scroll?.writable, true)
    }

    /// The display, accessibility, time, render hint and visibility parts of the protocol decode to
    /// their own cases, not to `.other`.
    func testEveryDeveloperEveryPlatformFixtures() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "messages", withExtension: "json", subdirectory: "Fixtures"))
        let messages = try JSONDecoder().decode([InspectorMessage].self, from: Data(contentsOf: url))
        guard case .appHello(let hello) = messages[0] else { return XCTFail("first fixture is the app hello") }
        XCTAssertEqual(hello.display, InspectorDisplay(hz: 120, adaptive: true))
        XCTAssertEqual(hello.accessibility, InspectorAccessibility(reduceMotion: false))
        XCTAssertTrue(hello.capabilities?.contains("time") == true)
        let swiftUI = messages.compactMap { m -> AppHello? in if case .appHello(let h) = m, h.framework == "swiftui" { return h }; return nil }.first
        XCTAssertEqual(swiftUI?.display, InspectorDisplay(hz: 60))
        XCTAssertEqual(swiftUI?.accessibility?.reduceMotion, true)
        XCTAssertEqual(hello.device, InspectorDevice(name: "iPhone 17 Pro", model: "iPhone18,1", id: "D95F3325-AE85-4445-9CB9-2D3C90388D88", simulator: true))
        XCTAssertEqual(swiftUI?.device, InspectorDevice(model: "iPhone17,1", simulator: false))

        XCTAssertTrue(messages.contains(.time(scale: 0.25, step: nil)))
        XCTAssertTrue(messages.contains(.time(scale: 0, step: 1)))
        XCTAssertTrue(messages.contains(.time(scale: 0, step: 4)))
        XCTAssertFalse(messages.contains { if case .other("time", _) = $0 { return true }; return false })

        let events = messages.flatMap { m -> [InspectorEvent] in if case .events(let e) = m { return e }; return [] }
        let hints = events.compactMap { e -> InspectorRenderHint? in if case .renderHint(let h) = e { return h }; return nil }
        XCTAssertEqual(hints.map(\.hint), ["shadow-path", "blur"])
        XCTAssertEqual(hints[0].id, "CardsViewController.card/shadowPath")
        XCTAssertNotNil(hints[0].detail)
        XCTAssertNil(hints[1].detail)
        let swiftUIAnim = events.compactMap { e -> InspectorAnimEvent? in if case .anim(let a) = e, a.site.fn == "withAnimation" { return a }; return nil }.first
        XCTAssertEqual(swiftUIAnim?.site.target, "card")
        XCTAssertEqual(swiftUIAnim?.site.line, 41)

        let markers = messages.flatMap { m -> [InspectorMarker] in if case .samples(let b) = m { return b.markers ?? [] }; return [] }
        XCTAssertTrue(markers.contains(.accessibility(.init(t: 1500, reduceMotion: true))))
        XCTAssertTrue(markers.contains(.display(.init(t: 1600, hz: 60))))
        XCTAssertTrue(markers.contains(.visibility(.init(t: 1700, id: "CardsViewController.pill/position.x", visible: false, reason: .offscreen))))
        XCTAssertTrue(markers.contains(.visibility(.init(t: 2300, id: "CardsViewController.pill/position.x", visible: true))))
        XCTAssertTrue(markers.contains(.visibility(.init(t: 2400, id: "DetailViewController.header/opacity", visible: false, reason: .detached))))
        XCTAssertTrue(markers.contains(.time(.init(t: 1800, scale: 0.25))))
        XCTAssertTrue(markers.contains(.time(.init(t: 2100, scale: 0, step: 6))), "a step while paused")
        XCTAssertEqual(markers.first { if case .time = $0 { return true }; return false }?.t, 1800)
    }

    /// Optional fields are left out when nil, as the TS types have them (`step?`, `reason?`, `detail?`,
    /// `adaptive?`, `display?`).
    func testNewFieldsAreLeftOutWhenNil() throws {
        func json(_ m: InspectorMessage) throws -> JSONValue { try JSONDecoder().decode(JSONValue.self, from: Data(InspectorJSON.encode(m).utf8)) }
        XCTAssertEqual(try json(.time(scale: 1, step: nil)), ["type": "time", "scale": 1])
        XCTAssertEqual(try json(.time(scale: 0, step: 2)), ["type": "time", "scale": 0, "step": 2])
        XCTAssertEqual(try InspectorJSON.decode(#"{"type":"time","scale":0.5}"#), .time(scale: 0.5, step: nil))
        // Read leniently, so even a message the app ignores is answered.
        XCTAssertEqual(try InspectorJSON.decode(#"{"type":"time"}"#), .time(scale: nil, step: nil))
        XCTAssertEqual(try InspectorJSON.decode(#"{"type":"time","scale":"fast","step":"x"}"#), .time(scale: nil, step: nil))

        let hint = try json(.events([.renderHint(InspectorRenderHint(id: "a/opacity", hint: "group-opacity"))]))
        XCTAssertEqual(hint["events"], [["kind": "renderHint", "id": "a/opacity", "hint": "group-opacity"]])
        let visibility = try json(.samples(SampleBatch(samples: [], markers: [.visibility(.init(t: 5, id: "a/position.x", visible: true))])))
        XCTAssertEqual(visibility["markers"], [["kind": "visibility", "t": 5, "id": "a/position.x", "visible": true]])

        let hello = try json(.appHello(AppHello(app: "A", platform: "ios", display: InspectorDisplay(hz: 60), accessibility: InspectorAccessibility(reduceMotion: false))))
        XCTAssertEqual(hello["display"], ["hz": 60])
        XCTAssertEqual(hello["accessibility"], ["reduceMotion": false])
        let bare = try json(.appHello(AppHello(app: "A", platform: "ios")))
        XCTAssertNil(bare["display"])
        XCTAssertNil(bare["accessibility"])
    }

    /// The source root rides in the hello (where call sites resolve and "Apply to code" may write).
    func testHelloCarriesTheSourceRoot() throws {
        let hello = AppHello(app: "Demo", platform: "ios", root: "/Users/me/Demo")
        let json = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(InspectorMessage.appHello(hello)))
        XCTAssertEqual(json["root"], "/Users/me/Demo")
        let none = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(InspectorMessage.appHello(AppHello(app: "Demo", platform: "ios"))))
        XCTAssertNil(none["root"])
    }

    /// `T | null` fields are always written; `T?:` fields are left out when nil.
    func testNullableAndOptionalFields() throws {
        let site = InspectorCallSite(id: "a", file: "f", line: 1, column: 2, fn: "CABasicAnimation", component: nil, target: nil, prop: nil, params: [])
        let event = InspectorEvent.anim(InspectorAnimEvent(eid: 1, site: site, at: 5, args: [.null]))
        let json = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(event))
        XCTAssertEqual(json["site"]?["component"], .null)
        XCTAssertEqual(json["site"]?["target"], .null)
        XCTAssertEqual(json["site"]?["prop"], .null)
        XCTAssertNil(json["t"])
        XCTAssertNil(json["stack"])
        XCTAssertNil(json["thread"])
        XCTAssertEqual(json["kind"], "anim")

        let signal = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(InspectorEvent.signal(.init(id: "s", file: "f", line: 0, component: nil, name: nil))))
        XCTAssertEqual(signal, ["kind": "signal", "site": ["id": "s", "file": "f", "line": 0, "component": nil, "name": nil]])
        let unsignal = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(InspectorEvent.unsignal(id: "s")))
        XCTAssertEqual(unsignal, ["kind": "unsignal", "id": "s"])
        let scrub = try JSONDecoder().decode(JSONValue.self, from: Data(try InspectorJSON.encode(.scrub(t: nil)).utf8))
        XCTAssertEqual(scrub, ["type": "scrub", "t": nil], "t is written as null, not left out")
    }

    func testSamplesBatchLeavesOutEmptyExtras() throws {
        let text = try InspectorJSON.encode(.samples(SampleBatch(samples: [InspectorSample(id: "x", t: 16, v: 0.5)])))
        let json = try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
        XCTAssertEqual(json, ["type": "samples", "samples": [["id": "x", "t": 16, "v": 0.5]]])
    }

    func testScrubExtensionAndUnknownTypes() throws {
        XCTAssertEqual(try InspectorJSON.decode(#"{"type":"scrub","t":420}"#), .scrub(t: 420))
        XCTAssertEqual(try InspectorJSON.decode(#"{"type":"scrub","t":null}"#), .scrub(t: nil))
        guard case .other("somethingNew", let json) = try InspectorJSON.decode(#"{"type":"somethingNew","x":[1,true]}"#) else { return XCTFail() }
        XCTAssertEqual(json["x"], [1, true])
    }

    func testNonFiniteNumbersBecomeNull() throws {
        let text = String(decoding: try JSONEncoder().encode(JSONValue.array([.number(.nan), .number(.infinity), 1])), as: UTF8.self)
        XCTAssertEqual(text, "[null,null,1]")
    }
}
