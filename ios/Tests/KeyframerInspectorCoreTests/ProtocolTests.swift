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
        XCTAssertTrue(messages.contains { if case .record(["*"], true) = $0 { return true }; return false })
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
